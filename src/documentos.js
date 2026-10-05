// Gerador de documentos em PDF (ingresso, contrato, proposta...). Cada empresa tem modelos em HTML com variáveis {{assim}};
// o painel monta o HTML, converte em PDF no Gotenberg e devolve um link público (difícil de adivinhar) para a atendente enviar.
// Quem edita os modelos é o administrador da plataforma; a empresa vê os documentos gerados e preenche os dados fixos (nome, Pix...).
import crypto from 'crypto';
import { q, qg, runAs, currentCompany } from './db.js';
import { normPhone } from './phone.js';
import { isAdmin } from './auth.js';
import { variaveisDoIngresso, qrHtml } from './ingresso_qr.js';
import { blocosParaHtml, normalizarDoc, INGRESSO_EXEMPLO } from './doc_blocos.js';

export const DOCUMENTOS_SQL = `
  CREATE TABLE IF NOT EXISTS doc_templates (
    id         BIGSERIAL PRIMARY KEY,
    kind       TEXT NOT NULL DEFAULT 'outro' CHECK (kind IN ('ingresso','contrato','proposta','outro')),
    name       TEXT NOT NULL,
    html       TEXT NOT NULL,
    is_default BOOLEAN NOT NULL DEFAULT false,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
  );
  CREATE UNIQUE INDEX IF NOT EXISTS uq_doc_templates_default ON doc_templates (kind) WHERE is_default;
  CREATE TABLE IF NOT EXISTS doc_files (
    id          BIGSERIAL PRIMARY KEY,
    template_id BIGINT REFERENCES doc_templates(id) ON DELETE SET NULL,
    kind        TEXT NOT NULL,
    title       TEXT NOT NULL,
    number      TEXT,
    customer_id BIGINT REFERENCES customers(id) ON DELETE SET NULL,
    token       TEXT NOT NULL UNIQUE,
    pdf         BYTEA NOT NULL,
    vars        JSONB NOT NULL DEFAULT '{}',
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
  );
  CREATE INDEX IF NOT EXISTS idx_doc_files_created ON doc_files (created_at DESC);
  CREATE TABLE IF NOT EXISTS doc_settings (
    id   INT PRIMARY KEY CHECK (id = 1),
    vars JSONB NOT NULL DEFAULT '{}'
  );`;

// Ingresso de uma pessoa: guarda a venda e o evento para reaproveitar o arquivo pronto e apagá-lo quando o evento acabar
export const DOC_FILES_VENDA_SQL = `
  ALTER TABLE doc_files ADD COLUMN IF NOT EXISTS sale_id BIGINT;
  ALTER TABLE doc_files ADD COLUMN IF NOT EXISTS seq INT;
  ALTER TABLE doc_files ADD COLUMN IF NOT EXISTS event_id BIGINT;
  CREATE INDEX IF NOT EXISTS idx_doc_files_sale ON doc_files (sale_id, seq) WHERE sale_id IS NOT NULL;
  CREATE INDEX IF NOT EXISTS idx_doc_files_event ON doc_files (event_id) WHERE event_id IS NOT NULL;`;

// Modelos montados por blocos (editor visual) e logotipo da empresa para os documentos
export const DOC_BLOCOS_SQL = `
  ALTER TABLE doc_templates ADD COLUMN IF NOT EXISTS blocks JSONB;
  ALTER TABLE doc_settings ADD COLUMN IF NOT EXISTS logo TEXT;`;

const TIPOS = ['ingresso', 'contrato', 'proposta', 'outro'];
const HTML_MAX = 3 * 1024 * 1024;
const TZ = 'America/Sao_Paulo';

// ---------- variáveis e HTML ----------
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
// Trecho de HTML que vem de fora (ex.: a lista que a atendente monta): sem script, sem frames, sem eventos
export const limparHtml = (h) => String(h ?? '')
  .replace(/<\s*(script|iframe|object|embed|link|meta|base|form)\b[\s\S]*?(<\s*\/\s*\1\s*>|$)/gi, '')
  .replace(/<\s*(script|iframe|object|embed|link|meta|base|form)\b[^>]*>/gi, '')
  .replace(/\son\w+\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, '')
  .replace(/javascript\s*:/gi, '');
const NOME_VAR = '[A-Za-z_][A-Za-z0-9_]*';
export const variaveisDe = (html) => [...new Set([...String(html).matchAll(new RegExp(`\\{\\{\\{?\\s*(${NOME_VAR})\\s*\\}?\\}\\}`, 'g'))].map((m) => m[1]))];
export function renderizar(html, vars) {
  return String(html)
    .replace(new RegExp(`\\{\\{\\{\\s*(${NOME_VAR})\\s*\\}\\}\\}`, 'g'), (_, k) => limparHtml(vars[k]))
    .replace(new RegExp(`\\{\\{\\s*(${NOME_VAR})\\s*\\}\\}`, 'g'), (_, k) => esc(vars[k]))
    .replace(/<img\b[^>]*\ssrc=""[^>]*>/gi, '');   // logotipo ainda não enviado: o espaço some em vez de mostrar uma imagem quebrada
}
const partes = (d = new Date()) => Object.fromEntries(new Intl.DateTimeFormat('pt-BR', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false })
  .formatToParts(d).filter((p) => p.type !== 'literal').map((p) => [p.type, p.value === '24' ? '00' : p.value]));
// Variáveis que existem sempre, em qualquer documento
export function variaveisBase(d = new Date()) {
  const p = partes(d);
  return {
    numero: `${p.year}${p.month}${p.day}${p.hour}${p.minute}`,       // 202610041530
    numero_curto: `${p.hour}${p.minute}${p.second}`,                  // 153012
    data: `${p.day}/${p.month}/${p.year}`,
    hora: `${p.hour}:${p.minute}`,
  };
}

// ---------- Gotenberg ----------
export const gotenbergLigado = () => !!process.env.GOTENBERG_URL;
function gotenbergFetch(path, opts = {}) {
  const base = String(process.env.GOTENBERG_URL || '').replace(/\/+$/, '');
  const headers = { ...(opts.headers || {}) };
  if (process.env.GOTENBERG_USER) headers.authorization = 'Basic ' + Buffer.from(`${process.env.GOTENBERG_USER}:${process.env.GOTENBERG_PASSWORD || ''}`).toString('base64');
  return fetch(base + path, { ...opts, headers, signal: AbortSignal.timeout(opts.timeout || 60000) });
}
export async function htmlParaPdf(html) {
  const form = new FormData();
  form.append('files', new Blob([html], { type: 'text/html' }), 'index.html');
  const r = await gotenbergFetch('/forms/chromium/convert/html', { method: 'POST', body: form });
  if (!r.ok) throw new Error(`O serviço de PDF respondeu ${r.status}`);
  return Buffer.from(await r.arrayBuffer());
}
// só o endereço (sem usuário nem senha), para o administrador conferir o que o servidor está usando
const enderecoGotenberg = () => String(process.env.GOTENBERG_URL || '').replace(/\/\/[^/@]*@/, '//').replace(/\/+$/, '');
export async function testarGotenberg() {
  if (!gotenbergLigado()) return { ok: false, motivo: 'O serviço de PDF ainda não foi configurado neste servidor.' };
  try {
    const r = await gotenbergFetch('/health', { timeout: 8000 });
    if (!r.ok) return { ok: false, motivo: `O serviço de PDF respondeu ${r.status}.`, detalhe: `endereço ${enderecoGotenberg()} · resposta ${r.status}` };
    // o /health não pede senha: gera um PDF mínimo para conferir também o usuário e a senha
    try { await htmlParaPdf('<html><body>teste</body></html>'); }
    catch (e) { return { ok: false, motivo: e.message.includes('401') ? 'O serviço de PDF recusou o usuário ou a senha.' : 'O serviço de PDF está no ar, mas não conseguiu gerar um PDF de teste.', detalhe: `endereço ${enderecoGotenberg()} · ${e.message}` }; }
    return { ok: true };
  } catch (e) {
    return { ok: false, motivo: 'Não foi possível alcançar o serviço de PDF.', detalhe: `endereço ${enderecoGotenberg()} · ${e.cause?.code || e.name}: ${e.cause?.message || e.message}` };
  }
}

// ---------- modelos de exemplo ----------
const EST_BASE = `<style>body{font-family:Arial,Helvetica,sans-serif;color:#1f2937;padding:30px}h1{text-align:center;margin-bottom:4px}h3{background:#1f2937;color:#fff;padding:8px 10px;border-radius:4px;font-size:16px}table{width:100%;border-collapse:collapse;margin-bottom:18px}td{padding:9px;border-bottom:1px solid #ddd;vertical-align:top}.l{font-weight:bold;width:220px;background:#f8f8f8}.rodape{margin-top:30px;text-align:center;color:#777;font-size:13px}</style>`;
export const EXEMPLOS = [
  {
    kind: 'contrato', name: 'Termo de apresentação (exemplo)',
    html: `<!DOCTYPE html><html lang="pt-BR"><head><meta charset="UTF-8"><title>Termo de apresentação</title>${EST_BASE}</head><body>
<h1>Termo de Apresentação Musical</h1>
<h3>Dados da contratação</h3>
<table><tr><td class="l">Nº do contrato</td><td>{{numero}}</td></tr><tr><td class="l">Data da assinatura</td><td>{{data}}</td></tr><tr><td class="l">Status</td><td>RESERVADO</td></tr></table>
<h3>Contratante</h3>
<table><tr><td class="l">Nome</td><td>{{nome}}</td></tr><tr><td class="l">Telefone</td><td>{{telefone}}</td></tr></table>
<h3>Contratado</h3>
<table><tr><td class="l">Nome</td><td>{{contratado_nome}}</td></tr><tr><td class="l">Telefone</td><td>{{contratado_telefone}}</td></tr></table>
<h3>Informações do evento</h3>
<div>{{{text}}}</div>
<p>Chave Pix para pagamentos: <strong>{{chave_pix}}</strong><br>O acordado neste termo vale a partir do pagamento de 50% para a reserva da data.</p>
<h3>Condições para a apresentação</h3>
<ul><li>Hidratação e alimentação dos profissionais envolvidos.</li><li>Espaço e estrutura condizentes, livres de umidade, calor extremo e chuva.</li><li>Suprimento elétrico de 127 ou 220 volts.</li></ul>
<h3>Condições de manutenção do contrato</h3>
<ul><li>O acordo é rescindido caso alguma das partes descumpra o pactuado.</li><li>É admitido até um reagendamento pelo contratante, avisado com no mínimo 30 dias de antecedência.</li><li>No caso de rescisão unilateral sem força maior, a parte causadora paga à outra 50% do valor deste acordo.</li></ul>
<div class="rodape">{{empresa}}</div></body></html>`,
  },
  {
    kind: 'ingresso', name: 'Ingresso (exemplo)', blocks: INGRESSO_EXEMPLO,
    html: blocosParaHtml(INGRESSO_EXEMPLO, 'Ingresso'),
  },
  {
    kind: 'proposta', name: 'Proposta comercial (exemplo)',
    html: `<!DOCTYPE html><html lang="pt-BR"><head><meta charset="UTF-8"><title>Proposta</title>${EST_BASE}</head><body>
<h1>Proposta</h1><p style="text-align:center;color:#666">{{empresa}} · {{data}}</p>
<h3>Para</h3><table><tr><td class="l">Nome</td><td>{{nome}}</td></tr><tr><td class="l">Telefone</td><td>{{telefone}}</td></tr></table>
<h3>Proposta</h3><div>{{{text}}}</div>
<p>Validade: {{validade}}</p><div class="rodape">{{empresa}}</div></body></html>`,
  },
];

// ---------- validação ----------
const txt = (v, max) => { const s = String(v ?? '').trim(); return s.length <= max && !/[\u0000-\u0008\u000b-\u001f]/.test(s) ? s : null; };
const idOk = (v) => (/^\d+$/.test(String(v ?? '')) ? String(v) : null);
const ehAdmin = async (req) => !!req.user && (await isAdmin(req.user.imp || req.user.id));
function lerVars(obj) {
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return {};
  const out = {};
  for (const [k, v] of Object.entries(obj).slice(0, 60)) {
    if (!new RegExp(`^${NOME_VAR}$`).test(k)) continue;
    const s = String(v ?? '');
    if (s.length > 20000) continue;
    out[k] = s;
  }
  return out;
}

async function varsFixas() {
  return (await q('SELECT vars FROM doc_settings WHERE id=1')).rows[0]?.vars || {};
}
const LOGO_MAX = 1024 * 1024 * 1.4;   // texto do arquivo em base64 (~1 MB de imagem)
const logoOk = (v) => typeof v === 'string' && v.length <= LOGO_MAX && /^data:image\/(png|jpeg|webp|gif);base64,[A-Za-z0-9+/=]+$/.test(v);
// {{logotipo_src}} é o endereço da imagem (para blocos e modelos próprios); {{{logotipo}}} já vem como imagem pronta
async function varsLogo() {
  const logo = (await q('SELECT logo FROM doc_settings WHERE id=1')).rows[0]?.logo || '';
  return { logotipo_src: logo, logotipo: logo ? `<img src="${logo}" alt="" style="max-height:90px;max-width:100%">` : '' };
}

// ---------- rotas ----------
export function registerDocumentRoutes(r, wrap) {
  const soAdmin = (fn) => wrap(async (req, res) => {
    if (!(await ehAdmin(req))) return res.status(403).json({ error: 'Só o administrador edita os modelos de documento' });
    return fn(req, res);
  });

  r.get('/documents/status', wrap(async (req, res) => res.json({ configured: gotenbergLigado(), admin: await ehAdmin(req) })));
  r.get('/documents/health', soAdmin(async (req, res) => res.json(await testarGotenberg())));

  r.get('/documents/settings', wrap(async (req, res) => res.json({ vars: await varsFixas() })));
  r.put('/documents/settings', wrap(async (req, res) => {
    const vars = lerVars(req.body?.vars);
    await q(`INSERT INTO doc_settings (id, vars) VALUES (1, $1::jsonb) ON CONFLICT (id) DO UPDATE SET vars=EXCLUDED.vars`, [JSON.stringify(vars)]);
    res.json({ vars });
  }));

  r.get('/documents/logo', wrap(async (req, res) => res.json({ logo: (await varsLogo()).logotipo_src || null })));
  r.put('/documents/logo', wrap(async (req, res) => {
    const logo = req.body?.logo;
    if (logo !== null && !logoOk(logo)) return res.status(400).json({ error: 'Use uma imagem PNG, JPG, WebP ou GIF de até 1 MB.' });
    await q(`INSERT INTO doc_settings (id, vars, logo) VALUES (1, '{}'::jsonb, $1) ON CONFLICT (id) DO UPDATE SET logo=EXCLUDED.logo`, [logo]);
    res.json({ logo });
  }));

  r.get('/documents/templates', wrap(async (req, res) => {
    const { rows } = await q('SELECT id::text AS id, kind, name, is_default, updated_at FROM doc_templates ORDER BY kind, is_default DESC, name');
    res.json(rows);
  }));
  r.get('/documents/templates/:id', wrap(async (req, res) => {
    const id = idOk(req.params.id);
    const t = id && (await q('SELECT id::text AS id, kind, name, html, blocks, is_default FROM doc_templates WHERE id=$1', [id])).rows[0];
    if (!t) return res.status(404).json({ error: 'Modelo não encontrado' });
    res.json({ ...t, variables: variaveisDe(t.html) });
  }));
  r.post('/documents/templates/examples', soAdmin(async (req, res) => {
    let novos = 0;
    for (const e of EXEMPLOS) {
      if ((await q('SELECT 1 FROM doc_templates WHERE kind=$1 AND name=$2', [e.kind, e.name])).rowCount) continue;
      const temPadrao = (await q('SELECT 1 FROM doc_templates WHERE kind=$1 AND is_default', [e.kind])).rowCount > 0;
      await q('INSERT INTO doc_templates (kind, name, html, blocks, is_default) VALUES ($1,$2,$3,$4::jsonb,$5)', [e.kind, e.name, e.html, e.blocks ? JSON.stringify(e.blocks) : null, !temPadrao]);
      novos++;
    }
    res.json({ added: novos });
  }));

  function lerModelo(b, parcial) {
    const o = {};
    if (!parcial || b.name !== undefined) { o.name = txt(b.name, 80); if (!o.name) return { erro: 'Dê um nome ao modelo (até 80 letras)' }; }
    if (!parcial || b.kind !== undefined) { if (!TIPOS.includes(b.kind)) return { erro: 'Tipo de documento inválido' }; o.kind = b.kind; }
    if (b.blocks !== undefined && b.blocks !== null) {
      if (typeof b.blocks !== 'object') return { erro: 'Os blocos do modelo são inválidos' };
      o.blocks = normalizarDoc(b.blocks);
      o.html = blocosParaHtml(o.blocks, o.name || 'Documento');
    } else if (!parcial || b.html !== undefined) {
      o.blocks = null;
      if (typeof b.html !== 'string' || !b.html.trim()) return { erro: 'O modelo está vazio' };
      if (b.html.length > HTML_MAX) return { erro: 'O modelo é grande demais (máximo 3 MB, contando as imagens)' };
      o.html = b.html;
    }
    if (b.is_default !== undefined) o.is_default = !!b.is_default;
    return { o };
  }
  async function aplicarPadrao(id, kind) {
    await q('UPDATE doc_templates SET is_default=false WHERE kind=$1 AND id<>$2', [kind, id]);
    await q('UPDATE doc_templates SET is_default=true WHERE id=$1', [id]);
  }
  r.post('/documents/templates', soAdmin(async (req, res) => {
    const { o, erro } = lerModelo(req.body || {}, false);
    if (erro) return res.status(400).json({ error: erro });
    const id = (await q('INSERT INTO doc_templates (kind, name, html, blocks) VALUES ($1,$2,$3,$4::jsonb) RETURNING id', [o.kind, o.name, o.html, o.blocks ? JSON.stringify(o.blocks) : null])).rows[0].id;
    const tem = (await q('SELECT 1 FROM doc_templates WHERE kind=$1 AND is_default', [o.kind])).rowCount > 0;
    if (o.is_default || !tem) await aplicarPadrao(id, o.kind);
    res.status(201).json({ id: String(id) });
  }));
  r.put('/documents/templates/:id', soAdmin(async (req, res) => {
    const id = idOk(req.params.id);
    const cur = id && (await q('SELECT id, kind FROM doc_templates WHERE id=$1', [id])).rows[0];
    if (!cur) return res.status(404).json({ error: 'Modelo não encontrado' });
    const { o, erro } = lerModelo(req.body || {}, true);
    if (erro) return res.status(400).json({ error: erro });
    const kind = o.kind || cur.kind;
    if (kind !== cur.kind) await q('UPDATE doc_templates SET is_default=false WHERE id=$1', [id]);
    await q(`UPDATE doc_templates SET name=COALESCE($2,name), kind=$3, html=COALESCE($4,html), blocks=CASE WHEN $5::boolean THEN $6::jsonb ELSE blocks END, updated_at=now() WHERE id=$1`,
      [id, o.name ?? null, kind, o.html ?? null, o.html !== undefined, o.blocks ? JSON.stringify(o.blocks) : null]);
    if (o.is_default) await aplicarPadrao(id, kind);
    res.json({ ok: true });
  }));
  r.delete('/documents/templates/:id', soAdmin(async (req, res) => {
    const id = idOk(req.params.id);
    const { rowCount } = id ? await q('DELETE FROM doc_templates WHERE id=$1', [id]) : { rowCount: 0 };
    rowCount ? res.json({ ok: true }) : res.status(404).json({ error: 'Modelo não encontrado' });
  }));

  // HTML de um modelo por blocos (para quem quiser seguir editando o código)
  r.post('/documents/blocks-html', soAdmin(async (req, res) => {
    if (!req.body?.blocks || typeof req.body.blocks !== 'object') return res.status(400).json({ error: 'Blocos inválidos' });
    res.json({ html: blocosParaHtml(req.body.blocks, txt(req.body.name, 80) || 'Documento') });
  }));

  // Pré-visualização do modelo com dados de teste (o HTML volta pronto para o painel mostrar)
  r.post('/documents/preview', soAdmin(async (req, res) => {
    const html = req.body?.blocks && typeof req.body.blocks === 'object' ? blocosParaHtml(req.body.blocks) : typeof req.body?.html === 'string' ? req.body.html : '';
    if (!html || html.length > HTML_MAX) return res.status(400).json({ error: 'Modelo inválido' });
    const vars = { ...variaveisBase(), nome: 'Maria da Silva', telefone: '5532999990000', empresa: 'Sua empresa', qrcode: await qrHtml('TMI-0-0-0-000000000000', 120), codigo: 'TMI-0-0-0-000000000000', evento: 'Show de exemplo', evento_data: '10/10/2026 21:00', abertura: '10/10/2026 19:00', local: 'Casa de exemplo', setor: 'Pista', mesa: '1 × Mesa 4 lugares', pessoa: '1 de 4', text: '<ul><li>Item de exemplo: valor</li><li>Outro item: valor</li></ul>', ...(await varsLogo()), ...(await varsFixas()), ...lerVars(req.body?.vars) };
    const usadas = variaveisDe(html);
    const vazias = usadas.filter((k) => !(k in vars));
    res.json({ html: renderizar(html, vars), missing: vazias });
  }));

  // Gera o PDF: template = 'ingresso' | 'contrato' | 'proposta' | 'outro' (usa o modelo padrão do tipo) ou o id de um modelo
  // Gera o PDF: template = 'ingresso' | 'contrato' | 'proposta' | 'outro' (usa o modelo padrão do tipo) ou o id de um modelo.
  // Com sale_id (+ seq) é o ingresso de uma pessoa da lista do evento, com QR Code.
  async function gerarDocumento(req, b) {
    if (!gotenbergLigado()) return { status: 503, body: { error: 'A geração de PDF ainda não está ligada neste servidor' } };
    const alvo = String(b.template ?? '').trim();
    let t;
    if (TIPOS.includes(alvo)) t = (await q('SELECT * FROM doc_templates WHERE kind=$1 AND is_default', [alvo])).rows[0];
    else if (idOk(alvo)) t = (await q('SELECT * FROM doc_templates WHERE id=$1', [alvo])).rows[0];
    if (!t) return { status: 404, body: { error: 'Modelo de documento não encontrado' } };
    const nome = txt(b.name, 120);
    if (nome === null) return { status: 400, body: { error: 'Nome inválido' } };
    const phone = b.number || b.phone ? normPhone(b.number || b.phone) : '';
    if ((b.number || b.phone) && (phone.length < 10 || phone.length > 15)) return { status: 400, body: { error: 'Telefone inválido (use DDD + número)' } };
    let extras = {}, nomeFinal = nome, eventoId = null;
    if (b.sale_id !== undefined && b.sale_id !== null && b.sale_id !== '') {
      const ing = await variaveisDoIngresso(b.sale_id, b.seq);
      if (ing.erro) return { status: ing.erro[0], body: { error: ing.erro[1] } };
      extras = ing.vars; nomeFinal = nome || ing.nome; eventoId = ing.event_id || null;
    }
    const texto = String(b.text ?? '');
    if (texto.length > 20000) return { status: 400, body: { error: 'Texto grande demais' } };
    const empresa = (await qg('SELECT name FROM companies WHERE id=$1', [currentCompany()])).rows[0]?.name || '';
    const vars = { ...variaveisBase(), empresa, ...(await varsLogo()), ...(await varsFixas()), ...extras, ...lerVars(b.fields), nome: nomeFinal, telefone: phone || '', text: texto };
    let modelo = t.html;
    // o ingresso de uma pessoa sempre leva o QR Code: se o modelo não reservou o espaço, ele entra no fim da página
    if (extras.qrcode && !/\{\{\{?\s*qrcode\s*\}?\}\}/.test(modelo)) modelo = modelo.replace(/<\/body>/i, '<div style="text-align:center;margin:18px 0">{{{qrcode}}}<div style="font-size:11px;color:#666;margin-top:4px">{{codigo}}</div></div></body>');
    const html = renderizar(modelo, vars);
    let pdf;
    try { pdf = await htmlParaPdf(html); }
    catch (e) {
      console.error('documentos:', e.message, e.cause?.code || '', e.cause?.message || '', enderecoGotenberg());
      // o administrador da plataforma vê o motivo técnico; o cliente vê só a mensagem simples
      const detalhe = (await ehAdmin(req)) ? ` (${enderecoGotenberg()} · ${e.cause?.code || e.cause?.message || e.message})` : '';
      return { status: 502, body: { error: 'Não foi possível gerar o PDF agora. Tente de novo em instantes.' + detalhe } };
    }

    let customerId = null;
    if (phone) {
      customerId = (await q(`INSERT INTO customers (name, phone, source, status) VALUES (NULLIF($1,''),$2,$3,'lead')
                             ON CONFLICT (phone) DO UPDATE SET name=COALESCE(customers.name, EXCLUDED.name) RETURNING id`,
        [nomeFinal, phone, (req.baseUrl || '').includes('n8n') ? 'ia' : 'manual'])).rows[0].id;
      const perfil = t.kind === 'contrato' ? 'hirer' : t.kind === 'ingresso' ? 'buyer' : null;
      if (perfil) await q(`UPDATE customers SET client_kinds = CASE WHEN $2 = ANY(client_kinds) THEN client_kinds ELSE array_append(client_kinds, $2) END, status='client' WHERE id=$1`, [customerId, perfil]);
    }
    const token = `${currentCompany()}-${crypto.randomBytes(24).toString('hex')}`;
    const titulo = `${t.name}${nomeFinal ? ' — ' + nomeFinal : ''}`.slice(0, 160);
    const f = (await q(`INSERT INTO doc_files (template_id, kind, title, number, customer_id, token, pdf, vars, sale_id, seq, event_id) VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9,$10,$11) RETURNING id`,
      [t.id, t.kind, titulo, vars.numero, customerId, token, pdf, JSON.stringify({ ...lerVars(b.fields), nome: nomeFinal, telefone: phone }),
       extras.qrcode && /^\d+$/.test(String(b.sale_id ?? '')) ? b.sale_id : null, extras.qrcode ? Number(b.seq ?? 1) : null, eventoId])).rows[0];
    const base = process.env.PUBLIC_URL || `${req.headers['x-forwarded-proto'] || req.protocol}://${req.headers['x-forwarded-host'] || req.get('host')}`;
    return { status: 201, body: { id: String(f.id), kind: t.kind, number: vars.numero, filename: `${t.kind}${vars.numero}.pdf`, url: `${base.replace(/\/+$/, '')}/d/${token}.pdf` } };
  }
  gerarRef.fn = gerarDocumento;

  r.post('/documents/generate', wrap(async (req, res) => {
    const o = await gerarDocumento(req, req.body || {});
    res.status(o.status).json(o.body);
  }));

  r.get('/documents', wrap(async (req, res) => {
    const { rows } = await q(`SELECT f.id::text AS id, f.kind, f.title, f.number, f.created_at, f.token, c.name AS customer
      FROM doc_files f LEFT JOIN customers c ON c.id=f.customer_id ORDER BY f.created_at DESC LIMIT 200`);
    res.json(rows);
  }));
  r.get('/documents/:id/pdf', wrap(async (req, res) => {
    const id = idOk(req.params.id);
    const f = id && (await q('SELECT kind, number, pdf FROM doc_files WHERE id=$1', [id])).rows[0];
    if (!f) return res.status(404).json({ error: 'Documento não encontrado' });
    res.set({ 'content-type': 'application/pdf', 'content-disposition': `inline; filename="${f.kind}${f.number || ''}.pdf"` }).send(f.pdf);
  }));
  r.delete('/documents/:id', wrap(async (req, res) => {
    const id = idOk(req.params.id);
    const { rowCount } = id ? await q('DELETE FROM doc_files WHERE id=$1', [id]) : { rowCount: 0 };
    rowCount ? res.json({ ok: true }) : res.status(404).json({ error: 'Documento não encontrado' });
  }));
}

// Link público do PDF: o código tem 192 bits aleatórios, então só quem recebeu o link consegue abrir
export const gerarRef = { fn: null };   // preenchido ao registrar as rotas: outros módulos geram PDF pelo mesmo caminho

export function registerDocumentoPublico(app) {
  app.get('/d/:token.pdf', async (req, res) => {
    const m = String(req.params.token || '').match(/^(\d+)-([0-9a-f]{48})$/);
    if (!m) return res.status(404).end();
    try {
      const f = await runAs(Number(m[1]), async () => (await q('SELECT kind, number, pdf FROM doc_files WHERE token=$1', [req.params.token])).rows[0]);
      if (!f) return res.status(404).end();
      res.set({ 'content-type': 'application/pdf', 'content-disposition': `inline; filename="${f.kind}${f.number || ''}.pdf"`, 'cache-control': 'private, max-age=300' }).send(f.pdf);
    } catch (e) { console.error('documentos:', e.message); res.status(404).end(); }
  });
}


// Quando o evento termina, os ingressos em PDF dele deixam de ser guardados (contratos e propostas ficam). O QR não depende do arquivo.
export async function limparIngressosEncerrados() {
  const empresas = (await qg('SELECT id FROM companies')).rows;
  let total = 0;
  for (const e of empresas) {
    try {
      total += await runAs(e.id, async () => {
        const r = await q(`DELETE FROM doc_files WHERE kind = 'ingresso' AND event_id IN (SELECT id FROM events WHERE COALESCE(ends_at, starts_at + interval '3 hours') < now())`);
        return r.rowCount;
      });
    } catch (x) { if (!/does not exist|doc_files|event_id/.test(x.message)) console.error('limpeza de ingressos:', x.message); }
  }
  return total;
}
export function startLimpezaIngressos() {
  const passo = () => limparIngressosEncerrados().catch((x) => console.error('limpeza de ingressos:', x.message));
  setInterval(passo, 60 * 60 * 1000).unref();
  setTimeout(passo, 60000).unref();
}
