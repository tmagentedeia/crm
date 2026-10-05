import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { qg } from './db.js';

// Funções e acessos da equipe da empresa.
// - O dono (role 'owner') vê tudo. Cada pessoa da equipe (role 'staff') tem uma função, e a função diz quais telas ela abre.
// - O administrador da empresa pode abrir exceções por pessoa (lista própria de telas, no lugar da lista da função).
// - O bloqueio vale no servidor: quem não tem a tela não consegue usar as rotas dela, mesmo digitando o endereço.

export const FUNCOES_SQL = `
CREATE TABLE IF NOT EXISTS company_funcoes (
  id          BIGSERIAL PRIMARY KEY,
  company_id  BIGINT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  name        TEXT NOT NULL,
  telas       JSONB NOT NULL DEFAULT '[]',
  inicio      TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (company_id, name)
);
ALTER TABLE users ADD COLUMN IF NOT EXISTS funcao_id BIGINT REFERENCES company_funcoes(id) ON DELETE SET NULL;
ALTER TABLE users ADD COLUMN IF NOT EXISTS telas_proprias JSONB;
ALTER TABLE users ADD COLUMN IF NOT EXISTS active BOOLEAN NOT NULL DEFAULT true;
`;

// Telas que podem ser dadas à equipe. "config" e "equipe" ficam só com o dono.
export const TELAS = [
  'dashboard', 'agenda', 'fila', 'clientes', 'inativos', 'profissionais', 'servicos', 'atendente', 'comandos', 'bloqueios', 'campanhas',
  'clube', 'pedidos', 'eventos', 'financeiro', 'comissoes', 'casa_de_shows', 'lista_evento', 'lista_evento_comentarista', 'lista_evento_editor', 'documentos', 'delivery',
  'rst_salao', 'rst_cozinha', 'rst_caixa', 'rst_gestao',
];
export const registrarTelas = (...novas) => { for (const t of novas) if (!TELAS.includes(t)) TELAS.push(t); };

// Cada tela e as rotas do servidor que ela usa (primeiro trecho do caminho)
export const ROTAS_DA_TELA = {
  dashboard: ['dashboard'],
  agenda: ['appointments', 'availability', 'booking-mode'],
  fila: ['waitlist'],
  clientes: ['customers', 'import'],
  inativos: ['customers-inactive'],
  profissionais: ['professionals', 'import'],
  servicos: ['services', 'categories', 'import'],
  atendente: ['agent-manual', 'agent-updates', 'agent-config', 'agent-attendants', 'assistant-manual', 'assistant-updates', 'assistant'],
  comandos: ['agent-commands'],
  bloqueios: ['blocks'],
  campanhas: ['campaigns'],
  clube: ['club'],
  pedidos: ['orders', 'lives', 'suggestions'],
  eventos: ['events'],
  financeiro: ['finance', 'payments'],
  comissoes: ['commissions', 'product-sales'],
  casa_de_shows: ['casa-de-shows'],
  lista_evento: [],                                          // só consulta (as leituras estão abaixo)
  lista_evento_comentarista: ['event-list-comment'],               // marca entrada e anota na portaria
  lista_evento_editor: ['event-list', 'event-list-comment'],   // edita a lista toda
  documentos: ['documents'],
  delivery: ['delivery'],
  rst_salao: ['restaurant'],
  rst_cozinha: ['restaurant'],
  rst_caixa: ['restaurant'],
  rst_gestao: ['restaurant', 'delivery'],   // o cardápio do restaurante é o mesmo do delivery
};
// Leituras que uma tela precisa de dados de outras (só consulta, nunca alteração)
export const LEITURAS_DA_TELA = {
  agenda: ['professionals', 'services', 'categories', 'customers', 'club'],
  fila: ['professionals', 'services', 'categories', 'customers'],
  clientes: ['professionals', 'services', 'club'],
  inativos: ['customers', 'professionals', 'services'],
  pedidos: ['customers', 'club'],
  eventos: ['customers', 'professionals'],
  comissoes: ['professionals', 'services', 'categories'],
  delivery: ['customers'],
  casa_de_shows: ['customers', 'finance', 'payments'],
  lista_evento: ['event-list', 'events'],
  lista_evento_comentarista: ['event-list', 'events'],
  lista_evento_editor: ['events'],
  campanhas: ['customers', 'services', 'club'],
  financeiro: ['customers'],
};
// Sempre permitido para a equipe, só leitura: dados da empresa para montar o painel
const SEMPRE_LEITURA = ['company'];

export const ADMIN_DA_EMPRESA = new Set(['owner']);

export function rotaPermitida(telas, segmento, metodo) {
  const leitura = metodo === 'GET' || metodo === 'HEAD';
  if (segmento === 'me') return true;
  if (leitura && SEMPRE_LEITURA.includes(segmento)) return true;
  for (const t of telas) {
    if (ROTAS_DA_TELA[t]?.includes(segmento)) return true;
    if (leitura && LEITURAS_DA_TELA[t]?.includes(segmento)) return true;
  }
  return false;
}

// Telas efetivas de uma pessoa da equipe (lista própria, se houver; senão a da função). null = login inexistente ou desativado.
const cache = new Map();
export const limparCacheAcessos = () => cache.clear();
export async function acessoDe(userId) {
  const c = cache.get(userId);
  if (c && Date.now() - c.t < 5000) return c.v;
  const { rows } = await qg(
    `SELECT u.id, u.role, u.active, u.telas_proprias, f.telas AS telas_funcao, f.inicio, f.name AS funcao
     FROM users u LEFT JOIN company_funcoes f ON f.id = u.funcao_id WHERE u.id=$1`, [userId]);
  const u = rows[0];
  let v = null;
  if (u && u.active) {
    const bruto = Array.isArray(u.telas_proprias) ? u.telas_proprias : (Array.isArray(u.telas_funcao) ? u.telas_funcao : []);
    const telas = bruto.filter((t) => TELAS.includes(t));
    v = { telas, inicio: telas.includes(u.inicio) ? u.inicio : (telas[0] || null), funcao: u.funcao || null, role: u.role };
  }
  cache.set(userId, { t: Date.now(), v });
  return v;
}

// Vai antes de todas as rotas de /api. Só mexe com quem é da equipe; dono e administrador seguem como sempre.
export async function bloqueioPorFuncao(req, res, next) {
  const h = req.headers.authorization || '';
  if (!h.startsWith('Bearer ')) return next();
  let p;
  try { p = jwt.verify(h.slice(7), process.env.JWT_SECRET); } catch { return next(); } // o requireUser trata o erro
  if (p.imp || p.role !== 'staff') return next();
  try {
    const acc = await acessoDe(p.id);
    if (!acc) return res.status(401).json({ error: 'Sessão inválida ou expirada' });
    const seg = req.path.split('/')[1] || '';
    if (rotaPermitida(acc.telas, seg, req.method)) return next();
    res.status(403).json({ error: 'Você não tem acesso a esta área' });
  } catch (e) { console.error(e); res.status(500).json({ error: 'Erro interno' }); }
}

const FUNCOES_PADRAO = [
  { name: 'Recepção', telas: ['dashboard', 'agenda', 'fila', 'clientes', 'inativos'], inicio: 'agenda' },
  { name: 'Profissional', telas: ['agenda', 'clientes'], inicio: 'agenda' },
  { name: 'Caixa', telas: ['financeiro', 'clientes'], inicio: 'financeiro' },
];

async function garantirPadrao(companyId) {
  const { rows } = await qg('SELECT 1 FROM company_funcoes WHERE company_id=$1 LIMIT 1', [companyId]);
  if (rows[0]) return;
  for (const f of FUNCOES_PADRAO.concat(extrasPadrao)) {
    await qg('INSERT INTO company_funcoes (company_id,name,telas,inicio) VALUES ($1,$2,$3::jsonb,$4) ON CONFLICT DO NOTHING',
      [companyId, f.name, JSON.stringify(f.telas.filter((t) => TELAS.includes(t))), f.inicio]);
  }
}
const extrasPadrao = [];
// Quem tem o restaurante ligado ganha as funções de garçom, cozinha e caixa prontas (uma vez, enquanto não houver nenhuma função do restaurante)
const FUNCOES_RESTAURANTE = [
  { name: 'Garçom', telas: ['rst_salao'], inicio: 'rst_salao' },
  { name: 'Cozinha', telas: ['rst_cozinha'], inicio: 'rst_cozinha' },
  { name: 'Caixa do restaurante', telas: ['rst_salao', 'rst_caixa'], inicio: 'rst_caixa' },
];
async function garantirRestaurante(companyId) {
  const c = (await qg("SELECT modules->>'restaurante' AS on FROM companies WHERE id=$1", [companyId])).rows[0];
  if (c?.on !== 'true') return;
  const tem = (await qg(`SELECT 1 FROM company_funcoes WHERE company_id=$1 AND EXISTS (SELECT 1 FROM jsonb_array_elements_text(telas) t WHERE t LIKE 'rst\_%') LIMIT 1`, [companyId])).rows[0];
  if (tem) return;
  for (const f of FUNCOES_RESTAURANTE)
    await qg('INSERT INTO company_funcoes (company_id,name,telas,inicio) VALUES ($1,$2,$3::jsonb,$4) ON CONFLICT DO NOTHING', [companyId, f.name, JSON.stringify(f.telas), f.inicio]);
}

const limparTelas = (v) => (Array.isArray(v) ? [...new Set(v.filter((t) => TELAS.includes(t)))] : null);
const nomeOk = (s) => typeof s === 'string' && s.trim().length > 0 && s.trim().length <= 40 && !/[\u0000-\u001f<>]/.test(s);
const emailOk = (s) => typeof s === 'string' && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s.trim()) && s.length <= 120;

export function registerEquipeRoutes(app, requireUser) {
  const dono = async (req, res, next) => {
    if (req.user.imp) return next(); // administrador da plataforma dentro da empresa
    const { rows } = await qg('SELECT role FROM users WHERE id=$1', [req.user.id]);
    if (rows[0]?.role !== 'owner') return res.status(403).json({ error: 'Só o administrador da empresa pode mexer na equipe' });
    next();
  };
  const w = (fn) => (req, res) => fn(req, res).catch((e) => {
    if (e.code === '23505') return res.status(409).json({ error: 'Já existe um cadastro com esse nome ou e-mail' });
    console.error(e); res.status(500).json({ error: 'Erro interno' });
  });
  const cid = (req) => req.user.companyId;
  const pre = [requireUser, dono];

  app.get('/api/equipe', ...pre, w(async (req, res) => {
    await garantirPadrao(cid(req));
    await garantirRestaurante(cid(req));
    const usuarios = (await qg(
      `SELECT id, name, email, role, active, funcao_id, telas_proprias FROM users WHERE company_id=$1 ORDER BY (role='owner') DESC, lower(name)`, [cid(req)])).rows;
    const funcoes = (await qg('SELECT id, name, telas, inicio FROM company_funcoes WHERE company_id=$1 ORDER BY id', [cid(req)])).rows;
    res.json({ usuarios, funcoes, telas: TELAS });
  }));

  app.post('/api/equipe/funcoes', ...pre, w(async (req, res) => {
    const { name, inicio } = req.body || {};
    const telas = limparTelas(req.body?.telas);
    if (!nomeOk(name)) return res.status(400).json({ error: 'Dê um nome à função (até 40 letras)' });
    if (!telas) return res.status(400).json({ error: 'Escolha as telas da função' });
    const { rows } = await qg('INSERT INTO company_funcoes (company_id,name,telas,inicio) VALUES ($1,$2,$3::jsonb,$4) RETURNING id, name, telas, inicio',
      [cid(req), name.trim(), JSON.stringify(telas), telas.includes(inicio) ? inicio : null]);
    res.status(201).json(rows[0]);
  }));
  app.put('/api/equipe/funcoes/:id', ...pre, w(async (req, res) => {
    const { name, inicio } = req.body || {};
    const telas = limparTelas(req.body?.telas);
    if (!nomeOk(name) || !telas) return res.status(400).json({ error: 'Nome e telas são obrigatórios' });
    const { rows } = await qg('UPDATE company_funcoes SET name=$3, telas=$4::jsonb, inicio=$5 WHERE id=$1 AND company_id=$2 RETURNING id, name, telas, inicio',
      [req.params.id, cid(req), name.trim(), JSON.stringify(telas), telas.includes(inicio) ? inicio : null]);
    limparCacheAcessos();
    rows[0] ? res.json(rows[0]) : res.status(404).json({ error: 'Função não encontrada' });
  }));
  app.delete('/api/equipe/funcoes/:id', ...pre, w(async (req, res) => {
    const em = (await qg('SELECT count(*)::int AS n FROM users WHERE funcao_id=$1 AND company_id=$2', [req.params.id, cid(req)])).rows[0].n;
    if (em > 0) return res.status(409).json({ error: 'Há pessoas com essa função. Troque a função delas antes de apagar.' });
    await qg('DELETE FROM company_funcoes WHERE id=$1 AND company_id=$2', [req.params.id, cid(req)]);
    res.json({ ok: true });
  }));

  // funcao_id precisa ser da própria empresa
  const funcaoDaEmpresa = async (req, id) => {
    if (id === null || id === undefined || id === '') return null;
    const r = (await qg('SELECT id FROM company_funcoes WHERE id=$1 AND company_id=$2', [id, cid(req)])).rows[0];
    return r ? r.id : undefined;
  };

  app.post('/api/equipe/usuarios', ...pre, w(async (req, res) => {
    const { name, email, password } = req.body || {};
    if (!nomeOk(name)) return res.status(400).json({ error: 'Informe o nome (até 40 letras)' });
    if (!emailOk(email)) return res.status(400).json({ error: 'E-mail inválido' });
    if (typeof password !== 'string' || password.length < 8) return res.status(400).json({ error: 'A senha precisa ter 8 ou mais caracteres' });
    const f = await funcaoDaEmpresa(req, req.body?.funcao_id);
    if (f === undefined) return res.status(400).json({ error: 'Função inválida' });
    const proprias = req.body?.telas_proprias == null ? null : limparTelas(req.body.telas_proprias);
    const hash = await bcrypt.hash(password, 10);
    const { rows } = await qg(
      `INSERT INTO users (company_id,name,email,password_hash,role,funcao_id,telas_proprias) VALUES ($1,$2,$3,$4,'staff',$5,$6::jsonb)
       RETURNING id, name, email, role, active, funcao_id, telas_proprias`,
      [cid(req), name.trim(), email.trim().toLowerCase(), hash, f, proprias ? JSON.stringify(proprias) : null]);
    res.status(201).json(rows[0]);
  }));
  app.put('/api/equipe/usuarios/:id', ...pre, w(async (req, res) => {
    const alvo = (await qg('SELECT id, role FROM users WHERE id=$1 AND company_id=$2', [req.params.id, cid(req)])).rows[0];
    if (!alvo) return res.status(404).json({ error: 'Pessoa não encontrada' });
    if (alvo.role === 'owner') return res.status(400).json({ error: 'O acesso do administrador da empresa não muda aqui' });
    const b = req.body || {};
    const sets = [], vals = [req.params.id, cid(req)];
    const add = (sql, v) => { vals.push(v); sets.push(sql.replace('?', '$' + vals.length)); };
    if (b.name !== undefined) { if (!nomeOk(b.name)) return res.status(400).json({ error: 'Nome inválido' }); add('name=?', b.name.trim()); }
    if (b.email !== undefined) { if (!emailOk(b.email)) return res.status(400).json({ error: 'E-mail inválido' }); add('email=?', b.email.trim().toLowerCase()); }
    if (b.password) { if (typeof b.password !== 'string' || b.password.length < 8) return res.status(400).json({ error: 'A senha precisa ter 8 ou mais caracteres' }); add('password_hash=?', await bcrypt.hash(b.password, 10)); }
    if (b.active !== undefined) add('active=?', !!b.active);
    if (b.funcao_id !== undefined) { const f = await funcaoDaEmpresa(req, b.funcao_id); if (f === undefined) return res.status(400).json({ error: 'Função inválida' }); add('funcao_id=?', f); }
    if (b.telas_proprias !== undefined) {
      const t = b.telas_proprias === null ? null : limparTelas(b.telas_proprias);
      if (b.telas_proprias !== null && !t) return res.status(400).json({ error: 'Lista de telas inválida' });
      add('telas_proprias=?::jsonb', t ? JSON.stringify(t) : null);
    }
    if (!sets.length) return res.json({ ok: true });
    const { rows } = await qg(`UPDATE users SET ${sets.join(', ')} WHERE id=$1 AND company_id=$2 RETURNING id, name, email, role, active, funcao_id, telas_proprias`, vals);
    limparCacheAcessos();
    res.json(rows[0]);
  }));
  app.delete('/api/equipe/usuarios/:id', ...pre, w(async (req, res) => {
    const r = await qg(`DELETE FROM users WHERE id=$1 AND company_id=$2 AND role='staff'`, [req.params.id, cid(req)]);
    limparCacheAcessos();
    r.rowCount ? res.json({ ok: true }) : res.status(404).json({ error: 'Pessoa não encontrada' });
  }));
}
