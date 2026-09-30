import express from 'express';
import cors from 'cors';
import bcrypt from 'bcryptjs';
import path from 'path';
import { fileURLToPath } from 'url';
import 'dotenv/config';
import { q } from './db.js';
import { requireUser, requireN8n, requireAdmin, isAdmin, signToken } from './auth.js';
import { buildRouter } from './routes.js';

const app = express();
app.use(cors());
app.use(express.json({ limit: '4mb' }));

// ---------- Login / cadastro ----------
app.post('/api/auth/login', async (req, res) => {
  const { email, password } = req.body;
  const { rows } = await q('SELECT * FROM users WHERE lower(email)=lower($1)', [email || '']);
  const u = rows[0];
  if (!u || !(await bcrypt.compare(password || '', u.password_hash)))
    return res.status(401).json({ error: 'E-mail ou senha incorretos' });
  const salon = (await q('SELECT id,name,inactive_days,logo FROM salons WHERE id=$1', [u.salon_id])).rows[0];
  res.json({ token: signToken(u), user: { id: u.id, name: u.name, role: u.role }, salon });
});

// Cria salão + dono. Deixe ALLOW_SIGNUP=false depois de criar o seu (ou proteja com sua própria regra).
app.post('/api/auth/register', async (req, res) => {
  if (process.env.ALLOW_SIGNUP !== 'true') return res.status(403).json({ error: 'Cadastro desativado' });
  const { salon_name, name, email, password } = req.body;
  if (!salon_name || !name || !email || !password || password.length < 8)
    return res.status(400).json({ error: 'Preencha tudo (senha com 8+ caracteres)' });
  try {
    const slug = salon_name.toLowerCase().normalize('NFD').replace(/[^\w]+/g, '-').replace(/^-|-$/g, '')
      + '-' + Math.random().toString(36).slice(2, 6);
    const s = await q('INSERT INTO salons (name,slug) VALUES ($1,$2) RETURNING *', [salon_name, slug]);
    const hash = await bcrypt.hash(password, 10);
    const u = await q(
      "INSERT INTO users (salon_id,name,email,password_hash,role) VALUES ($1,$2,$3,$4,'owner') RETURNING *",
      [s.rows[0].id, name, email, hash]);
    res.status(201).json({ token: signToken(u.rows[0]), salon: s.rows[0] });
  } catch (e) {
    if (e.code === '23505') return res.status(409).json({ error: 'E-mail já cadastrado' });
    console.error(e); res.status(500).json({ error: 'Erro interno' });
  }
});

// ---------- Configurações do salão ----------
app.get('/api/salon', requireUser, async (req, res) => {
  const { rows } = await q('SELECT id,name,phone,inactive_days,logo,max_barbers FROM salons WHERE id=$1', [req.user.salonId]);
  res.json(rows[0]);
});

app.put('/api/salon', requireUser, async (req, res) => {
  const { name, phone, inactive_days, logo } = req.body;
  // logo: data URL de imagem, ou null para remover (string vazia = remover)
  if (logo && (!/^data:image\/(png|jpeg|webp|svg\+xml);base64,/.test(logo) || logo.length > 700000))
    return res.status(400).json({ error: 'Logotipo inválido ou grande demais' });
  const { rows } = await q(
    `UPDATE salons SET name=COALESCE($2,name), phone=COALESCE($3,phone),
     inactive_days=COALESCE($4,inactive_days),
     logo = CASE WHEN $5::boolean THEN NULLIF($6,'') ELSE logo END
     WHERE id=$1 RETURNING id,name,phone,inactive_days,logo,max_barbers`,
    [req.user.salonId, name, phone, inactive_days, logo !== undefined, logo ?? null]);
  res.json(rows[0]);
});

// ---------- Administração da plataforma (só e-mails em ADMIN_EMAILS) ----------
app.get('/api/me', requireUser, async (req, res) => {
  res.json({ admin: await isAdmin(req.user.id) });
});

app.get('/api/admin/salons', requireUser, requireAdmin, async (req, res) => {
  const { rows } = await q(
    `SELECT s.id, s.name, s.max_barbers, s.created_at,
            (SELECT u.email FROM users u WHERE u.salon_id = s.id ORDER BY (u.role = 'owner') DESC, u.id LIMIT 1) AS owner_email,
            (SELECT COUNT(*)::int FROM barbers b WHERE b.salon_id = s.id AND b.active) AS ativos
     FROM salons s ORDER BY s.id`);
  res.json(rows);
});

app.put('/api/admin/salons/:id', requireUser, requireAdmin, async (req, res) => {
  let { max_barbers } = req.body; // null/'' = sem limite
  max_barbers = max_barbers === null || max_barbers === '' || max_barbers === undefined ? null : Number(max_barbers);
  if (max_barbers !== null && (!Number.isInteger(max_barbers) || max_barbers < 0))
    return res.status(400).json({ error: 'Limite inválido' });
  const { rows } = await q('UPDATE salons SET max_barbers=$2 WHERE id=$1 RETURNING id, name, max_barbers', [req.params.id, max_barbers]);
  rows[0] ? res.json(rows[0]) : res.status(404).json({ error: 'Salão não encontrado' });
});

// ---------- API do painel (JWT) e do N8N (x-api-key + x-salon-id) ----------
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

app.listen(process.env.PORT || 3000, () => console.log('CRM Salão rodando na porta', process.env.PORT || 3000));
