// Desconto do Clube nos ingressos. Uso: BASE=http://localhost:3999 node test/casa_de_shows_clube.mjs
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
const limpa = () => psql("set search_path to company_1, public; delete from company_1.shows_sale_payments; delete from company_1.shows_sales where sector_id in (select id from company_1.shows_sectors where name = 'Pista Clube'); delete from company_1.shows_sectors where name = 'Pista Clube'; delete from company_1.events where title like 'Show Clube%'; delete from company_1.customers where phone like '%32977770001' or phone like '%3277770002'; delete from company_1.shows_club_discount");
limpa();
const A = (await call('POST', '/api/auth/login', { body: { email: 'demo@demo.com', password: 'demo1234' } })).body;
const api = (m, p, body) => call(m, '/api' + p, { token: A.token, body });
const N8N = { 'x-api-key': process.env.N8N_API_KEY || 'k', 'x-company-id': '1' };
const h = (n) => new Date(Date.now() + n * 36e5).toISOString();

const ev = (await api('POST', '/events', { title: 'Show Clube', starts_at: h(24 * 10) })).body;
await api('PUT', `/casa-de-shows/events/${ev.id}/conditions`, { price: 100 });
const setor = (await api('POST', '/casa-de-shows/sectors', { name: 'Pista Clube', space: 100 })).body;
const venda = (b) => api('POST', '/casa-de-shows/sales', { event_id: ev.id, sector_id: setor.id, ...b });
const preco = async (q = '') => (await call('GET', `/n8n/casa-de-shows/events/${ev.id}/price?x=1${q}`, { headers: N8N })).body;

// ---- configuração ----
check('começa desligado', (await api('GET', '/casa-de-shows/club-discount')).body.percent === null);
check('percentual inválido', (await api('PUT', '/casa-de-shows/club-discount', { percent: 150 })).status === 400);
check('acompanhantes inválidos', (await api('PUT', '/casa-de-shows/club-discount', { percent: 10, companions: 99 })).status === 400);
check('n8n não muda a configuração', (await call('PUT', '/n8n/casa-de-shows/club-discount', { headers: N8N, body: { percent: 10 } })).status === 403);
let c = (await api('PUT', '/casa-de-shows/club-discount', { percent: 10, companions: 1 })).body;
check('liga 10% e 1 acompanhante', c.percent === 10 && c.companions === 1, JSON.stringify(c));

// ---- membro e não membro ----
const semMembro = (await venda({ name: 'Visitante', phone: '32988880099', people: 2 })).body;
check('quem não é membro paga cheio', semMembro.club_discount === 0 && semMembro.total === 200, JSON.stringify(semMembro));
await venda({ name: 'Marcos Clube', phone: '32977770001', people: 1 });
psql("update company_1.customers set club_status='member' where phone like '%3277770001'");
let pr = await preco('&phone=32977770001&people=4');
check('o preço reconhece o membro', pr.club && pr.club.member === true && pr.club.percent === 10, JSON.stringify(pr.club));
check('quem não é do clube não leva', (await preco('&phone=32988880099&people=2')).club.member === false);
check('desconto para o membro e 1 acompanhante', pr.club_discount === 20 && pr.total === 380, JSON.stringify(pr));
pr = await preco('&phone=32977770001&people=1');
check('sozinho: desconto de uma pessoa', pr.club_discount === 10 && pr.total === 90);
check('sem telefone o preço segue cheio', (await preco('&people=2')).total === 200);

let v = (await venda({ name: 'Marcos Clube', phone: '32977770001', people: 4 })).body;
check('venda guarda o abatimento', v.club_discount === 20 && v.total === 380, JSON.stringify(v));
let pg = (await api('POST', `/casa-de-shows/sales/${v.id}/payments`, { method: 'dinheiro', amount: 380 })).body;
v = (await api('GET', `/casa-de-shows/sales?event_id=${ev.id}`)).body.find((x) => x.id === v.id);
check('pagando o total com desconto, a venda fica paga', v.paid === 380 && v.total === 380, JSON.stringify(v));
let r = (await api('PUT', `/casa-de-shows/sales/${v.id}`, { people: 2 })).body;
check('mudar as pessoas recalcula', r.club_discount === 20 && r.total === 180, JSON.stringify(r));
r = (await api('PUT', `/casa-de-shows/sales/${v.id}`, { people: 1 })).body;
check('uma pessoa só abate uma', r.club_discount === 10 && r.total === 90, JSON.stringify(r));
r = (await api('PUT', `/casa-de-shows/sales/${v.id}`, { unit_price: 80 })).body;
check('valor digitado à mão não leva desconto', r.club_discount === 0 && r.total === 80, JSON.stringify(r));

// ---- não soma com palavra-chave ----
await api('POST', `/casa-de-shows/events/${ev.id}/codes`, { word: 'amigos clube', kind: 'percent', value: 30 });
v = (await venda({ name: 'Marcos Clube', phone: '32977770001', people: 2, code: 'amigos clube' })).body;
check('palavra mais barata vale; o clube não soma', v.unit_price === 70 && v.club_discount === 0 && v.total === 140, JSON.stringify(v));
await api('POST', `/casa-de-shows/events/${ev.id}/codes`, { word: 'leve', kind: 'percent', value: 5 });
v = (await venda({ name: 'Marcos Clube', phone: '32977770001', people: 2, code: 'leve' })).body;
check('clube mais barato que a palavra: leva só a diferença', v.unit_price === 95 && v.club_discount === 10 && v.total === 180, JSON.stringify(v));

// ---- desligar ----
await api('PUT', '/casa-de-shows/club-discount', { percent: null });
check('desligado: volta ao preço cheio', (await preco('&phone=32977770001&people=2')).total === 200);
v = (await venda({ name: 'Marcos Clube', phone: '32977770001', people: 2 })).body;
check('desligado: venda cheia', v.club_discount === 0 && v.total === 200);
const sm = (await api('GET', `/casa-de-shows/payments/summary?event_id=${ev.id}`)).body;
check('resumo de recebimentos usa o total com desconto', typeof sm.expected === 'number', JSON.stringify(sm));
limpa();
console.log(`casa_de_shows_clube: ${ok} ok, ${fail} falhas`);
process.exit(fail ? 1 : 0);
