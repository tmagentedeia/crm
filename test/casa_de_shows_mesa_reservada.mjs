// Mesa reservada: o dono compra a mesa e os lugares que sobram são vendidos a convidados. Uso: BASE=http://localhost:3999 node test/casa_de_shows_mesa_reservada.mjs
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
psql("set search_path to company_1, public; delete from company_1.shows_sale_payments; update company_1.shows_sales set host_sale_id = null where host_sale_id is not null; delete from company_1.shows_sales where sector_id in (select id from company_1.shows_sectors where name like 'Setor Mesa Res%'); delete from company_1.shows_sectors where name like 'Setor Mesa Res%'; delete from company_1.shows_table_types where name like 'Mesa Res%'; delete from company_1.events where title like 'Show Mesa Res%'; delete from company_1.customers where phone like '%3288870001' or phone like '%3288870002'");
const A = (await call('POST', '/api/auth/login', { body: { email: 'demo@demo.com', password: 'demo1234' } })).body;
const api = (m, p, body) => call(m, '/api' + p, { token: A.token, body });
const N8N = { 'x-api-key': process.env.N8N_API_KEY || 'k', 'x-company-id': '1' };
const n8n = (m, p, body) => call(m, '/n8n' + p, { headers: N8N, body });
const h = (n) => new Date(Date.now() + n * 36e5).toISOString();

const ev = (await api('POST', '/events', { title: 'Show Mesa Res', starts_at: h(24 * 10) })).body;
const setor = (await api('POST', '/casa-de-shows/sectors', { name: 'Setor Mesa Res', space: 30 })).body;
const mesa12 = (await api('POST', '/casa-de-shows/table-types', { name: 'Mesa Res 12', seats: 12, space: 6 })).body;
const mesa4 = (await api('POST', '/casa-de-shows/table-types', { name: 'Mesa Res 4', seats: 4, space: 2 })).body;
await api('PUT', `/casa-de-shows/events/${ev.id}/conditions`, { price: 100 });
const uso = async () => (await api('GET', `/casa-de-shows/availability?event_id=${ev.id}`)).body;
const usoSetor = async () => { const d = await uso(); const x = (d.sectors || []).find((z) => String(z.sector_id) === String(setor.id)); return x; };

// o dono compra a mesa de 12 e o espaço é descontado do setor
const dono = (await api('POST', '/casa-de-shows/sales', { event_id: ev.id, sector_id: setor.id, name: 'Dono da Mesa', phone: '32988870001', people: 2, table_type_id: mesa12.id, tables: 1 })).body;
check('dono comprou a mesa de 12', dono.id && dono.tables === 1 && dono.seats === 12, JSON.stringify(dono));
const antes = await usoSetor();
check('espaço usado pela mesa do dono', antes && antes.used === 6, JSON.stringify(antes));

const G = (id, body) => api('POST', `/casa-de-shows/sales/${id}/guests`, body);
check('sem mesa reservada ligada não aceita convidado', (await G(dono.id, { name: 'X', people: 1 })).status === 404);
check('ligar exige a palavra', (await api('PUT', `/casa-de-shows/sales/${dono.id}/held`, { enabled: true, kind: 'percent', value: 20 })).status === 400);
check('percentual inválido', (await api('PUT', `/casa-de-shows/sales/${dono.id}/held`, { enabled: true, word: 'aniv', kind: 'percent', value: 150 })).status === 400);
check('n8n não liga a mesa', (await n8n('PUT', `/casa-de-shows/sales/${dono.id}/held`, { enabled: true, word: 'aniv', kind: 'percent', value: 20 })).status === 403);
let m = await api('PUT', `/casa-de-shows/sales/${dono.id}/held`, { enabled: true, word: 'AnivMesa', kind: 'percent', value: 20 });
check('liga a mesa reservada', m.status === 200 && m.body.held && m.body.seats_total === 12 && m.body.owner_people === 2 && m.body.free === 10 && m.body.code.word === 'AnivMesa', JSON.stringify(m.body));
let lista = (await api('GET', `/casa-de-shows/sales?event_id=${ev.id}`)).body;
check('lista mostra a mesa com lugares à venda', lista.find((x) => x.id === dono.id).held === true && lista.find((x) => x.id === dono.id).held_seats === 10 && lista.find((x) => x.id === dono.id).held_sold === 0);
check('palavra da mesa não aparece nas palavras gerais', !(await api('GET', `/casa-de-shows/events/${ev.id}/codes`)).body.some((k) => k.word === 'AnivMesa'));

// o atendente consulta o preço pela palavra
let p = (await n8n('GET', `/casa-de-shows/events/${ev.id}/price?code=anivmesa&people=3`)).body;
check('preço pela palavra: 20% sobre o valor vigente', p.code_valid && p.base_price === 100 && p.unit_price === 80 && p.total === 240 && p.held && p.held.free_seats === 10, JSON.stringify(p));

// o atendente vende pela palavra: entra na mesa e tira lugares
const v1 = await n8n('POST', '/casa-de-shows/sales', { event_id: ev.id, code: 'anivmesa', name: 'Convidado Um', phone: '32988870002', people: 3 });
check('venda pela palavra vira convidado da mesa', v1.status === 201 && v1.body.host_sale_id === dono.id && v1.body.unit_price === 80 && v1.body.tables === 0 && v1.body.total === 240, JSON.stringify(v1.body));
const depois = await usoSetor();
check('convidado não consome espaço novo do setor', depois.used === antes.used && depois.free === antes.free, JSON.stringify(depois));
m = (await api('GET', `/casa-de-shows/sales/${dono.id}/held`)).body;
check('lugares debitados', m.sold === 3 && m.free === 7 && m.guests.length === 1, JSON.stringify({ sold: m.sold, free: m.free }));
check('convidado vira cliente', psql("select status from company_1.customers where phone like '%3288870002'") === 'client');

// capacidade
const v2 = await n8n('POST', '/casa-de-shows/sales', { event_id: ev.id, code: 'anivmesa', name: 'Grupo Grande', people: 8 });
check('mais pessoas que lugares livres é recusado', v2.status === 409 && /7 lugar/.test(v2.body.error), JSON.stringify(v2.body));
const v3 = await n8n('POST', '/casa-de-shows/sales', { event_id: ev.id, code: 'anivmesa', name: 'Convidado Dois', people: 7 });
check('ocupa os últimos lugares', v3.status === 201);
p = (await n8n('GET', `/casa-de-shows/events/${ev.id}/price?code=anivmesa`)).body;
check('mesa lotada: palavra deixa de valer', p.code_valid === false && /todos vendidos/.test(p.reason), JSON.stringify(p));
check('venda pela palavra com a mesa lotada é recusada', (await n8n('POST', '/casa-de-shows/sales', { event_id: ev.id, code: 'anivmesa', name: 'Atrasado', people: 1 })).status === 409);

// cancelar um convidado devolve os lugares
const c1 = await api('PUT', `/casa-de-shows/sales/${v1.body.id}`, { status: 'cancelled' });
m = (await api('GET', `/casa-de-shows/sales/${dono.id}/held`)).body;
check('cancelar devolve os lugares', c1.status === 200 && m.free === 3 && m.sold === 7, JSON.stringify({ free: m.free, sold: m.sold }));
check('editar convidado além dos lugares é recusado', (await api('PUT', `/casa-de-shows/sales/${v3.body.id}`, { people: 11 })).status === 409);
check('editar convidado dentro dos lugares', (await api('PUT', `/casa-de-shows/sales/${v3.body.id}`, { people: 9, note: 'chega tarde' })).status === 200);
check('reativar convidado respeita os lugares', (await api('PUT', `/casa-de-shows/sales/${v1.body.id}`, { status: 'confirmed' })).status === 409);
await api('PUT', `/casa-de-shows/sales/${v3.body.id}`, { people: 7 });

// regras do dono
check('cancelar a mesa com convidados é recusado', (await api('PUT', `/casa-de-shows/sales/${dono.id}`, { status: 'cancelled' })).status === 409);
check('desligar a mesa com convidados é recusado', (await api('PUT', `/casa-de-shows/sales/${dono.id}/held`, { enabled: false })).status === 409);
check('apagar a mesa com convidados é recusado', (await api('DELETE', `/casa-de-shows/sales/${dono.id}`)).status === 409);
check('dono não pode reduzir a mesa abaixo dos lugares vendidos', (await api('PUT', `/casa-de-shows/sales/${dono.id}`, { table_type_id: mesa4.id, tables: 1 })).status === 409);
check('dono pode mudar de pessoas dentro da folga', (await api('PUT', `/casa-de-shows/sales/${dono.id}`, { people: 3 })).status === 200);
await api('PUT', `/casa-de-shows/sales/${dono.id}`, { people: 2 });
const kid = (await api('GET', `/casa-de-shows/sales/${dono.id}/held`)).body.code.id;
check('palavra da mesa não se edita nas palavras gerais', (await api('PUT', `/casa-de-shows/codes/${kid}`, { value: 5 })).status === 409 && (await api('DELETE', `/casa-de-shows/codes/${kid}`)).status === 409);
check('convidado não vira mesa reservada', (await api('PUT', `/casa-de-shows/sales/${v3.body.id}/held`, { enabled: true, word: 'x', kind: 'percent', value: 5 })).status === 409);

// valor fixo
m = await api('PUT', `/casa-de-shows/sales/${dono.id}/held`, { enabled: true, word: 'AnivMesa', kind: 'price', value: 60 });
check('troca para valor fixo', m.status === 200 && m.body.code.kind === 'price' && m.body.code.value === 60);
p = (await n8n('GET', `/casa-de-shows/events/${ev.id}/price?code=anivmesa`)).body;
check('valor fixo respeitado', p.unit_price === 60 && p.base_price === 100, JSON.stringify(p));
// desconto nunca passa do valor vigente
await api('PUT', `/casa-de-shows/sales/${dono.id}/held`, { enabled: true, word: 'AnivMesa', kind: 'price', value: 150 });
p = (await n8n('GET', `/casa-de-shows/events/${ev.id}/price?code=anivmesa`)).body;
check('valor fixo acima do vigente não encarece', p.unit_price === 100, JSON.stringify(p));
await api('PUT', `/casa-de-shows/sales/${dono.id}/held`, { enabled: true, word: 'AnivMesa', kind: 'percent', value: 20 });

// a equipe vende os lugares que sobraram na portaria
await api('PUT', `/casa-de-shows/sales/${v3.body.id}`, { status: 'cancelled' });   // libera 7
const cl = await api('PUT', `/casa-de-shows/sales/${dono.id}/held`, { closed: true });
check('encerrar a venda pela palavra', cl.status === 200 && cl.body.code.closed === true, JSON.stringify(cl.body.code));
p = (await n8n('GET', `/casa-de-shows/events/${ev.id}/price?code=anivmesa`)).body;
check('encerrada: a palavra não vale mais para o atendente', p.code_valid === false, JSON.stringify(p));
check('encerrada: venda pela palavra recusada', (await n8n('POST', '/casa-de-shows/sales', { event_id: ev.id, code: 'anivmesa', name: 'Tarde', people: 1 })).status === 409);
const g1 = await G(dono.id, { name: 'Portaria Um', people: 2, price_mode: 'normal' });
check('portaria vende lugar da mesa no valor normal', g1.status === 201 && g1.body.unit_price === 100 && g1.body.host_sale_id === dono.id, JSON.stringify(g1.body));
const g2 = await G(dono.id, { name: 'Portaria Dois', people: 1, price_mode: 'manual', unit_price: 70 });
check('portaria vende com valor combinado', g2.status === 201 && g2.body.unit_price === 70);
const g3 = await G(dono.id, { name: 'Portaria Três', people: 1 });
check('portaria com o desconto da mesa', g3.status === 201 && g3.body.unit_price === 80, JSON.stringify(g3.body));
check('manual exige valor', (await G(dono.id, { name: 'Sem valor', people: 1, price_mode: 'manual' })).status === 400);
check('convidado exige nome', (await G(dono.id, { people: 1 })).status === 400);
check('telefone inválido', (await G(dono.id, { name: 'Tel', people: 1, phone: '12' })).status === 400);
check('reabrir a venda pela palavra', (await api('PUT', `/casa-de-shows/sales/${dono.id}/held`, { closed: false })).body.code.closed === false);

// pagamentos do convidado e do dono são separados
const pg = await api('POST', `/casa-de-shows/sales/${g1.body.id}/payments`, { method: 'dinheiro', amount: 200 });
check('convidado tem pagamento próprio', pg.status === 201);
const pd = await api('POST', `/casa-de-shows/sales/${dono.id}/payments`, { method: 'cortesia' });
const ld = (await api('GET', `/casa-de-shows/sales?event_id=${ev.id}`)).body;
check('pagamento do dono (cortesia) não mistura com o do convidado', pd.status === 201 && ld.find((x) => x.id === dono.id).courtesy === true && ld.find((x) => x.id === g1.body.id).paid === 200 && ld.find((x) => x.id === g1.body.id).courtesy === false);
check('lista traz o nome da mesa no convidado', ld.find((x) => x.id === g1.body.id).host_name === 'Dono da Mesa');
check('convidado vem logo depois da mesa', ld.findIndex((x) => x.id === g1.body.id) > ld.findIndex((x) => x.id === dono.id));

// duplicar o evento não copia a palavra da mesa
const dup = await api('POST', `/casa-de-shows/events/${ev.id}/duplicate`, { title: 'Show Mesa Res 2', starts_at: h(24 * 20) });
check('duplicar não copia a palavra da mesa reservada', Number(psql(`select count(*) from company_1.shows_event_codes where event_id = ${dup.body.event.id}`)) === 0);

// desligar depois de cancelar tudo
for (const g of (await api('GET', `/casa-de-shows/sales/${dono.id}/held`)).body.guests) await api('DELETE', `/casa-de-shows/sales/${g.id}`);
check('desliga a mesa sem convidados', (await api('PUT', `/casa-de-shows/sales/${dono.id}/held`, { enabled: false })).body.held === false);
check('desligada: a palavra some', (await n8n('GET', `/casa-de-shows/events/${ev.id}/price?code=anivmesa`)).body.code_valid === false);
check('sem evento não vira mesa reservada', (await (async () => { const s = (await api('POST', '/casa-de-shows/sales', { date: '2031-09-20', sector_id: setor.id, name: 'Avulsa', people: 2 })).body; return (await api('PUT', `/casa-de-shows/sales/${s.id}/held`, { enabled: true, word: 'abc', kind: 'percent', value: 10 })).status; })()) === 409);

psql(`set search_path to company_1, public; delete from shows_sale_payments; update shows_sales set host_sale_id = null where sector_id = ${setor.id}; delete from shows_sales where sector_id = ${setor.id}`);
await api('DELETE', `/casa-de-shows/sectors/${setor.id}`);
await api('DELETE', `/casa-de-shows/table-types/${mesa12.id}`); await api('DELETE', `/casa-de-shows/table-types/${mesa4.id}`);
for (const e of [ev, dup.body.event]) await api('DELETE', '/events/' + e.id);
psql("delete from company_1.customers where phone like '%3288870001' or phone like '%3288870002'");
console.log(`${ok} ok, ${fail} falhas`);
process.exit(fail ? 1 : 0);
