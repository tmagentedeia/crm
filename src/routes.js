import { Router } from 'express';
import { q } from './db.js';
import { runImport } from './importer.js';

const digits = (s) => String(s || '').replace(/\D/g, '');
// Telefone digitado só com DDD (10 ou 11 dígitos): põe o 55 e tira o 9 extra do celular,
// que é como o WhatsApp/UAZAPI entrega o número ao agente (55 + DDD + 8 dígitos).
const custPhone = (s) => {
  const d = digits(s);
  if (d.length === 11 && d[2] === '9') return '55' + d.slice(0, 2) + d.slice(3);
  if (d.length === 10 || d.length === 11) return '55' + d;
  return d;
};
const wrap = (fn) => (req, res) => fn(req, res).catch((e) => {
  if (e.code === '23P01') return res.status(409).json({ error: 'Horário indisponível (conflito de agenda)' });
  if (e.code === '23505') return res.status(409).json({ error: 'Registro duplicado' });
  console.error(e);
  res.status(500).json({ error: 'Erro interno' });
});

// ---------- Espelho no Google Agenda (via webhook do N8N) ----------
// Se N8N_WEBHOOK_URL estiver definida, todo agendamento criado / com status alterado / apagado
// é avisado ao N8N, que cria/apaga o evento na agenda Google do profissional.
// Não bloqueia nem quebra o agendamento: se o N8N estiver fora do ar, só o espelho fica sem atualizar.
async function apptSnapshot(salonId, id) {
  const { rows } = await q(
    `SELECT a.id, a.salon_id, a.barber_id, a.status, a.starts_at, a.ends_at, a.price, a.google_event_id,
            b.name AS barber_name, b.google_calendar_id AS calendar_id,
            c.name AS customer_name, c.phone AS customer_phone, sv.name AS service_name
     FROM appointments a
     JOIN barbers b ON b.id=a.barber_id JOIN customers c ON c.id=a.customer_id
     JOIN services sv ON sv.id=a.service_id
     WHERE a.id=$1 AND a.salon_id=$2`, [id, salonId]);
  return rows[0] || null;
}
function notifyN8n(event, snap) {
  const url = process.env.N8N_WEBHOOK_URL;
  if (!url || !snap || (!snap.calendar_id && !snap.google_event_id)) return;
  fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': process.env.N8N_API_KEY || '' },
    body: JSON.stringify({ event, appointment: (({ salon_id, ...r }) => ({ ...r, companyid: salon_id }))(snap) }),
    signal: AbortSignal.timeout(8000),
  }).then((r) => { if (!r.ok) console.error('Webhook N8N respondeu', r.status); })
    .catch((e) => console.error('Falha ao avisar N8N:', e.message));
}

// Aceita o ID da agenda Google ou o link colado (extrai o ID do parâmetro cid/src do link)
function normCalendarId(v) {
  const t = String(v ?? '').trim();
  const m = t.match(/[?&](cid|src)=([^&#]+)/);
  if (!m) return t;
  const raw = decodeURIComponent(m[2]);
  if (m[1] === 'src') return raw;
  try { const d = Buffer.from(raw.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8'); return /^[\w.+-]+@[\w.-]+$/.test(d) ? d : t; } catch { return t; }
}

// ---------- Fila de espera ----------
// Quando um horário é liberado (agendamento cancelado ou apagado), avisa o N8N para mandar
// WhatsApp ao primeiro cliente da fila (ordem de chegada) que queria aquele horário.
// N8N_WAITLIST_WEBHOOK_URL = webhook do workflow "Salão - Aviso Fila de Espera".
async function checkWaitlist(snap) {
  const url = process.env.N8N_WAITLIST_WEBHOOK_URL;
  if (!url || !snap) return;
  const { rows } = await q(
    `UPDATE waitlist w SET status='notified', notified_at=now()
     WHERE w.id = (
       SELECT w2.id FROM waitlist w2
       WHERE w2.salon_id=$1 AND w2.status='waiting'
         AND (w2.barber_id IS NULL OR w2.barber_id=$2)
         AND w2.desired_at >= $3 AND w2.desired_at < $4 AND w2.desired_at > now()
       ORDER BY w2.created_at LIMIT 1)
     RETURNING w.id, w.desired_at`, [snap.salon_id, snap.barber_id, snap.starts_at, snap.ends_at]);
  if (!rows[0]) return;
  const d = await q(
    `SELECT c.name AS customer_name, c.phone AS customer_phone FROM waitlist w
     JOIN customers c ON c.id=w.customer_id WHERE w.id=$1`, [rows[0].id]);
  fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': process.env.N8N_API_KEY || '' },
    body: JSON.stringify({ event: 'slot_opened', entry: {
      id: rows[0].id, companyid: snap.salon_id, desired_at: rows[0].desired_at,
      barber_name: snap.barber_name, service_name: snap.service_name, ...d.rows[0] } }),
    signal: AbortSignal.timeout(8000),
  }).then((r) => { if (!r.ok) console.error('Webhook fila respondeu', r.status); })
    .catch((e) => console.error('Falha ao avisar fila:', e.message));
}
const normName = (s) => String(s || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().trim();

// Limite de profissionais ativos por salão (salons.max_barbers; NULL = sem limite)
async function barberLimitReached(salonId, excludeId = null) {
  const { rows } = await q(
    `SELECT s.max_barbers,
            (SELECT COUNT(*)::int FROM barbers b WHERE b.salon_id = s.id AND b.active AND b.id IS DISTINCT FROM $2) AS ativos
     FROM salons s WHERE s.id = $1`, [salonId, excludeId]);
  const r = rows[0];
  return r && r.max_barbers !== null && r.ativos >= r.max_barbers ? r.max_barbers : null;
}

// Serviços de cada profissional (tabela barber_services). Sem nenhuma linha = faz todos os serviços.
async function setBarberServices(salonId, barberId, ids) {
  await q('DELETE FROM barber_services WHERE barber_id=$1', [barberId]);
  if (!ids.length) return;
  await q(`INSERT INTO barber_services (barber_id, service_id)
           SELECT $1, id FROM services WHERE salon_id=$2 AND id = ANY($3::bigint[])`,
    [barberId, salonId, ids.map(Number)]);
}
// Um profissional faz um serviço se: (a) o serviço é de uma categoria que ele atende
// (serviço sem categoria = qualquer um) e (b) se ele tiver
// serviços específicos marcados, o serviço está entre eles.
const BARBER_DOES = `(
  (EXISTS (SELECT 1 FROM services sx JOIN barber_categories bc ON bc.category_id=sx.category_id
              WHERE sx.id=%S% AND bc.barber_id=%B%)
   OR EXISTS (SELECT 1 FROM services sy WHERE sy.id=%S% AND sy.category_id IS NULL))
  AND (NOT EXISTS (SELECT 1 FROM barber_services bs WHERE bs.barber_id=%B%)
       OR EXISTS (SELECT 1 FROM barber_services bs WHERE bs.barber_id=%B% AND bs.service_id=%S%))
)`;
const doesSql = (b, sv) => BARBER_DOES.replaceAll('%B%', b).replaceAll('%S%', sv);

async function setBarberCategories(salonId, barberId, ids) {
  await q('DELETE FROM barber_categories WHERE barber_id=$1', [barberId]);
  await q(`INSERT INTO barber_categories (barber_id, category_id)
           SELECT $1, id FROM categories WHERE salon_id=$2 AND id = ANY($3::bigint[])`,
    [barberId, salonId, ids.map(Number)]);
}
// exige ao menos uma categoria válida do salão
async function validCategoryIds(salonId, ids) {
  if (!Array.isArray(ids) || !ids.length) return false;
  const { rows } = await q('SELECT count(*)::int AS n FROM categories WHERE salon_id=$1 AND id = ANY($2::bigint[])', [salonId, ids.map(Number)]);
  return rows[0].n > 0;
}

// Router compartilhado: usado pelo painel (JWT) e pelo N8N (API key). Sempre filtra por req.user.salonId.
export function buildRouter() {
  const r = Router();

  // ---------- CATEGORIAS ----------
  // Devolve cada categoria com seus serviços e os profissionais que atendem nela
  // (profissional sem serviços marcados = faz todos, então entra em todas as categorias).
  r.get('/categories', wrap(async (req, res) => {
    const { rows } = await q(
      `SELECT c.id, c.name,
         COALESCE((SELECT json_agg(json_build_object('id',sv.id,'name',sv.name) ORDER BY sv.name)
                   FROM services sv WHERE sv.category_id=c.id AND sv.active), '[]') AS services,
         COALESCE((SELECT json_agg(DISTINCT b.name)
                   FROM barbers b WHERE b.salon_id=c.salon_id AND b.active
                     AND EXISTS (SELECT 1 FROM barber_categories x WHERE x.barber_id=b.id AND x.category_id=c.id)
                     AND EXISTS (SELECT 1 FROM services sv WHERE sv.category_id=c.id AND sv.active
                                 AND (NOT EXISTS (SELECT 1 FROM barber_services bs WHERE bs.barber_id=b.id)
                                      OR EXISTS (SELECT 1 FROM barber_services bs WHERE bs.barber_id=b.id AND bs.service_id=sv.id)))), '[]') AS barbers
       FROM categories c WHERE c.salon_id=$1 ORDER BY c.name`, [req.user.salonId]);
    res.json(rows);
  }));
  r.post('/categories', wrap(async (req, res) => {
    const name = String(req.body.name || '').trim();
    if (!name) return res.status(400).json({ error: 'Informe o nome da categoria' });
    const { rows } = await q('INSERT INTO categories (salon_id,name) VALUES ($1,$2) RETURNING *', [req.user.salonId, name]);
    res.status(201).json(rows[0]);
  }));
  r.put('/categories/:id', wrap(async (req, res) => {
    const name = String(req.body.name || '').trim();
    if (!name) return res.status(400).json({ error: 'Informe o nome da categoria' });
    const { rows } = await q('UPDATE categories SET name=$3 WHERE id=$1 AND salon_id=$2 RETURNING *',
      [req.params.id, req.user.salonId, name]);
    rows[0] ? res.json(rows[0]) : res.status(404).json({ error: 'Não encontrado' });
  }));
  r.delete('/categories/:id', wrap(async (req, res) => {
    // os serviços da categoria ficam sem categoria (não são apagados)
    await q('DELETE FROM categories WHERE id=$1 AND salon_id=$2', [req.params.id, req.user.salonId]);
    res.json({ ok: true });
  }));

  // ---------- SERVIÇOS ----------
  const validCat = async (salonId, id) =>
    !id || (await q('SELECT 1 FROM categories WHERE id=$1 AND salon_id=$2', [id, salonId])).rows[0];
  r.get('/services', wrap(async (req, res) => {
    const { rows } = await q(
      `SELECT s.*, c.name AS category FROM services s LEFT JOIN categories c ON c.id=s.category_id
       WHERE s.salon_id=$1 ORDER BY c.name NULLS LAST, s.name`, [req.user.salonId]);
    res.json(rows);
  }));
  r.post('/services', wrap(async (req, res) => {
    const { name, price = 0, duration_min = 30, category_id } = req.body;
    if (!(await validCat(req.user.salonId, category_id))) return res.status(400).json({ error: 'Categoria inválida' });
    const { rows } = await q(
      'INSERT INTO services (salon_id,name,price,duration_min,category_id) VALUES ($1,$2,$3,$4,$5) RETURNING *',
      [req.user.salonId, name, price, duration_min, category_id || null]);
    res.status(201).json(rows[0]);
  }));
  r.put('/services/:id', wrap(async (req, res) => {
    const { name, price, duration_min, active, category_id } = req.body;
    if (!(await validCat(req.user.salonId, category_id))) return res.status(400).json({ error: 'Categoria inválida' });
    // category_id: undefined = não mexe; null/'' = remove
    const { rows } = await q(
      `UPDATE services SET name=COALESCE($3,name), price=COALESCE($4,price),
       duration_min=COALESCE($5,duration_min), active=COALESCE($6,active),
       category_id = CASE WHEN $7::boolean THEN $8::bigint ELSE category_id END
       WHERE id=$1 AND salon_id=$2 RETURNING *`,
      [req.params.id, req.user.salonId, name, price, duration_min, active,
       category_id !== undefined, category_id || null]);
    rows[0] ? res.json(rows[0]) : res.status(404).json({ error: 'Não encontrado' });
  }));
  r.delete('/services/:id', wrap(async (req, res) => {
    // desativa em vez de apagar, para preservar o histórico de agendamentos
    await q('UPDATE services SET active=false WHERE id=$1 AND salon_id=$2', [req.params.id, req.user.salonId]);
    res.json({ ok: true });
  }));

  // ---------- BARBEIROS ----------
  r.get('/barbers', wrap(async (req, res) => {
    const { rows } = await q(
      `SELECT b.*, COALESCE(json_agg(json_build_object(
          'weekday',s.weekday,'start_time',s.start_time,'end_time',s.end_time,
          'break_start',s.break_start,'break_end',s.break_end) ORDER BY s.weekday)
          FILTER (WHERE s.id IS NOT NULL), '[]') AS schedules,
          COALESCE((SELECT json_agg(bs.service_id ORDER BY bs.service_id) FROM barber_services bs WHERE bs.barber_id=b.id), '[]') AS service_ids,
          COALESCE((SELECT json_agg(bc.category_id ORDER BY bc.category_id) FROM barber_categories bc WHERE bc.barber_id=b.id), '[]') AS category_ids,
          COALESCE((SELECT json_agg(sv.id ORDER BY sv.id) FROM services sv
                    WHERE sv.salon_id=b.salon_id AND sv.active AND ${doesSql('b.id', 'sv.id')}), '[]') AS does_service_ids
       FROM barbers b LEFT JOIN barber_schedules s ON s.barber_id=b.id
       WHERE b.salon_id=$1 GROUP BY b.id ORDER BY b.name`, [req.user.salonId]);
    res.json(rows);
  }));
  r.post('/barbers', wrap(async (req, res) => {
    const { name, color = '#3B82F6', phone, google_calendar_id, schedules = [], service_ids, category_ids } = req.body;
    if (!(await validCategoryIds(req.user.salonId, category_ids)))
      return res.status(400).json({ error: 'Escolha pelo menos uma categoria para o profissional' });
    const limit = await barberLimitReached(req.user.salonId);
    if (limit !== null) return res.status(403).json({ error: `Limite de ${limit} profissionais do seu plano atingido` });
    const { rows } = await q(
      'INSERT INTO barbers (salon_id,name,color,phone,google_calendar_id) VALUES ($1,$2,$3,$4,$5) RETURNING *',
      [req.user.salonId, name, color, phone, normCalendarId(google_calendar_id) || null]);
    const b = rows[0];
    for (const s of schedules) {
      await q(`INSERT INTO barber_schedules (barber_id,weekday,start_time,end_time,break_start,break_end)
               VALUES ($1,$2,$3,$4,$5,$6)`,
        [b.id, s.weekday, s.start_time, s.end_time, s.break_start || null, s.break_end || null]);
    }
    await setBarberCategories(req.user.salonId, b.id, category_ids);
    if (Array.isArray(service_ids)) await setBarberServices(req.user.salonId, b.id, service_ids);
    res.status(201).json(b); // agenda individual = appointments filtrados por barber_id
  }));
  r.put('/barbers/:id', wrap(async (req, res) => {
    const { name, color, phone, active, schedules, google_calendar_id, service_ids, category_ids } = req.body;
    if (category_ids !== undefined && !(await validCategoryIds(req.user.salonId, category_ids)))
      return res.status(400).json({ error: 'Escolha pelo menos uma categoria para o profissional' });
    if (active === true) {
      const limit = await barberLimitReached(req.user.salonId, req.params.id);
      if (limit !== null) return res.status(403).json({ error: `Limite de ${limit} profissionais do seu plano atingido` });
    }
    // google_calendar_id: undefined = não mexe; string vazia = remove
    const { rows } = await q(
      `UPDATE barbers SET name=COALESCE($3,name), color=COALESCE($4,color),
       phone=COALESCE($5,phone), active=COALESCE($6,active),
       google_calendar_id = CASE WHEN $7::boolean THEN NULLIF(trim($8),'') ELSE google_calendar_id END
       WHERE id=$1 AND salon_id=$2 RETURNING *`,
      [req.params.id, req.user.salonId, name, color, phone, active,
       google_calendar_id !== undefined, normCalendarId(google_calendar_id)]);
    if (!rows[0]) return res.status(404).json({ error: 'Não encontrado' });
    // category_ids: undefined = não mexe (se vier, precisa ter ao menos uma)
    if (Array.isArray(category_ids)) await setBarberCategories(req.user.salonId, req.params.id, category_ids);
    // service_ids: undefined = não mexe; [] = faz todos os serviços das categorias
    if (Array.isArray(service_ids)) await setBarberServices(req.user.salonId, req.params.id, service_ids);
    if (Array.isArray(schedules)) {
      await q('DELETE FROM barber_schedules WHERE barber_id=$1', [req.params.id]);
      for (const s of schedules) {
        await q(`INSERT INTO barber_schedules (barber_id,weekday,start_time,end_time,break_start,break_end)
                 VALUES ($1,$2,$3,$4,$5,$6)`,
          [req.params.id, s.weekday, s.start_time, s.end_time, s.break_start || null, s.break_end || null]);
      }
    }
    res.json(rows[0]);
  }));

  // ---------- CLIENTES / LEADS ----------
  r.get('/customers', wrap(async (req, res) => {
    const { status, search } = req.query;
    const { rows } = await q(
      `SELECT * FROM customers WHERE salon_id=$1
       AND ($2::text IS NULL OR status=$2)
       AND ($3::text IS NULL OR name ILIKE '%'||$3||'%' OR phone LIKE '%'||$3||'%')
       ORDER BY created_at DESC LIMIT 500`,
      [req.user.salonId, status || null, search || null]);
    res.json(rows);
  }));
  // Upsert por telefone: o agente de IA chama isso quando um lead novo conversa
  r.post('/customers', wrap(async (req, res) => {
    const { name, phone, chat_id, source = 'manual', notes, status } = req.body;
    if (status !== undefined && !['lead', 'client'].includes(status)) return res.status(400).json({ error: 'Tipo inválido' });
    const { rows } = await q(
      `INSERT INTO customers (salon_id,name,phone,chat_id,source,notes,status)
       VALUES ($1,$2,$3,$4,$5,$6,COALESCE($7,'lead'))
       ON CONFLICT (salon_id,phone) DO UPDATE SET
         name=COALESCE(EXCLUDED.name,customers.name),
         chat_id=COALESCE(EXCLUDED.chat_id,customers.chat_id),
         notes=COALESCE(EXCLUDED.notes,customers.notes)
       RETURNING *`,
      [req.user.salonId, name, custPhone(phone), chat_id, source, notes, status ?? null]);
    res.status(201).json(rows[0]);
  }));
  r.get('/customers/by-phone/:phone', wrap(async (req, res) => {
    const { rows } = await q('SELECT * FROM customers WHERE salon_id=$1 AND phone=$2',
      [req.user.salonId, digits(req.params.phone)]);
    rows[0] ? res.json(rows[0]) : res.status(404).json({ error: 'Não encontrado' });
  }));
  r.get('/customers/:id', wrap(async (req, res) => {
    const c = await q('SELECT * FROM customers WHERE id=$1 AND salon_id=$2', [req.params.id, req.user.salonId]);
    if (!c.rows[0]) return res.status(404).json({ error: 'Não encontrado' });
    const h = await q(
      'SELECT * FROM v_customer_history WHERE customer_id=$1 AND salon_id=$2 ORDER BY starts_at DESC',
      [req.params.id, req.user.salonId]);
    res.json({ ...c.rows[0], history: h.rows });
  }));
  r.put('/customers/:id', wrap(async (req, res) => {
    const { name, phone, notes, status } = req.body;
    if (status !== undefined && !['lead', 'client'].includes(status)) return res.status(400).json({ error: 'Tipo inválido' });
    if (phone !== undefined && digits(phone).length < 10) return res.status(400).json({ error: 'Telefone inválido (use DDD + número)' });
    const { rows } = await q(
      `UPDATE customers SET name=COALESCE($3,name), phone=COALESCE($4,phone), notes=COALESCE($5,notes),
       status=COALESCE($6,status)
       WHERE id=$1 AND salon_id=$2 RETURNING *`,
      [req.params.id, req.user.salonId, name, phone ? custPhone(phone) : null, notes, status ?? null]);
    rows[0] ? res.json(rows[0]) : res.status(404).json({ error: 'Não encontrado' });
  }));
  // Exclui o cliente/lead junto com seus agendamentos e entradas na fila de espera.
  // Eventos espelhados no Google Agenda são apagados via N8N.
  r.delete('/customers/:id', wrap(async (req, res) => {
    const c = await q('SELECT id FROM customers WHERE id=$1 AND salon_id=$2', [req.params.id, req.user.salonId]);
    if (!c.rows[0]) return res.status(404).json({ error: 'Não encontrado' });
    const ids = (await q('SELECT id FROM appointments WHERE customer_id=$1 AND salon_id=$2', [req.params.id, req.user.salonId])).rows;
    const snaps = [];
    for (const a of ids) snaps.push(await apptSnapshot(req.user.salonId, a.id));
    await q('DELETE FROM waitlist WHERE customer_id=$1 AND salon_id=$2', [req.params.id, req.user.salonId]);
    await q('DELETE FROM appointments WHERE customer_id=$1 AND salon_id=$2', [req.params.id, req.user.salonId]);
    await q('DELETE FROM customers WHERE id=$1 AND salon_id=$2', [req.params.id, req.user.salonId]);
    res.json({ ok: true, appointments_deleted: snaps.length });
    snaps.forEach((sn) => notifyN8n('deleted', sn));
  }));

  // ---------- INATIVOS ----------
  r.get('/customers-inactive', wrap(async (req, res) => {
    const days = Number(req.query.days) || null; // se vier, sobrescreve salons.inactive_days
    const { rows } = await q(
      `SELECT c.*, (now()::date - c.last_visit_at::date) AS days_absent
       FROM customers c JOIN salons s ON s.id=c.salon_id
       WHERE c.salon_id=$1 AND c.status='client' AND c.last_visit_at IS NOT NULL
         AND c.last_visit_at < now() - make_interval(days => COALESCE($2, s.inactive_days))
         AND NOT EXISTS (SELECT 1 FROM appointments a WHERE a.customer_id=c.id
                         AND a.status='scheduled' AND a.starts_at > now())
       ORDER BY c.last_visit_at ASC`,
      [req.user.salonId, days]);
    res.json(rows);
  }));

  // ---------- AGENDAMENTOS ----------
  r.get('/appointments', wrap(async (req, res) => {
    // filtros opcionais: from, to, barber_id, phone (do cliente), status, google_event_id
    const { from, to, barber_id, phone, status, google_event_id } = req.query;
    const { rows } = await q(
      `SELECT a.*, c.name AS customer_name, c.phone AS customer_phone,
              sv.name AS service_name, b.name AS barber_name, b.color AS barber_color,
              b.google_calendar_id AS barber_google_calendar_id
       FROM appointments a
       JOIN customers c ON c.id=a.customer_id
       JOIN services sv ON sv.id=a.service_id
       JOIN barbers b ON b.id=a.barber_id
       WHERE a.salon_id=$1
         AND ($2::timestamptz IS NULL OR a.starts_at >= $2)
         AND ($3::timestamptz IS NULL OR a.starts_at < $3)
         AND ($4::bigint IS NULL OR a.barber_id = $4)
         AND ($5::text IS NULL OR c.phone = $5)
         AND ($6::text IS NULL OR a.status = $6)
         AND ($7::text IS NULL OR a.google_event_id = $7)
       ORDER BY a.starts_at`,
      [req.user.salonId, from || null, to || null, barber_id || null,
       phone ? digits(phone) : null, status || null, google_event_id || null]);
    res.json(rows);
  }));
  r.post('/appointments', wrap(async (req, res) => {
    const { barber_id, customer_id, service_id, starts_at, source = 'manual' } = req.body;
    const sv = await q('SELECT price,duration_min FROM services WHERE id=$1 AND salon_id=$2 AND active',
      [service_id, req.user.salonId]);
    if (!sv.rows[0]) return res.status(400).json({ error: 'Serviço inválido' });
    const ok = await q(
      `SELECT (SELECT 1 FROM barbers WHERE id=$1 AND salon_id=$3 AND active) AS b,
              (SELECT 1 FROM customers WHERE id=$2 AND salon_id=$3) AS c`,
      [barber_id, customer_id, req.user.salonId]);
    if (!ok.rows[0].b || !ok.rows[0].c) return res.status(400).json({ error: 'Profissional ou cliente inválido' });
    const does = await q(`SELECT ${doesSql('$1', '$2')} AS ok`, [barber_id, service_id]);
    if (!does.rows[0].ok) return res.status(400).json({ error: 'Este profissional não realiza esse serviço' });
    const { rows } = await q(
      `INSERT INTO appointments (salon_id,barber_id,customer_id,service_id,starts_at,ends_at,price,source)
       VALUES ($1,$2,$3,$4,$5::timestamptz,$5::timestamptz + make_interval(mins => $6),$7,$8) RETURNING *`,
      [req.user.salonId, barber_id, customer_id, service_id, starts_at,
       sv.rows[0].duration_min, sv.rows[0].price, source]);
    res.status(201).json(rows[0]);
    apptSnapshot(req.user.salonId, rows[0].id).then((s) => notifyN8n('created', s)).catch(() => {});
  }));
  // Lembrete ao cliente: o N8N chama isto de tempos em tempos. Reserva e devolve, de forma atômica,
  // os agendamentos que começam entre min_minutes e window_minutes a partir de agora e ainda não
  // receberam lembrete (duas chamadas seguidas nunca devolvem o mesmo agendamento).
  // Não lembra quem acabou de agendar (ver regra em reminders/claim).
  r.post('/appointments/reminders/claim', wrap(async (req, res) => {
    // Regra vem da configuração do salão (reminder_minutes = antecedência; NULL = desligado).
    // Janela: de (N-30min) a (N+5min) antes; não lembra quem marcou com menos de N+60min de antecedência.
    const cfg = (await q('SELECT reminder_minutes FROM salons WHERE id=$1', [req.user.salonId])).rows[0];
    const N = cfg?.reminder_minutes;
    if (!N) return res.json([]);
    const win = N + 5, min = Math.max(N - 30, 15), gap = N + 60;
    const limit = Math.min(Math.max(Number(req.body?.limit) || 15, 1), 50);
    const { rows } = await q(
      `UPDATE appointments a SET reminder_sent_at = now()
       WHERE a.id IN (
         SELECT a2.id FROM appointments a2
         WHERE a2.salon_id=$1 AND a2.status='scheduled' AND a2.reminder_sent_at IS NULL
           AND a2.starts_at > now() + make_interval(mins => $2)
           AND a2.starts_at <= now() + make_interval(mins => $3)
           AND a2.created_at <= a2.starts_at - make_interval(mins => $5)
         ORDER BY a2.starts_at LIMIT $4 FOR UPDATE SKIP LOCKED)
       RETURNING a.id`, [req.user.salonId, min, win, limit, gap]);
    const out = [];
    for (const { id } of rows) {
      const s = await apptSnapshot(req.user.salonId, id);
      const sal = (await q('SELECT name, timezone FROM salons WHERE id=$1', [req.user.salonId])).rows[0];
      out.push({ id: s.id, starts_at: s.starts_at, customer_name: s.customer_name, customer_phone: s.customer_phone,
                 barber_name: s.barber_name, service_name: s.service_name, salon_name: sal.name, timezone: sal.timezone });
    }
    res.json(out);
  }));
  // status: attended | no_show | cancelled | scheduled
  r.patch('/appointments/:id/status', wrap(async (req, res) => {
    const { status } = req.body;
    if (!['scheduled', 'attended', 'no_show', 'cancelled'].includes(status))
      return res.status(400).json({ error: 'Status inválido' });
    const { rows } = await q('UPDATE appointments SET status=$3 WHERE id=$1 AND salon_id=$2 RETURNING *',
      [req.params.id, req.user.salonId, status]);
    if (!rows[0]) return res.status(404).json({ error: 'Não encontrado' });
    res.json(rows[0]);
    apptSnapshot(req.user.salonId, rows[0].id).then((s) => {
      notifyN8n('updated', s);
      // cancelado ou faltou = horário liberado (só sai aviso se o horário ainda for futuro)
      if (status === 'cancelled' || status === 'no_show') checkWaitlist(s);
    }).catch(() => {});
  }));
  // guarda o id do evento espelhado no Google Agenda (string vazia = remove)
  r.patch('/appointments/:id', wrap(async (req, res) => {
    const { google_event_id } = req.body;
    if (google_event_id === undefined) return res.status(400).json({ error: 'Nada para atualizar' });
    const { rows } = await q(
      "UPDATE appointments SET google_event_id=NULLIF(trim($3),'') WHERE id=$1 AND salon_id=$2 RETURNING *",
      [req.params.id, req.user.salonId, google_event_id ?? '']);
    rows[0] ? res.json(rows[0]) : res.status(404).json({ error: 'Não encontrado' });
  }));
  r.delete('/appointments/:id', wrap(async (req, res) => {
    const snap = await apptSnapshot(req.user.salonId, req.params.id); // foto antes de apagar
    await q('DELETE FROM appointments WHERE id=$1 AND salon_id=$2', [req.params.id, req.user.salonId]);
    res.json({ ok: true });
    notifyN8n('deleted', snap);
    if (snap && ['scheduled', 'attended'].includes(snap.status)) checkWaitlist(snap).catch(() => {});
  }));

  // ---------- FILA DE ESPERA ----------
  r.get('/waitlist', wrap(async (req, res) => {
    const { status, phone } = req.query;
    const { rows } = await q(
      `SELECT w.*, c.name AS customer_name, c.phone AS customer_phone, b.name AS barber_name
       FROM waitlist w JOIN customers c ON c.id=w.customer_id LEFT JOIN barbers b ON b.id=w.barber_id
       WHERE w.salon_id=$1 AND ($2::text IS NULL OR w.status=$2) AND ($3::text IS NULL OR c.phone=$3)
       ORDER BY (w.status='waiting') DESC, w.desired_at`,
      [req.user.salonId, status || null, phone ? digits(phone) : null]);
    res.json(rows);
  }));
  // body: { phone, name?, desired_at, barber_id | barber_name? } — sem profissional = qualquer um
  r.post('/waitlist', wrap(async (req, res) => {
    const { phone, name, desired_at, barber_id, barber_name } = req.body;
    const d = new Date(desired_at);
    if (!digits(phone) || !desired_at || isNaN(d)) return res.status(400).json({ error: 'Informe telefone e horário desejado (ISO 8601)' });
    let bid = barber_id || null;
    if (!bid && normName(barber_name)) {
      const bs = (await q('SELECT id,name FROM barbers WHERE salon_id=$1 AND active', [req.user.salonId])).rows;
      const n = normName(barber_name);
      const b = bs.find((x) => normName(x.name) === n) || bs.find((x) => normName(x.name).includes(n) || n.includes(normName(x.name)));
      if (!b) return res.status(400).json({ error: `Profissional não encontrado (opções: ${bs.map((x) => x.name).join(', ')})` });
      bid = b.id;
    }
    const cu = await q(
      `INSERT INTO customers (salon_id,name,phone,source) VALUES ($1,$2,$3,'ia')
       ON CONFLICT (salon_id,phone) DO UPDATE SET name=COALESCE(customers.name,EXCLUDED.name) RETURNING id`,
      [req.user.salonId, name || null, digits(phone)]);
    const dup = await q(
      `SELECT id FROM waitlist WHERE salon_id=$1 AND customer_id=$2 AND status='waiting'
       AND desired_at=$3 AND barber_id IS NOT DISTINCT FROM $4::bigint`, [req.user.salonId, cu.rows[0].id, d, bid]);
    if (dup.rows[0]) return res.status(200).json({ ...dup.rows[0], already: true });
    const { rows } = await q(
      'INSERT INTO waitlist (salon_id,customer_id,barber_id,desired_at) VALUES ($1,$2,$3,$4) RETURNING *',
      [req.user.salonId, cu.rows[0].id, bid, d]);
    res.status(201).json(rows[0]);
  }));
  r.delete('/waitlist/:id', wrap(async (req, res) => {
    await q("UPDATE waitlist SET status='cancelled' WHERE id=$1 AND salon_id=$2", [req.params.id, req.user.salonId]);
    res.json({ ok: true });
  }));

  // ---------- IMPORTAR PLANILHA ----------
  // body: { services:[...], professionals:[...], customers:[...], dry_run: true|false }
  r.post('/import', wrap(async (req, res) => {
    const { services, professionals, customers, dry_run } = req.body || {};
    const cap = (a) => (Array.isArray(a) ? a.slice(0, 2000) : []);
    res.json(await runImport(req.user.salonId, { services: cap(services), professionals: cap(professionals), customers: cap(customers) }, !!dry_run));
  }));

  // ---------- HORÁRIOS LIVRES (usado pelo agente de IA) ----------
  // GET /availability?date=2026-10-01&service_id=1[&barber_id=2]
  r.get('/availability', wrap(async (req, res) => {
    const { date, service_id, barber_id } = req.query;
    const sv = await q('SELECT duration_min FROM services WHERE id=$1 AND salon_id=$2',
      [service_id, req.user.salonId]);
    if (!sv.rows[0]) return res.status(400).json({ error: 'Serviço inválido' });
    const dur = sv.rows[0].duration_min;
    const tz = (await q('SELECT timezone FROM salons WHERE id=$1', [req.user.salonId])).rows[0].timezone;

    // slots de 15 em 15 min dentro do expediente, fora da pausa, sem conflito e no futuro
    const { rows } = await q(
      `WITH b AS (
         SELECT b.id AS barber_id, b.name, s.start_time, s.end_time, s.break_start, s.break_end
         FROM barbers b JOIN barber_schedules s ON s.barber_id=b.id
         WHERE b.salon_id=$1 AND b.active AND ($4::bigint IS NULL OR b.id=$4)
           AND ${doesSql('b.id', '$6::bigint')}
           AND s.weekday = EXTRACT(DOW FROM $2::date)
       ), slots AS (
         SELECT b.barber_id, b.name, g AS t_start, g + make_interval(mins => $3) AS t_end, b.break_start, b.break_end
         FROM b, generate_series(
           ($2::date + b.start_time)::timestamp,
           ($2::date + b.end_time)::timestamp - make_interval(mins => $3),
           interval '15 minutes') g
       )
       SELECT barber_id, name AS barber_name,
              to_char(t_start,'HH24:MI') AS time,
              (t_start AT TIME ZONE $5) AS starts_at
       FROM slots
       WHERE (break_start IS NULL OR NOT (t_start::time < break_end AND t_end::time > break_start))
         AND (t_start AT TIME ZONE $5) > now()
         AND NOT EXISTS (SELECT 1 FROM appointments a WHERE a.barber_id=slots.barber_id
               AND a.status IN ('scheduled','attended')
               AND tstzrange(a.starts_at,a.ends_at) && tstzrange(t_start AT TIME ZONE $5, t_end AT TIME ZONE $5))
         AND NOT EXISTS (SELECT 1 FROM blocked_slots x WHERE x.barber_id=slots.barber_id
               AND tstzrange(x.starts_at,x.ends_at) && tstzrange(t_start AT TIME ZONE $5, t_end AT TIME ZONE $5))
       ORDER BY t_start, barber_id`,
      [req.user.salonId, date, dur, barber_id || null, tz, service_id]);
    res.json(rows);
  }));

  // ---------- JANELA ESPECÍFICA (usado pelo agente de IA) ----------
  // GET /availability/window?start=2026-10-01T14:00:00-03:00&end=2026-10-01T14:30:00-03:00[&barber_id=2]
  // Diz quem está livre e quem está indisponível (e por quê) para aquele horário exato.
  r.get('/availability/window', wrap(async (req, res) => {
    const { start, end, barber_id, service_id } = req.query;
    const s = new Date(start), e = new Date(end);
    if (!start || !end || isNaN(s) || isNaN(e) || e <= s)
      return res.status(400).json({ error: 'Informe start e end (ISO 8601) com end > start' });
    const tz = (await q('SELECT timezone FROM salons WHERE id=$1', [req.user.salonId])).rows[0].timezone;
    const { rows } = await q(
      `WITH l AS (SELECT $2::timestamptz AS s, $3::timestamptz AS e,
                         ($2::timestamptz AT TIME ZONE $5) AS ls, ($3::timestamptz AT TIME ZONE $5) AS le)
       SELECT b.id AS barber_id, b.name AS barber_name,
         CASE
           WHEN $6::bigint IS NOT NULL AND NOT ${doesSql('b.id', '$6::bigint')} THEN 'não realiza este serviço'
           WHEN l.s <= now() THEN 'horário já passou'
           WHEN l.ls::date <> l.le::date THEN 'fora do expediente'
           WHEN NOT EXISTS (SELECT 1 FROM barber_schedules sc WHERE sc.barber_id=b.id
                 AND sc.weekday = EXTRACT(DOW FROM l.ls)::int
                 AND l.ls::time >= sc.start_time AND l.le::time <= sc.end_time) THEN 'fora do expediente'
           WHEN EXISTS (SELECT 1 FROM barber_schedules sc WHERE sc.barber_id=b.id
                 AND sc.weekday = EXTRACT(DOW FROM l.ls)::int AND sc.break_start IS NOT NULL
                 AND l.ls::time < sc.break_end AND l.le::time > sc.break_start) THEN 'pausa'
           WHEN EXISTS (SELECT 1 FROM appointments a WHERE a.barber_id=b.id
                 AND a.status IN ('scheduled','attended')
                 AND tstzrange(a.starts_at,a.ends_at) && tstzrange(l.s,l.e)) THEN 'ocupado'
           WHEN EXISTS (SELECT 1 FROM blocked_slots x WHERE x.barber_id=b.id
                 AND tstzrange(x.starts_at,x.ends_at) && tstzrange(l.s,l.e)) THEN 'bloqueado'
           ELSE NULL END AS motivo
       FROM barbers b, l
       WHERE b.salon_id=$1 AND b.active AND ($4::bigint IS NULL OR b.id=$4)
       ORDER BY b.name`,
      [req.user.salonId, start, end, barber_id || null, tz, service_id || null]);
    res.json({
      free: rows.filter((x) => !x.motivo).map(({ barber_id: id, barber_name }) => ({ barber_id: id, barber_name })),
      busy: rows.filter((x) => x.motivo).map(({ barber_id: id, barber_name, motivo }) => ({ barber_id: id, barber_name, motivo })),
    });
  }));

  // ---------- DASHBOARD ----------
  r.get('/dashboard', wrap(async (req, res) => {
    const days = Number(req.query.days) || 30;
    const id = req.user.salonId;
    const base = `FROM v_dashboard_base WHERE salon_id=$1 AND status='attended'
                  AND starts_at >= now() - make_interval(days => $2)`;
    const [tot, byDay, byService, byBarber, leads] = await Promise.all([
      q(`SELECT COUNT(*)::int AS atendimentos, COALESCE(SUM(price),0) AS faturamento ${base}`, [id, days]),
      q(`SELECT weekday, COUNT(*)::int AS total ${base} GROUP BY weekday ORDER BY weekday`, [id, days]),
      q(`SELECT service, COUNT(*)::int AS total ${base} GROUP BY service ORDER BY total DESC LIMIT 10`, [id, days]),
      q(`SELECT barber, COUNT(*)::int AS total ${base} GROUP BY barber ORDER BY total DESC`, [id, days]),
      q(`SELECT status, COUNT(*)::int AS total FROM customers WHERE salon_id=$1 GROUP BY status`, [id]),
    ]);
    res.json({
      days, ...tot.rows[0],
      por_dia_semana: byDay.rows, servicos: byService.rows,
      barbeiros: byBarber.rows, clientes: leads.rows,
    });
  }));


  // ---------- Comandos do agente (pausar / retomar / ligar / desligar) ----------
  // O dono manda mensagens pelo próprio WhatsApp; o N8N pergunta aqui o que a frase significa.
  // Três níveis:
  //  1) liga/desliga  — /off e /on, FIXOS (sem cadastro): bloqueio/retomada total da conversa, sem prazo.
  //  2) bloquear/liberar — frases CADASTRÁVEIS (pause = bloquear 24h, resume = liberar): bloqueio/retomada total.
  //  3) pausa suave — regra geral, sem cadastro (qualquer mensagem pausa; termina em ?/... retoma).
  const LIMITS = { pause: 10, resume: 10 };
  const KINDS = Object.keys(LIMITS);
  const normCmd = (t) => String(t ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase()
    .replace(/[,!.?;:]+/g, ' ').replace(/\s+/g, ' ').trim();
  // "/off" e "/on" mantêm a barra (a pontuação acima não a remove)
  async function agentCommandSet(salonId) {
    const [sal, cmds, atts] = await Promise.all([
      q('SELECT agent_name, adm_name FROM salons WHERE id=$1', [salonId]),
      q('SELECT id,kind,phrase,phrase_norm FROM agent_commands WHERE salon_id=$1 ORDER BY id', [salonId]),
      q('SELECT id,name,name_norm FROM agent_attendants WHERE salon_id=$1 ORDER BY id', [salonId]),
    ]);
    const agent = sal.rows[0]?.agent_name || '';
    const adm = sal.rows[0]?.adm_name || '';
    const auto = [{ kind: 'off', phrase: '/off', fixed: true }, { kind: 'on', phrase: '/on', fixed: true }];
    if (adm) auto.push({ kind: 'pause', phrase: `${adm} aqui`, fixed: true });
    for (const a of atts.rows) auto.push({ kind: 'pause', phrase: `${a.name} aqui`, attendant_id: a.id });
    if (agent) {
      auto.push({ kind: 'resume', phrase: `tá contigo ${agent}`, from_agent: true });
      auto.push({ kind: 'resume', phrase: `segue com a ${agent}`, from_agent: true });
    }
    return { agent, adm, custom: cmds.rows, attendants: atts.rows, auto };
  }
  const allPhrases = (set) => [
    ...set.auto.map((x) => ({ kind: x.kind, norm: normCmd(x.phrase) })),
    ...set.custom.map((x) => ({ kind: x.kind, norm: x.phrase_norm })),
  ];
  r.get('/agent-config', wrap(async (req, res) => {
    const set = await agentCommandSet(req.user.salonId);
    res.json({ agent_name: set.agent, adm_name: set.adm, attendants: set.attendants.map(({ id, name }) => ({ id, name })),
      commands: set.custom.map(({ id, kind, phrase }) => ({ id, kind, phrase })),
      automatic: set.auto.map(({ kind, phrase, fixed }) => ({ kind, phrase, fixed: !!fixed })),
      limits: LIMITS });
  }));
  r.put('/agent-config', wrap(async (req, res) => {
    const b = req.body || {};
    for (const [k, label, col] of [['agent_name', 'Nome do agente', 'agent_name'], ['adm_name', 'Nome do proprietário', 'adm_name']]) {
      if (b[k] === undefined) continue;
      const name = String(b[k] ?? '').trim();
      if (name.length > 40) return res.status(400).json({ error: `${label} muito longo` });
      await q(`UPDATE salons SET ${col}=$2 WHERE id=$1`, [req.user.salonId, name || null]);
    }
    res.json({ ok: true });
  }));
  // limite por tipo conta frases próprias (+ atendentes, no caso de "pause")
  async function checkCommand(salonId, kind, norm) {
    if (norm.length < 3) return 'Frase muito curta (mínimo 3 letras)';
    const set = await agentCommandSet(salonId);
    const clash = allPhrases(set).find((x) => x.norm === norm);
    if (clash) return `Essa frase já é usada em "${clash.kind}"`;
    const used = set.custom.filter((c) => c.kind === kind).length + (kind === 'pause' ? set.attendants.length : 0);
    if (used >= LIMITS[kind]) return `Limite de ${LIMITS[kind]} frases para este tipo atingido`;
    return null;
  }
  r.post('/agent-commands', wrap(async (req, res) => {
    const kind = req.body?.kind, phrase = String(req.body?.phrase ?? '').trim();
    if (!KINDS.includes(kind)) return res.status(400).json({ error: 'Tipo inválido' });
    const norm = normCmd(phrase);
    const bad = await checkCommand(req.user.salonId, kind, norm);
    if (bad) return res.status(400).json({ error: bad });
    const { rows } = await q('INSERT INTO agent_commands (salon_id,kind,phrase,phrase_norm) VALUES ($1,$2,$3,$4) RETURNING id,kind,phrase',
      [req.user.salonId, kind, phrase, norm]);
    res.status(201).json(rows[0]);
  }));
  r.delete('/agent-commands/:id', wrap(async (req, res) => {
    await q('DELETE FROM agent_commands WHERE id=$1 AND salon_id=$2', [req.params.id, req.user.salonId]);
    res.json({ ok: true });
  }));
  r.post('/agent-attendants', wrap(async (req, res) => {
    const name = String(req.body?.name ?? '').trim();
    if (name.length > 40) return res.status(400).json({ error: 'Nome muito longo' });
    const bad = await checkCommand(req.user.salonId, 'pause', normCmd(`${name} aqui`));
    if (bad) return res.status(400).json({ error: bad });
    const { rows } = await q('INSERT INTO agent_attendants (salon_id,name,name_norm) VALUES ($1,$2,$3) RETURNING id,name',
      [req.user.salonId, name, normCmd(name)]);
    res.status(201).json(rows[0]);
  }));
  r.delete('/agent-attendants/:id', wrap(async (req, res) => {
    await q('DELETE FROM agent_attendants WHERE id=$1 AND salon_id=$2', [req.params.id, req.user.salonId]);
    res.json({ ok: true });
  }));
  // Body: { text, fallback? }. Resposta: { action: 'off'|'on'|'pause'|'resume'|'none', explicit?, ignore?, rule? }
  // explicit = casou com frase cadastrada (bloqueio/retomada TOTAL); ignore = "/algo" que não é comando; rule 'geral' = pausa/retomada simples (?/...)
  // Casa quando o texto COMEÇA com a frase (palavra inteira); vence a frase mais longa.
  r.post('/agent-commands/classify', wrap(async (req, res) => {
    const text = normCmd(req.body?.text);
    const set = await agentCommandSet(req.user.salonId);
    const send = (o) => res.json({ ...o, agent_name: set.agent || null, adm_name: set.adm || set.attendants[0]?.name || null, attendants: set.attendants.map((a) => a.name) });
    if (!text) return send({ action: 'none' });
    let best = null;
    for (const x of allPhrases(set)) {
      if (!x.norm) continue;
      if ((text === x.norm || text.startsWith(x.norm + ' ')) && (!best || x.norm.length > best.norm.length)) best = x;
    }
    if (best) return send({ action: best.kind, phrase: best.norm, explicit: true });
    // Regra geral das mensagens do dono: terminou em "?" ou "..." = retoma; qualquer outra coisa = pausa.
    // "/algo" não reconhecido é ignorado. Só vale se a rota for chamada para mensagens do dono.
    const raw = String(req.body?.text ?? '').trim();
    if (raw.startsWith('/')) return send({ action: 'none', ignore: true });
    if (req.body?.fallback === false) return send({ action: 'none' });
    send({ action: /(\?|\.\.\.|…)$/.test(raw) ? 'resume' : 'pause', phrase: null, rule: 'geral' });
  }));

  return r;
}
