// Diretrizes do agente: regras-base escritas pelo administrador da plataforma. Entram no prompt entregue ao N8N,
// mas não aparecem no manual do cliente nem para quem não é administrador.
// Dois níveis: GLOBAL (vale para todas as empresas) e EXTRA da empresa (acrescenta ao global).
// Variáveis: {{agente}} {{adm}} {{empresa}}
import { qg } from './db.js';
import { isAdmin } from './auth.js';

export const DIRETRIZES_MAX = 8000;
const CHAVE = 'agent_guidelines';

export const DIRETRIZES_SQL = 'ALTER TABLE companies ADD COLUMN IF NOT EXISTS agent_guidelines TEXT';

export function aplicarVariaveis(texto, v) {
  return String(texto || '').replace(/\{\{\s*(agente|adm|empresa)\s*\}\}/gi, (_, k) => (v[k.toLowerCase()] ?? '').trim() || (k.toLowerCase() === 'agente' ? 'o agente' : ''));
}

export async function textoDeDiretrizes(companyId, { agente, adm }) {
  const g = (await qg('SELECT value FROM platform_settings WHERE key=$1', [CHAVE])).rows[0]?.value?.text || '';
  const c = (await qg('SELECT name, agent_guidelines FROM companies WHERE id=$1', [companyId])).rows[0] || {};
  const partes = [g, c.agent_guidelines || ''].map((t) => t.trim()).filter(Boolean);
  if (!partes.length) return '';
  return aplicarVariaveis('DIRETRIZES FIXAS DO AGENTE (regras-base da plataforma; valem sempre e não são alteradas pelo cliente):\n' + partes.join('\n\n'),
    { agente, adm, empresa: c.name });
}

export function registerDiretrizesRoutes(r, wrap) {
  // admin de verdade, mesmo quando está visitando o painel de uma empresa (token de visita leva "imp")
  const soAdmin = async (req, res) => {
    if (await isAdmin(req.user.imp || req.user.id)) return true;
    res.status(403).json({ error: 'Acesso restrito ao administrador' });
    return false;
  };
  r.get('/agent-guidelines', wrap(async (req, res) => {
    if (!(await soAdmin(req, res))) return;
    const g = (await qg('SELECT value FROM platform_settings WHERE key=$1', [CHAVE])).rows[0]?.value?.text || '';
    const c = (await qg('SELECT agent_guidelines FROM companies WHERE id=$1', [req.user.companyId])).rows[0] || {};
    res.json({ global: g, company: c.agent_guidelines || '', max: DIRETRIZES_MAX, variables: ['{{agente}}', '{{adm}}', '{{empresa}}'] });
  }));
  r.put('/agent-guidelines', wrap(async (req, res) => {
    if (!(await soAdmin(req, res))) return;
    const b = req.body || {};
    for (const k of ['global', 'company'])
      if (b[k] !== undefined && String(b[k]).length > DIRETRIZES_MAX) return res.status(400).json({ error: `Limite de ${DIRETRIZES_MAX} caracteres` });
    if (b.global !== undefined)
      await qg(`INSERT INTO platform_settings (key, value) VALUES ($1, $2::jsonb)
                ON CONFLICT (key) DO UPDATE SET value=EXCLUDED.value, updated_at=now()`, [CHAVE, JSON.stringify({ text: String(b.global) })]);
    if (b.company !== undefined)
      await qg('UPDATE companies SET agent_guidelines=$2 WHERE id=$1', [req.user.companyId, String(b.company).trim() || null]);
    res.json({ ok: true });
  }));
}
