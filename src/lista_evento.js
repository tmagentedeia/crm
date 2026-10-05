// Lista do evento: uma linha por pessoa que vai ao evento (no lugar da planilha), montada a partir das vendas da Casa de Shows.
// Cada pessoa pode ter nome, telefone e observações próprios; a portaria marca quem entrou. Toda mudança fica registrada.
// Acessos (telas da equipe): lista_evento = só consulta · lista_evento_comentarista = marca entrada e comenta · lista_evento_editor = edita tudo.
import { q, qg, runAs, currentCompany } from './db.js';
import { normPhone } from './phone.js';
import { gerarRef, htmlParaPdf, gotenbergLigado } from './documentos.js';
import { lerCodigo } from './ingresso_qr.js';
import { podeVerTelefone } from './funcoes.js';

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

// Envio da lista pelo WhatsApp: quem recebe, se está ligado e o registro do que já foi enviado por evento
export const SHOWS_LISTA_ENVIO_SQL = `
  CREATE TABLE IF NOT EXISTS shows_list_settings (
    id      BOOLEAN PRIMARY KEY DEFAULT true CHECK (id),
    enabled BOOLEAN NOT NULL DEFAULT false,
    phones  TEXT[] NOT NULL DEFAULT '{}',
    to_admin   BOOLEAN NOT NULL DEFAULT true,
    to_company BOOLEAN NOT NULL DEFAULT false
  );
  ALTER TABLE shows_list_settings ADD COLUMN IF NOT EXISTS to_admin BOOLEAN NOT NULL DEFAULT true;
  ALTER TABLE shows_list_settings ADD COLUMN IF NOT EXISTS to_company BOOLEAN NOT NULL DEFAULT false;
  CREATE TABLE IF NOT EXISTS shows_list_dispatch (
    event_id BIGINT PRIMARY KEY REFERENCES events(id) ON DELETE CASCADE,
    sent_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    ok       BOOLEAN,
    detail   TEXT
  );`;

const OCUPAM = ['confirmed', 'attended'];
const idOk = (v) => (/^\d+$/.test(String(v ?? '')) ? String(v) : null);
const txt = (v, max) => { const s = String(v ?? '').trim(); return s.length <= max && !/[\u0000-\u0008\u000b-\u001f<>]/.test(s) ? s : null; };
const PAGAMENTO = { courtesy: 'Cortesia', paid: 'Pago', partial: 'Parcial', pending: 'Pendente', no_price: '—' };

const cel = (v) => { const s = String(v ?? ''); return /[;"\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; };
function csvDe(rows, comTelefone = true) {
  const cab = ['Nome', 'Setor', 'Mesa', ...(comTelefone ? ['Telefone'] : []), 'Valor', 'Pagamento', 'Entrou', 'Observações', 'Observações da portaria'];
  const linhasCsv = rows.map((x) => [x.name, x.sector, x.table, ...(comTelefone ? [x.phone || ''] : []), x.unit_price === null ? '' : String(x.unit_price).replace('.', ','), x.payment_label,
    x.entered_at ? 'Sim' : '', x.note, x.door_note].map(cel).join(';'));
  return '\ufeff' + [cab.join(';'), ...linhasCsv].join('\r\n') + '\r\n';
}

const esc = (v) => String(v ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
// Folha da lista (para imprimir ou ler no celular): cabeçalho do evento e uma linha por pessoa
function htmlDaLista(ev, quando, rows) {
  const entraram = rows.filter((x) => x.entered_at).length, pend = rows.filter((x) => ['pending', 'partial'].includes(x.payment)).length;
  const linhasHtml = rows.map((x, i) => `<tr><td class="n">${i + 1}</td><td><strong>${esc(x.name)}</strong>${x.note ? `<div class="o">${esc(x.note)}</div>` : ''}${x.door_note ? `<div class="o">Portaria: ${esc(x.door_note)}</div>` : ''}</td><td>${esc(x.sector)}</td><td>${esc(x.table)}</td><td class="${x.payment === 'pending' || x.payment === 'partial' ? 'pend' : ''}">${esc(x.payment_label)}</td><td class="c">${x.entered_at ? '✔' : '☐'}</td></tr>`).join('');
  return `<!DOCTYPE html><html lang="pt-BR"><head><meta charset="UTF-8"><title>Lista do evento</title><style>
body{font-family:Arial,Helvetica,sans-serif;color:#1f2937;margin:0;padding:24px;font-size:12px}h1{margin:0 0 4px;font-size:22px}.sub{color:#555;margin-bottom:10px}
.res{display:flex;gap:18px;margin:10px 0 14px;font-size:13px}.res b{font-size:16px}
table{width:100%;border-collapse:collapse}th{background:#1f2937;color:#fff;text-align:left;padding:7px 8px;font-size:11px}td{padding:6px 8px;border-bottom:1px solid #ddd;vertical-align:top}
tr:nth-child(even) td{background:#f8f8f8}.n{width:24px;color:#777}.c{text-align:center;font-size:15px}.o{color:#666;font-size:10px;margin-top:2px}.pend{color:#b45309;font-weight:bold}</style></head><body>
<h1>${esc(ev.title)}</h1><div class="sub">${esc(quando)}</div>
<div class="res"><div><b>${rows.length}</b> pessoa(s)</div><div><b>${entraram}</b> já entraram</div><div><b>${pend}</b> com pagamento pendente</div></div>
<table><thead><tr><th>#</th><th>Nome</th><th>Setor</th><th>Mesa</th><th>Pagamento</th><th>Entrou</th></tr></thead><tbody>${linhasHtml}</tbody></table></body></html>`;
}

// Conexão do WhatsApp da empresa (configurada pelo administrador do sistema): endereço do serviço e chave
async function conexaoWhats(companyId) {
  const c = (await qg('SELECT wa_api_url, wa_api_token FROM companies WHERE id=$1', [companyId])).rows[0];
  return c?.wa_api_url && c?.wa_api_token ? { base: String(c.wa_api_url).replace(/\/+$/, ''), token: c.wa_api_token } : null;
}
async function postarWhats(con, caminho, corpo) {
  const r = await fetch(con.base + caminho, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json', token: con.token }, body: JSON.stringify(corpo), signal: AbortSignal.timeout(30000) });
  if (!r.ok) throw new Error(`O WhatsApp respondeu ${r.status}`);
}
const pausa = (ms) => new Promise((ok) => setTimeout(ok, process.env.LISTA_PAUSA_RAPIDA ? 5 : ms));
let servico = null;   // preenchido por registerListaEventoRoutes

// Todo minuto: para cada empresa com o envio ligado, manda a lista dos eventos cuja casa já abriu (uma vez por evento)
export function startListaScheduler() {
  const passo = async () => {
    if (!servico) return;
    try {
      const empresas = (await qg("SELECT id FROM companies WHERE COALESCE(modules->>'casa_de_shows','true') <> 'false' AND wa_api_url IS NOT NULL AND wa_api_token IS NOT NULL")).rows;
      for (const e of empresas) await runAs(e.id, () => servico.rodar(e.id)).catch((x) => console.error('lista do evento:', x.message));
    } catch (x) { console.error('lista do evento:', x.message); }
  };
  setInterval(passo, 60000).unref();
}

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
              s.status, s.people, s.guests, s.unit_price::float AS unit_price, s.club_discount::float AS club_discount,
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
      const total = x.unit_price !== null ? x.unit_price * x.people - x.club_discount : null;
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
    const ver = await podeVerTelefone(req.user);
    const rows = (await linhas(ev.id)).map((x) => (ver ? x : { ...x, phone: null }));
    res.json({
      event: ev, rows, phone_hidden: !ver,
      summary: { people: rows.length, entered: rows.filter((x) => x.entered_at).length, pending_payment: rows.filter((x) => ['pending', 'partial'].includes(x.payment)).length },
    });
  }));

  r.get('/event-list/export', tratar(async (req, res) => {
    const ev = await eventoDe(req.query.event_id);
    const rows = await linhas(ev.id);
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="lista-${ev.id}.csv"`);
    res.send(csvDe(rows, await podeVerTelefone(req.user)));
  }));

  r.get('/event-list/log', tratar(async (req, res) => {
    const ev = await eventoDe(req.query.event_id);
    const ver = await podeVerTelefone(req.user);
    const rs = (await q('SELECT id, sale_id, seq, person, at, actor, action, detail FROM shows_attendee_log WHERE event_id=$1 ORDER BY at DESC, id DESC LIMIT 300', [ev.id])).rows;
    // quem não pode ver telefones também não vê o número que aparece no histórico das edições
    res.json(ver ? rs : rs.map((x) => (x.detail ? { ...x, detail: x.detail.replace(/telefone: [^·]*/g, 'telefone: alterado ') .trim() } : x)));
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

  // ---- edição (editor): nome, telefone e observação da casa ----
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
      if (!(await podeVerTelefone(req.user))) throw erro(403, 'Você não tem acesso aos telefones da lista');
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

  // ---- ingresso com QR Code de cada pessoa (editor) ----
  const ingressoDe = async (req, sale, seq) => {
    if (!gerarRef.fn) throw erro(503, 'A geração de PDF não está disponível');
    const o = await gerarRef.fn(req, { template: 'ingresso', sale_id: sale, seq });
    if (o.status >= 400) throw erro(o.status, o.body.error);
    return { seq, url: o.body.url, id: o.body.id };
  };
  r.post('/event-list/:sale/:seq/ticket', tratar(async (req, res) => {
    const p = await pessoa(q, req.params.sale, req.params.seq);
    res.status(201).json({ ...(await ingressoDe(req, p.s.id, p.seq)), name: p.nome });
  }));
  // todos os ingressos de uma venda, um PDF por pessoa
  r.post('/event-list/:sale/tickets', tratar(async (req, res) => {
    const p = await pessoa(q, req.params.sale, 1);
    const out = [];
    for (let n = 1; n <= p.s.people; n++) out.push({ ...(await ingressoDe(req, p.s.id, n)), name: (await pessoa(q, p.s.id, n)).nome });
    res.status(201).json({ tickets: out });
  }));

  // ---- portaria: marcar entrada e anotar ----
  // Corpo: { entered: true|false, at?: hora em que a pessoa entrou (marcada sem internet e enviada depois; até 24 h atrás) }
  r.put('/event-list-comment/:sale/:seq/entry', tratar(async (req, res) => {
    const p = await pessoa(q, req.params.sale, req.params.seq);
    if (typeof req.body?.entered !== 'boolean') throw erro(400, 'Informe se a pessoa entrou');
    const por = await ator(req);
    await garantir(p);
    const quando = new Date(req.body.at || NaN);
    const hora = !isNaN(quando) && quando <= new Date() && Date.now() - quando < 864e5 ? quando.toISOString() : null;
    await q('UPDATE shows_attendees SET entered_at = CASE WHEN $3::boolean THEN COALESCE($5::timestamptz, now()) ELSE NULL END, entered_by = CASE WHEN $3::boolean THEN $4 ELSE NULL END WHERE sale_id=$1 AND seq=$2', [p.s.id, p.seq, req.body.entered, por, hora]);
    await registrar(p.s.event_id, p.s.id, p.seq, p.nome, por, req.body.entered ? 'entrada' : 'entrada_desfeita', null);
    res.json({ ok: true });
  }));
  // Marca (ou desmarca) todas as pessoas de uma venda de uma vez
  r.put('/event-list-comment/:sale/entry', tratar(async (req, res) => {
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
  // Leitura do QR Code na portaria. Corpo: { code, event_id? }. Sempre responde 200 com { result }:
  // ok (entrada marcada agora) · ja_entrou · outro_evento · cancelado · invalido
  r.post('/event-list-comment/scan', tratar(async (req, res) => {
    const c = lerCodigo(req.body?.code);
    if (!c) return res.json({ result: 'invalido', message: 'QR Code não reconhecido' });
    if (c.company !== currentCompany()) return res.json({ result: 'invalido', message: 'Ingresso de outra empresa' });
    let p;
    try { p = await pessoa(q, c.sale, c.seq); }
    catch (e) {
      if (e.status === 409) return res.json({ result: 'cancelado', message: 'Ingresso cancelado' });
      if (e.status === 404) return res.json({ result: 'invalido', message: 'Ingresso não encontrado' });
      throw e;
    }
    const ev = (await q('SELECT id, title FROM events WHERE id=$1', [p.s.event_id])).rows[0];
    if (req.body?.event_id && String(p.s.event_id) !== String(req.body.event_id))
      return res.json({ result: 'outro_evento', message: `Ingresso de outro evento: ${ev?.title || ''}`, name: p.nome, event: ev?.title || null });
    const linha = (await linhas(p.s.event_id)).find((x) => String(x.sale_id) === String(p.s.id) && x.seq === p.seq) || {};
    const dados = { name: p.nome, sector: linha.sector, table: linha.table, payment: linha.payment, payment_label: linha.payment_label, note: linha.note || '', door_note: linha.door_note || '' };
    if (p.a.entered_at) return res.json({ result: 'ja_entrou', message: 'Esta pessoa já entrou', entered_at: p.a.entered_at, entered_by: p.a.entered_by, ...dados });
    const por = await ator(req);
    await garantir(p);
    await q('UPDATE shows_attendees SET entered_at = now(), entered_by = $3 WHERE sale_id=$1 AND seq=$2', [p.s.id, p.seq, por]);
    await registrar(p.s.event_id, p.s.id, p.seq, p.nome, por, 'entrada', 'QR Code');
    res.json({ result: 'ok', message: 'Entrada marcada', ...dados });
  }));
  // Corpo: { note }
  r.put('/event-list-comment/:sale/:seq/note', tratar(async (req, res) => {
    const p = await pessoa(q, req.params.sale, req.params.seq);
    const v = txt(req.body?.note, 500); if (v === null) throw erro(400, 'Observação inválida (até 500 letras)');
    const por = await ator(req);
    await garantir(p);
    await q('UPDATE shows_attendees SET door_note=NULLIF($3,\'\') WHERE sale_id=$1 AND seq=$2', [p.s.id, p.seq, v]);
    await registrar(p.s.event_id, p.s.id, p.seq, p.nome, por, 'comentario', v || '(apagada)');
    res.json({ ok: true });
  }));

  // ---- envio da lista pelo WhatsApp, quando a casa abre ----
  const foneValido = (v) => { const n = normPhone(v); return /^\d{12,13}$/.test(n) ? n : null; };
  // o serviço de WhatsApp recebe o celular com o 9 (como nos avisos que a empresa já envia)
  const paraEnvio = (n) => (/^55\d{2}[6-9]\d{7}$/.test(n) ? n.slice(0, 4) + '9' + n.slice(4) : n);
  // Por padrão o envio está ligado e vai para o WhatsApp do administrador (Configurações > Dados do administrador; se faltar, o telefone da empresa); a empresa pode marcar também o telefone da empresa e somar outras pessoas
  const configEnvio = async () => (await q('SELECT enabled, phones, to_admin, to_company FROM shows_list_settings WHERE id')).rows[0] || { enabled: true, phones: [], to_admin: true, to_company: false };
  const destinatarios = async (cfg) => {
    const c = (await qg('SELECT phone, admin_phone FROM companies WHERE id=$1', [currentCompany()])).rows[0] || {};
    const adm = foneValido(c.admin_phone || ''), emp = foneValido(c.phone || '');
    const a = adm || emp;   // sem WhatsApp do administrador, vale o telefone da empresa
    return { adm: a, empresa: emp, todos: [...new Set([cfg.to_admin ? a : null, cfg.to_company ? emp : null, ...cfg.phones].filter(Boolean))] };
  };
  const quandoBr = async (d) => {
    const tz = (await qg('SELECT timezone FROM companies WHERE id=$1', [currentCompany()])).rows[0]?.timezone || 'America/Sao_Paulo';
    return new Date(d).toLocaleString('pt-BR', { timeZone: tz, dateStyle: 'short', timeStyle: 'short' });
  };

  async function enviarLista(ev) {
    const con = await conexaoWhats(currentCompany());
    if (!con) throw erro(409, 'O envio pelo WhatsApp ainda não foi liberado para esta empresa');
    const cfg = await configEnvio();
    const dest = (await destinatarios(cfg)).todos;
    if (!dest.length) throw erro(409, 'Cadastre o WhatsApp do administrador em Configurações ou inclua quem recebe a lista');
    const rows = await linhas(ev.id);
    const entraram = rows.filter((x) => x.entered_at).length, pendentes = rows.filter((x) => ['pending', 'partial'].includes(x.payment)).length;
    const resumo = `Lista do evento\n*${ev.title}*\n${await quandoBr(ev.starts_at)}\n\n${rows.length} pessoa(s) · ${entraram} já entraram · ${pendentes} com pagamento pendente`;
    const csv = Buffer.from(csvDe(rows, false), 'utf8').toString('base64');
    // a folha em PDF é o formato preferido; sem o serviço de PDF, vai a planilha
    let pdf = null;
    if (gotenbergLigado()) { try { pdf = (await htmlParaPdf(htmlDaLista(ev, await quandoBr(ev.starts_at), rows))).toString('base64'); } catch (e) { console.error('lista do evento (PDF):', e.message); } }
    const nomeBase = `lista-${ev.title}`.replace(/[^\w.\- ]+/g, '').slice(0, 76) || 'lista';
    const linhasTxt = rows.map((x) => `${x.name} — ${x.sector}, ${x.table}${x.payment === 'pending' || x.payment === 'partial' ? ' (pagamento ' + x.payment_label.toLowerCase() + ')' : ''}`);
    let comPlanilha = true;
    for (const [i, n] of dest.entries()) {
      if (i) await pausa(5000);
      const numero = paraEnvio(n);
      await postarWhats(con, '/send/text', { number: numero, text: resumo + (pdf ? '\n\nA lista vai logo abaixo.' : '\n\nA planilha vai logo abaixo.'), readchat: true });
      await pausa(3000);
      try {
        await postarWhats(con, '/send/media', { number: numero, type: 'document', file: pdf || csv, docName: `${nomeBase}.${pdf ? 'pdf' : 'csv'}`, readchat: true });
      } catch (e) {
        // sem a planilha, manda os nomes em texto (em partes, devagar)
        comPlanilha = false;
        let parte = '';
        const partes = [];
        for (const l of linhasTxt) { if ((parte + l).length > 3200) { partes.push(parte); parte = ''; } parte += l + '\n'; }
        if (parte) partes.push(parte);
        for (const t of partes.slice(0, 8)) { await pausa(3000); await postarWhats(con, '/send/text', { number: numero, text: t, readchat: true }); }
      }
    }
    return { recipients: dest.length, spreadsheet: comPlanilha, people: rows.length };
  }

  async function rodar() {
    const cfg = await configEnvio();
    if (!cfg.enabled || !(await destinatarios(cfg)).todos.length) return;
    const evs = (await q(
      `SELECT e.id, e.title, e.starts_at FROM events e
       WHERE COALESCE(e.doors_at, e.starts_at) <= now() AND e.starts_at + interval '3 hours' > now()
         AND NOT EXISTS (SELECT 1 FROM shows_list_dispatch d WHERE d.event_id = e.id)
         AND EXISTS (SELECT 1 FROM shows_sales s WHERE s.event_id = e.id AND s.status = ANY($1))
       ORDER BY e.starts_at`, [OCUPAM])).rows;
    for (const ev of evs) {
      const vez = await q('INSERT INTO shows_list_dispatch (event_id) VALUES ($1) ON CONFLICT DO NOTHING RETURNING event_id', [ev.id]);
      if (!vez.rowCount) continue;
      try { const o = await enviarLista(ev); await q('UPDATE shows_list_dispatch SET ok=true, detail=$2 WHERE event_id=$1', [ev.id, o.spreadsheet ? 'planilha enviada' : 'enviado em texto']); }
      catch (e) { await q('UPDATE shows_list_dispatch SET ok=false, detail=$2 WHERE event_id=$1', [ev.id, String(e.message).slice(0, 300)]); }
    }
  }
  servico = { rodar };

  r.get('/event-list-settings', tratar(async (req, res) => {
    const cfg = await configEnvio();
    const prox = (await q(
      `SELECT e.id, e.title, COALESCE(e.doors_at, e.starts_at) AS envia_em FROM events e
       WHERE e.starts_at + interval '3 hours' > now() AND NOT EXISTS (SELECT 1 FROM shows_list_dispatch d WHERE d.event_id = e.id)
       ORDER BY e.starts_at LIMIT 1`)).rows[0] || null;
    const dest = await destinatarios(cfg);
    res.json({ enabled: cfg.enabled, phones: cfg.phones, to_admin: cfg.to_admin, to_company: cfg.to_company, admin_phone: dest.adm, company_phone: dest.empresa, recipients: dest.todos.length, connected: !!(await conexaoWhats(currentCompany())), next: prox });
  }));
  // Corpo: { enabled: true|false, phones: ['32999999999', ...] } (até 5 pessoas)
  r.put('/event-list-settings', tratar(async (req, res) => {
    if ((req.baseUrl || '').includes('n8n')) throw erro(403, 'Só pelo painel');
    const b = req.body || {};
    if (typeof b.enabled !== 'boolean') throw erro(400, 'Informe se o envio está ligado');
    const lista = Array.isArray(b.phones) ? b.phones : [];
    if (lista.length > 5) throw erro(400, 'No máximo 5 pessoas recebem a lista');
    const fones = [];
    for (const v of lista) { if (String(v ?? '').trim() === '') continue; const n = foneValido(v); if (!n) throw erro(400, `Telefone inválido: ${v} (use DDD + número)`); if (!fones.includes(n)) fones.push(n); }
    const toAdmin = b.to_admin === undefined ? true : b.to_admin === true, toCompany = b.to_company === true;
    await q(`INSERT INTO shows_list_settings (id, enabled, phones, to_admin, to_company) VALUES (true, $1, $2, $3, $4)
             ON CONFLICT (id) DO UPDATE SET enabled=$1, phones=$2, to_admin=$3, to_company=$4`, [b.enabled, fones, toAdmin, toCompany]);
    res.json({ enabled: b.enabled, phones: fones, to_admin: toAdmin, to_company: toCompany });
  }));
  // Envia agora (teste ou reenvio): Corpo { event_id }
  r.post('/event-list/send-now', tratar(async (req, res) => {
    if ((req.baseUrl || '').includes('n8n')) throw erro(403, 'Só pelo painel');
    const ev = await eventoDe(req.body?.event_id);
    try { res.json(await enviarLista(ev)); }
    catch (e) { if (e.status) throw e; throw erro(502, 'Não foi possível enviar pelo WhatsApp agora. Tente de novo em instantes.'); }
  }));
}
