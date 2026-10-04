// Contratações: shows contratados pela pessoa (data, local, valor, situação). Ficam na ficha do Contratante,
// com o valor médio contratado. Podem ser lançadas no painel ou pela atendente (mesma rota em /n8n).
import { q } from './db.js';
import { normPhone } from './phone.js';

export const CONTRATACOES_SQL = `
  CREATE TABLE IF NOT EXISTS scn_hirings (
    id          BIGSERIAL PRIMARY KEY,
    customer_id BIGINT NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
    show_date   DATE,
    venue       TEXT,
    value       NUMERIC(12,2) CHECK (value >= 0),
    status      TEXT NOT NULL DEFAULT 'proposal' CHECK (status IN ('proposal','confirmed','done','cancelled')),
    note        TEXT,
    source      TEXT NOT NULL DEFAULT 'manual',
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
  );
  CREATE INDEX IF NOT EXISTS idx_scn_hirings_customer ON scn_hirings (customer_id, show_date DESC);`;

export const STATUS_CONTRATACAO = ['proposal', 'confirmed', 'done', 'cancelled'];
const r2 = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;
const txt = (v, max) => { const s = String(v ?? '').trim(); return s.length <= max && !/[\u0000-\u0008\u000b-\u001f<>]/.test(s) ? s : null; };
const dataOk = (v) => /^\d{4}-\d{2}-\d{2}$/.test(String(v || '')) && !isNaN(new Date(v + 'T00:00:00Z')) ? String(v) : null;

export async function historicoContratacoes(customerId) {
  const rows = (await q(
    `SELECT id, show_date::text AS date, venue, value::float AS value, status, note FROM scn_hirings
     WHERE customer_id=$1 ORDER BY show_date DESC NULLS LAST, id DESC LIMIT 200`, [customerId])).rows;
  const contam = rows.filter((x) => ['confirmed', 'done'].includes(x.status) && x.value > 0); // proposta e cancelada não entram na média
  const total = r2(contam.reduce((a, x) => a + x.value, 0));
  return { hirings: { rows, contracts: contam.length, total, average_value: contam.length ? r2(total / contam.length) : null } };
}

export function registerHiringRoutes(r, wrap) {
  const quem = (req) => (req.baseUrl || '').includes('n8n') ? 'ia' : 'manual';
  function ler(b, parcial) {
    const o = {};
    if (!parcial || b.show_date !== undefined) { if (b.show_date === undefined || b.show_date === null || b.show_date === '') o.show_date = null; else { o.show_date = dataOk(b.show_date); if (!o.show_date) return { erro: 'Data inválida (use AAAA-MM-DD)' }; } }
    if (!parcial || b.venue !== undefined) { o.venue = txt(b.venue, 120); if (o.venue === null) return { erro: 'Local inválido (até 120 letras)' }; }
    if (b.value !== undefined) {
      if (b.value === null || b.value === '') o.value = null;
      else { const n = Number(String(b.value).replace(/[R$\s]/g, '').replace(',', '.')); if (!Number.isFinite(n) || n < 0 || n > 9999999) return { erro: 'Valor inválido' }; o.value = r2(n); }
    }
    if (b.status !== undefined) { if (!STATUS_CONTRATACAO.includes(b.status)) return { erro: 'Situação inválida' }; o.status = b.status; }
    if (b.note !== undefined) { o.note = txt(b.note, 500); if (o.note === null) return { erro: 'Observação inválida (até 500 letras)' }; }
    return { o };
  }
  // quem contrata passa a ser cliente (se a contratação está confirmada ou feita) e tem o perfil Contratante
  const marcar = (id, status) => q(
    `UPDATE customers SET client_kinds = CASE WHEN 'hirer' = ANY(client_kinds) THEN client_kinds ELSE array_append(client_kinds, 'hirer') END,
            status = CASE WHEN $2 IN ('confirmed','done') THEN 'client' ELSE status END WHERE id=$1`, [id, status]);

  r.get('/scenarium/hirings', wrap(async (req, res) => {
    const id = /^\d+$/.test(String(req.query.customer_id || '')) ? req.query.customer_id : null;
    const phone = req.query.phone ? normPhone(req.query.phone) : null;
    if (!id && !phone) return res.status(400).json({ error: 'Informe customer_id ou phone' });
    const c = (await q(id ? 'SELECT id FROM customers WHERE id=$1' : 'SELECT id FROM customers WHERE phone=$1', [id || phone])).rows[0];
    if (!c) return res.json({ hirings: { rows: [], contracts: 0, total: 0, average_value: null } });
    res.json(await historicoContratacoes(c.id));
  }));

  r.post('/scenarium/hirings', wrap(async (req, res) => {
    const b = req.body || {};
    let cid = /^\d+$/.test(String(b.customer_id || '')) ? b.customer_id : null;
    if (!cid && b.phone) {
      const phone = normPhone(b.phone);
      if (!phone || phone.length < 10) return res.status(400).json({ error: 'Telefone inválido (use DDD + número)' });
      const nome = txt(b.name, 80);
      if (nome === null) return res.status(400).json({ error: 'Nome inválido' });
      cid = (await q(`INSERT INTO customers (name,phone,source,status) VALUES (NULLIF($1,''),$2,$3,'lead')
                      ON CONFLICT (phone) DO UPDATE SET name=COALESCE(customers.name, EXCLUDED.name) RETURNING id`, [nome, phone, quem(req)])).rows[0].id;
    }
    if (!cid) return res.status(400).json({ error: 'Informe customer_id ou phone' });
    if (!(await q('SELECT 1 FROM customers WHERE id=$1', [cid])).rowCount) return res.status(404).json({ error: 'Cliente não encontrado' });
    const { o, erro } = ler(b, false);
    if (erro) return res.status(400).json({ error: erro });
    const status = o.status || 'proposal';
    const row = (await q(`INSERT INTO scn_hirings (customer_id, show_date, venue, value, status, note, source) VALUES ($1,$2,NULLIF($3,''),$4,$5,$6,$7)
                          RETURNING id, show_date::text AS date, venue, value::float AS value, status, note`,
      [cid, o.show_date ?? null, o.venue ?? '', o.value ?? null, status, o.note ?? null, quem(req)])).rows[0];
    await marcar(cid, status);
    res.status(201).json({ ...row, customer_id: String(cid) });
  }));

  r.put('/scenarium/hirings/:id', wrap(async (req, res) => {
    const { o, erro } = ler(req.body || {}, true);
    if (erro) return res.status(400).json({ error: erro });
    const cur = (await q('SELECT * FROM scn_hirings WHERE id=$1', [req.params.id])).rows[0];
    if (!cur) return res.status(404).json({ error: 'Contratação não encontrada' });
    const n = { show_date: cur.show_date, venue: cur.venue, value: cur.value, status: cur.status, note: cur.note };
    for (const k of Object.keys(o)) n[k] = o[k];
    await q('UPDATE scn_hirings SET show_date=$2, venue=NULLIF($3,\'\'), value=$4, status=$5, note=$6 WHERE id=$1',
      [cur.id, n.show_date, n.venue ?? '', n.value, n.status, n.note]);
    await marcar(cur.customer_id, n.status);
    res.json({ ok: true });
  }));

  r.delete('/scenarium/hirings/:id', wrap(async (req, res) => {
    const { rowCount } = await q('DELETE FROM scn_hirings WHERE id=$1', [req.params.id]);
    if (!rowCount) return res.status(404).json({ error: 'Contratação não encontrada' });
    res.json({ ok: true });
  }));
}
