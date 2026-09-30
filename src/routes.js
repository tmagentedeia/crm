import { Router } from 'express';
import { q } from './db.js';

const digits = (s) => String(s || '').replace(/\D/g, '');
const wrap = (fn) => (req, res) => fn(req, res).catch((e) => {
  if (e.code === '23P01') return res.status(409).json({ error: 'Horário indisponível (conflito de agenda)' });
  if (e.code === '23505') return res.status(409).json({ error: 'Registro duplicado' });
  console.error(e);
  res.status(500).json({ error: 'Erro interno' });
});

// Limite de barbeiros ativos por salão (salons.max_barbers; NULL = sem limite)
async function barberLimitReached(salonId, excludeId = null) {
  const { rows } = await q(
    `SELECT s.max_barbers,
            (SELECT COUNT(*)::int FROM barbers b WHERE b.salon_id = s.id AND b.active AND b.id IS DISTINCT FROM $2) AS ativos
     FROM salons s WHERE s.id = $1`, [salonId, excludeId]);
  const r = rows[0];
  return r && r.max_barbers !== null && r.ativos >= r.max_barbers ? r.max_barbers : null;
}

// Router compartilhado: usado pelo painel (JWT) e pelo N8N (API key). Sempre filtra por req.user.salonId.
export function buildRouter() {
  const r = Router();

  // ---------- SERVIÇOS ----------
  r.get('/services', wrap(async (req, res) => {
    const { rows } = await q('SELECT * FROM services WHERE salon_id=$1 ORDER BY name', [req.user.salonId]);
    res.json(rows);
  }));
  r.post('/services', wrap(async (req, res) => {
    const { name, price = 0, duration_min = 30 } = req.body;
    const { rows } = await q(
      'INSERT INTO services (salon_id,name,price,duration_min) VALUES ($1,$2,$3,$4) RETURNING *',
      [req.user.salonId, name, price, duration_min]);
    res.status(201).json(rows[0]);
  }));
  r.put('/services/:id', wrap(async (req, res) => {
    const { name, price, duration_min, active } = req.body;
    const { rows } = await q(
      `UPDATE services SET name=COALESCE($3,name), price=COALESCE($4,price),
       duration_min=COALESCE($5,duration_min), active=COALESCE($6,active)
       WHERE id=$1 AND salon_id=$2 RETURNING *`,
      [req.params.id, req.user.salonId, name, price, duration_min, active]);
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
          FILTER (WHERE s.id IS NOT NULL), '[]') AS schedules
       FROM barbers b LEFT JOIN barber_schedules s ON s.barber_id=b.id
       WHERE b.salon_id=$1 GROUP BY b.id ORDER BY b.name`, [req.user.salonId]);
    res.json(rows);
  }));
  r.post('/barbers', wrap(async (req, res) => {
    const { name, color = '#3B82F6', phone, schedules = [] } = req.body;
    const limit = await barberLimitReached(req.user.salonId);
    if (limit !== null) return res.status(403).json({ error: `Limite de ${limit} profissionais do seu plano atingido` });
    const { rows } = await q(
      'INSERT INTO barbers (salon_id,name,color,phone) VALUES ($1,$2,$3,$4) RETURNING *',
      [req.user.salonId, name, color, phone]);
    const b = rows[0];
    for (const s of schedules) {
      await q(`INSERT INTO barber_schedules (barber_id,weekday,start_time,end_time,break_start,break_end)
               VALUES ($1,$2,$3,$4,$5,$6)`,
        [b.id, s.weekday, s.start_time, s.end_time, s.break_start || null, s.break_end || null]);
    }
    res.status(201).json(b); // agenda individual = appointments filtrados por barber_id
  }));
  r.put('/barbers/:id', wrap(async (req, res) => {
    const { name, color, phone, active, schedules } = req.body;
    if (active === true) {
      const limit = await barberLimitReached(req.user.salonId, req.params.id);
      if (limit !== null) return res.status(403).json({ error: `Limite de ${limit} profissionais do seu plano atingido` });
    }
    const { rows } = await q(
      `UPDATE barbers SET name=COALESCE($3,name), color=COALESCE($4,color),
       phone=COALESCE($5,phone), active=COALESCE($6,active)
       WHERE id=$1 AND salon_id=$2 RETURNING *`,
      [req.params.id, req.user.salonId, name, color, phone, active]);
    if (!rows[0]) return res.status(404).json({ error: 'Não encontrado' });
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
    const { name, phone, chat_id, source = 'manual', notes } = req.body;
    const { rows } = await q(
      `INSERT INTO customers (salon_id,name,phone,chat_id,source,notes)
       VALUES ($1,$2,$3,$4,$5,$6)
       ON CONFLICT (salon_id,phone) DO UPDATE SET
         name=COALESCE(EXCLUDED.name,customers.name),
         chat_id=COALESCE(EXCLUDED.chat_id,customers.chat_id),
         notes=COALESCE(EXCLUDED.notes,customers.notes)
       RETURNING *`,
      [req.user.salonId, name, digits(phone), chat_id, source, notes]);
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
    const { name, phone, notes } = req.body;
    const { rows } = await q(
      `UPDATE customers SET name=COALESCE($3,name), phone=COALESCE($4,phone), notes=COALESCE($5,notes)
       WHERE id=$1 AND salon_id=$2 RETURNING *`,
      [req.params.id, req.user.salonId, name, phone ? digits(phone) : null, notes]);
    rows[0] ? res.json(rows[0]) : res.status(404).json({ error: 'Não encontrado' });
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
    const { from, to, barber_id } = req.query;
    const { rows } = await q(
      `SELECT a.*, c.name AS customer_name, c.phone AS customer_phone,
              sv.name AS service_name, b.name AS barber_name, b.color AS barber_color
       FROM appointments a
       JOIN customers c ON c.id=a.customer_id
       JOIN services sv ON sv.id=a.service_id
       JOIN barbers b ON b.id=a.barber_id
       WHERE a.salon_id=$1
         AND ($2::timestamptz IS NULL OR a.starts_at >= $2)
         AND ($3::timestamptz IS NULL OR a.starts_at < $3)
         AND ($4::bigint IS NULL OR a.barber_id = $4)
       ORDER BY a.starts_at`,
      [req.user.salonId, from || null, to || null, barber_id || null]);
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
    if (!ok.rows[0].b || !ok.rows[0].c) return res.status(400).json({ error: 'Barbeiro ou cliente inválido' });
    const { rows } = await q(
      `INSERT INTO appointments (salon_id,barber_id,customer_id,service_id,starts_at,ends_at,price,source)
       VALUES ($1,$2,$3,$4,$5::timestamptz,$5::timestamptz + make_interval(mins => $6),$7,$8) RETURNING *`,
      [req.user.salonId, barber_id, customer_id, service_id, starts_at,
       sv.rows[0].duration_min, sv.rows[0].price, source]);
    res.status(201).json(rows[0]);
  }));
  // status: attended | no_show | cancelled | scheduled
  r.patch('/appointments/:id/status', wrap(async (req, res) => {
    const { status } = req.body;
    if (!['scheduled', 'attended', 'no_show', 'cancelled'].includes(status))
      return res.status(400).json({ error: 'Status inválido' });
    const { rows } = await q('UPDATE appointments SET status=$3 WHERE id=$1 AND salon_id=$2 RETURNING *',
      [req.params.id, req.user.salonId, status]);
    rows[0] ? res.json(rows[0]) : res.status(404).json({ error: 'Não encontrado' });
  }));
  r.delete('/appointments/:id', wrap(async (req, res) => {
    await q('DELETE FROM appointments WHERE id=$1 AND salon_id=$2', [req.params.id, req.user.salonId]);
    res.json({ ok: true });
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
      [req.user.salonId, date, dur, barber_id || null, tz]);
    res.json(rows);
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

  return r;
}
