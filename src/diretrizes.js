// Diretrizes do agente: regras-base escritas pelo administrador da plataforma. Entram no prompt entregue ao N8N,
// mas não aparecem no manual do cliente nem para quem não é administrador.
// Dois níveis: GLOBAL (vale para todas as empresas) e EXTRA da empresa (acrescenta ao global).
// Variáveis: {{agente}} {{adm}} {{empresa}}
import { qg } from './db.js';
import { isAdmin } from './auth.js';
import { lerCaixas, juntarCaixas, tituloDe, acharCaixa, temSeparador } from './manualCaixas.js';

export const DIRETRIZES_MAX = 8000;
const CHAVE = 'agent_guidelines';

export const DIRETRIZES_SQL = 'ALTER TABLE companies ADD COLUMN IF NOT EXISTS agent_guidelines TEXT';

export function aplicarVariaveis(texto, v) {
  return String(texto || '').replace(/\{\{\s*(agente|adm|empresa)\s*\}\}/gi, (_, k) => (v[k.toLowerCase()] ?? '').trim() || (k.toLowerCase() === 'agente' ? 'o agente' : ''));
}

export async function textoDeDiretrizes(companyId, { agente, adm }) {
  const g = (await qg('SELECT value FROM platform_settings WHERE key=$1', [CHAVE])).rows[0]?.value?.text || '';
  const c = (await qg('SELECT name, agent_guidelines FROM companies WHERE id=$1', [companyId])).rows[0] || {};
  // as caixas do editor ficam separadas por uma linha "=====", que não vai para o agente
  const semSeparadores = (t) => String(t || '').replace(/^={5}[ \t]*\r?\n?/gm, '');
  const partes = [g, c.agent_guidelines || ''].map((t) => semSeparadores(t).trim()).filter(Boolean);
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

  // Maria (assistente pessoal): lê e troca UMA caixa das diretrizes da EMPRESA, a pedido do ADM. Só pela chave do N8N: a tela do painel
  // continua exclusiva do administrador da plataforma. A parte GLOBAL (de todas as empresas) nunca passa por aqui.
  const soN8n = (req, res) => {
    if (req.user?.role === 'n8n') return true;
    res.status(403).json({ error: 'Disponível só para o assistente pessoal' });
    return false;
  };
  const textoDaEmpresa = async (id) => (await qg('SELECT agent_guidelines FROM companies WHERE id=$1', [id])).rows[0]?.agent_guidelines || '';
  r.get('/agent-guidelines/caixas', wrap(async (req, res) => {
    if (!soN8n(req, res)) return;
    const t = await textoDaEmpresa(req.user.companyId);
    const caixas = t.trim() ? lerCaixas(t) : [];
    res.json({ total: caixas.length, caixas: caixas.map((c, i) => ({ n: i + 1, titulo: tituloDe(c) || '(vazia)' })) });
  }));
  r.get('/agent-guidelines/caixa', wrap(async (req, res) => {
    if (!soN8n(req, res)) return;
    const texto = await textoDaEmpresa(req.user.companyId);
    if (!texto.trim()) return res.status(404).json({ error: 'Esta empresa ainda não tem diretrizes próprias' });
    const caixas = lerCaixas(texto);
    const a = acharCaixa(caixas, { n: req.query.n, titulo: req.query.titulo });
    if (a.erro) return res.status(a.status).json({ error: a.erro });
    res.json({ n: a.i + 1, titulo: tituloDe(caixas[a.i]), texto: caixas[a.i] });
  }));
  // Troca o texto de uma caixa; as outras não mudam. Não há versões anteriores guardadas: a resposta traz o texto de antes.
  r.put('/agent-guidelines/caixa', wrap(async (req, res) => {
    if (!soN8n(req, res)) return;
    const texto = String(req.body?.texto ?? '').replace(/\r\n/g, '\n');
    if (!texto.trim()) return res.status(400).json({ error: 'Escreva o texto da caixa' });
    if (temSeparador(texto)) return res.status(400).json({ error: 'O texto de uma caixa não pode ter a linha de separação (=====)' });
    const atual = await textoDaEmpresa(req.user.companyId);
    if (!atual.trim()) return res.status(404).json({ error: 'Esta empresa ainda não tem diretrizes próprias' });
    const caixas = lerCaixas(atual);
    const a = acharCaixa(caixas, { n: req.body?.n, titulo: req.body?.titulo });
    if (a.erro) return res.status(a.status).json({ error: a.erro });
    const antes = caixas[a.i];
    caixas[a.i] = texto;
    const novo = juntarCaixas(caixas).trim();
    if (novo.length > DIRETRIZES_MAX) return res.status(400).json({ error: `As diretrizes passariam do limite de ${DIRETRIZES_MAX} caracteres` });
    await qg('UPDATE companies SET agent_guidelines=$2 WHERE id=$1', [req.user.companyId, novo]);
    res.json({ ok: true, n: a.i + 1, antes, depois: texto });
  }));
}
