import express from 'express';
import cors from 'cors';
import bcrypt from 'bcryptjs';
import path from 'path';
import { fileURLToPath } from 'url';
import 'dotenv/config';
import { q, qg, runAs, schemaOf } from './db.js';
import { createCompany } from './companies.js';
import { snapshotCompany } from './templates.js';
import { pool } from './db.js';
import { newApiKey } from './apikeys.js';
import { cleanModules, cleanMenuCustom, cleanModuleLabels } from './modules.js';
import { aplicacaoDoPlano } from './plans.js';
import { listar as listarBloqueios, bloquear, liberar, numeroDoContato, nomeValido, prefixoValido, redisDisponivel } from './blocks.js';
import { requireUser, requireN8n, requireAdmin, isAdmin, signToken, signImpersonationToken } from './auth.js';
import { buildRouter } from './routes.js';
import { startCampaignScheduler } from './campaigns.js';
import { startListaScheduler } from './lista_evento.js';
import { startLimpezaIngressos } from './documentos.js';
import { birthdayTickAll } from './aniversario.js';
import { registerDocumentoPublico } from './documentos.js';
import { registerIndicacoesAdmin, sincronizarTodas, usarCodigo, acharPorCodigo } from './indicacoes.js';
import { startCortesias } from './pedidos.js';
import { registerMidiaPublica } from './casa_de_shows.js';
import { nomeTabelaValido } from './conversas.js';
import { bloqueioPorFuncao, registerEquipeRoutes, acessoDe } from './funcoes.js';

const app = express();
app.use(cors());
app.use(express.json({ limit: '4mb' }));
// As respostas da API mudam conforme quem pergunta: nenhum navegador ou intermediário pode guardar e reaproveitar
app.use(['/api', '/n8n'], (req, res, next) => { res.set({ 'Cache-Control': 'no-store, private', Pragma: 'no-cache', Vary: 'Authorization' }); next(); });
// Equipe: quem tem uma função só usa as telas dela (vale para todas as rotas do painel)
app.use('/api', bloqueioPorFuncao);

// ---------- Login / cadastro ----------
app.post('/api/auth/login', async (req, res) => {
  const { email, password } = req.body;
  const { rows } = await qg('SELECT * FROM users WHERE lower(email)=lower($1)', [email || '']);
  const u = rows[0];
  if (!u || !u.active || !(await bcrypt.compare(password || '', u.password_hash)))
    return res.status(401).json({ error: 'E-mail ou senha incorretos' });
  const company = (await qg('SELECT id,name,inactive_days,logo,modules,locked_modules,menu_custom,module_labels FROM companies WHERE id=$1', [u.company_id])).rows[0];
  res.json({ token: signToken(u), user: { id: u.id, name: u.name, role: u.role }, company: await comUpgrade(company) });
});

// Cria empresa + dono. Deixe ALLOW_SIGNUP=false depois de criar a sua (ou proteja com sua própria regra).
app.post('/api/auth/register', async (req, res) => {
  if (process.env.ALLOW_SIGNUP !== 'true') return res.status(403).json({ error: 'Cadastro desativado' });
  const { company_name, name, email, password } = req.body;
  if (!company_name || !name || !email || !password || password.length < 8)
    return res.status(400).json({ error: 'Preencha tudo (senha com 8+ caracteres)' });
  try {
    const { company, user } = await createCompany({ name: company_name, ownerName: name, email, password });
    res.status(201).json({ token: signToken(user), company });
  } catch (e) {
    if (e.code === '23505') return res.status(409).json({ error: 'E-mail já cadastrado' });
    console.error(e); res.status(500).json({ error: 'Erro interno' });
  }
});


// Contato e texto do aviso de "função de outro plano" (definidos pelo administrador, valem para todas as empresas)
async function upgradeInfo() {
  const v = (await qg("SELECT value FROM platform_settings WHERE key='upgrade'")).rows[0]?.value || {};
  return { phone: String(v.phone || ''), text: String(v.text || '') };
}
// login_email: e-mail de login do responsável da empresa (vale como e-mail do administrador enquanto ele não informar outro)
const loginDaEmpresa = async (id) => (await qg("SELECT email FROM users WHERE company_id=$1 ORDER BY (role = 'owner') DESC, id LIMIT 1", [id])).rows[0]?.email || null;
const comUpgrade = async (c) => (c ? { ...c, upgrade: await upgradeInfo(), login_email: await loginDaEmpresa(c.id) } : c);

// ---------- Configurações da empresa ----------
app.get('/api/company', requireUser, async (req, res) => {
  const { rows } = await qg('SELECT id,name,phone,admin_name,admin_phone,admin_email,inactive_days,logo,max_professionals,reminder_minutes,modules,locked_modules,menu_custom,module_labels FROM companies WHERE id=$1', [req.user.companyId]);
  res.json(await comUpgrade(rows[0]));
});

app.put('/api/company', requireUser, async (req, res) => {
  const { name, phone, inactive_days, logo, reminder_minutes, menu_custom, admin_name, admin_phone, admin_email } = req.body;
  if (admin_email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(admin_email).trim())) return res.status(400).json({ error: 'E-mail do administrador inválido' });
  const adm = (v) => (v === undefined ? null : String(v ?? '').trim());
  const menu = menu_custom === undefined ? undefined : cleanMenuCustom(menu_custom);
  if (menu === null) return res.status(400).json({ error: 'Nome ou ícone do menu inválido (nome até 30 letras, ícone curto)' });
  if (reminder_minutes != null && (!Number.isInteger(Number(reminder_minutes)) || Number(reminder_minutes) < 30 || Number(reminder_minutes) > 4320))
    return res.status(400).json({ error: 'Antecedência do lembrete deve ficar entre 30 minutos e 72 horas' });
  // logo: data URL de imagem, ou null para remover (string vazia = remover)
  if (logo && (!/^data:image\/(png|jpeg|webp|svg\+xml);base64,/.test(logo) || logo.length > 700000))
    return res.status(400).json({ error: 'Logotipo inválido ou grande demais' });
  const { rows } = await qg(
    `UPDATE companies SET name=COALESCE($2,name), phone=COALESCE($3,phone),
     inactive_days=COALESCE($4,inactive_days),
     logo = CASE WHEN $5::boolean THEN NULLIF($6,'') ELSE logo END,
     reminder_minutes = CASE WHEN $7::boolean THEN $8::int ELSE reminder_minutes END,
     menu_custom = CASE WHEN $9::boolean THEN $10::jsonb ELSE menu_custom END,
     admin_name = CASE WHEN $11::text IS NULL THEN admin_name ELSE NULLIF($11,'') END,
     admin_phone = CASE WHEN $12::text IS NULL THEN admin_phone ELSE NULLIF($12,'') END,
     admin_email = CASE WHEN $13::text IS NULL THEN admin_email ELSE NULLIF($13,'') END
     WHERE id=$1 RETURNING id,name,phone,admin_name,admin_phone,admin_email,inactive_days,logo,max_professionals,reminder_minutes,modules,locked_modules,menu_custom,module_labels`,
    [req.user.companyId, name, phone, inactive_days, logo !== undefined, logo ?? null,
     reminder_minutes !== undefined, reminder_minutes == null ? null : Number(reminder_minutes),
     menu !== undefined, JSON.stringify(menu ?? {}), adm(admin_name), adm(admin_phone), adm(admin_email)]);
  res.json(await comUpgrade(rows[0]));
});

// ---------- Contatos bloqueados (painel <-> atendente) ----------
// A empresa só enxerga e altera os bloqueios da própria instância (configurada pelo administrador).
async function configBloqueios(req, res) {
  const c = (await qg('SELECT whatsapp_instance, redis_prefix FROM companies WHERE id=$1', [req.user.companyId])).rows[0];
  if (!redisDisponivel()) { res.status(503).json({ error: 'A lista de bloqueios ainda não está disponível. Fale com o suporte.' }); return null; }
  if (!c?.whatsapp_instance) { res.status(409).json({ error: 'A lista de bloqueios ainda não foi ligada ao atendimento desta empresa. Fale com o suporte.' }); return null; }
  return { instancia: c.whatsapp_instance, prefixo: c.redis_prefix || '' };
}
const falhaBloqueios = (res, e) => {
  console.error(e);
  res.status(e.code === 'SEM_REDIS' || /Redis|Connection|connect/i.test(e.message) ? 503 : 500)
    .json({ error: 'Não foi possível falar com a lista de bloqueios agora. Tente de novo em instantes.' });
};

app.get('/api/blocks', requireUser, async (req, res) => {
  const cfg = await configBloqueios(req, res); if (!cfg) return;
  try {
    const itens = await listarBloqueios(cfg);
    const nomes = itens.length
      ? (await q('SELECT name, phone FROM customers WHERE phone = ANY($1::text[])', [itens.map((i) => i.id)])).rows
      : [];
    const porTel = new Map(nomes.map((n) => [n.phone, n.name]));
    res.json(itens.map((i) => ({ ...i, nome: porTel.get(i.id) || null })));
  } catch (e) { falhaBloqueios(res, e); }
});

app.post('/api/blocks', requireUser, async (req, res) => {
  const cfg = await configBloqueios(req, res); if (!cfg) return;
  const id = numeroDoContato(req.body.phone);
  if (!id) return res.status(400).json({ error: 'Telefone inválido. Digite com DDD, por exemplo (32) 99999-9999' });
  const duracao = req.body.duration === 'forever' ? 'sempre' : req.body.duration === '24h' ? '24h' : null;
  if (!duracao) return res.status(400).json({ error: 'Escolha bloquear por 24 horas ou para sempre' });
  try { await bloquear(cfg, id, duracao); res.status(201).json({ id }); } catch (e) { falhaBloqueios(res, e); }
});

app.delete('/api/blocks/:id', requireUser, async (req, res) => {
  const cfg = await configBloqueios(req, res); if (!cfg) return;
  if (!/^[0-9A-Za-z]{5,30}$/.test(req.params.id)) return res.status(400).json({ error: 'Contato inválido' });
  try { await liberar(cfg, req.params.id); res.json({ ok: true }); } catch (e) { falhaBloqueios(res, e); }
});

// Administração: instância do WhatsApp e prefixo dos bloqueios da empresa
app.put('/api/admin/companies/:id/blocks-config', requireUser, requireAdmin, async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isSafeInteger(id) || id <= 0) return res.status(404).json({ error: 'Empresa não encontrada' });
  const instancia = String(req.body.whatsapp_instance ?? '').trim();
  const prefixo = String(req.body.redis_prefix ?? '').trim().replace(/:+$/, ''); // o ":" final é acrescentado pelo painel
  if (instancia && !nomeValido(instancia)) return res.status(400).json({ error: 'Nome da instância inválido (use letras, números, - _ . :)' });
  if (!prefixoValido(prefixo)) return res.status(400).json({ error: 'Prefixo inválido (use letras, números, - _ . :)' });
  const { rows } = await qg(
    'UPDATE companies SET whatsapp_instance=NULLIF($2,\'\'), redis_prefix=$3 WHERE id=$1 RETURNING id, whatsapp_instance, redis_prefix', [id, instancia, prefixo]);
  rows[0] ? res.json(rows[0]) : res.status(404).json({ error: 'Empresa não encontrada' });
});

// Administração: tabela com o histórico de conversas do agente (alimenta os atendimentos do dashboard)
app.put('/api/admin/companies/:id/chat-table', requireUser, requireAdmin, async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isSafeInteger(id) || id <= 0) return res.status(404).json({ error: 'Empresa não encontrada' });
  const tabela = String(req.body.chat_table ?? '').trim();
  if (tabela && !nomeTabelaValido(tabela)) return res.status(400).json({ error: 'Nome da tabela inválido (use letras, números e _)' });
  const { rows } = await qg('UPDATE companies SET chat_table=NULLIF($2,\'\') WHERE id=$1 RETURNING id, chat_table', [id, tabela]);
  rows[0] ? res.json(rows[0]) : res.status(404).json({ error: 'Empresa não encontrada' });
});

// Administração: endereço do fluxo de envio de campanhas da empresa (o painel aciona este endereço a cada envio)
app.put('/api/admin/companies/:id/campaign-webhook', requireUser, requireAdmin, async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isSafeInteger(id) || id <= 0) return res.status(404).json({ error: 'Empresa não encontrada' });
  const url = String(req.body.url ?? '').trim();
  if (url) {
    let ok = url.length <= 500;
    try { const u = new URL(url); ok = ok && (u.protocol === 'https:' || u.protocol === 'http:'); } catch { ok = false; }
    if (!ok) return res.status(400).json({ error: 'Endereço inválido (use um endereço completo, começando com https://)' });
  }
  const { rows } = await qg("UPDATE companies SET campaign_webhook_url=NULLIF($2,'') WHERE id=$1 RETURNING id, campaign_webhook_url", [id, url]);
  rows[0] ? res.json(rows[0]) : res.status(404).json({ error: 'Empresa não encontrada' });
});

// Administração: conexão do WhatsApp da empresa para avisos enviados pelo painel (endereço do serviço e chave; a chave nunca volta nas respostas)
app.put('/api/admin/companies/:id/whatsapp', requireUser, requireAdmin, async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isSafeInteger(id) || id <= 0) return res.status(404).json({ error: 'Empresa não encontrada' });
  const url = String(req.body.url ?? '').trim().replace(/\/+$/, '');
  const token = String(req.body.token ?? '').trim();
  if (url) {
    let ok = url.length <= 300;
    try { const u = new URL(url); ok = ok && (u.protocol === 'https:' || u.protocol === 'http:'); } catch { ok = false; }
    if (!ok) return res.status(400).json({ error: 'Endereço inválido (use um endereço completo, começando com https://)' });
  }
  if (token.length > 200 || /\s/.test(token)) return res.status(400).json({ error: 'Chave inválida' });
  // sem endereço = desliga; chave em branco = mantém a atual
  const { rows } = await qg(
    `UPDATE companies SET wa_api_url = NULLIF($2,''), wa_api_token = CASE WHEN $2 = '' THEN NULL WHEN $3 <> '' THEN $3 ELSE wa_api_token END WHERE id=$1 RETURNING id, wa_api_url, (wa_api_token IS NOT NULL) AS wa_api_set, right(wa_api_token, 4) AS wa_api_fim`, [id, url, token]);
  rows[0] ? res.json(rows[0]) : res.status(404).json({ error: 'Empresa não encontrada' });
});

// ---------- Administração da plataforma (só e-mails em ADMIN_EMAILS) ----------
app.get('/api/me', requireUser, async (req, res) => {
  const acc = req.user.role === 'staff' && !req.user.imp ? await acessoDe(req.user.id) : null;
  res.json({ admin: await isAdmin(req.user.id), impersonating: !!req.user.imp, equipe: acc ? { telas: acc.telas, inicio: acc.inicio, funcao: acc.funcao } : null });
});

// Versão no ar: início do servidor (= hora do deploy) e, se a hospedagem informar, o código da versão.
const NO_AR_DESDE = new Date().toISOString();
app.get('/api/admin/version', requireUser, requireAdmin, (req, res) => {
  const c = String(process.env.SOURCE_COMMIT || '').trim();
  res.json({ commit: c ? c.slice(0, 7) : null, started_at: NO_AR_DESDE });
});

// Últimos acessos do administrador ao painel de empresas ("Abrir painel")
app.get('/api/admin/access-log', requireUser, requireAdmin, async (req, res) => {
  const { rows } = await qg(
    `SELECT l.id, l.created_at, l.company_id, c.name AS company_name, a.email AS admin_email
     FROM admin_access_log l
     LEFT JOIN companies c ON c.id = l.company_id
     LEFT JOIN users a ON a.id = l.admin_user_id
     ORDER BY l.id DESC LIMIT 50`);
  res.json(rows);
});

registerIndicacoesAdmin(app, requireUser, requireAdmin);
registerEquipeRoutes(app, requireUser);
// Conferência de quem é quem: para cada empresa, o responsável (e-mail do login), o nome do agente e o manual publicado no banco.
// Serve para apontar de onde vem um dado que parece estar na empresa errada.
app.get('/api/admin/diagnostico', requireUser, requireAdmin, async (req, res) => {
  const cs = (await qg('SELECT id, name, created_at, agent_name, adm_name FROM companies ORDER BY id')).rows;
  const out = [];
  for (const c of cs) {
    const item = { id: c.id, name: c.name, created_at: c.created_at, donos: [], agente: c.agent_name || null, adm: c.adm_name || null, manual_publicado_em: null, manual_inicio: null };
    try {
      item.donos = (await qg("SELECT email, role FROM users WHERE company_id=$1 ORDER BY (role = 'owner') DESC, id LIMIT 5", [c.id])).rows;
      const s = schemaOf(c.id);
      item.manual_publicado_em = (await qg(`SELECT max(published_at) AS t FROM ${s}.agent_manual_versions`)).rows[0]?.t || null;
      item.clientes = (await qg(`SELECT count(*)::int AS n FROM ${s}.customers`)).rows[0].n;
      item.eventos = (await qg(`SELECT count(*)::int AS n FROM ${s}.events`).catch(() => ({ rows: [{ n: null }] }))).rows[0].n;
      const m = (await qg(`SELECT content FROM ${s}.agent_manual_versions WHERE published_at IS NOT NULL ORDER BY published_at DESC, id DESC LIMIT 1`)).rows[0];
      item.manual_inicio = m ? String(m.content).replace(/\s+/g, ' ').slice(0, 80) : null;
    } catch (e) { item.erro = e.message.slice(0, 120); }
    out.push(item);
  }
  res.json(out);
});

app.get('/api/admin/companies', requireUser, requireAdmin, async (req, res) => {
  const { rows } = await qg(
    `SELECT c.id, c.name, c.max_professionals, c.doc_slots, c.billing_due_day, c.billing_exempt, (SELECT count(*) FROM partner_referrals pr WHERE pr.company_id=c.id)::int AS referrals_total, c.created_at, c.modules, c.locked_modules, c.module_labels, c.whatsapp_instance, c.chat_table, c.redis_prefix, c.campaign_webhook_url, c.wa_api_url, (c.wa_api_token IS NOT NULL) AS wa_api_set, right(c.wa_api_token, 4) AS wa_api_fim, c.booking_mode, c.api_key_hint, c.api_key_created_at,
            (SELECT u.email FROM users u WHERE u.company_id = c.id ORDER BY (u.role = 'owner') DESC, u.id LIMIT 1) AS owner_email
     FROM companies c ORDER BY c.id`);
  // profissionais ativos: contados dentro do schema de cada empresa
  for (const c of rows) {
    c.ativos = await runAs(c.id, async () => (await q('SELECT COUNT(*)::int AS n FROM professionals WHERE active')).rows[0].n);
  }
  res.json(rows);
});

// Troca o e-mail de login do responsável da empresa; exige uma senha nova junto.
app.put('/api/admin/companies/:id/owner', requireUser, requireAdmin, async (req, res) => {
  const email = String(req.body.email || '').trim().toLowerCase();
  const password = String(req.body.password || '');
  if (!/^\S+@\S+\.\S+$/.test(email)) return res.status(400).json({ error: 'E-mail inválido' });
  if (password.length < 8) return res.status(400).json({ error: 'A senha nova precisa ter ao menos 8 caracteres' });
  const u = (await qg(`SELECT id, email FROM users WHERE company_id=$1 ORDER BY (role='owner') DESC, id LIMIT 1`, [req.params.id])).rows[0];
  if (!u) return res.status(404).json({ error: 'Responsável não encontrado' });
  // quem é administrador é reconhecido pelo e-mail: não deixa trocar de um jeito que tire o acesso à Administração
  const admins = (process.env.ADMIN_EMAILS || '').split(',').map((x) => x.trim().toLowerCase()).filter(Boolean);
  if (admins.includes(u.email.toLowerCase()) && !admins.includes(email))
    return res.status(409).json({ error: 'Este é um e-mail de administrador. Para não perder o acesso à Administração, inclua primeiro o novo e-mail na lista de administradores do servidor (ADMIN_EMAILS) e só depois faça a troca.' });
  try {
    await qg('UPDATE users SET email=$2, password_hash=$3 WHERE id=$1', [u.id, email, await bcrypt.hash(password, 10)]);
  } catch (e) {
    if (e.code === '23505') return res.status(409).json({ error: 'Já existe um usuário com este e-mail' });
    throw e;
  }
  res.json({ id: Number(req.params.id), owner_email: email });
});

app.put('/api/admin/companies/:id', requireUser, requireAdmin, async (req, res) => {
  let { max_professionals } = req.body; // null/'' = sem limite; ausente = não mexe
  const mexeLimite = max_professionals !== undefined;
  max_professionals = max_professionals === null || max_professionals === '' || max_professionals === undefined ? null : Number(max_professionals);
  if (max_professionals !== null && (!Number.isInteger(max_professionals) || max_professionals < 0))
    return res.status(400).json({ error: 'Limite inválido' });
  // vagas de documento: vazio = sem limite; ausente = não mexe
  const mexeVagas = req.body.doc_slots !== undefined;
  const docSlots = req.body.doc_slots === null || req.body.doc_slots === '' || req.body.doc_slots === undefined ? null : Number(req.body.doc_slots);
  if (docSlots !== null && (!Number.isInteger(docSlots) || docSlots < 0 || docSlots > 4)) return res.status(400).json({ error: 'Vagas de documento inválidas (de 0 a 4, ou vazio para sem limite)' });
  const bm = req.body.booking_mode;
  if (bm !== undefined && !['auto', 'confirm'].includes(bm)) return res.status(400).json({ error: 'Modo de agendamento inválido' });
  const { rows } = await qg('UPDATE companies SET max_professionals=CASE WHEN $4::boolean THEN $2::int ELSE max_professionals END, booking_mode=COALESCE($3, booking_mode), doc_slots=CASE WHEN $5::boolean THEN $6::int ELSE doc_slots END WHERE id=$1 RETURNING id, name, max_professionals, doc_slots, booking_mode', [req.params.id, max_professionals, bm ?? null, mexeLimite, mexeVagas, docSlots]);
  rows[0] ? res.json(rows[0]) : res.status(404).json({ error: 'Empresa não encontrada' });
});

// "Abrir painel": o administrador entra no painel da empresa como o responsável dela, sem usar a senha.
// O acesso dura 2 horas e fica registrado (admin_access_log). Não funciona estando já dentro de outra empresa.
app.post('/api/admin/companies/:id/impersonate', requireUser, requireAdmin, async (req, res) => {
  if (req.user.imp) return res.status(403).json({ error: 'Volte à administração antes de abrir outra empresa' });
  const id = Number(req.params.id);
  if (!Number.isSafeInteger(id) || id <= 0) return res.status(404).json({ error: 'Empresa não encontrada' });
  const company = (await qg('SELECT id,name,inactive_days,logo,modules,locked_modules,menu_custom,module_labels FROM companies WHERE id=$1', [id])).rows[0];
  if (!company) return res.status(404).json({ error: 'Empresa não encontrada' });
  const u = (await qg('SELECT * FROM users WHERE company_id=$1 ORDER BY (role = \'owner\') DESC, id LIMIT 1', [id])).rows[0];
  if (!u) return res.status(404).json({ error: 'Essa empresa não tem usuário' });
  await qg('INSERT INTO admin_access_log (admin_user_id, company_id, target_user_id) VALUES ($1,$2,$3)', [req.user.id, id, u.id]);
  res.json({ token: signImpersonationToken(u, req.user.id), user: { id: u.id, name: u.name, role: u.role }, company: await comUpgrade(company) });
});

// Gera (ou regenera) a chave de integração da empresa. A chave em texto só aparece nesta resposta;
// no banco fica só o hash. Regenerar invalida a chave anterior na hora.
app.post('/api/admin/companies/:id/api-key', requireUser, requireAdmin, async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isSafeInteger(id) || id <= 0) return res.status(404).json({ error: 'Empresa não encontrada' });
  const k = newApiKey();
  const { rows } = await qg(
    'UPDATE companies SET api_key_hash=$2, api_key_hint=$3, api_key_created_at=now() WHERE id=$1 RETURNING id, name, api_key_created_at',
    [id, k.hash, k.hint]);
  rows[0] ? res.json({ ...rows[0], api_key: k.key }) : res.status(404).json({ error: 'Empresa não encontrada' });
});

// Cria uma empresa nova: empresa + dono + schema + chave de integração, já com os módulos escolhidos.
// A chave em texto só aparece nesta resposta.
app.post('/api/admin/companies', requireUser, requireAdmin, async (req, res) => {
  const name = String(req.body.name || '').trim();
  const ownerName = String(req.body.owner_name || '').trim();
  const email = String(req.body.email || '').trim().toLowerCase();
  const password = String(req.body.password || '');
  const modules = cleanModules(req.body.modules ?? {});
  if (!name || !ownerName || !/^\S+@\S+\.\S+$/.test(email) || password.length < 8)
    return res.status(400).json({ error: 'Preencha o nome da empresa, o nome e o e-mail do responsável e uma senha com 8 ou mais caracteres' });
  if (!modules) return res.status(400).json({ error: 'Módulos inválidos' });
  const codigo = String(req.body.referral_code || '').trim();
  if (codigo) {
    if (!(await acharPorCodigo(codigo))) return res.status(400).json({ error: 'Código de indicação não encontrado' });
  }
  try {
    let template = null;
    if (req.body.template_id) {
      template = (await qg('SELECT data FROM company_templates WHERE id=$1', [Number(req.body.template_id) || 0])).rows[0]?.data;
      if (!template) return res.status(400).json({ error: 'Modelo não encontrado' });
    }
    const { company, apiKey } = await createCompany({ name, ownerName, email, password, modules, template });
    let indicada = null;
    if (codigo) indicada = await usarCodigo(codigo, name).catch((e) => { console.error('indicações:', e.message); return null; });
    res.status(201).json({ id: company.id, name: company.name, owner_email: email, modules: company.modules, api_key: apiKey, indicada_por: indicada?.indicadoPor || null });
  } catch (e) {
    if (e.code === '23505') return res.status(409).json({ error: 'E-mail já cadastrado' });
    console.error(e); res.status(500).json({ error: 'Erro interno' });
  }
});

// ---------- Menu padrão das empresas novas ----------
// Vale só para empresa criada SEM modelo; empresas já existentes e as criadas de um modelo não mudam.
app.get('/api/admin/default-menu', requireUser, requireAdmin, async (req, res) => {
  const v = (await qg("SELECT value FROM platform_settings WHERE key='default_menu'")).rows[0]?.value;
  res.json(v || { menu_custom: {}, from_company_name: null });
});

app.put('/api/admin/default-menu', requireUser, requireAdmin, async (req, res) => {
  if (req.body.clear) {
    await qg("DELETE FROM platform_settings WHERE key='default_menu'");
    return res.json({ menu_custom: {}, from_company_name: null });
  }
  const id = Number(req.body.company_id);
  const c = Number.isSafeInteger(id) && id > 0 ? (await qg('SELECT id, name, menu_custom FROM companies WHERE id=$1', [id])).rows[0] : null;
  if (!c) return res.status(404).json({ error: 'Empresa não encontrada' });
  const value = { menu_custom: c.menu_custom || {}, from_company_id: c.id, from_company_name: c.name };
  await qg(`INSERT INTO platform_settings (key, value) VALUES ('default_menu', $1::jsonb)
            ON CONFLICT (key) DO UPDATE SET value=EXCLUDED.value, updated_at=now()`, [JSON.stringify(value)]);
  res.json(value);
});

// ---------- Modelos de empresa ----------
app.get('/api/admin/templates', requireUser, requireAdmin, async (req, res) => {
  const { rows } = await qg('SELECT id, name, description, created_at, data FROM company_templates ORDER BY name');
  res.json(rows.map(({ data, ...t }) => ({ ...t, modules: data.modules || {},
    categorias: (data.categories || []).length, servicos: (data.services || []).length, tem_manual: !!data.manual })));
});

// "Salvar como modelo": guarda a estrutura de uma empresa existente (sem nenhum dado de cliente)
app.post('/api/admin/templates', requireUser, requireAdmin, async (req, res) => {
  const name = String(req.body.name || '').trim();
  const description = String(req.body.description || '').trim() || null;
  const companyId = Number(req.body.company_id);
  if (!name) return res.status(400).json({ error: 'Dê um nome ao modelo' });
  if (!Number.isSafeInteger(companyId) || companyId <= 0) return res.status(404).json({ error: 'Empresa não encontrada' });
  const cx = await pool.connect();
  try {
    const data = await snapshotCompany(companyId, cx);
    if (!data) return res.status(404).json({ error: 'Empresa não encontrada' });
    const { rows } = await qg('INSERT INTO company_templates (name, description, data) VALUES ($1,$2,$3) RETURNING id, name', [name, description, JSON.stringify(data)]);
    res.status(201).json(rows[0]);
  } catch (e) {
    if (e.code === '23505') return res.status(409).json({ error: 'Já existe um modelo com esse nome' });
    console.error(e); res.status(500).json({ error: 'Erro interno' });
  } finally { cx.release(); }
});

app.delete('/api/admin/templates/:id', requireUser, requireAdmin, async (req, res) => {
  await qg('DELETE FROM company_templates WHERE id=$1', [Number(req.params.id) || 0]);
  res.json({ ok: true });
});

// Liga e desliga os módulos de uma empresa (só os informados mudam; os demais ficam como estão).
app.put('/api/admin/companies/:id/modules', requireUser, requireAdmin, async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isSafeInteger(id) || id <= 0) return res.status(404).json({ error: 'Empresa não encontrada' });
  const modules = cleanModules(req.body.modules);
  if (!modules) return res.status(400).json({ error: 'Módulos inválidos' });
  const { rows } = await qg('UPDATE companies SET modules = modules || $2::jsonb WHERE id=$1 RETURNING id, name, modules', [id, JSON.stringify(modules)]);
  rows[0] ? res.json(rows[0]) : res.status(404).json({ error: 'Empresa não encontrada' });
});

// Aplica um plano (starter, pro ou advanced): liga os módulos dele, desliga os demais e deixa os de fora à vista, apagados.
// O limite de profissionais e as demais configurações da empresa não mudam.
app.put('/api/admin/companies/:id/plan', requireUser, requireAdmin, async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isSafeInteger(id) || id <= 0) return res.status(404).json({ error: 'Empresa não encontrada' });
  const ap = aplicacaoDoPlano(String(req.body.plan ?? ''));
  if (!ap) return res.status(400).json({ error: 'Plano inválido' });
  const { rows } = await qg('UPDATE companies SET modules = modules || $2::jsonb, locked_modules = $3::jsonb WHERE id=$1 RETURNING id, name, modules, locked_modules, max_professionals',
    [id, JSON.stringify(ap.modules), JSON.stringify(ap.locks)]);
  rows[0] ? res.json(rows[0]) : res.status(404).json({ error: 'Empresa não encontrada' });
});

// Funções desligadas que continuam aparecendo apagadas (com cadeado) no painel da empresa, convidando ao upgrade.
app.put('/api/admin/companies/:id/locks', requireUser, requireAdmin, async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isSafeInteger(id) || id <= 0) return res.status(404).json({ error: 'Empresa não encontrada' });
  const locks = cleanModules(req.body.locks);
  if (!locks) return res.status(400).json({ error: 'Funções inválidas' });
  const { rows } = await qg('UPDATE companies SET locked_modules = locked_modules || $2::jsonb WHERE id=$1 RETURNING id, name, locked_modules', [id, JSON.stringify(locks)]);
  rows[0] ? res.json(rows[0]) : res.status(404).json({ error: 'Empresa não encontrada' });
});

// Contato (WhatsApp) e texto do aviso de upgrade
app.get('/api/admin/upgrade', requireUser, requireAdmin, async (req, res) => res.json(await upgradeInfo()));
app.put('/api/admin/upgrade', requireUser, requireAdmin, async (req, res) => {
  const phone = String(req.body.phone ?? '').replace(/\D/g, '');
  const text = String(req.body.text ?? '').trim();
  if (phone.length > 15) return res.status(400).json({ error: 'Telefone inválido' });
  if (text.length > 300 || /[<>]/.test(text)) return res.status(400).json({ error: 'Texto inválido (até 300 letras, sem < ou >)' });
  await qg(`INSERT INTO platform_settings (key, value) VALUES ('upgrade', $1::jsonb)
            ON CONFLICT (key) DO UPDATE SET value=EXCLUDED.value, updated_at=now()`, [JSON.stringify({ phone, text })]);
  res.json({ phone, text });
});

// Nomes que a empresa dá às coisas de um módulo (ex.: "Live" vira "Loja"). Só muda o texto das telas.
app.put('/api/admin/companies/:id/labels', requireUser, requireAdmin, async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isSafeInteger(id) || id <= 0) return res.status(404).json({ error: 'Empresa não encontrada' });
  const labels = cleanModuleLabels(req.body.labels);
  if (!labels) return res.status(400).json({ error: 'Nomes inválidos (até 30 letras cada, sem < ou >)' });
  const { rows } = await qg('UPDATE companies SET module_labels=$2::jsonb WHERE id=$1 RETURNING id, name, module_labels', [id, JSON.stringify(labels)]);
  rows[0] ? res.json(rows[0]) : res.status(404).json({ error: 'Empresa não encontrada' });
});

registerDocumentoPublico(app);
registerMidiaPublica(app);

// ---------- API do painel (JWT) e do N8N (x-api-key + x-company-id) ----------
app.use('/api', requireUser, buildRouter());
app.use('/n8n', requireN8n, buildRouter());

// ---------- Frontend (build do React em /public) ----------
const dir = path.dirname(fileURLToPath(import.meta.url));
const pub = path.join(dir, '..', 'public');
app.use(express.static(pub));
app.get('*', (req, res, next) => {
  if (req.path.startsWith('/api') || req.path.startsWith('/n8n')) return next();
  res.sendFile(path.join(pub, 'index.html'), (err) => err && next());
});

app.listen(process.env.PORT || 3000, () => console.log('CRM rodando na porta', process.env.PORT || 3000));
startCampaignScheduler();
startListaScheduler();
startLimpezaIngressos();
// aniversariantes: confere de hora em hora (a fila de cada empresa é montada no máximo uma vez por dia)
setTimeout(birthdayTickAll, 20000).unref();
setTimeout(sincronizarTodas, 30000).unref();
setInterval(sincronizarTodas, 3600000).unref();
setInterval(birthdayTickAll, Math.max(Number(process.env.BIRTHDAY_TICK_MS) || 3600000, 500)).unref();
startCortesias();
