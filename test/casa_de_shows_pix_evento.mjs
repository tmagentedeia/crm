// Chaves Pix por evento, com rodízio por valor. Uso: BASE=http://localhost:3999 node test/casa_de_shows_pix_evento.mjs
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
const A = (await call('POST', '/api/auth/login', { body: { email: 'demo@demo.com', password: 'demo1234' } })).body;
const api = (m, p, body) => call(m, '/api' + p, { token: A.token, body });
const N8N = { 'x-api-key': process.env.N8N_API_KEY || 'k', 'x-company-id': '1' };
psql("set search_path to company_1, public; delete from company_1.pix_keys where key like '%.rodizio@x.com'; delete from company_1.events where title like 'Show Rod%' or title = 'Show Outro' or title = 'dbg'; delete from company_1.shows_reservations where sector_id in (select id from company_1.shows_sectors where name in ('Pista Rodízio','dbg')); delete from company_1.shows_sectors where name in ('Pista Rodízio','dbg')");

const k1 = (await api('POST', '/finance/keys', { key_type: 'email', key: 'um.rodizio@x.com', beneficiary: 'Um' })).body;
const k2 = (await api('POST', '/finance/keys', { key_type: 'email', key: 'dois.rodizio@x.com', beneficiary: 'Dois' })).body;
const k3 = (await api('POST', '/finance/keys', { key_type: 'email', key: 'tres.rodizio@x.com', beneficiary: 'Três' })).body;
const ev = (await api('POST', '/events', { title: 'Show Rodízio', starts_at: '2031-06-20T22:00:00-03:00' })).body;
const ev2 = (await api('POST', '/events', { title: 'Show Outro', starts_at: '2031-06-27T22:00:00-03:00' })).body;
const setor = (await api('POST', '/casa-de-shows/sectors', { name: 'Pista Rodízio', space: 200 })).body;
const reserva = async (e, nome, preco) => (await api('POST', '/casa-de-shows/reservations', { event_id: e, sector_id: setor.id, name: nome, people: 2, unit_price: preco })).body;
const pix = (e) => api('GET', `/casa-de-shows/events/${e}/pix`);

let g = (await pix(ev.id)).body;
check('sem chaves próprias: não configurado', g.configured === false && g.keys.length === 0);
check('sem chaves próprias: usa chave da empresa', g.current && g.current.key_id, JSON.stringify(g));
check('evento inexistente', (await pix('999999')).status === 404);

check('chave inexistente', (await api('PUT', `/casa-de-shows/events/${ev.id}/pix`, { keys: [{ key_id: '999999' }] })).status === 400);
check('chave repetida', (await api('PUT', `/casa-de-shows/events/${ev.id}/pix`, { keys: [{ key_id: k1.id }, { key_id: k1.id }] })).status === 400);
check('limite inválido', (await api('PUT', `/casa-de-shows/events/${ev.id}/pix`, { keys: [{ key_id: k1.id, limit_amount: 'abc' }] })).status === 400);
check('limite zero', (await api('PUT', `/casa-de-shows/events/${ev.id}/pix`, { keys: [{ key_id: k1.id, limit_amount: 0 }] })).status === 400);
check('lista inválida', (await api('PUT', `/casa-de-shows/events/${ev.id}/pix`, { keys: 'x' })).status === 400);
check('n8n não grava', (await call('PUT', `/n8n/casa-de-shows/events/${ev.id}/pix`, { headers: N8N, body: { keys: [] } })).status === 403);

const put = await api('PUT', `/casa-de-shows/events/${ev.id}/pix`, { keys: [{ key_id: k1.id, limit_amount: '300' }, { key_id: k2.id, limit_amount: 200 }, { key_id: k3.id }] });
check('grava rodízio', put.status === 200 && put.body.configured && put.body.keys.length === 3 && put.body.current.key_id == k1.id, JSON.stringify(put.body));

const r1 = await reserva(ev.id, 'Cliente 1', 250);
const r2 = await reserva(ev.id, 'Cliente 2', 250);
const r3 = await reserva(ev.id, 'Cliente 3', 250);
const pagar = (r, key, amount) => api('POST', `/casa-de-shows/reservations/${r.id}/payments`, { method: 'pix', amount, pix_key_id: key });
await pagar(r1, k1.id, 250);
g = (await pix(ev.id)).body;
check('abaixo do limite: continua na primeira', g.current.key_id == k1.id && g.keys[0].received === 250 && !g.all_full, JSON.stringify(g));
await pagar(r2, k1.id, 100);
g = (await pix(ev.id)).body;
check('passou do limite: vai para a segunda', g.current.key_id == k2.id && g.keys[0].received === 350, JSON.stringify(g));
const preco = (await call('GET', `/n8n/casa-de-shows/events/${ev.id}/price`, { headers: N8N })).body;
check('atendente recebe a chave da vez', preco.pix_key && preco.pix_key.key_id == k2.id && preco.pix_key.key === 'dois.rodizio@x.com' && preco.pix_all_full === false, JSON.stringify(preco));
const pg = await pagar(r3, k2.id, 200);
g = (await pix(ev.id)).body;
check('segunda cheia: vai para a terceira (sem limite)', g.current.key_id == k3.id, JSON.stringify(g));
await pagar(r3, k3.id, 900);
g = (await pix(ev.id)).body;
check('última sem limite nunca enche', g.current.key_id == k3.id && !g.all_full);

// cancelada não conta
await api('PUT', `/casa-de-shows/reservations/${r2.id}`, { status: 'cancelled' });
g = (await pix(ev.id)).body;
check('reserva cancelada não conta no limite', g.keys[0].received === 250 && g.current.key_id == k1.id, JSON.stringify(g));
await api('PUT', `/casa-de-shows/reservations/${r2.id}`, { status: 'confirmed' });

// chave desativada pula a vez
await api('PUT', `/finance/keys/${k1.id}`, { active: false });
g = (await pix(ev.id)).body;
check('chave desativada é pulada', g.current.key_id == k3.id || g.current.key_id == k2.id, JSON.stringify(g.current));
await api('PUT', `/finance/keys/${k1.id}`, { active: true });

// todas com limite e cheias
await api('PUT', `/casa-de-shows/events/${ev.id}/pix`, { keys: [{ key_id: k1.id, limit_amount: 100 }, { key_id: k2.id, limit_amount: 100 }] });
g = (await pix(ev.id)).body;
check('todas cheias: fica a última e avisa', g.all_full === true && g.current.key_id == k2.id, JSON.stringify(g));

// outro evento é independente
check('outro evento não é afetado', (await pix(ev2.id)).body.configured === false);
await api('PUT', `/casa-de-shows/events/${ev2.id}/pix`, { keys: [{ key_id: k3.id }] });
check('outro evento com chave própria', (await pix(ev2.id)).body.current.key_id == k3.id && (await pix(ev.id)).body.current.key_id == k2.id);

// duplicar copia o rodízio
const dup = await api('POST', `/casa-de-shows/events/${ev.id}/duplicate`, { title: 'Show Rodízio 2', starts_at: '2031-07-04T22:00:00-03:00' });
const gd = (await pix(dup.body.event.id)).body;
check('duplicar copia o rodízio, sem o recebido', gd.configured && gd.keys.length === 2 && gd.keys[0].received === 0 && gd.keys[0].limit_amount === 100, JSON.stringify(gd));

// limpar volta à chave da empresa
const lim = await api('PUT', `/casa-de-shows/events/${ev.id}/pix`, { keys: [] });
check('limpar volta ao padrão da empresa', lim.status === 200 && lim.body.configured === false);

// apagar a chave da empresa tira do rodízio
await api('PUT', `/casa-de-shows/events/${ev2.id}/pix`, { keys: [{ key_id: k3.id }] });
await api('DELETE', `/finance/keys/${k3.id}`);
check('chave apagada sai do rodízio', (await pix(ev2.id)).body.configured === false);

for (const e of [ev, ev2, dup.body.event]) await api('DELETE', '/events/' + e.id);
await api('DELETE', `/casa-de-shows/sectors/${setor.id}`);
await api('DELETE', `/finance/keys/${k1.id}`); await api('DELETE', `/finance/keys/${k2.id}`);
console.log(`${ok} ok, ${fail} falhas`);
process.exit(fail ? 1 : 0);
