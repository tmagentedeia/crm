// "Abrir painel" do administrador. Uso: BASE=http://localhost:3999 node test/acesso_admin.mjs
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
const A = await login('demo@demo.com', 'demo1234'); // administrador, empresa 1
const B = await login('dois@x.com', 'senhasenha');   // empresa comum
const idB = B.company.id;

check('não administrador não abre painel de ninguém', (await call('POST', `/api/admin/companies/${idB}/impersonate`, { token: B.token })).status === 403);
check('sem login = 401', (await call('POST', `/api/admin/companies/${idB}/impersonate`)).status === 401);
check('empresa inexistente = 404', (await call('POST', '/api/admin/companies/99999/impersonate', { token: A.token })).status === 404);
check('id inválido = 404', (await call('POST', '/api/admin/companies/abc/impersonate', { token: A.token })).status === 404);

const r = await call('POST', `/api/admin/companies/${idB}/impersonate`, { token: A.token });
check('administrador abre o painel', r.status === 200 && r.body.token && r.body.company.id === idB, JSON.stringify(r));
const T = r.body.token;
const me = await call('GET', '/api/me', { token: T });
check('/api/me marca o acesso como administrador', me.body.impersonating === true && me.body.admin === false, JSON.stringify(me.body));
const comp = await call('GET', '/api/company', { token: T });
check('enxerga a empresa aberta', comp.status === 200 && comp.body.id === idB);
check('dados são só da empresa aberta (serviços)', (await call('GET', '/api/services', { token: T })).status === 200);
check('não usa a administração estando dentro da empresa', (await call('GET', '/api/admin/companies', { token: T })).status === 403);
check('não encadeia para outra empresa', (await call('POST', '/api/admin/companies/1/impersonate', { token: T })).status === 403);
const normal = await call('GET', '/api/me', { token: B.token });
check('login normal não é marcado como acesso do administrador', normal.body.impersonating === false);
console.log(`acesso_admin: ${ok} ok, ${fail} falhas`); process.exit(fail ? 1 : 0);
