// Dashboard: resumo de atendimentos, pedidos de música, valores recebidos e ingressos. Uso: BASE=http://localhost:3999 node test/dashboard.mjs
const BASE = process.env.BASE || 'http://localhost:3999';
let ok = 0, fail = 0;
const check = (name, cond, extra = '') => { cond ? ok++ : (fail++, console.log('FALHOU:', name, extra)); };
const login = await (await fetch(BASE + '/api/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: 'demo@demo.com', password: 'demo1234' }) })).json();
const get = async (days) => (await fetch(`${BASE}/api/dashboard?days=${days}`, { headers: { authorization: 'Bearer ' + login.token } })).json();
const d = await get(365);
check('mantém atendimentos e faturamento', Number.isInteger(d.atendimentos) && d.faturamento !== undefined);
check('pedidos de música', d.pedidos && Number.isInteger(d.pedidos.total) && d.pedidos.atendidos <= d.pedidos.total, JSON.stringify(d.pedidos));
check('músicas mais pedidas', Array.isArray(d.musicas) && d.musicas.length <= 10);
check('valores recebidos', d.recebido && typeof d.recebido.total === 'number' && Number.isInteger(d.recebido.aceitos), JSON.stringify(d.recebido));
check('ingressos vendidos', d.ingressos && Number.isInteger(d.ingressos.vendas) && Number.isInteger(d.ingressos.pessoas) && typeof d.ingressos.total === 'number', JSON.stringify(d.ingressos));
const curto = await get(1);
check('período menor não passa do maior', curto.pedidos.total <= d.pedidos.total && curto.recebido.total <= d.recebido.total + 0.001);
console.log(`dashboard: ${ok} ok, ${fail} falhas`);
process.exit(fail ? 1 : 0);
