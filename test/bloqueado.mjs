// Funções desligadas que aparecem apagadas (convite de upgrade) e o aviso de upgrade. Uso: BASE=http://localhost:3999 node test/bloqueado.mjs
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

let c = (await call('GET', '/api/company', { token: A.token })).body;
check('começa sem nada à vista', JSON.stringify(c.locked_modules) === '{}' && c.upgrade.phone === '' && c.upgrade.text === '');

check('deixa o Financeiro à vista, apagado', (await call('PUT', '/api/admin/companies/1/locks', { token: A.token, body: { locks: { financeiro: true } } })).status === 200);
c = (await call('GET', '/api/company', { token: A.token })).body;
check('empresa recebe as funções à vista', c.locked_modules.financeiro === true);
check('login também traz', (await login('demo@demo.com', 'demo1234')).company.locked_modules.financeiro === true);
check('lista do admin traz', (await call('GET', '/api/admin/companies', { token: A.token })).body.find((x) => Number(x.id) === 1).locked_modules.financeiro === true);

check('função desconhecida = 400', (await call('PUT', '/api/admin/companies/1/locks', { token: A.token, body: { locks: { xyz: true } } })).status === 400);
check('valor que não é verdadeiro/falso = 400', (await call('PUT', '/api/admin/companies/1/locks', { token: A.token, body: { locks: { financeiro: 'sim' } } })).status === 400);
check('quem não é admin não mexe', (await call('PUT', '/api/admin/companies/1/locks', { token: B.token, body: { locks: { financeiro: false } } })).status === 403);
check('outra empresa não é afetada', JSON.stringify((await call('GET', '/api/company', { token: B.token })).body.locked_modules) === '{}');

// aviso de upgrade
check('salva o aviso', (await call('PUT', '/api/admin/upgrade', { token: A.token, body: { phone: '+55 (32) 99999-0000', text: 'Fale com a gente!' } })).body.phone === '5532999990000');
c = (await call('GET', '/api/company', { token: B.token })).body;
check('todas as empresas recebem o aviso', c.upgrade.phone === '5532999990000' && c.upgrade.text === 'Fale com a gente!');
check('texto com < é recusado', (await call('PUT', '/api/admin/upgrade', { token: A.token, body: { phone: '', text: '<b>x</b>' } })).status === 400);
check('quem não é admin não muda o aviso', (await call('PUT', '/api/admin/upgrade', { token: B.token, body: { phone: '1', text: 'x' } })).status === 403);

// volta ao estado limpo
await call('PUT', '/api/admin/companies/1/locks', { token: A.token, body: { locks: { financeiro: false } } });
await call('PUT', '/api/admin/upgrade', { token: A.token, body: { phone: '', text: '' } });
check('escondeu de novo', (await call('GET', '/api/company', { token: A.token })).body.locked_modules.financeiro === false);

console.log(`bloqueado: ${ok} ok, ${fail} falhas`);
process.exit(fail ? 1 : 0);
