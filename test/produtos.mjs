// Catálogo de produtos e serviços: produto não aparece na agenda nem para o atendente. Uso: BASE=http://localhost:3999 node test/produtos.mjs
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
const t = A.token;

const cats = (await call('GET', '/api/categories', { token: t })).body;
const cat = cats[0]?.id;
const prod = (await call('POST', '/api/services', { token: t, body: { name: 'Shampoo catálogo teste', price: 45, kind: 'product', category_id: cat } })).body;
check('cria produto', prod.kind === 'product' && Number(prod.price) === 45, JSON.stringify(prod));
check('produto não guarda categoria', prod.category_id === null, JSON.stringify(prod));
const sv = (await call('POST', '/api/services', { token: t, body: { name: 'Serviço catálogo teste', price: 70, duration_min: 40 } })).body;
check('sem tipo cria serviço', sv.kind === 'service');
check('tipo inválido recusado', (await call('POST', '/api/services', { token: t, body: { name: 'X', kind: 'outro' } })).status === 400);

const padrao = (await call('GET', '/api/services', { token: t })).body;
check('lista padrão só traz serviços', padrao.every((x) => x.kind === 'service') && padrao.some((x) => x.id === sv.id) && !padrao.some((x) => x.id === prod.id));
const todos = (await call('GET', '/api/services?kind=all', { token: t })).body;
check('kind=all traz os dois', todos.some((x) => x.id === sv.id) && todos.some((x) => x.id === prod.id));
const so = (await call('GET', '/api/services?kind=product', { token: t })).body;
check('kind=product só produtos', so.length >= 1 && so.every((x) => x.kind === 'product'));

const up = (await call('PUT', '/api/services/' + prod.id, { token: t, body: { price: 50, kind: 'service' } })).body;
check('editar muda o preço mas não o tipo', Number(up.price) === 50 && up.kind === 'product', JSON.stringify(up));

const pr = (await call('GET', '/api/professionals', { token: t })).body.find((x) => x.active && (x.does_service_ids || []).length);
const cu = (await call('GET', '/api/customers', { token: t })).body[0];
if (pr && cu) {
  check('profissional não "faz" produto', !(pr.does_service_ids || []).map(String).includes(String(prod.id)));
  const ag = await call('POST', '/api/appointments', { token: t, body: { professional_id: pr.id, customer_id: cu.id, service_id: prod.id, starts_at: new Date(Date.UTC(2031, 2, 3, 13)).toISOString() } });
  check('não agenda produto', ag.status === 400, JSON.stringify(ag));
  const av = await call('GET', `/api/availability?date=2031-03-04&service_id=${prod.id}`, { token: t });
  check('sem horários para produto', av.status === 400, JSON.stringify(av));
}
const todasCats = (await call('GET', '/api/categories', { token: t })).body;
check('categorias não listam produto', !todasCats.some((c) => (c.services || []).some((s) => s.id === prod.id)));

// importar planilha com a coluna Tipo
const imp = (await call('POST', '/api/import', { token: t, body: { services: [
  { Serviço: 'Pomada import teste', Tipo: 'Produto', Preço: 30, Categoria: 'Qualquer' },
  { Serviço: 'Hidratação import teste', Tipo: 'Serviço', Preço: 90, 'Duração (min)': 50 },
], dry_run: false } })).body;
check('importação cria os dois', imp.services.created === 2, JSON.stringify(imp));
const dep = (await call('GET', '/api/services?kind=all', { token: t })).body;
const pom = dep.find((x) => x.name === 'Pomada import teste');
check('importado como produto, sem categoria', pom && pom.kind === 'product' && pom.category_id === null, JSON.stringify(pom));
check('importado como serviço', dep.find((x) => x.name === 'Hidratação import teste')?.kind === 'service');

// limpeza
for (const id of [prod.id, sv.id, pom?.id, dep.find((x) => x.name === 'Hidratação import teste')?.id].filter(Boolean))
  await call('DELETE', '/api/services/' + id + '/permanent?com_historico=1', { token: t });

console.log(`${ok} ok, ${fail} falhas`);
process.exit(fail ? 1 : 0);
