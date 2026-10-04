// Contratações na ficha do Contratante. Uso: BASE=http://localhost:3999 node test/contratacoes.mjs
const BASE = process.env.BASE || 'http://localhost:3999';
let ok = 0, fail = 0;
const check = (name, cond, extra = '') => { cond ? ok++ : (fail++, console.log('FALHOU:', name, extra)); };
const call = async (method, path, { token, body, headers: h } = {}) => {
  const headers = { 'content-type': 'application/json', ...h };
  if (token) headers.authorization = 'Bearer ' + token;
  const r = await fetch(BASE + path, { method, headers, body: body ? JSON.stringify(body) : undefined });
  let j = null; try { j = await r.json(); } catch {}
  return { status: r.status, body: j };
};
const A = (await call('POST', '/api/auth/login', { body: { email: 'demo@demo.com', password: 'demo1234' } })).body;
const B = (await call('POST', '/api/auth/login', { body: { email: 'dois@x.com', password: 'senhasenha' } })).body;
const N8N = { 'x-api-key': process.env.N8N_API_KEY || 'k', 'x-company-id': '1' };

const cust = (await call('POST', '/api/customers', { token: A.token, body: { name: 'Contratante Teste', phone: '32990004001' } })).body;
const id = cust.id;
check('começa como lead sem perfil', cust.status === 'lead' && !(cust.client_kinds || []).length);

const h1 = await call('POST', '/api/casa-de-shows/hirings', { token: A.token, body: { customer_id: id, show_date: '2027-03-10', venue: 'Clube Central', value: '5000,00', status: 'confirmed' } });
check('cria contratação', h1.status === 201 && h1.body.value === 5000 && h1.body.date === '2027-03-10', JSON.stringify(h1.body));
const h2 = await call('POST', '/api/casa-de-shows/hirings', { token: A.token, body: { customer_id: id, show_date: '2027-05-01', venue: 'Salão Azul', value: 3000, status: 'done' } });
const h3 = await call('POST', '/api/casa-de-shows/hirings', { token: A.token, body: { customer_id: id, venue: 'Ainda em conversa', value: 9000, status: 'proposal' } });
const h4 = await call('POST', '/api/casa-de-shows/hirings', { token: A.token, body: { customer_id: id, show_date: '2027-06-01', venue: 'Cancelado', value: 7000, status: 'cancelled' } });

let f = (await call('GET', '/api/customers/' + id, { token: A.token })).body;
check('vira cliente e contratante', f.status === 'client' && f.client_kinds.includes('hirer') && !f.client_kinds.includes('buyer'), JSON.stringify([f.status, f.client_kinds]));
check('ficha traz as 4 contratações', f.hirings.rows.length === 4);
check('valor médio só de confirmadas e realizadas', f.hirings.contracts === 2 && f.hirings.total === 8000 && f.hirings.average_value === 4000, JSON.stringify(f.hirings));
check('mais recente primeiro (sem data por último)', f.hirings.rows[0].venue === 'Cancelado' && f.hirings.rows[3].venue === 'Ainda em conversa');

// proposta confirmada passa a contar
check('altera a situação', (await call('PUT', '/api/casa-de-shows/hirings/' + h3.body.id, { token: A.token, body: { status: 'confirmed' } })).status === 200);
f = (await call('GET', '/api/customers/' + id, { token: A.token })).body;
check('média recalculada', f.hirings.contracts === 3 && f.hirings.average_value === 5666.67, JSON.stringify(f.hirings));

// validações
check('data inválida recusada', (await call('POST', '/api/casa-de-shows/hirings', { token: A.token, body: { customer_id: id, show_date: '10/03/2027' } })).status === 400);
check('valor negativo recusado', (await call('POST', '/api/casa-de-shows/hirings', { token: A.token, body: { customer_id: id, value: -5 } })).status === 400);
check('situação inválida recusada', (await call('POST', '/api/casa-de-shows/hirings', { token: A.token, body: { customer_id: id, status: 'x' } })).status === 400);
check('sem cliente recusado', (await call('POST', '/api/casa-de-shows/hirings', { token: A.token, body: { venue: 'a' } })).status === 400);

// pela atendente: cria o contato pelo telefone, como lead (proposta não vira cliente)
const ia = await call('POST', '/n8n/casa-de-shows/hirings', { headers: N8N, body: { phone: '32990004002', name: 'Pela Atendente', venue: 'Casa X', value: 4000, show_date: '2027-08-20' } });
check('atendente lança por telefone', ia.status === 201, JSON.stringify(ia.body));
const g = await call('GET', '/n8n/casa-de-shows/hirings?phone=32990004002', { headers: N8N });
check('consulta por telefone', g.status === 200 && g.body.hirings.rows.length === 1 && g.body.hirings.contracts === 0);
const fi = (await call('GET', '/api/customers/' + ia.body.customer_id, { token: A.token })).body;
check('proposta deixa lead, mas já é contratante', fi.status === 'lead' && fi.client_kinds.includes('hirer') && fi.source === 'ia', JSON.stringify([fi.status, fi.client_kinds, fi.source]));

// filtro por perfil na lista
const lista = (await call('GET', '/api/customers?kind=hirer&status=client', { token: A.token })).body;
check('filtro Contratante encontra', Array.isArray(lista) && lista.some((c) => String(c.id) === String(id)));

// isolamento entre empresas
check('outra empresa não mexe', (await call('PUT', '/api/casa-de-shows/hirings/' + h1.body.id, { token: B.token, body: { status: 'cancelled' } })).status === 404);
check('outra empresa não apaga', (await call('DELETE', '/api/casa-de-shows/hirings/' + h1.body.id, { token: B.token })).status === 404);

// apagar
check('apaga', (await call('DELETE', '/api/casa-de-shows/hirings/' + h4.body.id, { token: A.token })).status === 200);
f = (await call('GET', '/api/customers/' + id, { token: A.token })).body;
check('ficha sem a apagada', f.hirings.rows.length === 3);
// apagar o cliente leva as contratações (sem erro)
check('apagar o cliente funciona', (await call('DELETE', '/api/customers/' + id, { token: A.token })).status < 300);
await call('DELETE', '/api/customers/' + ia.body.customer_id, { token: A.token });

console.log(`contratacoes: ${ok} ok, ${fail} falhas`);
process.exit(fail ? 1 : 0);
