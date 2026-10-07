// Regras de uso das ferramentas do agente: caixas escritas pelo administrador da plataforma, UMA LISTA POR EMPRESA
// (cada empresa pode ter particularidades diferentes para a mesma ferramenta). Vão no FIM do prompt, depois do manual.
// Cada caixa só chega ao agente quando as condições dela estão cumpridas na empresa (módulos ligados, "Fazer agendamentos"
// ativo...), ou quando o administrador a força "sempre" ou "nunca" naquela caixa.
// Variáveis: {{agente}} {{adm}} {{empresa}}
import { qg } from './db.js';
import { isAdmin } from './auth.js';
import { moduloLigado } from './modules.js';
import { aplicarVariaveis } from './diretrizes.js';

export const FERRAMENTAS_MAX = 8000;   // soma dos textos das caixas de uma empresa
const CHAVE_MODELOS = 'agent_tools_presets';   // biblioteca de modelos da plataforma: copiada para a empresa, sem vínculo depois
export const FERRAMENTAS_SQL = 'ALTER TABLE companies ADD COLUMN IF NOT EXISTS agent_tools JSONB NOT NULL DEFAULT \'[]\'::jsonb';

// Condições que uma caixa pode exigir (todas precisam estar cumpridas). "agendamentos" é o botão "Fazer agendamentos" da Agenda.
export const CONDICOES = [
  { key: 'agenda', label: 'Agenda ligada' },
  { key: 'agendamentos', label: 'A empresa faz agendamentos' },
  { key: 'profissionais', label: 'Profissionais ligado' },
  { key: 'servicos', label: 'Produtos e Serviços ligado' },
  { key: 'fila', label: 'Fila de espera ligada' },
  { key: 'clientes', label: 'Clientes e Leads ligado' },
  { key: 'lembrete_cliente', label: 'Lembrete a pedido do cliente ligado' },
  { key: 'clube', label: 'Programa de assinaturas ligado' },
  { key: 'pedidos', label: 'Pedidos ligado' },
  { key: 'eventos', label: 'Eventos ligado' },
  { key: 'financeiro', label: 'Recebimentos ligado' },
  { key: 'assistente', label: 'Assistente pessoal ligado' },
  { key: 'campanhas', label: 'Campanhas ligado' },
  { key: 'documentos', label: 'Documentos ligado' },
  { key: 'delivery', label: 'Delivery ligado' },
  { key: 'restaurante', label: 'Restaurante ligado' },
  { key: 'casa_de_shows', label: 'Casa de Shows ligado' },
  { key: 'comissoes', label: 'Comissões ligado' },
  { key: 'beneficios', label: 'Programa de benefícios ligado' },
];
const CHAVES = CONDICOES.map((c) => c.key);

// Ferramentas conhecidas, oferecidas ao criar caixas: já aparecem as essenciais dos módulos ligados na empresa.
// Só nome e condições; o texto de cada caixa é escrito pelo administrador.
export const SUGESTOES = [
  { ref: 'consulta', title: 'Consulta ao ADM', conds: [] },
  { ref: 'agendamento', title: 'Agendamento (horários, marcar, remarcar e cancelar)', conds: ['agenda', 'agendamentos'] },
  { ref: 'espera', title: 'Lista de espera', conds: ['fila'] },
  { ref: 'clientes', title: 'Cadastro de clientes e leads', conds: ['clientes'] },
  { ref: 'lembrete', title: 'Lembrete a pedido do cliente', conds: ['lembrete_cliente'] },
  { ref: 'clube', title: 'Programa de assinaturas', conds: ['clube'] },
  { ref: 'pedidos', title: 'Pedidos', conds: ['pedidos'] },
  { ref: 'eventos', title: 'Eventos', conds: ['eventos'] },
  { ref: 'comprovantes', title: 'Comprovantes de pagamento', conds: ['financeiro'] },
  { ref: 'documentos', title: 'Documentos', conds: ['documentos'] },
  { ref: 'delivery', title: 'Delivery', conds: ['delivery'] },
  { ref: 'restaurante', title: 'Restaurante', conds: ['restaurante'] },
  { ref: 'casa_de_shows', title: 'Casa de Shows', conds: ['casa_de_shows'] },
  { ref: 'assistente', title: 'Assistente pessoal', conds: ['assistente'] },
];
const REFS = SUGESTOES.map((x) => x.ref);
const MODOS = ['auto', 'on', 'off'];   // auto: decidem as condições; on: sempre chega; off: nunca chega

const semSeparadores = (t) => String(t || '').replace(/^={5}[ \t]*\r?\n?/gm, '');

function limparCaixas(input) {
  if (!Array.isArray(input) || input.length > 60) return null;
  const vistos = new Set();
  const out = [];
  for (const b of input) {
    if (!b || typeof b !== 'object') return null;
    const id = String(b.id || '').trim();
    if (!/^[a-z0-9_-]{1,40}$/i.test(id) || vistos.has(id)) return null;
    vistos.add(id);
    const conds = Array.isArray(b.conds) ? b.conds : [];
    if (!conds.every((c) => CHAVES.includes(c))) return null;
    const mode = b.mode === undefined ? 'auto' : b.mode;
    if (!MODOS.includes(mode)) return null;
    const ref = b.ref === undefined || b.ref === '' || b.ref === null ? '' : b.ref;
    if (ref && !REFS.includes(ref)) return null;
    out.push({ id, title: String(b.title || '').trim().slice(0, 80), text: String(b.text || ''), conds: [...new Set(conds)], mode, ref });
  }
  return out;
}

function cumpre(caixa, empresa) {
  return (caixa.conds || []).every((c) => (c === 'agendamentos' ? empresa.scheduling_enabled !== false : moduloLigado(empresa.modules || {}, c)));
}
function chega(caixa, empresa) {
  if (caixa.mode === 'on') return true;
  if (caixa.mode === 'off') return false;
  return cumpre(caixa, empresa);
}

export async function textoDeFerramentas(companyId, { agente, adm }) {
  const emp = (await qg('SELECT name, modules, scheduling_enabled, agent_tools FROM companies WHERE id=$1', [companyId])).rows[0];
  if (!emp) return '';
  const partes = (emp.agent_tools || []).filter((b) => chega(b, emp) && semSeparadores(b.text).trim())
    .map((b) => `${b.title ? b.title.toUpperCase() + '\n' : ''}${semSeparadores(b.text).trim()}`);
  if (!partes.length) return '';
  return aplicarVariaveis('REGRAS DE USO DAS FERRAMENTAS:\n' + partes.join('\n\n'), { agente, adm, empresa: emp.name });
}

const carregarModelos = async () => {
  const v = (await qg('SELECT value FROM platform_settings WHERE key=$1', [CHAVE_MODELOS])).rows[0]?.value;
  return Array.isArray(v?.boxes) ? v.boxes : [];
};

export function registerFerramentasRoutes(r, wrap) {
  const soAdmin = async (req, res) => {
    if (await isAdmin(req.user.imp || req.user.id)) return true;
    res.status(403).json({ error: 'Acesso restrito ao administrador' });
    return false;
  };
  const situacao = async (companyId) => {
    const emp = (await qg('SELECT modules, scheduling_enabled, agent_tools FROM companies WHERE id=$1', [companyId])).rows[0] || {};
    const boxes = emp.agent_tools || [];
    return {
      boxes,
      active: Object.fromEntries(boxes.map((b) => [b.id, chega(b, emp)])),
      // ferramentas conhecidas: "disponivel" = os módulos dela estão ligados nesta empresa; "existe" = já há caixa para ela
      suggestions: SUGESTOES.map((x) => ({ ...x, disponivel: cumpre(x, emp), existe: boxes.some((b) => b.ref === x.ref) })),
      conditions: CONDICOES,
      max: FERRAMENTAS_MAX,
      variables: ['{{agente}}', '{{adm}}', '{{empresa}}'],
    };
  };
  r.get('/agent-tools', wrap(async (req, res) => {
    if (!(await soAdmin(req, res))) return;
    res.json(await situacao(req.user.companyId));
  }));
  r.put('/agent-tools', wrap(async (req, res) => {
    if (!(await soAdmin(req, res))) return;
    const caixas = limparCaixas((req.body || {}).boxes);
    if (!caixas) return res.status(400).json({ error: 'Caixas inválidas' });
    if (caixas.reduce((s, c) => s + c.text.length, 0) > FERRAMENTAS_MAX) return res.status(400).json({ error: `Limite de ${FERRAMENTAS_MAX} caracteres no total` });
    await qg('UPDATE companies SET agent_tools=$2::jsonb WHERE id=$1', [req.user.companyId, JSON.stringify(caixas)]);
    res.json(await situacao(req.user.companyId));
  }));
  // biblioteca de modelos: o administrador monta caixas prontas e copia para as empresas; depois de copiada, a caixa é da empresa
  r.get('/agent-tools/presets', wrap(async (req, res) => {
    if (!(await soAdmin(req, res))) return;
    res.json({ presets: await carregarModelos() });
  }));
  r.put('/agent-tools/presets', wrap(async (req, res) => {
    if (!(await soAdmin(req, res))) return;
    const caixas = limparCaixas((req.body || {}).presets);
    if (!caixas) return res.status(400).json({ error: 'Modelos inválidos' });
    const modelos = caixas.map((c) => ({ ...c, mode: 'auto' }));
    await qg(`INSERT INTO platform_settings (key, value) VALUES ($1, $2::jsonb)
              ON CONFLICT (key) DO UPDATE SET value=EXCLUDED.value, updated_at=now()`, [CHAVE_MODELOS, JSON.stringify({ boxes: modelos })]);
    res.json({ presets: modelos });
  }));
}
