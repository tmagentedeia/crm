// Lista do evento: uma linha por pessoa que vai ao evento (no lugar da planilha), montada a partir das vendas da Casa de Shows.
// Cada pessoa pode ter nome, telefone e observações próprios; a portaria marca quem entrou. Toda mudança fica registrada.
// Acessos (telas da equipe): lista_evento = só consulta · lista_evento_porteiro = marca entrada e anota na portaria · lista_evento_edicao = edita tudo.
import { q, qg } from './db.js';
import { normPhone } from './phone.js';

export const SHOWS_LISTA_SQL = `
  CREATE TABLE IF NOT EXISTS shows_attendees (
    sale_id    BIGINT NOT NULL REFERENCES shows_sales(id) ON DELETE CASCADE,
    seq        INT NOT NULL CHECK (seq >= 1),                 -- 1ª, 2ª... pessoa da venda
    name       TEXT,
    phone      TEXT,
    note       TEXT,                                          -- observação da casa
    door_note  TEXT,                                          -- observação da portaria
    entered_at TIMESTAMPTZ,
    entered_by TEXT,
    PRIMARY KEY (sale_id, seq)
  );
  CREATE TABLE IF NOT EXISTS shows_attendee_log (
    id        BIGSERIAL PRIMARY KEY,
    event_id  BIGINT,
    sale_id   BIGINT NOT NULL,
    seq       INT NOT NULL,
    person    TEXT,
    at        TIMESTAMPTZ NOT NULL DEFAULT now(),
    actor     TEXT NOT NULL,
    action    TEXT NOT NULL,
    detail    TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_shows_attendee_log_event ON shows_attendee_log (event_id, at DESC);
`;

const OCUPAM = ['confirmed', 'attended'];
const idOk = (v) => (/^\d+$/.test(String(v ?? '')) ? String(v) : null);
const txt = (v, max) => { const s = String(v ?? '').trim(); return s.length <= max && !/[\u0000-\u0008\u000b-\u001f<>]/.test(s) ? s : null; };
const PAGAMENTO = { courtesy: 'Cortesia', paid: 'Pago', partial: 'Parcial', pending: 'Pendente', no_price: '—' };

export function registerListaEventoRoutes(r, wrap) {
  const erro = (status, msg) => { const e = new Error(msg); e.status = status; return e; };
  const tratar = (fn) => wrap(async (req, res) => { try { await fn(req, res); } catch (e) { if (e.status) return res.status(e.status).json({ error: e.message }); throw e; } });
  const ator = async (req) => {
    if ((req.baseUrl || '').includes('n8n') || !req.user) return 'IA';
    const u = (await qg('SELECT name FROM users WHERE id=$1', [req.user.id])).rows[0];
    return u?.name || 'Equipe';
  };

  async function eventoDe(ref) {
    const id = idOk(ref);
    if (!id) throw erro(400, 'Escolha o evento');
    const e = (await q('SELECT id, title, starts_at FROM events WHERE id=$1', [id])).rows[0];
    if (!e) throw erro(404, 'Evento não encontrado');
    return e;
  }

  // Uma linha por pessoa: nome informado > nome da lista de nomes da venda > comprador (1ª pessoa) > "Acompanhante de ..."
  async function linhas(eventId) {
    const rs = (await q(
      `SELECT s.id AS sale_id, g.seq, s.name AS buyer, s.phone AS buyer_phone, sec.name AS sector, s.table_name, s.tables, s.host_sale_id,
              (SELECT h.name FROM shows_sales h WHERE h.id = s.host_sale_id) AS host_name,
              s.status, s.people, s.guests, s.unit_price::float AS unit_price,
              COALESCE((SELECT SUM(p.amount) FROM shows_sale_payments p WHERE p.sale_id = s.id AND p.method <> 'cortesia'), 0)::float AS paid,
              EXISTS (SELECT 1 FROM shows_sale_payments p WHERE p.sale_id = s.id AND p.method = 'cortesia') AS courtesy,
              a.name AS att_name, a.phone AS att_phone, a.note, a.door_note, a.entered_at, a.entered_by
       FROM shows_sales s
       JOIN shows_sectors sec ON sec.id = s.sector_id
       CROSS JOIN LATERAL generate_series(1, s.people) AS g(seq)
       LEFT JOIN shows_attendees a ON a.sale_id = s.id AND a.seq = g.seq
       WHERE s.event_id = $1 AND s.status = ANY($2)
       ORDER BY sec.position, COALESCE(s.host_sale_id, s.id), (s.host_sale_id IS NOT NULL), s.id, g.seq`, [eventId, OCUPAM])).rows;
    return rs.map((x) => {
      const nomes = String(x.guests || '').split('\n').map((l) => l.trim()).filter(Boolean);
      const nome = x.att_name || nomes[x.seq - 1] || (x.seq === 1 ? x.buyer : `Acompanhante de ${x.buyer}`);
      const total = x.unit_price !== null ? x.unit_price * x.people : null;
      const pay = x.courtesy ? 'courtesy' : total === null || total === 0 ? 'no_price' : x.paid >= total - 0.005 ? 'paid' : x.paid > 0 ? 'partial' : 'pending';
      return {
        key: `${x.sale_id}:${x.seq}`, sale_id: x.sale_id, seq: x.seq, name: nome, named: !!x.att_name,
        phone: x.att_phone || x.buyer_phone || null, buyer: x.buyer, sector: x.sector,
        table: x.host_sale_id ? `Mesa de ${x.host_name}` : `${x.tables} × ${x.table_name}`, table_name: x.table_name, tables: x.tables,
        unit_price: x.unit_price, payment: pay, payment_label: PAGAMENTO[pay], status: x.status,
        note: x.note || '', door_note: x.door_note || '', entered_at: x.entered_at, entered_by: x.entered_by,
      };
    });
  }

  r.get('/event-list', tratar(async (req, res) => {
    const ev = await eventoDe(req.query.event_id);
    const rows = await linhas(ev.id);
    res.json({
      event: ev, rows,
      summary: { people: rows.length, entered: rows.filter((x) => x.entered_at).length, pending_payment: rows.filter((x) => ['pending', 'partial'].includes(x.payment)).length },
    });
  }));

  r.get('/event-list/export', tratar(async (req, res) => {
    const ev = await eventoDe(req.query.event_id);
    const rows = await linhas(ev.id);
    const cel = (v) => { const s = String(v ?? ''); return /[;"\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; };
    const cab = ['Nome', 'Setor', 'Mesa', 'Telefone', 'Valor', 'Pagamento', 'Entrou', 'Observações', 'Observações da portaria'];
    const linhasCsv = rows.map((x) => [x.name, x.sector, x.table, x.phone || '', x.unit_price === null ? '' : String(x.unit_price).replace('.', ','), x.payment_label,
      x.entered_at ? 'Sim' : '', x.note, x.door_note].map(cel).join(';'));
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="lista-${ev.id}.csv"`);
    res.send('﻿' + [cab.join(';'), ...linhasCsv].join('\r\n') + '\r\n');
  }));

  r.get('/event-list/log', tratar(async (req, res) => {
    const ev = await eventoDe(req.query.event_id);
    res.json((await q('SELECT id, sale_id, seq, person, at, actor, action, detail FROM shows_attendee_log WHERE event_id=$1 ORDER BY at DESC, id DESC LIMIT 300', [ev.id])).rows);
  }));

  // confere que a pessoa existe (a venda está no evento e tem essa posição)
  async function pessoa(run, saleId, seq) {
    const sid = idOk(saleId), n = idOk(seq);
    const s = sid && (await run('SELECT id, event_id, name, people, guests, status FROM shows_sales WHERE id=$1', [sid])).rows[0];
    if (!s || !s.event_id) throw erro(404, 'Pessoa não encontrada');
    if (!n || Number(n) < 1 || Number(n) > s.people) throw erro(404, 'Pessoa não encontrada');
    if (!OCUPAM.includes(s.status)) throw erro(409, 'Essa venda está cancelada');
    const a = (await run('SELECT * FROM shows_attendees WHERE sale_id=$1 AND seq=$2', [s.id, n])).rows[0] || {};
    const nomes = String(s.guests || '').split('\n').map((l) => l.trim()).filter(Boolean);
    const nome = a.name || nomes[Number(n) - 1] || (Number(n) === 1 ? s.name : `Acompanhante de ${s.name}`);
    return { s, seq: Number(n), a, nome };
  }
  const registrar = (event_id, sale_id, seq, person, actor, action, detail) =>
    q('INSERT INTO shows_attendee_log (event_id, sale_id, seq, person, actor, action, detail) VALUES ($1,$2,$3,$4,$5,$6,$7)', [event_id, sale_id, seq, person, actor, action, detail || null]);
  const garantir = (p) => q('INSERT INTO shows_attendees (sale_id, seq) VALUES ($1,$2) ON CONFLICT DO NOTHING', [p.s.id, p.seq]);

  // ---- edição (administrador): nome, telefone e observação da casa ----
  r.put('/event-list/:sale/:seq', tratar(async (req, res) => {
    const p = await pessoa(q, req.params.sale, req.params.seq);
    const b = req.body || {};
    const por = await ator(req);
    await garantir(p);
    const mudou = [];
    if (b.name !== undefined) {
      const v = txt(b.name, 120); if (v === null) throw erro(400, 'Nome inválido (até 120 letras)');
      await q('UPDATE shows_attendees SET name=NULLIF($3,\'\') WHERE sale_id=$1 AND seq=$2', [p.s.id, p.seq, v]); mudou.push(`nome: ${v || '(padrão)'}`);
    }
    if (b.phone !== undefined) {
      let v = null;
      if (b.phone) { v = normPhone(b.phone); if (!/^\d{8,15}$/.test(v)) throw erro(400, 'Telefone inválido'); }
      await q('UPDATE shows_attendees SET phone=$3 WHERE sale_id=$1 AND seq=$2', [p.s.id, p.seq, v]); mudou.push(`telefone: ${v || '(do comprador)'}`);
    }
    if (b.note !== undefined) {
      const v = txt(b.note, 500); if (v === null) throw erro(400, 'Observação inválida (até 500 letras)');
      await q('UPDATE shows_attendees SET note=NULLIF($3,\'\') WHERE sale_id=$1 AND seq=$2', [p.s.id, p.seq, v]); mudou.push(`observação: ${v || '(vazia)'}`);
    }
    if (mudou.length) await registrar(p.s.event_id, p.s.id, p.seq, p.nome, por, 'edicao', mudou.join(' · '));
    res.json({ ok: true });
  }));

  // ---- portaria: marcar entrada e anotar ----
  // Corpo: { entered: true|false }
  r.put('/event-list-door/:sale/:seq/entry', tratar(async (req, res) => {
    const p = await pessoa(q, req.params.sale, req.params.seq);
    if (typeof req.body?.entered !== 'boolean') throw erro(400, 'Informe se a pessoa entrou');
    const por = await ator(req);
    await garantir(p);
    await q('UPDATE shows_attendees SET entered_at = CASE WHEN $3::boolean THEN now() ELSE NULL END, entered_by = CASE WHEN $3::boolean THEN $4 ELSE NULL END WHERE sale_id=$1 AND seq=$2', [p.s.id, p.seq, req.body.entered, por]);
    await registrar(p.s.event_id, p.s.id, p.seq, p.nome, por, req.body.entered ? 'entrada' : 'entrada_desfeita', null);
    res.json({ ok: true });
  }));
  // Marca (ou desmarca) todas as pessoas de uma venda de uma vez
  r.put('/event-list-door/:sale/entry', tratar(async (req, res) => {
    if (typeof req.body?.entered !== 'boolean') throw erro(400, 'Informe se as pessoas entraram');
    const p = await pessoa(q, req.params.sale, 1);
    const por = await ator(req);
    for (let n = 1; n <= p.s.people; n++) {
      const pn = await pessoa(q, p.s.id, n);
      await garantir(pn);
      await q('UPDATE shows_attendees SET entered_at = CASE WHEN $3::boolean THEN COALESCE(entered_at, now()) ELSE NULL END, entered_by = CASE WHEN $3::boolean THEN COALESCE(entered_by, $4) ELSE NULL END WHERE sale_id=$1 AND seq=$2', [p.s.id, n, req.body.entered, por]);
      await registrar(p.s.event_id, p.s.id, n, pn.nome, por, req.body.entered ? 'entrada' : 'entrada_desfeita', 'venda inteira');
    }
    res.json({ ok: true });
  }));
  // Corpo: { note }
  r.put('/event-list-door/:sale/:seq/note', tratar(async (req, res) => {
    const p = await pessoa(q, req.params.sale, req.params.seq);
    const v = txt(req.body?.note, 500); if (v === null) throw erro(400, 'Observação inválida (até 500 letras)');
    const por = await ator(req);
    await garantir(p);
    await q('UPDATE shows_attendees SET door_note=NULLIF($3,\'\') WHERE sale_id=$1 AND seq=$2', [p.s.id, p.seq, v]);
    await registrar(p.s.event_id, p.s.id, p.seq, p.nome, por, 'observacao_portaria', v || '(apagada)');
    res.json({ ok: true });
  }));
}
