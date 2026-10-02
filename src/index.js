import express from 'express';
import cors from 'cors';
import bcrypt from 'bcryptjs';
import path from 'path';
import { fileURLToPath } from 'url';
import 'dotenv/config';
import { q, qg, runAs } from './db.js';
import { createCompany } from './companies.js';
import { snapshotCompany } from './templates.js';
import { pool } from './db.js';
import { newApiKey } from './apikeys.js';
import { cleanModules, cleanMenuCustom } from './modules.js';
import { listar as listarBloqueios, bloquear, liberar, numeroDoContato, nomeValido, prefixoValido, redisDisponivel } from './blocks.js';
import { requireUser, requireN8n, requireAdmin, isAdmin, signToken, signImpersonationToken } from './auth.js';
import { buildRouter } from './routes.js';

const app = express();
app.use(cors());
app.use(express.json({ limit: '4mb' }));

// ---------- Login / cadastro ----------
app.post('/api/auth/login', async (req, res) => {
  const { email, password } = req.body;
  const { rows } = await qg('SELECT * FROM users WHERE lower(email)=lower($1)', [email || '']);
  const u = rows[0];
  if (!u || !(await bcrypt.compare(password || '', u.password_hash)))
    return res.status(401).json({ error: 'E-mail ou senha incorretos' });
  const company = (await qg('SELECT id,name,inactive_days,logo,modules,menu_custom FROM companies WHERE id=$1', [u.company_id])).rows[0];
  res.json({ token: signToken(u), user: { id: u.id, name: u.name, role: u.role }, company });
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

// ---------- Configurações da empresa ----------
app.get('/api/company', requireUser, async (req, res) => {
  const { rows } = await qg('SELECT id,name,phone,inactive_days,logo,max_professionals,reminder_minutes,modules,menu_custom FROM companies WHERE id=$1', [req.user.companyId]);
  res.json(rows[0]);
});

app.put('/api/company', requireUser, async (req, res) => {
  const { name, phone, inactive_days, logo, reminder_minutes, menu_custom } = req.body;
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
     menu_custom = CASE WHEN $9::boolean THEN $10::jsonb ELSE menu_custom END
     WHERE id=$1 RETURNING id,name,phone,inactive_days,logo,max_professionals,reminder_minutes,modules,menu_custom`,
    [req.user.companyId, name, phone, inactive_days, logo !== undefined, logo ?? null,
     reminder_minutes !== undefined, reminder_minutes == null ? null : Number(reminder_minutes),
     menu !== undefined, JSON.stringify(menu ?? {})]);
  res.json(rows[0]);
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

// ---------- Administração da plataforma (só e-mails em ADMIN_EMAILS) ----------
app.get('/api/me', requireUser, async (req, res) => {
  res.json({ admin: await isAdmin(req.user.id), impersonating: !!req.user.imp });
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

app.get('/api/admin/companies', requireUser, requireAdmin, async (req, res) => {
  const { rows } = await qg(
    `SELECT c.id, c.name, c.max_professionals, c.created_at, c.modules, c.whatsapp_instance, c.redis_prefix, c.booking_mode, c.api_key_hint, c.api_key_created_at,
            (SELECT u.email FROM users u WHERE u.company_id = c.id ORDER BY (u.role = 'owner') DESC, u.id LIMIT 1) AS owner_email
     FROM companies c ORDER BY c.id`);
  // profissionais ativos: contados dentro do schema de cada empresa
  for (const c of rows) {
    c.ativos = await runAs(c.id, async () => (await q('SELECT COUNT(*)::int AS n FROM professionals WHERE active')).rows[0].n);
  }
  res.json(rows);
});

app.put('/api/admin/companies/:id', requireUser, requireAdmin, async (req, res) => {
  let { max_professionals } = req.body; // null/'' = sem limite; ausente = não mexe
  const mexeLimite = max_professionals !== undefined;
  max_professionals = max_professionals === null || max_professionals === '' || max_professionals === undefined ? null : Number(max_professionals);
  if (max_professionals !== null && (!Number.isInteger(max_professionals) || max_professionals < 0))
    return res.status(400).json({ error: 'Limite inválido' });
  const bm = req.body.booking_mode;
  if (bm !== undefined && !['auto', 'confirm'].includes(bm)) return res.status(400).json({ error: 'Modo de agendamento inválido' });
  const { rows } = await qg('UPDATE companies SET max_professionals=CASE WHEN $4::boolean THEN $2::int ELSE max_professionals END, booking_mode=COALESCE($3, booking_mode) WHERE id=$1 RETURNING id, name, max_professionals, booking_mode', [req.params.id, max_professionals, bm ?? null, mexeLimite]);
  rows[0] ? res.json(rows[0]) : res.status(404).json({ error: 'Empresa não encontrada' });
});

// "Abrir painel": o administrador entra no painel da empresa como o responsável dela, sem usar a senha.
// O acesso dura 2 horas e fica registrado (admin_access_log). Não funciona estando já dentro de outra empresa.
app.post('/api/admin/companies/:id/impersonate', requireUser, requireAdmin, async (req, res) => {
  if (req.user.imp) return res.status(403).json({ error: 'Volte à administração antes de abrir outra empresa' });
  const id = Number(req.params.id);
  if (!Number.isSafeInteger(id) || id <= 0) return res.status(404).json({ error: 'Empresa não encontrada' });
  const company = (await qg('SELECT id,name,inactive_days,logo,modules,menu_custom FROM companies WHERE id=$1', [id])).rows[0];
  if (!company) return res.status(404).json({ error: 'Empresa não encontrada' });
  const u = (await qg('SELECT * FROM users WHERE company_id=$1 ORDER BY (role = \'owner\') DESC, id LIMIT 1', [id])).rows[0];
  if (!u) return res.status(404).json({ error: 'Essa empresa não tem usuário' });
  await qg('INSERT INTO admin_access_log (admin_user_id, company_id, target_user_id) VALUES ($1,$2,$3)', [req.user.id, id, u.id]);
  res.json({ token: signImpersonationToken(u, req.user.id), user: { id: u.id, name: u.name, role: u.role }, company });
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
  try {
    let template = null;
    if (req.body.template_id) {
      template = (await qg('SELECT data FROM company_templates WHERE id=$1', [Number(req.body.template_id) || 0])).rows[0]?.data;
      if (!template) return res.status(400).json({ error: 'Modelo não encontrado' });
    }
    const { company, apiKey } = await createCompany({ name, ownerName, email, password, modules, template });
    res.status(201).json({ id: company.id, name: company.name, owner_email: email, modules: company.modules, api_key: apiKey });
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
