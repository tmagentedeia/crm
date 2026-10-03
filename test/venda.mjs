// Venda com valor (pagamento aceito ou pedido pago) transforma lead em cliente. Uso: BASE=http://localhost:3999 node test/venda.mjs
const BASE = process.env.BASE || 'http://localhost:3999';
let ok = 0, fail = 0;
const check = (name, cond, extra = '') => { cond ? ok++ : (fail++, console.log('FALHOU:', name, extra)); };
const call = async (method, path, token, body) => {
  const r = await fetch(BASE + path, { method, headers: { 'content-type': 'application/json', authorization: 'Bearer ' + token }, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, body: await r.json().catch(() => null) };
};
const login = async (e, p) => (await (await fetch(BASE + '/api/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: e, password: p }) })).json()).token;
const A = await login('demo@demo.com', 'demo1234');
const T = (m, p, b) => call(m, p, A, b);
const sp = (minAtras) => new Date(Date.now() - minAtras * 60000 - 3 * 3600000).toISOString().slice(0, 16).replace('T', ' ');
const lead = async (nome, fim) => (await T('POST', '/api/customers', { name: nome, phone: '3299777' + fim, status: 'lead' })).body;
const status = async (id) => (await T('GET', `/api/customers/${id}`)).body.status;

// pedido pago pelo agente (valor informado) -> cliente
const a = await lead('Venda Pedido', '0001');
check('começa como lead', a.status === 'lead', JSON.stringify(a));
const o1 = await T('POST', '/api/orders', { phone: '553297770001', song: 'Pago na hora', amount_paid: 30 });
check('pedido pago cria', o1.status === 201, JSON.stringify(o1));
check('pedido pago: lead vira cliente', (await status(a.id)) === 'client');

// pedido sem valor (aguardando) -> continua lead
const b = await lead('Venda Aguardando', '0002');
await T('POST', '/api/orders', { phone: '553297770002', song: 'Sem valor' });
check('pedido sem valor: continua lead', (await status(b.id)) === 'lead');

// cortesia (valor 0) -> continua lead
const c = await lead('Venda Cortesia', '0003');
await T('POST', '/api/orders', { phone: '553297770003', song: 'Cortesia', kind: 'courtesy' });
check('cortesia: continua lead', (await status(c.id)) === 'lead');

// comprovante chega depois: pedido existente passa a pago com valor -> cliente
const d = await lead('Venda Depois', '0004');
const od = (await T('POST', '/api/orders', { phone: '553297770004', song: 'Paga depois' })).body;
check('antes do pagamento é lead', (await status(d.id)) === 'lead');
const up = await T('PUT', `/api/orders/${od.id}`, { amount_paid: 30 });
check('atualiza valor do pedido', up.status === 200, JSON.stringify(up));
check('valor registrado depois: vira cliente', (await status(d.id)) === 'client');

// pagamento aceito (comprovante conferido) -> cliente
const k = (await T('GET', '/api/finance/keys')).body;
if (!k.some((x) => x.active)) await T('POST', '/api/finance/keys', { key_type: 'email', key: 'venda.teste@x.com', beneficiary: 'Teste' });
const chave = (await T('GET', '/api/finance/keys')).body.find((x) => x.active);
const e = await lead('Venda Pix', '0005');
const pg = (await T('POST', '/api/payments/check', {
  phone: '553297770005', payer_name: 'Pagador', amount: 25, key: chave.key, txid: 'EVENDA' + Math.random().toString(36).slice(2).padEnd(26, 'x'),
  paid_at: sp(10), purpose: 'Contribuição' })).body;
check('comprovante aceito', pg.accepted === true, JSON.stringify(pg));
check('pagamento aceito: lead vira cliente', (await status(e.id)) === 'client');

// comprovante recusado não converte
const f = await lead('Venda Recusada', '0006');
const rec = (await T('POST', '/api/payments/check', {
  phone: '553297770006', payer_name: 'Pagador', amount: 25, key: 'outra@pessoa.com', txid: 'EVENDA' + Math.random().toString(36).slice(2).padEnd(26, 'x'),
  paid_at: sp(10) })).body;
check('comprovante de chave errada recusado', rec.accepted === false, JSON.stringify(rec));
check('pagamento recusado: continua lead', (await status(f.id)) === 'lead');

console.log(`venda: ${ok} ok, ${fail} falhas`); process.exit(fail ? 1 : 0);
