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

// ---- trocar o e-mail de login do responsável (com senha nova) ----
const ow = (body, token = A.token, id = idB) => call('PUT', `/api/admin/companies/${id}/owner`, { token, body });
check('troca de e-mail: só administrador', (await ow({ email: 'novo@x.com', password: 'senhanova1' }, B.token)).status === 403);
check('troca de e-mail: e-mail inválido = 400', (await ow({ email: 'abc', password: 'senhanova1' })).status === 400);
check('troca de e-mail: exige senha nova = 400', (await ow({ email: 'novo@x.com', password: '123' })).status === 400);
check('troca de e-mail: empresa inexistente = 404', (await ow({ email: 't@x.com', password: 'senhanova1' }, A.token, 99999)).status === 404);
check('troca de e-mail: já existente = 409', (await ow({ email: 'demo@demo.com', password: 'senhanova1' })).status === 409);
check('troca de e-mail do administrador para fora da lista = 409', (await ow({ email: 'fora@x.com', password: 'senhanova1' }, A.token, A.company.id)).status === 409);
const rr = await ow({ email: 'Troca.Teste@X.com', password: 'senhanova1' });
check('troca de e-mail ok', rr.body?.owner_email === 'troca.teste@x.com', JSON.stringify(rr));
check('login antigo não entra mais', (await call('POST', '/api/auth/login', { body: { email: 'dois@x.com', password: 'senhasenha' } })).status === 401);
check('login novo entra', !!(await login('troca.teste@x.com', 'senhanova1')).token);
await ow({ email: 'dois@x.com', password: 'senhasenha' });
check('volta ao e-mail original', !!(await login('dois@x.com', 'senhasenha')).token);

// ---- nomes personalizados do módulo Pedidos ----
const lb = (labels, token = A.token, id = idB) => call('PUT', `/api/admin/companies/${id}/labels`, { token, body: { labels } });
check('nomes: só administrador', (await lb({ pedidos: { group: 'Loja' } }, B.token)).status === 403);
check('nomes: módulo desconhecido = 400', (await lb({ xyz: { group: 'Loja' } })).status === 400);
check('nomes: campo desconhecido = 400', (await lb({ pedidos: { zzz: 'Loja' } })).status === 400);
check('nomes: muito longo = 400', (await lb({ pedidos: { group: 'x'.repeat(31) } })).status === 400);
check('nomes: sem < ou > ', (await lb({ pedidos: { group: '<b>' } })).status === 400);
check('nomes: empresa inexistente = 404', (await lb({ pedidos: { group: 'Loja' } }, A.token, 99999)).status === 404);
check('nomes: salva', (await lb({ pedidos: { group: ' Loja ', items: 'Compras', song: '' } })).body?.module_labels?.pedidos?.group === 'Loja');
const meB = (await call('GET', '/api/company', { token: B.token })).body;
check('empresa recebe seus nomes', meB.module_labels?.pedidos?.items === 'Compras' && !('song' in meB.module_labels.pedidos), JSON.stringify(meB.module_labels));
check('lista da administração traz os nomes', (await call('GET', '/api/admin/companies', { token: A.token })).body.find((x) => x.id === idB).module_labels.pedidos.group === 'Loja');
check('outra empresa não recebe', !((await call('GET', '/api/company', { token: A.token })).body.module_labels?.pedidos?.group));
check('nomes: voltar ao padrão', Object.keys((await lb({})).body.module_labels).length === 0);
console.log(`acesso_admin: ${ok} ok, ${fail} falhas`); process.exit(fail ? 1 : 0);
