// Exclusão em massa (serviços, clientes, pedidos, lives). Uso: BASE=http://localhost:3999 node test/apagar_massa.mjs
const BASE = process.env.BASE || 'http://localhost:3999';
let ok = 0, fail = 0;
const check = (name, cond, extra = '') => { cond ? ok++ : (fail++, console.log('FALHOU:', name, extra)); };
const call = async (method, path, token, body) => {
  const r = await fetch(BASE + path, { method, headers: { 'content-type': 'application/json', authorization: 'Bearer ' + token }, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, body: await r.json().catch(() => null) };
};
const login = async (e, p) => (await (await fetch(BASE + '/api/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: e, password: p }) })).json()).token;
const A = await login('demo@demo.com', 'demo1234');
const B = await login('dois@x.com', 'senhasenha');
const T = (m, p, b, t = A) => call(m, p, t, b);

// sem seleção = 400
for (const rota of ['services', 'customers', 'orders', 'lives', 'appointments', 'waitlist'])
  check(`${rota}: sem ids = 400`, (await T('POST', `/api/${rota}/bulk-delete`, { ids: [] })).status === 400);

// clientes: simulação descreve, apagar de verdade remove; outra empresa não apaga nada
const c = [];
for (let i = 0; i < 3; i++) c.push((await T('POST', '/api/customers', { name: 'Massa ' + i, phone: '3298007000' + i, status: 'lead' })).body.id);
const dry = (await T('POST', '/api/customers/bulk-delete', { ids: c, dry_run: true })).body;
check('clientes: simulação', dry.found === 3 && dry.appointments === 0, JSON.stringify(dry));
check('clientes: simulação não apaga', (await T('GET', '/api/customers/' + c[0])).status === 200);
const outra = (await T('POST', '/api/customers/bulk-delete', { ids: c }, B)).body;
check('clientes: outra empresa não apaga', (outra.deleted ?? 0) === 0 && (await T('GET', '/api/customers/' + c[0])).status === 200, JSON.stringify(outra));
const del = (await T('POST', '/api/customers/bulk-delete', { ids: c })).body;
check('clientes: apagou 3', del.deleted === 3, JSON.stringify(del));
check('clientes: sumiu', (await T('GET', '/api/customers/' + c[0])).status === 404);

// serviços
const s = [];
for (let i = 0; i < 2; i++) s.push((await T('POST', '/api/services', { name: 'Massa serv ' + i, duration_min: 30, price: 10, category: 'Teste' })).body?.id);
check('serviços criados', s.every(Boolean), JSON.stringify(s));
const sd = (await T('POST', '/api/services/bulk-delete', { ids: s, dry_run: true })).body;
check('serviços: simulação', sd.found === 2 && sd.com_historico === 0, JSON.stringify(sd));
const sr = (await T('POST', '/api/services/bulk-delete', { ids: s })).body;
check('serviços: apagou 2', sr.deleted === 2 && !(sr.skipped || []).length, JSON.stringify(sr));

// lives e pedidos
const o = (await T('POST', '/api/orders', { phone: '553280070009', song: 'Massa', name: 'Massa P' })).body;
check('pedido criado', !!o.id, JSON.stringify(o));
let l = o.live, criada = false;
if (!l) { criada = true; l = (await T('POST', '/api/lives', { title: 'Massa live', starts_at: new Date(Date.now() + 40 * 864e5).toISOString() })).body.live; }
const l2 = (await T('POST', '/api/lives', { title: 'Massa vazia', starts_at: new Date(Date.now() + 900 * 864e5).toISOString() })).body.live;
const lr = (await T('POST', '/api/lives/bulk-delete', { ids: [l.id, l2.id] })).body;
check('lives: só a vazia some', lr.deleted === 1 && lr.skipped?.length === 1, JSON.stringify(lr));
const pr = (await T('POST', '/api/orders/bulk-delete', { ids: [o.id] })).body;
check('pedidos: apagou', pr.deleted === 1, JSON.stringify(pr));
if (criada) check('lives: agora apaga', (await T('POST', '/api/lives/bulk-delete', { ids: [l.id] })).body.deleted === 1);

console.log(`apagar_massa: ${ok} ok, ${fail} falhas`);
process.exit(fail ? 1 : 0);
