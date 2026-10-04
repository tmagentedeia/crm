// Comissões: percentuais, períodos e fechamento. Uso: BASE=http://localhost:3999 node test/comissoes.mjs
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

// ---- ajustes ----
let s = (await call('GET', '/api/commissions/settings', { token: t })).body;
check('padrão: mensal, sem desconto', s.period === 'monthly' && s.deduction_pct === 0, JSON.stringify(s));
check('período inválido recusado', (await call('PUT', '/api/commissions/settings', { token: t, body: { period: 'diario' } })).status === 400);
check('desconto 100% recusado', (await call('PUT', '/api/commissions/settings', { token: t, body: { deduction_pct: 100 } })).status === 400);
check('desconto negativo recusado', (await call('PUT', '/api/commissions/settings', { token: t, body: { deduction_pct: -1 } })).status === 400);

// ---- períodos (2031-01-01 é quarta-feira) ----
await call('PUT', '/api/commissions/settings', { token: t, body: { period: 'weekly' } });
let f = (await call('GET', '/api/commissions?date=2031-01-01', { token: t })).body;
check('semanal vai de segunda a domingo', f.from === '2030-12-30' && f.to === '2031-01-05', `${f.from} ${f.to}`);
check('anterior e próximo da semana', f.prev_date === '2030-12-29' && f.next_date === '2031-01-06');
await call('PUT', '/api/commissions/settings', { token: t, body: { period: 'biweekly' } });
f = (await call('GET', '/api/commissions?date=2031-01-16', { token: t })).body;
check('quinzena do 16 ao fim do mês', f.from === '2031-01-16' && f.to === '2031-01-31', `${f.from} ${f.to}`);
f = (await call('GET', '/api/commissions?date=2031-01-15', { token: t })).body;
check('quinzena do 1 ao 15', f.from === '2031-01-01' && f.to === '2031-01-15');
await call('PUT', '/api/commissions/settings', { token: t, body: { period: 'monthly' } });
f = (await call('GET', '/api/commissions?date=2031-02-10', { token: t })).body;
check('mensal cobre o mês inteiro', f.from === '2031-02-01' && f.to === '2031-02-28', `${f.from} ${f.to}`);
check('data inválida cai no período de hoje', (await call('GET', '/api/commissions?date=abc', { token: t })).status === 200);

// ---- percentuais ----
const pr = (await call('GET', '/api/professionals', { token: t })).body.find((x) => x.active);
const cu = (await call('GET', '/api/customers', { token: t })).body[0];
const svA = (await call('POST', '/api/services', { token: t, body: { name: 'Comissão serv A', price: 100, duration_min: 30 } })).body;
const svB = (await call('POST', '/api/services', { token: t, body: { name: 'Comissão serv B', price: 60, duration_min: 30 } })).body;
const prodC = (await call('POST', '/api/services', { token: t, body: { name: 'Comissão produto', price: 50, kind: 'product' } })).body;
const put = (id, body) => call('PUT', '/api/commissions/rates/' + id, { token: t, body });
check('percentual acima de 100 recusado', (await put(pr.id, { service_pct: 101, product_pct: 0 })).status === 400);
check('percentual texto recusado', (await put(pr.id, { service_pct: 'abc', product_pct: 0 })).status === 400);
check('profissional inexistente = 404', (await put(999999, { service_pct: 10, product_pct: 10 })).status === 404);
check('exceção para produto recusada', (await put(pr.id, { service_pct: 40, product_pct: 10, overrides: [{ service_id: prodC.id, pct: 5 }] })).status === 400);
check('exceção com percentual inválido recusada', (await put(pr.id, { service_pct: 40, product_pct: 10, overrides: [{ service_id: svA.id, pct: 150 }] })).status === 400);
check('salva percentuais e exceção', (await put(pr.id, { service_pct: '40', product_pct: '10,5', overrides: [{ service_id: svA.id, pct: 50 }] })).status === 200);
const rates = (await call('GET', '/api/commissions/rates', { token: t })).body.find((x) => String(x.professional_id) === String(pr.id));
check('lê os percentuais salvos', rates.service_pct === 40 && rates.product_pct === 10.5 && rates.overrides.length === 1 && rates.overrides[0].pct === 50, JSON.stringify(rates));
check('salvar de novo troca as exceções', (await put(pr.id, { service_pct: 40, product_pct: 10.5, overrides: [{ service_id: svA.id, pct: 50 }, { service_id: svA.id, pct: 60 }] })).status === 200
  && (await call('GET', '/api/commissions/rates', { token: t })).body.find((x) => String(x.professional_id) === String(pr.id)).overrides.length === 1);

// ---- fechamento ----
const hora = (n, h) => new Date(Date.UTC(2031, 3, n, h)).toISOString();   // abril de 2031
const novo = async (service_id, n, h) => (await call('POST', '/api/appointments', { token: t, body: { professional_id: pr.id, customer_id: cu.id, service_id, starts_at: hora(n, h) } })).body;
const a1 = await novo(svA.id, 8, 13), a2 = await novo(svB.id, 8, 15), a3 = await novo(svB.id, 9, 13), a4 = await novo(svB.id, 9, 15);
check('criou os atendimentos', a1?.id && a2?.id && a3?.id && a4?.id, JSON.stringify([a1, a2, a3, a4]));
const st = (a, status) => call('PATCH', `/api/appointments/${a.id}/status`, { token: t, body: { status } });
await st(a1, 'attended'); await st(a2, 'attended'); await st(a3, 'cancelled');   // a4 segue só agendado
const venda = (await call('POST', '/api/product-sales', { token: t, body: { service_id: prodC.id, quantity: 2, professional_id: pr.id, sold_at: hora(10, 14) } })).body;
const semProf = (await call('POST', '/api/product-sales', { token: t, body: { service_id: prodC.id, quantity: 1, sold_at: hora(10, 15) } })).body;

f = (await call('GET', '/api/commissions?date=2031-04-15', { token: t })).body;
const p = f.professionals.find((x) => String(x.professional_id) === String(pr.id));
check('só conta atendimento atendido', p.services.length === 2, JSON.stringify(p.services.map((x) => x.name)));
check('serviço com percentual próprio: 100 × 50% = 50', p.services.find((x) => x.name === 'Comissão serv A').commission === 50 && p.services.find((x) => x.name === 'Comissão serv A').custom_rate === true);
check('serviço sem exceção usa o padrão: 60 × 40% = 24', p.services.find((x) => x.name === 'Comissão serv B').commission === 24);
check('produto: 100 × 10,5% = 10,50', p.products.length === 1 && p.products[0].commission === 10.5 && p.products[0].quantity === 2, JSON.stringify(p.products));
check('totais do profissional', p.services_total === 160 && p.services_commission === 74 && p.products_total === 100 && p.commission_total === 84.5, JSON.stringify(p));
check('total geral inclui o profissional', f.total_commission >= 84.5);
check('venda sem profissional não gera comissão', f.unassigned_sales.count >= 1 && f.unassigned_sales.total >= 50);

// desconto de 10% antes de calcular
await call('PUT', '/api/commissions/settings', { token: t, body: { deduction_pct: '10' } });
f = (await call('GET', '/api/commissions?date=2031-04-15', { token: t })).body;
const pd = f.professionals.find((x) => String(x.professional_id) === String(pr.id));
check('com desconto de 10%: 90 × 50% = 45', pd.services.find((x) => x.name === 'Comissão serv A').commission === 45 && f.deduction_pct === 10);
check('desconto vale também para produto: 90 × 10,5% = 9,45', pd.products[0].commission === 9.45, JSON.stringify(pd.products));
check('o valor cheio continua aparecendo', pd.services_total === 160 && pd.products_total === 100);

// período vazio e outras empresas
f = (await call('GET', '/api/commissions?date=2031-09-15', { token: t })).body;
check('período sem nada zera', f.professionals.every((x) => x.commission_total === 0) && f.total_commission === 0);
const fb = (await call('GET', '/api/commissions?date=2031-04-15', { token: B.token })).body;
check('outra empresa não vê esses valores', fb.total_commission === 0 && !fb.professionals.some((x) => String(x.professional_id) === String(pr.id) && x.commission_total > 0));
check('outra empresa não mexe nos percentuais', (await call('PUT', '/api/commissions/rates/' + pr.id, { token: B.token, body: { service_pct: 99, product_pct: 99 } })).status === 404
  || (await call('GET', '/api/commissions/rates', { token: B.token })).body.every((x) => x.service_pct !== 99));

// limpeza
await call('PUT', '/api/commissions/settings', { token: t, body: { period: 'monthly', deduction_pct: 0 } });
await put(pr.id, { service_pct: 0, product_pct: 0, overrides: [] });
for (const a of [a1, a2, a4]) await st(a, 'cancelled');
for (const v of [venda, semProf]) await call('DELETE', '/api/product-sales/' + v.id, { token: t });
for (const id of [svA.id, svB.id, prodC.id]) await call('DELETE', '/api/services/' + id + '/permanent?com_historico=1', { token: t });

console.log(`${ok} ok, ${fail} falhas`);
process.exit(fail ? 1 : 0);
