// O atendente pede o mapa ou as fotos de um setor e o painel envia pelo WhatsApp da empresa.
// Uso: BASE=http://localhost:3999 DATABASE_URL=... node test/shows_midia_envio.mjs
import { execSync } from 'child_process';
import http from 'http';
const BASE = process.env.BASE || 'http://localhost:3999';
let ok = 0, fail = 0;
const check = (name, cond, extra = '') => { cond ? ok++ : (fail++, console.log('FALHOU:', name, extra)); };
const call = async (method, path, { token, body, headers: h } = {}) => {
  const headers = { 'content-type': 'application/json', ...(h || {}) };
  if (token) headers.authorization = 'Bearer ' + token;
  const r = await fetch(BASE + path, { method, headers, body: body ? JSON.stringify(body) : undefined });
  let j = null; try { j = await r.json(); } catch {}
  return { status: r.status, body: j };
};
const psql = (sql) => execSync(`psql "${process.env.DATABASE_URL}" -tAc "${sql}"`).toString().trim();
const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

const recebidos = [];
const fake = http.createServer((req, res) => {
  let d = ''; req.on('data', (c) => (d += c)); req.on('end', () => { recebidos.push({ url: req.url, token: req.headers.token, body: JSON.parse(d || '{}') }); res.writeHead(200, { 'content-type': 'application/json' }); res.end('{}'); });
}).listen(0);
const porta = fake.address().port;

const A = (await call('POST', '/api/auth/login', { body: { email: 'demo@demo.com', password: 'demo1234' } })).body;
const api = (m, p, body) => call(m, '/api' + p, { token: A.token, body });
const n8n = (m, p, body) => call(m, '/n8n' + p, { body, headers: { 'x-api-key': 'k', 'x-company-id': String(A.company.id) } });

psql("update public.companies set wa_api_url=null, wa_api_token=null where id=1");
let r = await n8n('POST', '/casa-de-shows/media/send', { number: '5532999999999', what: 'map' });
check('sem WhatsApp ligado avisa', r.status === 200 && r.body.ok === false && /não foi ligado/.test(r.body.message), JSON.stringify(r));

psql(`update public.companies set wa_api_url='http://127.0.0.1:${porta}', wa_api_token='tok-teste' where id=1`);
const nome = 'Setor Foto ' + Date.now() % 100000;
const s = (await api('POST', '/casa-de-shows/sectors', { name: nome, space: 20 })).body;
const semFoto = (await api('POST', '/casa-de-shows/sectors', { name: 'Setor Sem Foto ' + Date.now() % 100000, space: 10 })).body;
psql("delete from company_1.shows_media where kind='map'");
r = await n8n('POST', '/casa-de-shows/media/send', { number: '5532999999999', what: 'map' });
check('sem mapa cadastrado', r.status === 200 && r.body.ok === false && /Não há mapa/.test(r.body.message), JSON.stringify(r));

await api('POST', '/casa-de-shows/media', { kind: 'map', data: PNG, caption: 'Mapa da casa' });
await api('POST', '/casa-de-shows/media', { kind: 'photo', sector_id: s.id, data: PNG });
await api('POST', '/casa-de-shows/media', { kind: 'photo', sector_id: s.id, data: PNG, caption: 'Vista do palco' });

r = await n8n('POST', '/casa-de-shows/media/send', { number: '5532999999999', what: 'map' });
check('envia o mapa', r.status === 200 && r.body.sent === 1, JSON.stringify(r));
check('mapa chegou ao WhatsApp', recebidos.length === 1 && recebidos[0].url === '/send/media' && recebidos[0].token === 'tok-teste' && recebidos[0].body.number === '5532999999999' && recebidos[0].body.type === 'image' && /\/m\//.test(recebidos[0].body.file) && recebidos[0].body.text === 'Mapa da casa', JSON.stringify(recebidos));

recebidos.length = 0;
r = await n8n('POST', '/casa-de-shows/media/send', { number: '5532999999999', sector: nome });
check('envia as fotos do setor pelo nome', r.status === 200 && r.body.sent === 2, JSON.stringify(r));
check('as duas fotos chegaram, com legenda', recebidos.length === 2 && recebidos[1].body.text === 'Vista do palco' && recebidos[0].body.text === nome, JSON.stringify(recebidos));

recebidos.length = 0;
r = await n8n('POST', '/casa-de-shows/media/send', { number: '5532999999999', sector: 'o ' + nome.toUpperCase() });
check('acha o setor sem ligar para maiúsculas', r.status === 200 && r.body.sent === 2, JSON.stringify(r));
r = await n8n('POST', '/casa-de-shows/media/send', { number: '5532999999999', sector: semFoto.name });
check('setor sem fotos avisa', r.status === 200 && r.body.ok === false && /não tem fotos/.test(r.body.message), JSON.stringify(r));
r = await n8n('POST', '/casa-de-shows/media/send', { number: '5532999999999', sector: 'Setor que nao existe zzz' });
check('setor que não existe lista os setores', r.status === 200 && r.body.ok === false && /Setores:/.test(r.body.message), JSON.stringify(r));
r = await n8n('POST', '/casa-de-shows/media/send', { number: '5532999999999', what: 'map', event: 'evento que nao existe' });
check('evento que não existe avisa', r.status === 200 && r.body.ok === false && /Não achei esse evento/.test(r.body.message), JSON.stringify(r));
r = await n8n('POST', '/casa-de-shows/media/send', { what: 'map' });
check('sem número avisa', r.status === 400, JSON.stringify(r));

psql("update public.companies set wa_api_url=null, wa_api_token=null where id=1");
await api('DELETE', '/casa-de-shows/sectors/' + s.id); await api('DELETE', '/casa-de-shows/sectors/' + semFoto.id);
fake.close();
console.log(`shows_midia_envio: ${ok} ok, ${fail} falhas`);
process.exit(fail ? 1 : 0);
