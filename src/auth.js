import jwt from 'jsonwebtoken';
import { q } from './db.js';

// Autenticação do painel (JWT do usuário logado)
export function requireUser(req, res, next) {
  const h = req.headers.authorization || '';
  const token = h.startsWith('Bearer ') ? h.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'Não autenticado' });
  try {
    const p = jwt.verify(token, process.env.JWT_SECRET);
    req.user = { id: p.id, salonId: p.salonId, role: p.role };
    next();
  } catch {
    res.status(401).json({ error: 'Sessão inválida ou expirada' });
  }
}

// Autenticação das automações (chave fixa + id da empresa informado na chamada: x-company-id).
export function requireN8n(req, res, next) {
  if (!process.env.N8N_API_KEY || req.headers['x-api-key'] !== process.env.N8N_API_KEY) {
    return res.status(401).json({ error: 'API key inválida' });
  }
  const salonId = Number(req.headers['x-company-id'] || req.query.company_id || req.body?.company_id);
  if (!salonId) return res.status(400).json({ error: 'x-company-id obrigatório' });
  req.user = { salonId, role: 'n8n' };
  next();
}

export const signToken = (u) =>
  jwt.sign({ id: u.id, salonId: u.salon_id, role: u.role }, process.env.JWT_SECRET, { expiresIn: '7d' });

// Administrador da plataforma = e-mail listado em ADMIN_EMAILS (separados por vírgula)
const adminEmails = () => (process.env.ADMIN_EMAILS || '').split(',').map((e) => e.trim().toLowerCase()).filter(Boolean);

export async function isAdmin(userId) {
  const { rows } = await q('SELECT email FROM users WHERE id=$1', [userId]);
  return !!rows[0] && adminEmails().includes(rows[0].email.toLowerCase());
}

export async function requireAdmin(req, res, next) {
  try {
    if (!(await isAdmin(req.user.id))) return res.status(403).json({ error: 'Acesso restrito ao administrador' });
    next();
  } catch (e) { console.error(e); res.status(500).json({ error: 'Erro interno' }); }
}
