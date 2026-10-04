// Mapa do espaço e fotos dos setores. Uso: BASE=http://localhost:3999 node test/scenarium_midia.mjs
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
psql("delete from company_1.scn_media");
const A = (await call('POST', '/api/auth/login', { body: { email: 'demo@demo.com', password: 'demo1234' } })).body;
const B = (await call('POST', '/api/auth/login', { body: { email: 'dois@x.com', password: 'senhasenha' } })).body;
const api = (m, p, body) => call(m, '/api' + p, { token: A.token, body });
const N8N = { 'x-api-key': process.env.N8N_API_KEY || 'k', 'x-company-id': '1' };
const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
const TEXTO = 'data:text/plain;base64,' + Buffer.from('isso não é uma imagem').toString('base64');
const setor = (await api('POST', '/scenarium/sectors', { name: 'Camarote Mídia', space: 40 })).body;
const setorId = String(setor.id);

check('sem mapa ainda', (await api('GET', '/scenarium/media')).body.map === null);
check('texto não vale como imagem', (await api('POST', '/scenarium/media', { kind: 'map', data: TEXTO })).status === 400);
check('tipo inválido recusado', (await api('POST', '/scenarium/media', { kind: 'video', data: PNG })).status === 400);
const mapa = (await api('POST', '/scenarium/media', { kind: 'map', data: PNG })).body;
check('mapa enviado devolve o endereço público', mapa.kind === 'map' && /\/m\/1-[0-9a-f]{40}$/.test(mapa.url), JSON.stringify(mapa));
const pub = await fetch(mapa.url.replace(/^https?:\/\/[^/]+/, BASE));
check('o endereço abre sem login, como imagem', pub.status === 200 && pub.headers.get('content-type') === 'image/png' && (await pub.arrayBuffer()).byteLength > 50);
check('endereço inventado não abre', (await fetch(BASE + '/m/1-' + '0'.repeat(40))).status === 404 && (await fetch(BASE + '/m/abc')).status === 404);
const mapa2 = (await api('POST', '/scenarium/media', { kind: 'map', data: PNG })).body;
check('novo mapa substitui o anterior', psql("select count(*) from company_1.scn_media where kind='map'") === '1' && mapa2.id !== mapa.id && (await fetch(mapa.url.replace(/^https?:\/\/[^/]+/, BASE))).status === 404);

check('foto precisa de setor', (await api('POST', '/scenarium/media', { kind: 'photo', data: PNG })).status === 400 && (await api('POST', '/scenarium/media', { kind: 'photo', sector_id: '999999', data: PNG })).status === 400);
const fotos = [];
for (let i = 0; i < 8; i++) fotos.push((await api('POST', '/scenarium/media', { kind: 'photo', sector_id: setorId, caption: 'Vista ' + i, data: PNG })).body);
check('até 8 fotos por setor', fotos.every((f) => f.id) && (await api('POST', '/scenarium/media', { kind: 'photo', sector_id: setorId, data: PNG })).status === 409);
const lista = (await api('GET', '/scenarium/media?sector_id=' + setorId)).body;
check('lista traz o mapa e as fotos do setor', lista.map.url === mapa2.url && lista.sectors.length === 1 && lista.sectors[0].name === 'Camarote Mídia' && lista.sectors[0].photos.length === 8 && lista.sectors[0].photos[0].caption === 'Vista 0');
check('legenda editada', (await api('PUT', '/scenarium/media/' + fotos[0].id, { caption: 'Nova legenda' })).status === 200 && (await api('GET', '/scenarium/media?sector_id=' + setorId)).body.sectors[0].photos[0].caption === 'Nova legenda');
check('o atendente consulta o mapa e as fotos', (await call('GET', '/n8n/scenarium/media', { headers: N8N })).body.sectors.some((s) => s.photos.length === 8));
check('o atendente não envia nem apaga', (await call('POST', '/n8n/scenarium/media', { headers: N8N, body: { kind: 'map', data: PNG } })).status === 403 && (await call('DELETE', '/n8n/scenarium/media/' + fotos[0].id, { headers: N8N })).status === 403);
check('apagar a foto', (await api('DELETE', '/scenarium/media/' + fotos[1].id)).status === 200 && (await fetch(fotos[1].url.replace(/^https?:\/\/[^/]+/, BASE))).status === 404 && (await api('DELETE', '/scenarium/media/' + fotos[1].id)).status === 404);
check('apagar o setor leva as fotos junto', (await api('DELETE', '/scenarium/sectors/' + setorId)).status === 200 && psql("select count(*) from company_1.scn_media where kind='photo'") === '0');
check('outra empresa não vê', (await call('GET', '/api/scenarium/media', { token: B.token })).body.map === null);
console.log(`scenarium_midia: ${ok} ok, ${fail} falhas`);
process.exit(fail ? 1 : 0);
