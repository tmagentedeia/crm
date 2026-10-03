import { Router } from 'express';
import { lerCaixas, juntarCaixas, tituloDe, acharCaixa, temSeparador } from './manualCaixas.js';
import { q, qg, tx, currentCompany } from './db.js';
import { runImport } from './importer.js';
import { registerCampaignRoutes } from './campaigns.js';
import { normPhone } from './phone.js';
import { parseBirthday } from './ficha.js';
import { registerOrderRoutes, historicoDoCliente } from './pedidos.js';
import { registerEventRoutes } from './eventos.js';
import { registerFinanceRoutes } from './financeiro.js';

const digits = (s) => String(s || '').replace(/\D/g, '');
const custPhone = normPhone;
// ids vindos do corpo de uma exclusão em massa: inteiros positivos, sem repetir, no máximo 2000
const idsDe = (body) => [...new Set((Array.isArray(body?.ids) ? body.ids : []).map(Number).filter((n) => Number.isInteger(n) && n > 0))].slice(0, 2000);
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
async function apptSnapshot(id) {
  const { rows } = await q(
    `SELECT a.id, $2::bigint AS companyid, a.professional_id, a.status, a.starts_at, a.ends_at, a.price, a.google_event_id,
            b.name AS professional_name, b.google_calendar_id AS calendar_id,
            c.name AS customer_name, c.phone AS customer_phone, sv.name AS service_name
     FROM appointments a
     JOIN professionals b ON b.id=a.professional_id JOIN customers c ON c.id=a.customer_id
     JOIN services sv ON sv.id=a.service_id
     WHERE a.id=$1`, [id, currentCompany()]);
  return rows[0] || null;
}
function notifyN8n(event, snap) {
  const url = process.env.N8N_WEBHOOK_URL;
  if (!url || !snap || (!snap.calendar_id && !snap.google_event_id)) return;
  fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': process.env.N8N_API_KEY || '' },
    body: JSON.stringify({ event, appointment: snap }),
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
// N8N_WAITLIST_WEBHOOK_URL = webhook do workflow de aviso da fila de espera.
async function checkWaitlist(snap) {
  const url = process.env.N8N_WAITLIST_WEBHOOK_URL;
  if (!url || !snap) return;
  const { rows } = await q(
    `UPDATE waitlist w SET status='notified', notified_at=now()
     WHERE w.id = (
       SELECT w2.id FROM waitlist w2
       WHERE w2.status='waiting'
         AND (w2.professional_id IS NULL OR w2.professional_id=$1)
         AND w2.desired_at >= $2 AND w2.desired_at < $3 AND w2.desired_at > now()
       ORDER BY w2.created_at LIMIT 1)
     RETURNING w.id, w.desired_at`, [snap.professional_id, snap.starts_at, snap.ends_at]);
  if (!rows[0]) return;
  const d = await q(
    `SELECT c.name AS customer_name, c.phone AS customer_phone FROM waitlist w
     JOIN customers c ON c.id=w.customer_id WHERE w.id=$1`, [rows[0].id]);
  fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': process.env.N8N_API_KEY || '' },
    body: JSON.stringify({ event: 'slot_opened', entry: {
      id: rows[0].id, companyid: snap.companyid, desired_at: rows[0].desired_at,
      professional_name: snap.professional_name, service_name: snap.service_name, ...d.rows[0] } }),
    signal: AbortSignal.timeout(8000),
  }).then((r) => { if (!r.ok) console.error('Webhook fila respondeu', r.status); })
    .catch((e) => console.error('Falha ao avisar fila:', e.message));
}
const normName = (s) => String(s || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().trim();

// Limite de profissionais ativos por empresa (companies.max_professionals; NULL = sem limite)
async function professionalLimitReached(excludeId = null) {
  const lim = (await qg('SELECT max_professionals FROM companies WHERE id=$1', [currentCompany()])).rows[0]?.max_professionals;
  if (lim === null || lim === undefined) return null;
  const ativos = (await q('SELECT COUNT(*)::int AS n FROM professionals WHERE active AND id IS DISTINCT FROM $1', [excludeId])).rows[0].n;
  return ativos >= lim ? lim : null;
}

// Serviços de cada profissional (tabela professional_services). Sem nenhuma linha = faz todos os serviços.
async function setProfessionalServices(professionalId, ids) {
  await q('DELETE FROM professional_services WHERE professional_id=$1', [professionalId]);
  if (!ids.length) return;
  await q(`INSERT INTO professional_services (professional_id, service_id)
           SELECT $1, id FROM services WHERE id = ANY($2::bigint[])`,
    [professionalId, ids.map(Number)]);
}
// Um profissional faz um serviço se: (a) o serviço é de uma categoria que ele atende
// (serviço sem categoria = qualquer um) e (b) se ele tiver
// serviços específicos marcados, o serviço está entre eles.
const PROFESSIONAL_DOES = `(
  (EXISTS (SELECT 1 FROM services sx JOIN professional_categories bc ON bc.category_id=sx.category_id
              WHERE sx.id=%S% AND bc.professional_id=%B%)
   OR EXISTS (SELECT 1 FROM services sy WHERE sy.id=%S% AND sy.category_id IS NULL))
  AND (NOT EXISTS (SELECT 1 FROM professional_services bs WHERE bs.professional_id=%B%)
       OR EXISTS (SELECT 1 FROM professional_services bs WHERE bs.professional_id=%B% AND bs.service_id=%S%))
)`;
const doesSql = (b, sv) => PROFESSIONAL_DOES.replaceAll('%B%', b).replaceAll('%S%', sv);

async function setProfessionalCategories(professionalId, ids) {
  await q('DELETE FROM professional_categories WHERE professional_id=$1', [professionalId]);
  await q(`INSERT INTO professional_categories (professional_id, category_id)
           SELECT $1, id FROM categories WHERE id = ANY($2::bigint[])`,
    [professionalId, ids.map(Number)]);
}
// exige ao menos uma categoria válida da empresa
async function validCategoryIds(ids) {
  if (!Array.isArray(ids) || !ids.length) return false;
  const { rows } = await q('SELECT count(*)::int AS n FROM categories WHERE id = ANY($1::bigint[])', [ids.map(Number)]);
  return rows[0].n > 0;
}

// Router compartilhado: usado pelo painel (JWT) e pelo N8N (API key). Cada requisição roda no schema da empresa (ver db.js).
export function buildRouter() {
  const r = Router();

  // ---------- ATENDENTE: MANUAL E ATUALIZAÇÕES PROVISÓRIAS ----------
  const MANUAL_MAX = 50000, UPDATE_MAX = 1000, UPDATES_MAX = 10;
  // Momento escolhido pela pessoa, no horário da empresa: "aaaa-mm-ddThh:mm"
  const isMoment = (v) => v === null || v === undefined || v === '' || /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(String(v));
  const mOrNull = (v) => (v ? String(v) : null);
  const tzSql = "(SELECT timezone FROM public.companies WHERE id=$1)";
  const toTs = (n) => `$${n}::text::timestamp AT TIME ZONE ${tzSql}`;
  const fromTs = (col) => `to_char(${col} AT TIME ZONE ${tzSql}, 'YYYY-MM-DD"T"HH24:MI')`;
  const ACTIVE_NOW = "n.active AND (n.starts_at IS NULL OR n.starts_at <= now()) AND (n.ends_at IS NULL OR n.ends_at > now())";

  // O atendente e o assistente (opcional) têm o mesmo tipo de manual e de atualizações provisórias, cada um com suas tabelas.
  const montarManual = (P, MT, UT, ehAssistente) => {
    r.get(`/${P}-manual`, wrap(async (req, res) => {
      const { rows } = await q(
        `SELECT id, content, created_at, published_at FROM ${MT} ORDER BY COALESCE(published_at, created_at) DESC, id DESC`);
      const draft = rows.find((v) => !v.published_at) || null;
      const published = rows.filter((v) => v.published_at);
      res.json({
        draft: draft ? { content: draft.content, updated_at: draft.created_at } : null,
        current: published[0] || null,
        versions: published.map((v) => ({ id: v.id, published_at: v.published_at, content: v.content })),
      });
    }));
    // Salva o rascunho (não muda o que o atendente usa até publicar)
    r.put(`/${P}-manual`, wrap(async (req, res) => {
      const content = String(req.body.content ?? '');
      if (content.length > MANUAL_MAX) return res.status(400).json({ error: `O manual passou do limite de ${MANUAL_MAX} caracteres` });
      await q(
        `INSERT INTO ${MT} (content) VALUES ($1)
         ON CONFLICT ((published_at IS NULL)) WHERE published_at IS NULL DO UPDATE SET content=EXCLUDED.content, created_at=now()`, [content]);
      res.json({ ok: true });
    }));
    // Publica o rascunho: passa a valer para o atendente
    r.post(`/${P}-manual/publish`, wrap(async (req, res) => {
      const { rows } = await q(
        `UPDATE ${MT} SET published_at=now() WHERE published_at IS NULL AND btrim(content) <> '' RETURNING id`);
      rows[0] ? res.json({ ok: true }) : res.status(400).json({ error: 'Escreva o manual antes de publicar' });
    }));
    // Volta uma versão antiga: ela vira o rascunho (e você publica quando quiser)
    r.post(`/${P}-manual/restore/:id`, wrap(async (req, res) => {
      const v = (await q(`SELECT content FROM ${MT} WHERE id=$1 AND published_at IS NOT NULL`, [req.params.id])).rows[0];
      if (!v) return res.status(404).json({ error: 'Versão não encontrada' });
      await q(
        `INSERT INTO ${MT} (content) VALUES ($1)
         ON CONFLICT ((published_at IS NULL)) WHERE published_at IS NULL DO UPDATE SET content=EXCLUDED.content, created_at=now()`, [v.content]);
      res.json({ ok: true });
    }));

    // Leitura e troca de UMA caixa do manual publicado (usado pela Maria a pedido do ADM). Só vale para o atendente.
    if (!ehAssistente) {
      const publicado = async () => (await q(`SELECT id, content FROM ${MT} WHERE published_at IS NOT NULL ORDER BY published_at DESC, id DESC LIMIT 1`)).rows[0];
      r.get(`/${P}-manual/caixas`, wrap(async (req, res) => {
        const man = await publicado();
        if (!man) return res.json({ total: 0, caixas: [] });
        const caixas = lerCaixas(man.content);
        res.json({ total: caixas.length, caixas: caixas.map((c, i) => ({ n: i + 1, titulo: tituloDe(c) || '(vazia)' })) });
      }));
      r.get(`/${P}-manual/caixa`, wrap(async (req, res) => {
        const man = await publicado();
        if (!man) return res.status(404).json({ error: 'Ainda não há manual publicado' });
        const caixas = lerCaixas(man.content);
        const a = acharCaixa(caixas, { n: req.query.n, titulo: req.query.titulo });
        if (a.erro) return res.status(a.status).json({ error: a.erro });
        res.json({ n: a.i + 1, titulo: tituloDe(caixas[a.i]), texto: caixas[a.i] });
      }));
      // Troca o texto de uma caixa e publica uma versão nova (a anterior fica no histórico). As outras caixas não mudam.
      r.put(`/${P}-manual/caixa`, wrap(async (req, res) => {
        const texto = String(req.body.texto ?? '').replace(/\r\n/g, '\n');
        if (!texto.trim()) return res.status(400).json({ error: 'Escreva o texto da caixa' });
        if (temSeparador(texto)) return res.status(400).json({ error: 'O texto de uma caixa não pode ter a linha de separação (=====)' });
        const man = await publicado();
        if (!man) return res.status(404).json({ error: 'Ainda não há manual publicado' });
        const rasc = (await q(`SELECT 1 FROM ${MT} WHERE published_at IS NULL`)).rows[0];
        if (rasc) return res.status(409).json({ error: 'Há um rascunho não publicado no painel. Publique ou descarte o rascunho antes de alterar por aqui.' });
        const caixas = lerCaixas(man.content);
        const a = acharCaixa(caixas, { n: req.body.n, titulo: req.body.titulo });
        if (a.erro) return res.status(a.status).json({ error: a.erro });
        const antes = caixas[a.i];
        caixas[a.i] = texto;
        const novo = juntarCaixas(caixas);
        if (novo.length > MANUAL_MAX) return res.status(400).json({ error: `O manual passaria do limite de ${MANUAL_MAX} caracteres` });
        const ins = await q(`INSERT INTO ${MT} (content, published_at) VALUES ($1, now()) RETURNING id`, [novo]);
        res.json({ ok: true, n: a.i + 1, antes, depois: texto, versao: ins.rows[0].id });
      }));
    }

    r.get(`/${P}-updates`, wrap(async (req, res) => {
      const { rows } = await q(
        `SELECT n.id, n.text, ${fromTs('n.starts_at')} AS starts_at, ${fromTs('n.ends_at')} AS ends_at, n.active,
                CASE WHEN NOT n.active OR (n.ends_at IS NOT NULL AND n.ends_at <= now()) THEN 'ended'
                     WHEN n.starts_at IS NOT NULL AND n.starts_at > now() THEN 'upcoming'
                     ELSE 'active' END AS state
         FROM ${UT} n ORDER BY n.created_at DESC, n.id DESC`, [req.user.companyId]);
      res.json({ max: UPDATES_MAX, updates: rows });
    }));
    const updateBody = (b) => {
      const text = String(b.text ?? '').trim();
      if (!text) return { error: 'Escreva a atualização' };
      if (text.length > UPDATE_MAX) return { error: `Texto muito longo (máximo ${UPDATE_MAX} caracteres). Atualizações provisórias devem ser curtas.` };
      if (!isMoment(b.starts_at) || !isMoment(b.ends_at)) return { error: 'Data ou hora inválida' };
      const starts_at = mOrNull(b.starts_at), ends_at = mOrNull(b.ends_at);
      if (starts_at && ends_at && ends_at <= starts_at) return { error: 'O fim precisa ser depois do início' };
      return { text, starts_at, ends_at };
    };
    const openCount = async (companyId, exceptId = 0) =>
      Number((await q(
        `SELECT count(*) AS n FROM ${UT} n WHERE n.id <> $1 AND n.active AND (n.ends_at IS NULL OR n.ends_at > now())`,
        [exceptId])).rows[0].n);
    r.post(`/${P}-updates`, wrap(async (req, res) => {
      const b = updateBody(req.body);
      if (b.error) return res.status(400).json({ error: b.error });
      if ((await openCount(req.user.companyId)) >= UPDATES_MAX)
        return res.status(400).json({ error: `Já são ${UPDATES_MAX} atualizações em vigor. Encerre alguma antes de criar outra.` });
      const { rows } = await q(
        `INSERT INTO ${UT} (text, starts_at, ends_at) VALUES ($2, CASE WHEN $3::text IS NULL THEN NULL ELSE ${toTs(3)} END, CASE WHEN $4::text IS NULL THEN NULL ELSE ${toTs(4)} END) RETURNING id`,
        [req.user.companyId, b.text, b.starts_at, b.ends_at]);
      res.status(201).json(rows[0]);
    }));
    // Editar, encerrar ({active:false}) ou reativar ({active:true, ends_at: novo momento ou vazio})
    r.put(`/${P}-updates/:id`, wrap(async (req, res) => {
      const cur = (await q(`SELECT n.*, ${fromTs('n.starts_at')} AS s_local, ${fromTs('n.ends_at')} AS e_local FROM ${UT} n WHERE n.id=$2`, [req.user.companyId, req.params.id])).rows[0];
      if (!cur) return res.status(404).json({ error: 'Atualização não encontrada' });
      const b = updateBody({ text: req.body.text ?? cur.text,
        starts_at: 'starts_at' in req.body ? req.body.starts_at : cur.s_local,
        ends_at: 'ends_at' in req.body ? req.body.ends_at : cur.e_local });
      if (b.error) return res.status(400).json({ error: b.error });
      const active = 'active' in req.body ? !!req.body.active : cur.active;
      if (active && !cur.active && (await openCount(req.user.companyId, cur.id)) >= UPDATES_MAX)
        return res.status(400).json({ error: `Já são ${UPDATES_MAX} atualizações em vigor. Encerre alguma antes de reativar esta.` });
      await q(
        `UPDATE ${UT} SET text=$3, starts_at=CASE WHEN $4::text IS NULL THEN NULL ELSE ${toTs(4)} END,
           ends_at=CASE WHEN $5::text IS NULL THEN NULL ELSE ${toTs(5)} END, active=$6 WHERE id=$2`,
        [req.user.companyId, cur.id, b.text, b.starts_at, b.ends_at, active]);
      res.json({ ok: true });
    }));
    r.delete(`/${P}-updates/:id`, wrap(async (req, res) => {
      await q(`DELETE FROM ${UT} WHERE id=$1`, [req.params.id]);
      res.json({ ok: true });
    }));

    // Texto pronto para o atendente: manual publicado + avisos em vigor hoje. O N8N chama isto antes do agente de IA.
    r.get(`/${P}/prompt`, wrap(async (req, res) => {
      // o assistente é opcional: com o interruptor desligado a empresa não tem assistente e nada é entregue
      if (ehAssistente) {
        const lig = (await qg('SELECT modules FROM companies WHERE id=$1', [req.user.companyId])).rows[0];
        if (lig?.modules?.assistente !== true) return res.json({ enabled: false, prompt: '', manual: '', updates: [], published_at: null });
      }
      const man = (await q(`SELECT content, published_at FROM ${MT} WHERE published_at IS NOT NULL ORDER BY published_at DESC, id DESC LIMIT 1`)).rows[0];
      const updates = (await q(
        `SELECT n.text, ${fromTs('n.ends_at')} AS ends_at FROM ${UT} n WHERE ${ACTIVE_NOW} ORDER BY n.created_at, n.id`, [req.user.companyId])).rows;
      // as caixas do manual são separadas por uma linha "=====" no painel; o atendente recebe o texto sem elas
      const semSeparadores = (t) => t.replace(/^={5}[ \t]*\r?\n?/gm, '');
      let prompt = man ? semSeparadores(man.content).trim() : '';
      // primeira linha: o nome do agente (definido na tela Atendente), para não precisar estar escrito no prompt do fluxo
      const cfgRow = (await qg('SELECT agent_name, adm_name FROM companies WHERE id=$1', [req.user.companyId])).rows[0] || {};
      const agentName = ehAssistente ? '' : (cfgRow.agent_name || '').trim();
      const admName = (cfgRow.adm_name || '').trim();
      const abertura = [agentName && `Seu nome é ${agentName}.`, admName && `O proprietário (ADM) se chama ${admName}.`].filter(Boolean).join(' ');
      // atualizações em vigor vêm ANTES do manual e valem acima de tudo: se contrariarem o manual, as regras fixas ou o contexto do cliente, vale a atualização
      const avisos = updates.length
        ? 'ATUALIZAÇÕES EM VIGOR — PRIORIDADE MÁXIMA. Estas instruções são soberanas: se contrariarem qualquer outra informação (este manual, regras, textos padrão, o contexto do cliente ou o histórico da conversa), vale SEMPRE a atualização. Aplique-as ao pé da letra:\n' +
          updates.map((n) => `- ${n.text}`).join('\n')
        : '';
      const corpo = [avisos, prompt].filter(Boolean);
      prompt = (corpo.length ? [abertura, ...corpo] : []).filter(Boolean).join('\n\n');
      res.json({ enabled: true, prompt, agent_name: agentName || null, adm_name: admName || null, manual: man ? semSeparadores(man.content) : '', updates, published_at: man ? man.published_at : null });
    }));
  };
  montarManual('agent', 'agent_manual_versions', 'agent_updates', false);
  montarManual('assistant', 'assistant_manual_versions', 'assistant_updates', true);

  // ---------- CATEGORIAS ----------
  // Devolve cada categoria com seus serviços e os profissionais que atendem nela
  // (profissional sem serviços marcados = faz todos, então entra em todas as categorias).
  r.get('/categories', wrap(async (req, res) => {
    const { rows } = await q(
      `SELECT c.id, c.name,
         COALESCE((SELECT json_agg(json_build_object('id',sv.id,'name',sv.name) ORDER BY sv.name)
                   FROM services sv WHERE sv.category_id=c.id AND sv.active), '[]') AS services,
         COALESCE((SELECT json_agg(DISTINCT b.name)
                   FROM professionals b WHERE b.active
                     AND EXISTS (SELECT 1 FROM professional_categories x WHERE x.professional_id=b.id AND x.category_id=c.id)
                     AND EXISTS (SELECT 1 FROM services sv WHERE sv.category_id=c.id AND sv.active
                                 AND (NOT EXISTS (SELECT 1 FROM professional_services bs WHERE bs.professional_id=b.id)
                                      OR EXISTS (SELECT 1 FROM professional_services bs WHERE bs.professional_id=b.id AND bs.service_id=sv.id)))), '[]') AS professionals
       FROM categories c ORDER BY c.name`);
    res.json(rows);
  }));
  r.post('/categories', wrap(async (req, res) => {
    const name = String(req.body.name || '').trim();
    if (!name) return res.status(400).json({ error: 'Informe o nome da categoria' });
    const { rows } = await q('INSERT INTO categories (name) VALUES ($1) RETURNING *', [name]);
    res.status(201).json(rows[0]);
  }));
  r.put('/categories/:id', wrap(async (req, res) => {
    const name = String(req.body.name || '').trim();
    if (!name) return res.status(400).json({ error: 'Informe o nome da categoria' });
    const { rows } = await q('UPDATE categories SET name=$2 WHERE id=$1 RETURNING *',
      [req.params.id, name]);
    rows[0] ? res.json(rows[0]) : res.status(404).json({ error: 'Não encontrado' });
  }));
  r.delete('/categories/:id', wrap(async (req, res) => {
    // os serviços da categoria ficam sem categoria (não são apagados)
    await q('DELETE FROM categories WHERE id=$1', [req.params.id]);
    res.json({ ok: true });
  }));

  // ---------- SERVIÇOS ----------
  const validCat = async (id) =>
    !id || (await q('SELECT 1 FROM categories WHERE id=$1', [id])).rows[0];
  r.get('/services', wrap(async (req, res) => {
    const { rows } = await q(
      `SELECT s.*, c.name AS category FROM services s LEFT JOIN categories c ON c.id=s.category_id
       ORDER BY c.name NULLS LAST, s.name`);
    res.json(rows);
  }));
  r.post('/services', wrap(async (req, res) => {
    const { name, price = 0, duration_min = 30, category_id } = req.body;
    if (!(await validCat(category_id))) return res.status(400).json({ error: 'Categoria inválida' });
    const { rows } = await q(
      'INSERT INTO services (name,price,duration_min,category_id) VALUES ($1,$2,$3,$4) RETURNING *',
      [name, price, duration_min, category_id || null]);
    res.status(201).json(rows[0]);
  }));
  r.put('/services/:id', wrap(async (req, res) => {
    const { name, price, duration_min, active, category_id } = req.body;
    if (!(await validCat(category_id))) return res.status(400).json({ error: 'Categoria inválida' });
    // category_id: undefined = não mexe; null/'' = remove
    const { rows } = await q(
      `UPDATE services SET name=COALESCE($2,name), price=COALESCE($3,price),
       duration_min=COALESCE($4,duration_min), active=COALESCE($5,active),
       category_id = CASE WHEN $6::boolean THEN $7::bigint ELSE category_id END
       WHERE id=$1 RETURNING *`,
      [req.params.id, name, price, duration_min, active,
       category_id !== undefined, category_id || null]);
    rows[0] ? res.json(rows[0]) : res.status(404).json({ error: 'Não encontrado' });
  }));
  r.delete('/services/:id', wrap(async (req, res) => {
    // desativa em vez de apagar, para preservar o histórico de agendamentos
    await q('UPDATE services SET active=false WHERE id=$1', [req.params.id]);
    res.json({ ok: true });
  }));

  // Exclusão de verdade: só se não houver agendamentos no histórico (senão continua só desativado)
  const semHistorico = 'Isso tem agendamentos no histórico, então só pode ficar desativado.';
  // ?com_historico=1 apaga junto os agendamentos ligados (ação definitiva, a tela pede confirmação forte)
  const excluirDeVez = (tabela, campo) => wrap(async (req, res) => {
    const comHist = req.query.com_historico === '1';
    try {
      const n = await tx(currentCompany(), async (t) => {
        let ag = 0;
        if (comHist) ag = (await t(`DELETE FROM appointments WHERE ${campo}=$1`, [req.params.id])).rowCount;
        const d = await t(`DELETE FROM ${tabela} WHERE id=$1`, [req.params.id]);
        return d.rowCount ? ag : null;
      });
      n === null ? res.status(404).json({ error: 'Não encontrado' }) : res.json({ ok: true, agendamentos_apagados: n });
    } catch (e) {
      if (e.code === '23503') return res.status(409).json({ error: semHistorico, tem_historico: true });
      throw e;
    }
  });
  r.delete('/services/:id/permanent', excluirDeVez('services', 'service_id'));
  // Exclusão em massa. dry_run:true só conta o que seria afetado. Serviço com agendamentos no histórico só é apagado com com_historico:true.
  r.post('/services/bulk-delete', wrap(async (req, res) => {
    const ids = idsDe(req.body);
    if (!ids.length) return res.status(400).json({ error: 'Nenhum item selecionado' });
    const out = await tx(currentCompany(), async (t) => {
      const rows = (await t(`SELECT s.id, s.name, (SELECT count(*)::int FROM appointments a WHERE a.service_id=s.id) AS ag FROM services s WHERE s.id = ANY($1::bigint[])`, [ids])).rows;
      const comAg = rows.filter((x) => x.ag > 0);
      if (req.body.dry_run === true) return { found: rows.length, com_historico: comAg.length, agendamentos: comAg.reduce((n, x) => n + x.ag, 0) };
      let deleted = 0, agendamentos = 0; const skipped = [];
      for (const x of rows) {
        if (x.ag > 0 && req.body.com_historico !== true) { skipped.push({ id: x.id, name: x.name, motivo: 'tem agendamentos no histórico' }); continue; }
        await t('SAVEPOINT bd');
        try {
          if (x.ag > 0) agendamentos += (await t('DELETE FROM appointments WHERE service_id=$1', [x.id])).rowCount;
          await t('DELETE FROM services WHERE id=$1', [x.id]);
          await t('RELEASE SAVEPOINT bd'); deleted++;
        } catch (e) {
          await t('ROLLBACK TO SAVEPOINT bd'); if (e.code !== '23503') throw e;
          skipped.push({ id: x.id, name: x.name, motivo: 'está em uso' });
        }
      }
      return { deleted, agendamentos_apagados: agendamentos, skipped };
    });
    res.json(out);
  }));

  // ---------- BARBEIROS ----------
  r.get('/professionals', wrap(async (req, res) => {
    const { rows } = await q(
      `SELECT b.*, COALESCE(json_agg(json_build_object(
          'weekday',s.weekday,'start_time',s.start_time,'end_time',s.end_time,
          'break_start',s.break_start,'break_end',s.break_end) ORDER BY s.weekday)
          FILTER (WHERE s.id IS NOT NULL), '[]') AS schedules,
          COALESCE((SELECT json_agg(bs.service_id ORDER BY bs.service_id) FROM professional_services bs WHERE bs.professional_id=b.id), '[]') AS service_ids,
          COALESCE((SELECT json_agg(bc.category_id ORDER BY bc.category_id) FROM professional_categories bc WHERE bc.professional_id=b.id), '[]') AS category_ids,
          COALESCE((SELECT json_agg(sv.id ORDER BY sv.id) FROM services sv
                    WHERE sv.active AND ${doesSql('b.id', 'sv.id')}), '[]') AS does_service_ids
       FROM professionals b LEFT JOIN professional_schedules s ON s.professional_id=b.id
       GROUP BY b.id ORDER BY b.name`);
    res.json(rows);
  }));
  r.post('/professionals', wrap(async (req, res) => {
    const { name, color = '#3B82F6', phone, google_calendar_id, schedules = [], service_ids, category_ids } = req.body;
    if (!(await validCategoryIds(category_ids)))
      return res.status(400).json({ error: 'Escolha pelo menos uma categoria para o profissional' });
    const limit = await professionalLimitReached();
    if (limit !== null) return res.status(403).json({ error: `Limite de ${limit} profissionais do seu plano atingido` });
    const { rows } = await q(
      'INSERT INTO professionals (name,color,phone,google_calendar_id) VALUES ($1,$2,$3,$4) RETURNING *',
      [name, color, phone, normCalendarId(google_calendar_id) || null]);
    const b = rows[0];
    for (const s of schedules) {
      await q(`INSERT INTO professional_schedules (professional_id,weekday,start_time,end_time,break_start,break_end)
               VALUES ($1,$2,$3,$4,$5,$6)`,
        [b.id, s.weekday, s.start_time, s.end_time, s.break_start || null, s.break_end || null]);
    }
    await setProfessionalCategories(b.id, category_ids);
    if (Array.isArray(service_ids)) await setProfessionalServices(b.id, service_ids);
    res.status(201).json(b); // agenda individual = appointments filtrados por professional_id
  }));
  r.delete('/professionals/:id/permanent', excluirDeVez('professionals', 'professional_id'));
  r.put('/professionals/:id', wrap(async (req, res) => {
    const { name, color, phone, active, schedules, google_calendar_id, service_ids, category_ids } = req.body;
    if (category_ids !== undefined && !(await validCategoryIds(category_ids)))
      return res.status(400).json({ error: 'Escolha pelo menos uma categoria para o profissional' });
    if (active === true) {
      const limit = await professionalLimitReached(req.params.id);
      if (limit !== null) return res.status(403).json({ error: `Limite de ${limit} profissionais do seu plano atingido` });
    }
    // google_calendar_id: undefined = não mexe; string vazia = remove
    const { rows } = await q(
      `UPDATE professionals SET name=COALESCE($2,name), color=COALESCE($3,color),
       phone=COALESCE($4,phone), active=COALESCE($5,active),
       google_calendar_id = CASE WHEN $6::boolean THEN NULLIF(trim($7),'') ELSE google_calendar_id END
       WHERE id=$1 RETURNING *`,
      [req.params.id, name, color, phone, active,
       google_calendar_id !== undefined, normCalendarId(google_calendar_id)]);
    if (!rows[0]) return res.status(404).json({ error: 'Não encontrado' });
    // category_ids: undefined = não mexe (se vier, precisa ter ao menos uma)
    if (Array.isArray(category_ids)) await setProfessionalCategories(req.params.id, category_ids);
    // service_ids: undefined = não mexe; [] = faz todos os serviços das categorias
    if (Array.isArray(service_ids)) await setProfessionalServices(req.params.id, service_ids);
    if (Array.isArray(schedules)) {
      await q('DELETE FROM professional_schedules WHERE professional_id=$1', [req.params.id]);
      for (const s of schedules) {
        await q(`INSERT INTO professional_schedules (professional_id,weekday,start_time,end_time,break_start,break_end)
                 VALUES ($1,$2,$3,$4,$5,$6)`,
          [req.params.id, s.weekday, s.start_time, s.end_time, s.break_start || null, s.break_end || null]);
      }
    }
    res.json(rows[0]);
  }));

  // ---------- CLIENTES / LEADS ----------
  // Cliente com o nível do Clube já resolvido (nome e benefícios por mês)
  const CUST = `SELECT c.*, l.name AS club_level_name, l.benefit_qty AS club_benefit_qty,
                  EXISTS (SELECT 1 FROM campaign_exclusions x WHERE x.phone=c.phone) AS campaign_excluded,
                  CASE WHEN c.birth_year IS NOT NULL AND c.birth_month IS NOT NULL THEN
                    EXTRACT(year FROM now())::int - c.birth_year
                    - CASE WHEN (c.birth_month, c.birth_day) > (EXTRACT(month FROM now())::int, EXTRACT(day FROM now())::int) THEN 1 ELSE 0 END
                  END AS age
                FROM customers c LEFT JOIN loyalty_levels l ON l.id=c.club_level_id`;
  // filtros da listagem: tipo, busca, situação no Clube ('member','former','supporter','none') e nível
  const FILTRO = `($1::text IS NULL OR c.status=$1)
       AND ($2::text IS NULL OR c.name ILIKE '%'||$2||'%' OR c.phone LIKE '%'||$2||'%')
       AND ($3::text IS NULL OR ($3='none' AND c.club_status IS NULL) OR c.club_status=$3)
       AND ($4::bigint IS NULL OR c.club_level_id=$4)`;
  const filtroArgs = (qs) => [qs.status || null, qs.search || null, qs.club || null,
    /^\d+$/.test(String(qs.level || '')) ? qs.level : null];

  // Campos da ficha (aniversário, cidade, Clube). Devolve { erro } ou { campos } só com o que veio no corpo.
  async function lerFicha(body, atual = null) {
    const campos = {};
    if (body.birthday !== undefined) {
      const b = parseBirthday(body.birthday);
      if (!b) return { erro: 'Data de nascimento inválida (use dia/mês/ano, ex.: 25/09/1990; o ano é opcional)' };
      Object.assign(campos, b);
    }
    for (const [k, rot, max] of [['last_name', 'Sobrenome', 80], ['state', 'Estado', 2]]) {
      if (body[k] === undefined) continue;
      let t = String(body[k] ?? '').trim();
      if (k === 'state') { t = t.toUpperCase(); if (t && !/^[A-Z]{2}$/.test(t)) return { erro: 'Estado inválido (use a sigla, ex.: MG)' }; }
      if (t.length > max || /[\u0000-\u001f<>]/.test(t)) return { erro: rot + ' inválido' };
      campos[k] = t || null;
    }
    if (body.gender !== undefined) {
      const g = body.gender || null;
      if (g !== null && !['female', 'male', 'other'].includes(g)) return { erro: 'Gênero inválido' };
      campos.gender = g;
    }
    if (body.city !== undefined) {
      const c = String(body.city ?? '').trim();
      if (c.length > 80) return { erro: 'Cidade muito longa' };
      campos.city = c || null;
    }
    if (body.club_status !== undefined) {
      const st = body.club_status || null;
      if (st !== null && !['member', 'former', 'supporter'].includes(st)) return { erro: 'Situação no programa inválida' };
      campos.club_status = st;
    }
    const final = campos.club_status !== undefined ? campos.club_status : (atual?.club_status ?? null);
    if (body.club_level_id !== undefined && body.club_level_id !== null && body.club_level_id !== '') {
      if (final !== 'member') return { erro: 'O nível só vale para quem é membro' };
      const l = await q('SELECT id FROM loyalty_levels WHERE id=$1', [body.club_level_id]);
      if (!l.rows[0]) return { erro: 'Nível não encontrado' };
      campos.club_level_id = l.rows[0].id;
    } else if (body.club_level_id !== undefined || (final !== 'member' && campos.club_status !== undefined)) {
      campos.club_level_id = null; // limpou o nível, ou deixou de ser membro
    }
    return { campos };
  }
  async function gravarFicha(id, campos) {
    const cols = Object.keys(campos);
    if (!cols.length) return;
    await q(`UPDATE customers SET ${cols.map((c, i) => `${c}=$${i + 2}`).join(', ')}, updated_at=now() WHERE id=$1`, [id, ...cols.map((c) => campos[c])]);
  }

  // Cadastro de assinante pela agente: cria o cliente se precisar, marca como membro e põe o nível (número ou nome do nível).
  r.post('/club/member', wrap(async (req, res) => {
    const b = req.body || {};
    const phone = custPhone(b.phone);
    if (digits(phone).length < 10) return res.status(400).json({ error: 'Telefone inválido (use DDD + número)' });
    const nome = String(b.name ?? '').trim();
    if (nome.length > 80 || /[\u0000-\u001f<>]/.test(nome)) return res.status(400).json({ error: 'Nome inválido' });
    const f = await lerFicha({ ...(b.last_name !== undefined ? { last_name: b.last_name } : {}), ...(b.birthday ? { birthday: b.birthday } : {}) });
    if (f.erro) return res.status(400).json({ error: f.erro });
    const niveis = (await q('SELECT id, name FROM loyalty_levels ORDER BY position, id')).rows;
    const pedido = String(b.level ?? '').trim().toLowerCase();
    const num = pedido.match(/\d+/)?.[0];
    const nivel = niveis.find((l) => l.name.trim().toLowerCase() === pedido)
      || (num ? niveis.find((l) => l.name.match(/\d+/)?.[0] === num) : null);
    if (!nivel) return res.status(400).json({ error: 'Nível não encontrado', levels: niveis.map((l) => l.name) });
    const { rows } = await q(
      `INSERT INTO customers (name,phone,source,status) VALUES (NULLIF($1,''),$2,'ia','client')
       ON CONFLICT (phone) DO UPDATE SET name=COALESCE(customers.name, EXCLUDED.name) RETURNING id`, [nome, phone]);
    await gravarFicha(rows[0].id, { ...f.campos, club_status: 'member', club_level_id: nivel.id });
    res.status(201).json((await q(`${CUST} WHERE c.id=$1`, [rows[0].id])).rows[0]);
  }));

  r.get('/customers', wrap(async (req, res) => {
    // ordem escolhida na tela: nome ou cidade (A-Z / Z-A); sem escolha, os mais recentes primeiro.
    // Quem não tem o campo preenchido vai sempre para o fim da lista.
    const dir = req.query.dir === 'desc' ? 'DESC' : 'ASC';
    const ORDEM = {
      name: `lower(NULLIF(btrim(c.name),'')) ${dir} NULLS LAST, lower(c.last_name) ${dir} NULLS LAST, c.created_at DESC`,
      city: `lower(NULLIF(btrim(c.city),'')) ${dir} NULLS LAST, lower(c.name) ASC NULLS LAST, c.created_at DESC`,
    };
    const ordem = ORDEM[req.query.sort] || 'c.created_at DESC';
    const { rows } = await q(`${CUST} WHERE ${FILTRO} ORDER BY ${ordem} LIMIT 500`, filtroArgs(req.query));
    res.json(rows);
  }));
  // Todos os clientes e leads (sem o limite da listagem), para baixar ou copiar para uma planilha. Mesmos filtros da listagem.
  r.get('/customers/export', wrap(async (req, res) => {
    const { rows } = await q(
      `SELECT c.name, c.phone, c.status, c.source, c.notes, c.last_visit_at, c.created_at,
              c.last_name, c.city, c.state, c.gender, c.birth_day, c.birth_month, c.birth_year, c.updated_at, c.club_status, l.name AS club_level_name
       FROM customers c LEFT JOIN loyalty_levels l ON l.id=c.club_level_id
       WHERE ${FILTRO} ORDER BY c.created_at DESC`, filtroArgs(req.query));
    res.json(rows);
  }));
  // Upsert por telefone: o agente de IA chama isso quando um lead novo conversa
  r.post('/customers', wrap(async (req, res) => {
    const { name, phone, chat_id, source = 'manual', notes, status } = req.body;
    if (status !== undefined && !['lead', 'client'].includes(status)) return res.status(400).json({ error: 'Tipo inválido' });
    const f = await lerFicha(req.body);
    if (f.erro) return res.status(400).json({ error: f.erro });
    const { rows } = await q(
      `INSERT INTO customers (name,phone,chat_id,source,notes,status)
       VALUES ($1,$2,$3,$4,$5,COALESCE($6,'lead'))
       ON CONFLICT (phone) DO UPDATE SET
         name=COALESCE(EXCLUDED.name,customers.name),
         chat_id=COALESCE(EXCLUDED.chat_id,customers.chat_id),
         notes=COALESCE(EXCLUDED.notes,customers.notes)
       RETURNING id`,
      [name, custPhone(phone), chat_id, source, notes, status ?? null]);
    await gravarFicha(rows[0].id, f.campos);
    res.status(201).json((await q(`${CUST} WHERE c.id=$1`, [rows[0].id])).rows[0]);
  }));
  r.get('/customers/by-phone/:phone', wrap(async (req, res) => {
    const { rows } = await q(`${CUST} WHERE c.phone=$1`, [digits(req.params.phone)]);
    rows[0] ? res.json(rows[0]) : res.status(404).json({ error: 'Não encontrado' });
  }));
  r.get('/customers/:id', wrap(async (req, res) => {
    const c = await q(`${CUST} WHERE c.id=$1`, [req.params.id]);
    if (!c.rows[0]) return res.status(404).json({ error: 'Não encontrado' });
    const h = await q(
      'SELECT * FROM v_customer_history WHERE customer_id=$1 ORDER BY starts_at DESC',
      [req.params.id]);
    res.json({ ...c.rows[0], history: h.rows, ...(await historicoDoCliente(req.params.id)) });
  }));
  r.put('/customers/:id', wrap(async (req, res) => {
    const { name, phone, notes, status } = req.body;
    if (status !== undefined && !['lead', 'client'].includes(status)) return res.status(400).json({ error: 'Tipo inválido' });
    if (phone !== undefined && digits(phone).length < 10) return res.status(400).json({ error: 'Telefone inválido (use DDD + número)' });
    const atual = (await q('SELECT club_status FROM customers WHERE id=$1', [req.params.id])).rows[0];
    if (!atual) return res.status(404).json({ error: 'Não encontrado' });
    const f = await lerFicha(req.body, atual);
    if (f.erro) return res.status(400).json({ error: f.erro });
    const { rows } = await q(
      `UPDATE customers SET name=COALESCE($2,name), phone=COALESCE($3,phone), notes=COALESCE($4,notes),
       status=COALESCE($5,status), updated_at=now()
       WHERE id=$1 RETURNING id`,
      [req.params.id, name, phone ? custPhone(phone) : null, notes, status ?? null]);
    await gravarFicha(rows[0].id, f.campos);
    res.json((await q(`${CUST} WHERE c.id=$1`, [rows[0].id])).rows[0]);
  }));

  // Exclusão em massa de clientes/leads, com agendamentos, fila de espera e pedidos deles. dry_run:true só conta.
  r.post('/customers/bulk-delete', wrap(async (req, res) => {
    const ids = idsDe(req.body);
    if (!ids.length) return res.status(400).json({ error: 'Nenhum item selecionado' });
    const ags = (await q('SELECT id FROM appointments WHERE customer_id = ANY($1::bigint[])', [ids])).rows;
    if (req.body.dry_run === true) {
      const orders = (await q('SELECT count(*)::int AS n FROM song_orders WHERE customer_id = ANY($1::bigint[])', [ids])).rows[0].n;
      const found = (await q('SELECT count(*)::int AS n FROM customers WHERE id = ANY($1::bigint[])', [ids])).rows[0].n;
      return res.json({ found, appointments: ags.length, orders });
    }
    const snaps = [];
    for (const a of ags) snaps.push(await apptSnapshot(a.id));
    const deleted = await tx(currentCompany(), async (t) => {
      await t('DELETE FROM waitlist WHERE customer_id = ANY($1::bigint[])', [ids]);
      await t('DELETE FROM song_orders WHERE customer_id = ANY($1::bigint[])', [ids]);
      await t('DELETE FROM appointments WHERE customer_id = ANY($1::bigint[])', [ids]);
      return (await t('DELETE FROM customers WHERE id = ANY($1::bigint[])', [ids])).rowCount;
    });
    res.json({ deleted, appointments_deleted: snaps.length });
    snaps.forEach((sn) => notifyN8n('deleted', sn));
  }));

  // ---------- CLUBE (programa de benefícios com níveis) ----------
  const nomeOk = (v, max) => { const t = String(v ?? '').trim(); return t && t.length <= max && !/[\u0000-\u001f<>]/.test(t) ? t : null; };
  r.get('/club', wrap(async (req, res) => {
    const s = (await q('SELECT program_name FROM loyalty_settings WHERE id=1')).rows[0];
    const levels = (await q(
      `SELECT l.id, l.name, l.benefit_qty, l.position,
              (SELECT count(*) FROM customers c WHERE c.club_level_id=l.id AND c.club_status='member')::int AS members
       FROM loyalty_levels l ORDER BY l.position, l.id`)).rows;
    const cont = (await q(`SELECT club_status, count(*)::int AS n FROM customers WHERE club_status IS NOT NULL GROUP BY 1`)).rows;
    const counts = { member: 0, former: 0, supporter: 0 };
    cont.forEach((c) => { counts[c.club_status] = c.n; });
    res.json({ program_name: s?.program_name || 'Programa de benefícios', levels, counts });
  }));
  r.put('/club', wrap(async (req, res) => {
    const nome = nomeOk(req.body.program_name, 30);
    if (!nome) return res.status(400).json({ error: 'Nome do programa inválido (até 30 letras)' });
    await q('UPDATE loyalty_settings SET program_name=$1 WHERE id=1', [nome]);
    res.json({ program_name: nome });
  }));
  const qtdOk = (v) => (Number.isInteger(Number(v)) && Number(v) >= 0 && Number(v) <= 999 && v !== '' && v !== null ? Number(v) : null);
  r.post('/club/levels', wrap(async (req, res) => {
    const nome = nomeOk(req.body.name, 40);
    const qtd = req.body.benefit_qty === undefined ? 0 : qtdOk(req.body.benefit_qty);
    if (!nome) return res.status(400).json({ error: 'Nome do nível inválido (até 40 letras)' });
    if (qtd === null) return res.status(400).json({ error: 'Quantidade de benefícios por mês inválida' });
    const { rows } = await q(
      `INSERT INTO loyalty_levels (name, benefit_qty, position)
       VALUES ($1,$2,COALESCE((SELECT max(position)+1 FROM loyalty_levels),1)) RETURNING *`, [nome, qtd]);
    res.status(201).json(rows[0]);
  }));
  r.put('/club/levels/:id', wrap(async (req, res) => {
    const nome = req.body.name === undefined ? null : nomeOk(req.body.name, 40);
    const qtd = req.body.benefit_qty === undefined ? null : qtdOk(req.body.benefit_qty);
    if (req.body.name !== undefined && !nome) return res.status(400).json({ error: 'Nome do nível inválido (até 40 letras)' });
    if (req.body.benefit_qty !== undefined && qtd === null) return res.status(400).json({ error: 'Quantidade de benefícios por mês inválida' });
    const { rows } = await q(
      'UPDATE loyalty_levels SET name=COALESCE($2,name), benefit_qty=COALESCE($3,benefit_qty) WHERE id=$1 RETURNING *',
      [req.params.id, nome, qtd]);
    rows[0] ? res.json(rows[0]) : res.status(404).json({ error: 'Não encontrado' });
  }));
  r.delete('/club/levels/:id', wrap(async (req, res) => {
    const l = await q('SELECT id FROM loyalty_levels WHERE id=$1', [req.params.id]);
    if (!l.rows[0]) return res.status(404).json({ error: 'Não encontrado' });
    const n = (await q('SELECT count(*)::int AS n FROM customers WHERE club_level_id=$1', [req.params.id])).rows[0].n;
    if (n) return res.status(409).json({ error: `Este nível tem ${n} cliente(s). Mude o nível deles antes de excluir.` });
    await q('DELETE FROM loyalty_levels WHERE id=$1', [req.params.id]);
    res.json({ ok: true });
  }));
  // Exclui o cliente/lead junto com seus agendamentos e entradas na fila de espera.
  // Eventos espelhados no Google Agenda são apagados via N8N.
  r.delete('/customers/:id', wrap(async (req, res) => {
    const c = await q('SELECT id FROM customers WHERE id=$1', [req.params.id]);
    if (!c.rows[0]) return res.status(404).json({ error: 'Não encontrado' });
    const ids = (await q('SELECT id FROM appointments WHERE customer_id=$1', [req.params.id])).rows;
    const snaps = [];
    for (const a of ids) snaps.push(await apptSnapshot(a.id));
    await q('DELETE FROM waitlist WHERE customer_id=$1', [req.params.id]);
    await q('DELETE FROM song_orders WHERE customer_id=$1', [req.params.id]);
    await q('DELETE FROM appointments WHERE customer_id=$1', [req.params.id]);
    await q('DELETE FROM customers WHERE id=$1', [req.params.id]);
    res.json({ ok: true, appointments_deleted: snaps.length });
    snaps.forEach((sn) => notifyN8n('deleted', sn));
  }));

  // ---------- INATIVOS ----------
  r.get('/customers-inactive', wrap(async (req, res) => {
    const days = Number(req.query.days) || null; // se vier, sobrescreve companies.inactive_days
    const { rows } = await q(
      `SELECT c.*, (now()::date - c.last_visit_at::date) AS days_absent
       FROM customers c JOIN public.companies s ON s.id=$1
       WHERE c.status='client' AND c.last_visit_at IS NOT NULL
         AND c.last_visit_at < now() - make_interval(days => COALESCE($2, s.inactive_days))
         AND NOT EXISTS (SELECT 1 FROM appointments a WHERE a.customer_id=c.id
                         AND a.status='scheduled' AND a.starts_at > now())
       ORDER BY c.last_visit_at ASC`,
      [req.user.companyId, days]);
    res.json(rows);
  }));

  // ---------- AGENDAMENTOS ----------
  r.get('/appointments', wrap(async (req, res) => {
    // filtros opcionais: from, to, professional_id, phone (do cliente), status, google_event_id
    const { from, to, professional_id, phone, status, google_event_id } = req.query;
    const { rows } = await q(
      `SELECT a.*, c.name AS customer_name, c.phone AS customer_phone,
              sv.name AS service_name, b.name AS professional_name, b.color AS professional_color,
              b.google_calendar_id AS professional_google_calendar_id
       FROM appointments a
       JOIN customers c ON c.id=a.customer_id
       JOIN services sv ON sv.id=a.service_id
       JOIN professionals b ON b.id=a.professional_id
       WHERE ($1::timestamptz IS NULL OR a.starts_at >= $1)
         AND ($2::timestamptz IS NULL OR a.starts_at < $2)
         AND ($3::bigint IS NULL OR a.professional_id = $3)
         AND ($4::text IS NULL OR c.phone = $4)
         AND ($5::text IS NULL OR a.status = $5)
         AND ($6::text IS NULL OR a.google_event_id = $6)
       ORDER BY a.starts_at`,
      [from || null, to || null, professional_id || null,
       phone ? digits(phone) : null, status || null, google_event_id || null]);
    res.json(rows);
  }));
  r.post('/appointments', wrap(async (req, res) => {
    const { professional_id, customer_id, service_id, starts_at, source = 'manual' } = req.body;
    const sv = await q('SELECT price,duration_min FROM services WHERE id=$1 AND active',
      [service_id]);
    if (!sv.rows[0]) return res.status(400).json({ error: 'Serviço inválido' });
    const ok = await q(
      `SELECT (SELECT 1 FROM professionals WHERE id=$1 AND active) AS b,
              (SELECT 1 FROM customers WHERE id=$2) AS c`,
      [professional_id, customer_id]);
    if (!ok.rows[0].b || !ok.rows[0].c) return res.status(400).json({ error: 'Profissional ou cliente inválido' });
    const does = await q(`SELECT ${doesSql('$1', '$2')} AS ok`, [professional_id, service_id]);
    if (!does.rows[0].ok) return res.status(400).json({ error: 'Este profissional não realiza esse serviço' });
    // empresa em "sob confirmação": o que o agente marca fica aguardando o responsável confirmar
    const mode = (await qg('SELECT booking_mode FROM companies WHERE id=$1', [currentCompany()])).rows[0]?.booking_mode;
    // se o responsável já autorizou esse horário (o agente perguntou a ele antes), nasce agendado
    const autorizado = req.body.adm_approved === true;
    const status = mode === 'confirm' && source === 'ia' && !autorizado ? 'pending' : 'scheduled';
    const r = await tx(currentCompany(), async (t) => {
      // Agente repetindo o pedido (cliente insistiu, ou duas chamadas no mesmo segundo): não marca de novo, devolve o que já existe.
      // Vale para o mesmo cliente, no mesmo horário (1 min), com o mesmo profissional ou o mesmo serviço.
      // A trava por cliente faz chamadas simultâneas passarem uma de cada vez.
      if (source === 'ia') {
        await t('SELECT pg_advisory_xact_lock($1)', [Number(customer_id)]);
        const dup = (await t(
          `SELECT * FROM appointments
           WHERE customer_id=$1 AND status IN ('pending','scheduled')
             AND abs(extract(epoch FROM (starts_at - $2::timestamptz))) < 60
             AND (professional_id=$3 OR service_id=$4)
           ORDER BY id LIMIT 1`, [customer_id, starts_at, professional_id, service_id])).rows[0];
        if (dup) return { row: dup, dup: true };
      }
      const ins = await t(
        `INSERT INTO appointments (professional_id,customer_id,service_id,starts_at,ends_at,price,source,status)
         VALUES ($1,$2,$3,$4::timestamptz,$4::timestamptz + make_interval(mins => $5),$6,$7,$8) RETURNING *`,
        [professional_id, customer_id, service_id, starts_at,
         sv.rows[0].duration_min, sv.rows[0].price, source, status]);
      return { row: ins.rows[0], dup: false };
    });
    const rows = [r.row];
    if (r.dup) return res.status(200).json({ ...r.row, already_exists: true });
    res.status(201).json(rows[0]);
    apptSnapshot(rows[0].id).then((s) => notifyN8n('created', s)).catch(() => {});
  }));
  // Lembrete ao cliente: o N8N chama isto de tempos em tempos. Reserva e devolve, de forma atômica,
  // os agendamentos que começam entre min_minutes e window_minutes a partir de agora e ainda não
  // receberam lembrete (duas chamadas seguidas nunca devolvem o mesmo agendamento).
  // Não lembra quem acabou de agendar (ver regra em reminders/claim).
  r.post('/appointments/reminders/claim', wrap(async (req, res) => {
    // Regra vem da configuração da empresa (reminder_minutes = antecedência; NULL = desligado).
    // Janela: de (N-30min) a (N+5min) antes; não lembra quem marcou com menos de N+60min de antecedência.
    const cfg = (await qg('SELECT reminder_minutes, name, timezone FROM companies WHERE id=$1', [req.user.companyId])).rows[0];
    const N = cfg?.reminder_minutes;
    if (!N) return res.json([]);
    const win = N + 5, min = Math.max(N - 30, 15), gap = N + 60;
    const limit = Math.min(Math.max(Number(req.body?.limit) || 15, 1), 50);
    const { rows } = await q(
      `UPDATE appointments a SET reminder_sent_at = now()
       WHERE a.id IN (
         SELECT a2.id FROM appointments a2
         WHERE a2.status='scheduled' AND a2.reminder_sent_at IS NULL
           AND a2.starts_at > now() + make_interval(mins => $1)
           AND a2.starts_at <= now() + make_interval(mins => $2)
           AND a2.created_at <= a2.starts_at - make_interval(mins => $4)
         ORDER BY a2.starts_at LIMIT $3 FOR UPDATE SKIP LOCKED)
       RETURNING a.id`, [min, win, limit, gap]);
    const out = [];
    for (const { id } of rows) {
      const s = await apptSnapshot(id);
      const sal = cfg;
      out.push({ id: s.id, starts_at: s.starts_at, customer_name: s.customer_name, customer_phone: s.customer_phone,
                 professional_name: s.professional_name, service_name: s.service_name, company_name: sal.name, timezone: sal.timezone });
    }
    res.json(out);
  }));
  // status: attended | no_show | cancelled | scheduled
  r.patch('/appointments/:id/status', wrap(async (req, res) => {
    const { status } = req.body;
    if (!['pending', 'scheduled', 'attended', 'no_show', 'cancelled'].includes(status))
      return res.status(400).json({ error: 'Status inválido' });
    const { rows } = await q('UPDATE appointments SET status=$2 WHERE id=$1 RETURNING *',
      [req.params.id, status]);
    if (!rows[0]) return res.status(404).json({ error: 'Não encontrado' });
    res.json(rows[0]);
    apptSnapshot(rows[0].id).then((s) => {
      notifyN8n('updated', s);
      // cancelado ou faltou = horário liberado (só sai aviso se o horário ainda for futuro)
      if (status === 'cancelled' || status === 'no_show') checkWaitlist(s);
    }).catch(() => {});
  }));
  // Resposta do responsável a um agendamento aguardando confirmação (pelo painel ou pelo WhatsApp):
  // vale a primeira resposta; quem chegar depois recebe 409 com a situação atual.
  r.post('/appointments/:id/respond', wrap(async (req, res) => {
    const { decision } = req.body || {};
    if (!['confirm', 'reject'].includes(decision)) return res.status(400).json({ error: 'Decisão inválida (confirm ou reject)' });
    const { rows } = await q(
      "UPDATE appointments SET status=$2 WHERE id=$1 AND status='pending' RETURNING *",
      [req.params.id, decision === 'confirm' ? 'scheduled' : 'cancelled']);
    if (!rows[0]) {
      const cur = (await q('SELECT status FROM appointments WHERE id=$1', [req.params.id])).rows[0];
      if (!cur) return res.status(404).json({ error: 'Não encontrado' });
      return res.status(409).json({ error: 'Esse agendamento já foi respondido', ja_respondido: true, status: cur.status });
    }
    res.json(rows[0]);
    apptSnapshot(rows[0].id).then((s) => {
      notifyN8n('updated', s);
      if (decision === 'reject') checkWaitlist(s);
    }).catch(() => {});
  }));
  // Modo de agendamento da empresa: 'auto' (horários fixos) ou 'confirm' (sob confirmação do responsável)
  r.get('/booking-mode', wrap(async (req, res) => {
    const c = (await qg('SELECT booking_mode, phone, adm_name FROM companies WHERE id=$1', [currentCompany()])).rows[0] || {};
    // notify_phone = telefone cadastrado da empresa (para onde vai o aviso de agendamento a confirmar)
    res.json({ booking_mode: c.booking_mode || 'auto', notify_phone: normPhone(c.phone) || null, adm_name: c.adm_name || null });
  }));
  // guarda o id do evento espelhado no Google Agenda (string vazia = remove)
  r.patch('/appointments/:id', wrap(async (req, res) => {
    const { google_event_id } = req.body;
    if (google_event_id === undefined) return res.status(400).json({ error: 'Nada para atualizar' });
    const { rows } = await q(
      "UPDATE appointments SET google_event_id=NULLIF(trim($2),'') WHERE id=$1 RETURNING *",
      [req.params.id, google_event_id ?? '']);
    rows[0] ? res.json(rows[0]) : res.status(404).json({ error: 'Não encontrado' });
  }));
  r.delete('/appointments/:id', wrap(async (req, res) => {
    const snap = await apptSnapshot(req.params.id); // foto antes de apagar
    await q('DELETE FROM appointments WHERE id=$1', [req.params.id]);
    res.json({ ok: true });
    notifyN8n('deleted', snap);
    if (snap && ['pending', 'scheduled', 'attended'].includes(snap.status)) checkWaitlist(snap).catch(() => {});
  }));

  r.post('/appointments/bulk-delete', wrap(async (req, res) => {
    const ids = idsDe(req.body);
    if (!ids.length) return res.status(400).json({ error: 'Nenhum item selecionado' });
    const snaps = [];
    for (const id of ids) { const sn = await apptSnapshot(id); if (sn) snaps.push(sn); }
    if (req.body.dry_run === true) return res.json({ found: snaps.length });
    const deleted = (await q('DELETE FROM appointments WHERE id = ANY($1::bigint[])', [snaps.map((s) => s.id)])).rowCount;
    res.json({ deleted });
    snaps.forEach((sn) => {
      notifyN8n('deleted', sn);
      if (['pending', 'scheduled', 'attended'].includes(sn.status)) checkWaitlist(sn).catch(() => {});
    });
  }));

  // ---------- FILA DE ESPERA ----------
  r.get('/waitlist', wrap(async (req, res) => {
    const { status, phone } = req.query;
    const { rows } = await q(
      `SELECT w.*, c.name AS customer_name, c.phone AS customer_phone, b.name AS professional_name
       FROM waitlist w JOIN customers c ON c.id=w.customer_id LEFT JOIN professionals b ON b.id=w.professional_id
       WHERE ($1::text IS NULL OR w.status=$1) AND ($2::text IS NULL OR c.phone=$2)
       ORDER BY (w.status='waiting') DESC, w.desired_at`,
      [status || null, phone ? digits(phone) : null]);
    res.json(rows);
  }));
  // body: { phone, name?, desired_at, professional_id | professional_name? } — sem profissional = qualquer um
  r.post('/waitlist', wrap(async (req, res) => {
    const { phone, name, desired_at, professional_id, professional_name } = req.body;
    const d = new Date(desired_at);
    if (!digits(phone) || !desired_at || isNaN(d)) return res.status(400).json({ error: 'Informe telefone e horário desejado (ISO 8601)' });
    let bid = professional_id || null;
    if (!bid && normName(professional_name)) {
      const bs = (await q('SELECT id,name FROM professionals WHERE active')).rows;
      const n = normName(professional_name);
      const b = bs.find((x) => normName(x.name) === n) || bs.find((x) => normName(x.name).includes(n) || n.includes(normName(x.name)));
      if (!b) return res.status(400).json({ error: `Profissional não encontrado (opções: ${bs.map((x) => x.name).join(', ')})` });
      bid = b.id;
    }
    const cu = await q(
      `INSERT INTO customers (name,phone,source) VALUES ($1,$2,'ia')
       ON CONFLICT (phone) DO UPDATE SET name=COALESCE(customers.name,EXCLUDED.name) RETURNING id`,
      [name || null, normPhone(phone)]);
    const dup = await q(
      `SELECT id FROM waitlist WHERE customer_id=$1 AND status='waiting'
       AND desired_at=$2 AND professional_id IS NOT DISTINCT FROM $3::bigint`, [cu.rows[0].id, d, bid]);
    if (dup.rows[0]) return res.status(200).json({ ...dup.rows[0], already: true });
    const { rows } = await q(
      'INSERT INTO waitlist (customer_id,professional_id,desired_at) VALUES ($1,$2,$3) RETURNING *',
      [cu.rows[0].id, bid, d]);
    res.status(201).json(rows[0]);
  }));
  r.delete('/waitlist/:id', wrap(async (req, res) => {
    await q("UPDATE waitlist SET status='cancelled' WHERE id=$1", [req.params.id]);
    res.json({ ok: true });
  }));
  // Exclui o registro de vez (qualquer situação), para limpar a lista.
  r.delete('/waitlist/:id/permanent', wrap(async (req, res) => {
    const { rowCount } = await q('DELETE FROM waitlist WHERE id=$1', [req.params.id]);
    if (!rowCount) return res.status(404).json({ error: 'Não encontrado' });
    res.json({ ok: true });
  }));

  r.post('/waitlist/bulk-delete', wrap(async (req, res) => {
    const ids = idsDe(req.body);
    if (!ids.length) return res.status(400).json({ error: 'Nenhum item selecionado' });
    if (req.body.dry_run === true) return res.json({ found: (await q('SELECT count(*)::int AS n FROM waitlist WHERE id = ANY($1::bigint[])', [ids])).rows[0].n });
    res.json({ deleted: (await q('DELETE FROM waitlist WHERE id = ANY($1::bigint[])', [ids])).rowCount });
  }));

  // ---------- IMPORTAR PLANILHA ----------
  // body: { services:[...], professionals:[...], customers:[...], dry_run: true|false }
  r.post('/import', wrap(async (req, res) => {
    const { services, professionals, customers, dry_run } = req.body || {};
    const cap = (a) => (Array.isArray(a) ? a.slice(0, 2000) : []);
    res.json(await runImport(req.user.companyId, { services: cap(services), professionals: cap(professionals), customers: cap(customers) }, !!dry_run));
  }));

  // ---------- HORÁRIOS LIVRES (usado pelo agente de IA) ----------
  // GET /availability?date=2026-10-01&service_id=1[&professional_id=2]
  r.get('/availability', wrap(async (req, res) => {
    const { date, service_id, professional_id } = req.query;
    const sv = await q('SELECT duration_min FROM services WHERE id=$1',
      [service_id]);
    if (!sv.rows[0]) return res.status(400).json({ error: 'Serviço inválido' });
    const dur = sv.rows[0].duration_min;
    const tz = (await qg('SELECT timezone FROM companies WHERE id=$1', [req.user.companyId])).rows[0].timezone;

    // slots de 15 em 15 min dentro do expediente, fora da pausa, sem conflito e no futuro
    const { rows } = await q(
      `WITH b AS (
         SELECT b.id AS professional_id, b.name, s.start_time, s.end_time, s.break_start, s.break_end
         FROM professionals b JOIN professional_schedules s ON s.professional_id=b.id
         WHERE b.active AND ($3::bigint IS NULL OR b.id=$3)
           AND ${doesSql('b.id', '$5::bigint')}
           AND s.weekday = EXTRACT(DOW FROM $1::date)
       ), slots AS (
         SELECT b.professional_id, b.name, g AS t_start, g + make_interval(mins => $2) AS t_end, b.break_start, b.break_end
         FROM b, generate_series(
           ($1::date + b.start_time)::timestamp,
           ($1::date + b.end_time)::timestamp - make_interval(mins => $2),
           interval '15 minutes') g
       )
       SELECT professional_id, name AS professional_name,
              to_char(t_start,'HH24:MI') AS time,
              (t_start AT TIME ZONE $4) AS starts_at
       FROM slots
       WHERE (break_start IS NULL OR NOT (t_start::time < break_end AND t_end::time > break_start))
         AND (t_start AT TIME ZONE $4) > now()
         AND NOT EXISTS (SELECT 1 FROM appointments a WHERE a.professional_id=slots.professional_id
               AND a.status IN ('pending','scheduled','attended')
               AND tstzrange(a.starts_at,a.ends_at) && tstzrange(t_start AT TIME ZONE $4, t_end AT TIME ZONE $4))
         AND NOT EXISTS (SELECT 1 FROM blocked_slots x WHERE x.professional_id=slots.professional_id
               AND tstzrange(x.starts_at,x.ends_at) && tstzrange(t_start AT TIME ZONE $4, t_end AT TIME ZONE $4))
       ORDER BY t_start, professional_id`,
      [date, dur, professional_id || null, tz, service_id]);
    res.json(rows);
  }));

  // ---------- JANELA ESPECÍFICA (usado pelo agente de IA) ----------
  // GET /availability/window?start=2026-10-01T14:00:00-03:00&end=2026-10-01T14:30:00-03:00[&professional_id=2]
  // Diz quem está livre e quem está indisponível (e por quê) para aquele horário exato.
  r.get('/availability/window', wrap(async (req, res) => {
    const { start, end, professional_id, service_id } = req.query;
    const s = new Date(start), e = new Date(end);
    if (!start || !end || isNaN(s) || isNaN(e) || e <= s)
      return res.status(400).json({ error: 'Informe start e end (ISO 8601) com end > start' });
    const cfg = (await qg('SELECT timezone, booking_mode FROM companies WHERE id=$1', [req.user.companyId])).rows[0];
    const tz = cfg.timezone;
    // empresa "sob confirmação": não há grade de horários a respeitar (quem decide é o responsável);
    // só valem conflitos reais (serviço, horário passado, já ocupado ou bloqueado)
    const semGrade = cfg.booking_mode === 'confirm';
    const { rows } = await q(
      `WITH l AS (SELECT $1::timestamptz AS s, $2::timestamptz AS e,
                         ($1::timestamptz AT TIME ZONE $4) AS ls, ($2::timestamptz AT TIME ZONE $4) AS le)
       SELECT b.id AS professional_id, b.name AS professional_name,
         CASE
           WHEN $5::bigint IS NOT NULL AND NOT ${doesSql('b.id', '$5::bigint')} THEN 'não realiza este serviço'
           WHEN l.s <= now() THEN 'horário já passou'
           WHEN NOT $6::boolean AND l.ls::date <> l.le::date THEN 'fora do expediente'
           WHEN NOT $6::boolean AND NOT EXISTS (SELECT 1 FROM professional_schedules sc WHERE sc.professional_id=b.id
                 AND sc.weekday = EXTRACT(DOW FROM l.ls)::int
                 AND l.ls::time >= sc.start_time AND l.le::time <= sc.end_time) THEN 'fora do expediente'
           WHEN NOT $6::boolean AND EXISTS (SELECT 1 FROM professional_schedules sc WHERE sc.professional_id=b.id
                 AND sc.weekday = EXTRACT(DOW FROM l.ls)::int AND sc.break_start IS NOT NULL
                 AND l.ls::time < sc.break_end AND l.le::time > sc.break_start) THEN 'pausa'
           WHEN EXISTS (SELECT 1 FROM appointments a WHERE a.professional_id=b.id
                 AND a.status IN ('pending','scheduled','attended')
                 AND tstzrange(a.starts_at,a.ends_at) && tstzrange(l.s,l.e)) THEN 'ocupado'
           WHEN EXISTS (SELECT 1 FROM blocked_slots x WHERE x.professional_id=b.id
                 AND tstzrange(x.starts_at,x.ends_at) && tstzrange(l.s,l.e)) THEN 'bloqueado'
           ELSE NULL END AS motivo
       FROM professionals b, l
       WHERE b.active AND ($3::bigint IS NULL OR b.id=$3)
       ORDER BY b.name`,
      [start, end, professional_id || null, tz, service_id || null, semGrade]);
    res.json({
      booking_mode: cfg.booking_mode || 'auto',
      free: rows.filter((x) => !x.motivo).map(({ professional_id: id, professional_name }) => ({ professional_id: id, professional_name })),
      busy: rows.filter((x) => x.motivo).map(({ professional_id: id, professional_name, motivo }) => ({ professional_id: id, professional_name, motivo })),
    });
  }));

  // ---------- DASHBOARD ----------
  r.get('/dashboard', wrap(async (req, res) => {
    const days = Number(req.query.days) || 30;
    const base = `FROM v_dashboard_base WHERE status='attended'
                  AND starts_at >= now() - make_interval(days => $1)`;
    const [tot, byDay, byService, byProfessional, leads] = await Promise.all([
      q(`SELECT COUNT(*)::int AS atendimentos, COALESCE(SUM(price),0) AS faturamento ${base}`, [days]),
      q(`SELECT weekday, COUNT(*)::int AS total ${base} GROUP BY weekday ORDER BY weekday`, [days]),
      q(`SELECT service, COUNT(*)::int AS total ${base} GROUP BY service ORDER BY total DESC LIMIT 10`, [days]),
      q(`SELECT professional, COUNT(*)::int AS total ${base} GROUP BY professional ORDER BY total DESC`, [days]),
      q(`SELECT status, COUNT(*)::int AS total FROM customers GROUP BY status`),
    ]);
    res.json({
      days, ...tot.rows[0],
      por_dia_semana: byDay.rows, servicos: byService.rows,
      profissionais: byProfessional.rows, clientes: leads.rows,
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
  async function agentCommandSet() {
    const [sal, cmds, atts] = await Promise.all([
      qg('SELECT agent_name, adm_name FROM companies WHERE id=$1', [currentCompany()]),
      q('SELECT id,kind,phrase,phrase_norm FROM agent_commands ORDER BY id'),
      q('SELECT id,name,name_norm FROM agent_attendants ORDER BY id'),
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
    const set = await agentCommandSet();
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
      await qg(`UPDATE companies SET ${col}=$2 WHERE id=$1`, [req.user.companyId, name || null]);
    }
    res.json({ ok: true });
  }));
  // limite por tipo conta frases próprias (+ atendentes, no caso de "pause")
  async function checkCommand(kind, norm) {
    if (norm.length < 3) return 'Frase muito curta (mínimo 3 letras)';
    const set = await agentCommandSet();
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
    const bad = await checkCommand(kind, norm);
    if (bad) return res.status(400).json({ error: bad });
    const { rows } = await q('INSERT INTO agent_commands (kind,phrase,phrase_norm) VALUES ($1,$2,$3) RETURNING id,kind,phrase',
      [kind, phrase, norm]);
    res.status(201).json(rows[0]);
  }));
  r.delete('/agent-commands/:id', wrap(async (req, res) => {
    await q('DELETE FROM agent_commands WHERE id=$1', [req.params.id]);
    res.json({ ok: true });
  }));
  r.post('/agent-attendants', wrap(async (req, res) => {
    const name = String(req.body?.name ?? '').trim();
    if (name.length > 40) return res.status(400).json({ error: 'Nome muito longo' });
    const bad = await checkCommand('pause', normCmd(`${name} aqui`));
    if (bad) return res.status(400).json({ error: bad });
    const { rows } = await q('INSERT INTO agent_attendants (name,name_norm) VALUES ($1,$2) RETURNING id,name',
      [name, normCmd(name)]);
    res.status(201).json(rows[0]);
  }));
  r.delete('/agent-attendants/:id', wrap(async (req, res) => {
    await q('DELETE FROM agent_attendants WHERE id=$1', [req.params.id]);
    res.json({ ok: true });
  }));
  // Body: { text, fallback? }. Resposta: { action: 'off'|'on'|'pause'|'resume'|'none', explicit?, ignore?, rule? }
  // explicit = casou com frase cadastrada (bloqueio/retomada TOTAL); ignore = "/algo" que não é comando; rule 'geral' = pausa/retomada simples (?/...)
  // Casa quando o texto COMEÇA com a frase (palavra inteira); vence a frase mais longa.
  r.post('/agent-commands/classify', wrap(async (req, res) => {
    const text = normCmd(req.body?.text);
    const set = await agentCommandSet();
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

  registerCampaignRoutes(r, wrap);
  registerOrderRoutes(r, wrap);
  registerEventRoutes(r, wrap);
  registerFinanceRoutes(r, wrap);
  return r;
}
