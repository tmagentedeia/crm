// Vendas de produtos (base da comissão). Uso: BASE=http://localhost:3999 node test/vendas_produtos.mjs
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
const t = A.token;

const prod = (await call('POST', '/api/services', { token: t, body: { name: 'Produto venda teste', price: 45.5, kind: 'product' } })).body;
const serv = (await call('POST', '/api/services', { token: t, body: { name: 'Serviço venda teste', price: 60, duration_min: 30 } })).body;
const pr = (await call('GET', '/api/professionals', { token: t })).body.find((x) => x.active);
const cu = (await call('GET', '/api/customers', { token: t })).body[0];
const mes = new Date().toISOString().slice(0, 7);

let r = await call('POST', '/api/product-sales', { token: t, body: { service_id: prod.id, quantity: 2, professional_id: pr?.id, customer_id: cu?.id } });
check('vende produto do catálogo', r.status === 201 && r.body.product_name === 'Produto venda teste', JSON.stringify(r));
check('preço vem do catálogo', r.body.unit_price === 45.5 && r.body.total === 91, JSON.stringify(r.body));
check('guarda profissional e cliente', (!pr || r.body.professional_name === pr.name) && (!cu || r.body.customer_id === cu.id));
const v1 = r.body;

r = await call('POST', '/api/product-sales', { token: t, body: { product_name: 'Avulso teste', quantity: 1, unit_price: '12,50' } });
check('venda avulsa com nome e valor digitados', r.status === 201 && r.body.service_id === null && r.body.total === 12.5 && r.body.professional_id === null, JSON.stringify(r));
const v2 = r.body;

check('serviço não vira venda de produto', (await call('POST', '/api/product-sales', { token: t, body: { service_id: serv.id, quantity: 1 } })).status === 400);
check('avulsa sem valor recusada', (await call('POST', '/api/product-sales', { token: t, body: { product_name: 'X', quantity: 1 } })).status === 400);
check('quantidade zero recusada', (await call('POST', '/api/product-sales', { token: t, body: { service_id: prod.id, quantity: 0 } })).status === 400);
check('sem produto nem nome recusada', (await call('POST', '/api/product-sales', { token: t, body: { quantity: 1, unit_price: 5 } })).status === 400);
check('profissional inexistente recusado', (await call('POST', '/api/product-sales', { token: t, body: { service_id: prod.id, professional_id: 999999 } })).status === 400);
check('valor negativo recusado', (await call('POST', '/api/product-sales', { token: t, body: { product_name: 'N', unit_price: -1 } })).status === 400);

const lista = (await call('GET', '/api/product-sales?month=' + mes, { token: t })).body;
check('lista do mês traz as duas', lista.rows.some((x) => x.id === v1.id) && lista.rows.some((x) => x.id === v2.id), JSON.stringify(lista).slice(0, 200));
check('total do mês soma as vendas', lista.total >= 103.5);
check('mês sem vendas vem vazio', (await call('GET', '/api/product-sales?month=2001-01', { token: t })).body.rows.length === 0);

r = await call('PUT', '/api/product-sales/' + v1.id, { token: t, body: { quantity: 3, unit_price: 40 } });
check('editar quantidade e valor', r.status === 200 && r.body.quantity === 3 && r.body.total === 120, JSON.stringify(r));
r = await call('PUT', '/api/product-sales/' + v1.id, { token: t, body: { professional_id: null } });
check('tirar o profissional', r.status === 200 && r.body.professional_id === null && r.body.quantity === 3);
check('editar venda que não existe = 404', (await call('PUT', '/api/product-sales/999999', { token: t, body: { quantity: 1 } })).status === 404);

// mudar o preço do catálogo não mexe na venda antiga
await call('PUT', '/api/services/' + prod.id, { token: t, body: { price: 99, name: 'Renomeado' } });
const dep = (await call('GET', '/api/product-sales?month=' + mes, { token: t })).body.rows.find((x) => x.id === v1.id);
check('catálogo muda, a venda antiga não', dep.product_name === 'Produto venda teste' && dep.unit_price === 40);

// isolamento entre empresas
check('outra empresa não vê a venda', !(await call('GET', '/api/product-sales?month=' + mes, { token: B.token })).body.rows.some((x) => x.id === v1.id));
check('outra empresa não apaga', (await call('DELETE', '/api/product-sales/' + v1.id, { token: B.token })).status === 404);

check('apaga a venda', (await call('DELETE', '/api/product-sales/' + v1.id, { token: t })).status === 200);
check('apagar de novo = 404', (await call('DELETE', '/api/product-sales/' + v1.id, { token: t })).status === 404);
await call('DELETE', '/api/product-sales/' + v2.id, { token: t });
for (const id of [prod.id, serv.id]) await call('DELETE', '/api/services/' + id + '/permanent?com_historico=1', { token: t });

console.log(`${ok} ok, ${fail} falhas`);
process.exit(fail ? 1 : 0);
