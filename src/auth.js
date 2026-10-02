import jwt from 'jsonwebtoken';
import { qg, runAs } from './db.js';
import { matchesCompanyKey, matchesGlobalKey } from './apikeys.js';

// Autenticação do painel (JWT do usuário logado). A partir daqui, tudo roda "como" a empresa do usuário.
export async function requireUser(req, res, next) {
  const h = req.headers.authorization || '';
  const token = h.startsWith('Bearer ') ? h.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'Não autenticado' });
  let p;
  try {
    p = jwt.verify(token, process.env.JWT_SECRET);
  } catch {
    return res.status(401).json({ error: 'Sessão inválida ou expirada' });
  }
  if (!p.companyId) return res.status(401).json({ error: 'Sessão inválida ou expirada' });
  req.user = { id: p.id, companyId: p.companyId, role: p.role, imp: p.imp || null };
  // Sessão que renova com o uso: se o login tem mais de 1 dia, devolve um novo (30 dias) no cabeçalho x-new-token.
  // Quem usa o painel pelo menos uma vez por mês nunca precisa entrar de novo. Só renova se o usuário ainda existir
  // (não prolonga acesso de quem foi removido). O acesso temporário do administrador não renova.
  if (!p.imp && p.id && p.iat && Date.now() / 1000 - p.iat > RENOVAR_APOS_S) {
    try {
      const { rows } = await qg('SELECT id, company_id, role FROM users WHERE id=$1', [p.id]);
      if (rows[0] && String(rows[0].company_id) === String(p.companyId)) res.setHeader('x-new-token', signToken(rows[0]));
    } catch { /* sem renovação desta vez; a sessão atual continua valendo */ }
  }
  runAs(p.companyId, next);
}

// Autenticação das automações: x-api-key + id da empresa (x-company-id).
// A chave tem que ser a da empresa indicada no x-company-id (assim um id errado nunca age na empresa de outro).
// A chave global (N8N_API_KEY) só vale durante a transição; ALLOW_GLOBAL_KEY=false a desliga (ver src/apikeys.js).
export async function requireN8n(req, res, next) {
  const key = req.headers['x-api-key'];
  const invalid = () => res.status(401).json({ error: 'API key inválida' });
  if (!key) return invalid();
  const globalOk = matchesGlobalKey(key);
  const companyId = Number(req.headers['x-company-id'] || req.query.company_id || req.body?.company_id);
  if (!Number.isSafeInteger(companyId) || companyId <= 0)
    return globalOk ? res.status(400).json({ error: 'x-company-id obrigatório' }) : invalid();
  try {
    const c = (await qg('SELECT api_key_hash FROM companies WHERE id=$1', [companyId])).rows[0];
    // sem uma chave válida, nem a existência da empresa é revelada
    if (!c) return globalOk ? res.status(404).json({ error: 'Empresa não encontrada' }) : invalid();
    if (!globalOk && !matchesCompanyKey(key, c.api_key_hash)) return invalid();
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: 'Erro interno' });
  }
  req.user = { companyId, role: 'n8n' };
  runAs(companyId, next);
}

const RENOVAR_APOS_S = 24 * 3600;
export const signToken = (u) =>
  jwt.sign({ id: u.id, companyId: u.company_id, role: u.role }, process.env.JWT_SECRET, { expiresIn: '30d' });

// Acesso temporário do administrador ao painel de uma empresa (sem saber a senha): vale 12 horas e leva a marca "imp".
export const signImpersonationToken = (u, adminUserId) =>
  jwt.sign({ id: u.id, companyId: u.company_id, role: u.role, imp: adminUserId }, process.env.JWT_SECRET, { expiresIn: '12h' });

// Administrador da plataforma = e-mail listado em ADMIN_EMAILS (separados por vírgula)
const adminEmails = () => (process.env.ADMIN_EMAILS || '').split(',').map((e) => e.trim().toLowerCase()).filter(Boolean);

export async function isAdmin(userId) {
  const { rows } = await qg('SELECT email FROM users WHERE id=$1', [userId]);
  return !!rows[0] && adminEmails().includes(rows[0].email.toLowerCase());
}

export async function requireAdmin(req, res, next) {
  try {
    if (!(await isAdmin(req.user.id))) return res.status(403).json({ error: 'Acesso restrito ao administrador' });
    next();
  } catch (e) { console.error(e); res.status(500).json({ error: 'Erro interno' }); }
}
