// Lotes de ingresso por evento. Uso: BASE=http://localhost:3999 node test/casa_de_shows_lotes.mjs
import { execSync } from 'child_process';
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
const psql = (sql) => execSync(`psql "${process.env.DATABASE_URL}" -tAc "${sql}"`).toString().trim();
psql("set search_path to company_1, public; delete from company_1.shows_reservations where sector_id in (select id from company_1.shows_sectors where name = 'Pista Lotes'); delete from company_1.shows_sectors where name = 'Pista Lotes'; delete from company_1.events where title like 'Show Lotes%'");
const A = (await call('POST', '/api/auth/login', { body: { email: 'demo@demo.com', password: 'demo1234' } })).body;
const api = (m, p, body) => call(m, '/api' + p, { token: A.token, body });
const N8N = { 'x-api-key': process.env.N8N_API_KEY || 'k', 'x-company-id': '1' };
const h = (n) => new Date(Date.now() + n * 36e5).toISOString();

const ev = (await api('POST', '/events', { title: 'Show Lotes', starts_at: h(24 * 10) })).body;
const L = (b) => api('PUT', `/casa-de-shows/events/${ev.id}/lots`, b);
const preco = async (q = '') => (await call('GET', `/n8n/casa-de-shows/events/${ev.id}/price?x=1${q}`, { headers: N8N })).body;

check('sem preço nenhum', (await preco()).unit_price === null);
check('evento inexistente', (await api('GET', '/casa-de-shows/events/999999/lots')).status === 404);
check('lista inválida', (await L({ lots: 'x' })).status === 400);
check('lote sem valor', (await L({ lots: [{ name: 'A', valid_until: h(5) }] })).status === 400);
check('valor inválido', (await L({ lots: [{ name: 'A', price: 'abc', valid_until: h(5) }] })).status === 400);
check('lote do meio sem prazo', (await L({ lots: [{ name: 'A', price: 50 }, { name: 'B', price: 60 }] })).status === 400);
check('prazos fora de ordem', (await L({ lots: [{ name: 'A', price: 50, valid_until: h(48) }, { name: 'B', price: 60, valid_until: h(24) }] })).status === 400);
check('prazo inválido', (await L({ lots: [{ name: 'A', price: 50, valid_until: 'ontem-ou-sei-la' }] })).status === 400);
check('n8n não grava lotes', (await call('PUT', `/n8n/casa-de-shows/events/${ev.id}/lots`, { headers: N8N, body: { lots: [] } })).status === 403);

// lote 1 vencido, lote 2 vigente, lote 3 sem prazo
let r = await L({ lots: [{ name: 'Lote 1', price: 40, valid_until: h(-48) }, { name: 'Lote 2', price: 60, valid_until: h(48) }, { name: 'Lote 3', price: 80 }] });
check('grava os lotes', r.status === 200 && r.body.lots.length === 3 && r.body.current.name === 'Lote 2', JSON.stringify(r.body));
let p = await preco();
check('vale o lote vigente', p.unit_price === 60 && p.lot === 'Lote 2' && p.tier === 'lote', JSON.stringify(p));
check('avisa o próximo lote', p.next_lot && p.next_lot.name === 'Lote 3' && p.next_lot.price === 80, JSON.stringify(p.next_lot));
p = await preco('&people=3');
check('total usa o lote', p.total === 180);
p = await preco('&code=semcodigo');
check('palavra inexistente continua recusada', p.code_valid === false);

// palavra-chave com desconto aplica sobre o lote
await api('POST', `/casa-de-shows/events/${ev.id}/codes`, { word: 'AMIGO', kind: 'percent', value: 50 });
p = await preco('&code=amigo');
check('desconto da palavra sobre o lote', p.unit_price === 30 && p.base_price === 60 && p.applied === 'code', JSON.stringify(p));

// lote 3 sem prazo, sem portaria: vale para sempre
r = await L({ lots: [{ name: 'Lote 1', price: 40, valid_until: h(-48) }, { name: 'Lote 2', price: 60, valid_until: h(-24) }, { name: 'Lote 3', price: 80 }] });
p = await preco();
check('último lote sem prazo e sem portaria', p.unit_price === 80 && p.lot === 'Lote 3', JSON.stringify(p));

// todos vencidos, sem portaria: fica o último; com portaria: portaria
r = await L({ lots: [{ name: 'Lote 1', price: 40, valid_until: h(-48) }, { name: 'Lote 2', price: 60, valid_until: h(-24) }] });
p = await preco();
check('todos vencidos sem portaria: último lote', p.unit_price === 60 && p.lot === 'Lote 2', JSON.stringify(p));
await api('PUT', `/casa-de-shows/events/${ev.id}/conditions`, { door_price: 120 });
p = await preco();
check('todos vencidos com portaria: valor da portaria', p.unit_price === 120 && p.tier === 'portaria' && !p.lot, JSON.stringify(p));

// portaria sem preço único cadastrado é aceita quando há lotes
check('portaria aceita com lotes', (await api('GET', `/casa-de-shows/events/${ev.id}/conditions`)).body.door_price === 120);

// lote sem prazo + portaria: vale até o começo do evento
r = await L({ lots: [{ name: 'Lote 1', price: 40, valid_until: h(24) }, { name: 'Lote 2', price: 70 }] });
p = await preco();
check('lote 1 vigente avisa que o próximo é o 2', p.lot === 'Lote 1' && p.next_lot && p.next_lot.name === 'Lote 2', JSON.stringify(p));
r = await L({ lots: [{ name: 'Lote 1', price: 40, valid_until: h(-24) }, { name: 'Lote 2', price: 70 }] });
p = await preco();
check('lote sem prazo vale até o evento (começa daqui a 10 dias)', p.unit_price === 70 && p.lot === 'Lote 2', JSON.stringify(p));
psql(`set search_path to company_1, public; update events set starts_at = now() - interval '1 hour' where id = ${ev.id}`);
p = await preco();
check('depois do começo do evento vale a portaria', p.unit_price === 120 && p.tier === 'portaria', JSON.stringify(p));
psql(`set search_path to company_1, public; update events set starts_at = now() + interval '10 days' where id = ${ev.id}`);

// a reserva pega o lote vigente
const setor = (await api('POST', '/casa-de-shows/sectors', { name: 'Pista Lotes', space: 100 })).body;
await L({ lots: [{ name: 'Lote 1', price: 40, valid_until: h(-24) }, { name: 'Lote 2', price: 70, valid_until: h(24) }] });
const rv = (await api('POST', '/casa-de-shows/reservations', { event_id: ev.id, sector_id: setor.id, name: 'Cliente Lote', people: 2 })).body;
check('reserva usa o preço do lote vigente', rv.unit_price === 70 && rv.total === 140, JSON.stringify(rv));

// duplicar copia os lotes com as datas deslocadas
const dup = await api('POST', `/casa-de-shows/events/${ev.id}/duplicate`, { title: 'Show Lotes 2', starts_at: h(24 * 20) });
const gd = (await api('GET', `/casa-de-shows/events/${dup.body.event.id}/lots`)).body;
check('duplicar copia os lotes', gd.lots.length === 2 && gd.lots[1].price === 70, JSON.stringify(gd));
const dt = new Date(gd.lots[1].valid_until) - new Date((await api('GET', `/casa-de-shows/events/${ev.id}/lots`)).body.lots[1].valid_until);
check('datas dos lotes acompanham o novo evento', Math.abs(dt - 24 * 36e5 * 10) < 5000, String(dt));

// apagar os lotes volta ao preço único
await L({ lots: [] });
await api('PUT', `/casa-de-shows/events/${ev.id}/conditions`, { price: 90, price_until: h(24), door_price: 150 });
p = await preco();
check('sem lotes vale o preço único de antes', p.unit_price === 90 && !p.lot && p.tier === 'normal', JSON.stringify(p));

for (const e of [ev, dup.body.event]) await api('DELETE', '/events/' + e.id);
psql(`set search_path to company_1, public; delete from shows_reservations where sector_id=${setor.id}`);
await api('DELETE', `/casa-de-shows/sectors/${setor.id}`);

// ---------- lote por quantidade ----------
const ev3 = (await api('POST', '/events', { title: 'Show Lotes Qtd', starts_at: h(24 * 10) })).body;
const L3 = (b) => api('PUT', `/casa-de-shows/events/${ev3.id}/lots`, b);
const pr3 = async () => (await call('GET', `/n8n/casa-de-shows/events/${ev3.id}/price?x=1`, { headers: N8N })).body;
const setor3 = (await api('POST', '/casa-de-shows/sectors', { name: 'Pista Lotes', space: 100 })).body;
const res3 = async (nome, n) => (await api('POST', '/casa-de-shows/reservations', { event_id: ev3.id, sector_id: setor3.id, name: nome, people: n })).body;
check('quantidade inválida', (await L3({ lots: [{ name: 'A', price: 50, max_qty: 0 }] })).status === 400);
check('quantidade com texto', (await L3({ lots: [{ name: 'A', price: 50, max_qty: 'muitos' }] })).status === 400);
check('lote do meio sem prazo e sem quantidade', (await L3({ lots: [{ name: 'A', price: 50 }, { name: 'B', price: 60 }] })).status === 400);
let r3 = await L3({ lots: [{ name: 'Lote 1', price: 40, max_qty: 6, valid_until: h(48) }, { name: 'Lote 2', price: 60, max_qty: 4 }, { name: 'Lote 3', price: 90 }] });
check('grava lotes com quantidade', r3.status === 200 && r3.body.lots[0].max_qty === 6 && r3.body.lots[0].sold === 0, JSON.stringify(r3.body));
let q3 = await pr3();
check('lote 1 com 6 ingressos', q3.lot === 'Lote 1' && q3.lot_qty === 6 && q3.lot_remaining === 6 && q3.unit_price === 40, JSON.stringify(q3));
const a1 = await res3('Compra A', 4);
check('venda no lote 1 usa o preço dele', a1.unit_price === 40, JSON.stringify(a1));
q3 = await pr3();
check('restam 2 no lote 1', q3.lot === 'Lote 1' && q3.lot_remaining === 2, JSON.stringify(q3));
const a2 = await res3('Compra B', 2);
q3 = await pr3();
check('esgotou o lote 1: vale o lote 2', a2.unit_price === 40 && q3.lot === 'Lote 2' && q3.unit_price === 60 && q3.lot_remaining === 4, JSON.stringify(q3));
check('lote 1 esgotado aparece como vendido', (await api('GET', `/casa-de-shows/events/${ev3.id}/lots`)).body.lots[0].sold === 6);
const a3 = await res3('Compra C', 4);
check('venda no lote 2 usa o preço dele', a3.unit_price === 60);
q3 = await pr3();
check('lote 2 esgotado: vale o lote 3', q3.lot === 'Lote 3' && q3.unit_price === 90 && q3.lot_remaining === null, JSON.stringify(q3));

// cancelar devolve o ingresso ao lote
await api('PUT', `/casa-de-shows/reservations/${a3.id}`, { status: 'cancelled' });
q3 = await pr3();
check('cancelar devolve o ingresso ao lote', q3.lot === 'Lote 2' && q3.lot_remaining === 4, JSON.stringify(q3));

// editar o lote mantendo o id preserva as vendas
const evx = (await api('POST', '/events', { title: 'Show Lotes Outro', starts_at: h(24 * 11) })).body;
const atual = (await api('GET', `/casa-de-shows/events/${ev3.id}/lots`)).body.lots;
r3 = await L3({ lots: atual.map((l) => ({ id: l.id, name: l.name + ' x', price: l.price, max_qty: l.max_qty, valid_until: l.valid_until })) });
check('editar com id mantém as vendas', r3.status === 200 && r3.body.lots[0].sold === 6 && r3.body.lots[0].name === 'Lote 1 x', JSON.stringify(r3.body.lots[0]));
{ const rr = await api('PUT', `/casa-de-shows/events/${evx.id}/lots`, { lots: [{ id: atual[0].id, name: 'Z', price: 1 }] }); check('id de lote de outro evento é recusado', rr.status === 400, JSON.stringify(rr)); }
// aumentar a quantidade reabre o lote
r3 = await L3({ lots: (await api('GET', `/casa-de-shows/events/${ev3.id}/lots`)).body.lots.map((l, i) => ({ id: l.id, name: l.name, price: l.price, max_qty: i === 0 ? 10 : l.max_qty, valid_until: l.valid_until })) });
q3 = await pr3();
check('aumentar a quantidade reabre o lote 1', q3.lot === 'Lote 1 x' && q3.lot_remaining === 4, JSON.stringify(q3));

// quantidade esgotada + portaria
await api('PUT', `/casa-de-shows/events/${ev3.id}/conditions`, { door_price: 150 });
r3 = await L3({ lots: [{ name: 'Único', price: 50, max_qty: 1 }] });
await res3('Compra D', 1);
q3 = await pr3();
check('esgotado o único lote: vale a portaria', q3.tier === 'portaria' && q3.unit_price === 150, JSON.stringify(q3));
await api('PUT', `/casa-de-shows/events/${ev3.id}/conditions`, { door_price: null });
q3 = await pr3();
check('esgotado sem portaria: continua o último lote', q3.lot === 'Único' && q3.lot_remaining === 0 && q3.unit_price === 50, JSON.stringify(q3));
psql(`set search_path to company_1, public; delete from shows_reservations where sector_id=${setor3.id}`);
await api('DELETE', `/casa-de-shows/sectors/${setor3.id}`);
await api('DELETE', '/events/' + ev3.id); await api('DELETE', '/events/' + evx.id);
console.log(`${ok} ok, ${fail} falhas`);
process.exit(fail ? 1 : 0);
