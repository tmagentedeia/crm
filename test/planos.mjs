// Planos Starter, Pro e Advanced aplicados pela Administração. Uso: BASE=http://localhost:3999 node test/planos.mjs
const BASE = process.env.BASE || 'http://localhost:3999';
let ok = 0, fail = 0;
const check = (name, cond, extra = '') => { cond ? ok++ : (fail++, console.log('FALHOU:', name, extra)); };
const call = async (method, path, { token, body } = {}) => {
  const headers = { 'content-type': 'application/json' };
  if (token) headers.authorization = 'Bearer ' + token;
  const r = await fetch(BASE + path, { method, headers, body: body ? JSON.stringify(body) : undefined });
  let j = null; try { j = await r.json(); } catch {}
  return { status: r.status, body: j };
};
const login = async (e, p) => (await call('POST', '/api/auth/login', { body: { email: e, password: p } })).body;
const A = await login('demo@demo.com', 'demo1234');
const B = await login('dois@x.com', 'senhasenha');
const empresa = async () => (await call('GET', '/api/admin/companies', { token: A.token })).body.find((x) => Number(x.id) === 2);
const plano = (p, id = 2, token = A.token) => call('PUT', `/api/admin/companies/${id}/plan`, { token, body: { plan: p } });

const antes = await empresa();

let r = await plano('starter');
check('aplica o Starter', r.status === 200, JSON.stringify(r));
let e = await empresa();
check('Starter liga o básico', ['atendente', 'clientes', 'dashboard', 'comandos', 'financeiro', 'agenda', 'servicos', 'profissionais', 'fila', 'inativos', 'eventos', 'importar'].every((k) => e.modules[k] === true), JSON.stringify(e.modules));
check('Starter desliga o que é do Pro e do Advanced', ['bloqueios', 'pedidos', 'comissoes', 'lembrete_cliente', 'campanhas', 'clube', 'assistente'].every((k) => e.modules[k] === false), JSON.stringify(e.modules));
check('Starter deixa os de fora à vista, apagados', e.locked_modules.comissoes === true && e.locked_modules.pedidos === true && e.locked_modules.campanhas === true && e.locked_modules.dashboard === undefined, JSON.stringify(e.locked_modules));
check('o que não tem menu não entra na vitrine', e.locked_modules.assistente === undefined && e.locked_modules.lembrete_cliente === undefined);
check('limite de profissionais não muda', e.max_professionals === antes.max_professionals, `${e.max_professionals} / ${antes.max_professionals}`);
const painel = (await call('GET', '/api/company', { token: B.token })).body;
check('o painel da empresa recebe a vitrine', painel.locked_modules?.comissoes === true && painel.modules?.pedidos === false);

r = await plano('pro');
e = await empresa();
check('Pro liga Pedidos, Comissões, Atendimentos bloqueados e lembrete do cliente', ['pedidos', 'comissoes', 'bloqueios', 'lembrete_cliente'].every((k) => e.modules[k] === true));
check('Pro ainda desliga Campanhas, Programa de assinaturas e Assistente', ['campanhas', 'clube', 'assistente'].every((k) => e.modules[k] === false) && e.locked_modules.campanhas === true && e.locked_modules.comissoes === undefined, JSON.stringify(e.locked_modules));

r = await plano('advanced');
e = await empresa();
check('Advanced liga tudo', Object.values(e.modules).every((v) => v === true) && Object.keys(e.locked_modules).length === 0, JSON.stringify(e));

// cortesia: ligar um módulo a mais num plano continua possível
await plano('starter');
await call('PUT', '/api/admin/companies/2/modules', { token: A.token, body: { modules: { comissoes: true } } });
e = await empresa();
check('cortesia: módulo extra ligado à mão fica ligado', e.modules.comissoes === true && e.modules.pedidos === false);

check('plano inválido = 400', (await plano('gold')).status === 400);
check('sem plano = 400', (await call('PUT', '/api/admin/companies/2/plan', { token: A.token, body: {} })).status === 400);
check('empresa inexistente = 404', (await plano('pro', 999999)).status === 404);
check('quem não é administrador = 403', (await plano('pro', 2, B.token)).status === 403);

// volta ao estado de antes
await call('PUT', '/api/admin/companies/2/modules', { token: A.token, body: { modules: antes.modules } });
const zera = Object.fromEntries(Object.keys(e.modules).map((k) => [k, antes.locked_modules?.[k] === true]));
await call('PUT', '/api/admin/companies/2/locks', { token: A.token, body: { locks: zera } });

console.log(`${ok} ok, ${fail} falhas`);
process.exit(fail ? 1 : 0);
