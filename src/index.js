import express from 'express';
import cors from 'cors';
import bcrypt from 'bcryptjs';
import path from 'path';
import { fileURLToPath } from 'url';
import 'dotenv/config';
import { q, qg, runAs } from './db.js';
import { createCompany } from './companies.js';
import { newApiKey } from './apikeys.js';
import { cleanModules } from './modules.js';
import { requireUser, requireN8n, requireAdmin, isAdmin, signToken } from './auth.js';
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
  const company = (await qg('SELECT id,name,inactive_days,logo,modules FROM companies WHERE id=$1', [u.company_id])).rows[0];
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
  const { rows } = await qg('SELECT id,name,phone,inactive_days,logo,max_professionals,reminder_minutes,modules FROM companies WHERE id=$1', [req.user.companyId]);
  res.json(rows[0]);
});

app.put('/api/company', requireUser, async (req, res) => {
  const { name, phone, inactive_days, logo, reminder_minutes } = req.body;
  if (reminder_minutes != null && (!Number.isInteger(Number(reminder_minutes)) || Number(reminder_minutes) < 30 || Number(reminder_minutes) > 4320))
    return res.status(400).json({ error: 'Antecedência do lembrete deve ficar entre 30 minutos e 72 horas' });
  // logo: data URL de imagem, ou null para remover (string vazia = remover)
  if (logo && (!/^data:image\/(png|jpeg|webp|svg\+xml);base64,/.test(logo) || logo.length > 700000))
    return res.status(400).json({ error: 'Logotipo inválido ou grande demais' });
  const { rows } = await qg(
    `UPDATE companies SET name=COALESCE($2,name), phone=COALESCE($3,phone),
     inactive_days=COALESCE($4,inactive_days),
     logo = CASE WHEN $5::boolean THEN NULLIF($6,'') ELSE logo END,
     reminder_minutes = CASE WHEN $7::boolean THEN $8::int ELSE reminder_minutes END
     WHERE id=$1 RETURNING id,name,phone,inactive_days,logo,max_professionals,reminder_minutes,modules`,
    [req.user.companyId, name, phone, inactive_days, logo !== undefined, logo ?? null,
     reminder_minutes !== undefined, reminder_minutes == null ? null : Number(reminder_minutes)]);
  res.json(rows[0]);
});

// ---------- Administração da plataforma (só e-mails em ADMIN_EMAILS) ----------
app.get('/api/me', requireUser, async (req, res) => {
  res.json({ admin: await isAdmin(req.user.id) });
});

app.get('/api/admin/companies', requireUser, requireAdmin, async (req, res) => {
  const { rows } = await qg(
    `SELECT c.id, c.name, c.max_professionals, c.created_at, c.modules, c.api_key_hint, c.api_key_created_at,
            (SELECT u.email FROM users u WHERE u.company_id = c.id ORDER BY (u.role = 'owner') DESC, u.id LIMIT 1) AS owner_email
     FROM companies c ORDER BY c.id`);
  // profissionais ativos: contados dentro do schema de cada empresa
  for (const c of rows) {
    c.ativos = await runAs(c.id, async () => (await q('SELECT COUNT(*)::int AS n FROM professionals WHERE active')).rows[0].n);
  }
  res.json(rows);
});

app.put('/api/admin/companies/:id', requireUser, requireAdmin, async (req, res) => {
  let { max_professionals } = req.body; // null/'' = sem limite
  max_professionals = max_professionals === null || max_professionals === '' || max_professionals === undefined ? null : Number(max_professionals);
  if (max_professionals !== null && (!Number.isInteger(max_professionals) || max_professionals < 0))
    return res.status(400).json({ error: 'Limite inválido' });
  const { rows } = await qg('UPDATE companies SET max_professionals=$2 WHERE id=$1 RETURNING id, name, max_professionals', [req.params.id, max_professionals]);
  rows[0] ? res.json(rows[0]) : res.status(404).json({ error: 'Empresa não encontrada' });
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
    const { company, apiKey } = await createCompany({ name, ownerName, email, password, modules });
    res.status(201).json({ id: company.id, name: company.name, owner_email: email, modules: company.modules, api_key: apiKey });
  } catch (e) {
    if (e.code === '23505') return res.status(409).json({ error: 'E-mail já cadastrado' });
    console.error(e); res.status(500).json({ error: 'Erro interno' });
  }
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
