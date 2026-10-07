// Ligações próprias da empresa: Redis dos bloqueios e banco das conversas (senha guardada cifrada; vazio = padrão do servidor).
// Uso: BASE=http://localhost:3999 REDIS_URL=redis://127.0.0.1:56379 DATABASE_URL=... node test/conexoes.mjs  (roda depois de bloqueios.mjs)
import { execSync } from 'child_process';
import Redis from 'ioredis';
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
const DB = process.env.DATABASE_URL;
const psql = (url, sql) => execSync(`psql "${url}" -tAc "${sql}"`).toString().trim();
const DB2 = DB.replace(/\/[^/?]+(\?|$)/, '/conv_proprio$1');
const BASE_DB = DB.replace(/\/[^/?]+(\?|$)/, '/postgres$1');
const A = await login('demo@demo.com', 'demo1234');   // administrador, empresa 1
const B = await login('dois@x.com', 'senhasenha');    // empresa 2 (não administrador)
const redisGlobal = new Redis(process.env.REDIS_URL);

// a empresa 2 tem Redis e banco de conversas PRÓPRIOS (segundo Redis na porta 56381, segundo banco "conv_proprio")
execSync("redis-server --port 56381 --save '' --appendonly no --daemonize yes >/dev/null");
const redisProprio = new Redis('redis://127.0.0.1:56381');
await redisProprio.flushall();
psql(BASE_DB, 'drop database if exists conv_proprio with (force)'); psql(BASE_DB, 'create database conv_proprio');
psql(DB2, 'create table chat_proprio (id serial primary key, session_id text not null, message jsonb not null)');

const U_REDIS = 'redis://:segredo-redis-123@127.0.0.1:56381';
// precisa da senha? o Redis de teste não pede; o endereço com senha só é guardado cifrado e entregue à biblioteca
const U_DB = DB2;
const set = (corpo, token = A.token) => call('PUT', '/api/admin/companies/2/connections', { token, body: corpo });

check('só administrador altera ligações', (await set({ redis_url: U_REDIS }, B.token)).status === 403);
check('endereço do Redis inválido é recusado', (await set({ redis_url: 'http://x.com' })).status === 400);
check('endereço do banco inválido é recusado', (await set({ conv_db_url: 'mysql://x' })).status === 400);
check('sem nada para salvar é recusado', (await set({})).status === 400);
check('empresa inexistente', (await call('PUT', '/api/admin/companies/9999/connections', { token: A.token, body: { redis_url: U_REDIS } })).status === 404);
const s = await set({ redis_url: U_REDIS, conv_db_url: U_DB });
check('grava as duas ligações', s.status === 200 && s.body?.redis_host === '127.0.0.1:56381', JSON.stringify(s.body));
check('a resposta não traz a senha', !JSON.stringify(s.body).includes('segredo-redis-123'));

const lista = await call('GET', '/api/admin/companies', { token: A.token });
const c2 = lista.body.find((c) => Number(c.id) === 2);
check('a lista mostra só o servidor, nunca o endereço com senha', c2.redis_set === true && c2.redis_host === '127.0.0.1:56381' && c2.conv_db_set === true && !JSON.stringify(lista.body).includes('segredo-redis-123') && !('redis_url' in c2) && !('conv_db_url' in c2));
const guardado = psql(DB, "select redis_url from companies where id=2");
check('no banco do painel o endereço está cifrado', guardado.startsWith('v1:') && !guardado.includes('segredo-redis-123') && !guardado.includes('redis://'), guardado.slice(0, 30));

// ---- Testar ligação usa o banco e o Redis da empresa (a tabela só existe no banco próprio) ----
await call('PUT', '/api/admin/companies/2/chat-table', { token: A.token, body: { chat_table: 'chat_proprio' } });
const t1 = await call('POST', '/api/admin/companies/2/check-history', { token: A.token, body: {} });
check('testar ligação grava no banco próprio e alcança o Redis próprio', t1.body?.ok === true && /alcança o Redis/.test(t1.body.motivo) && /chat_proprio/.test(t1.body.motivo), JSON.stringify(t1.body));
check('o teste não deixou linha no banco próprio', psql(DB2, 'select count(*) from chat_proprio') === '0');

// ---- bloqueios vão para o Redis da empresa, não para o do servidor ----
await redisGlobal.flushall();
const post = await call('POST', '/api/blocks', { token: B.token, body: { phone: '(32) 99999-1111', duration: '24h' } });
check('bloqueio criado', post.status === 201, JSON.stringify(post.body));
const chavesProprio = await redisProprio.keys('*'), chavesGlobal = await redisGlobal.keys('*');
check('a chave foi para o Redis da empresa', chavesProprio.some((k) => k.includes('ia_forced:tm-agentes:553299991111')), JSON.stringify(chavesProprio));
check('nada foi para o Redis do servidor', chavesGlobal.length === 0, JSON.stringify(chavesGlobal));
const l = await call('GET', '/api/blocks', { token: B.token });
check('a lista lê do Redis da empresa', l.status === 200 && l.body.some((x) => x.id === '553299991111'), JSON.stringify(l.body));
const lA = await call('GET', '/api/blocks', { token: A.token });
check('a empresa 1 (sem Redis próprio) não enxerga esse bloqueio', lA.status === 200 && !lA.body.some((x) => x.id === '553299991111'));

// ---- chave do servidor trocada: nunca cai no banco de outra empresa ----
psql(DB, "update companies set conv_db_url='v1:aaaa:bbbb:cccc', redis_url='v1:aaaa:bbbb:cccc' where id=2");
const t2 = await call('POST', '/api/admin/companies/2/check-history', { token: A.token, body: {} });
check('endereço guardado que não abre: avisa e não usa o do servidor', t2.body?.ok === false && /endereço guardado/.test(t2.body.motivo), JSON.stringify(t2.body));
check('bloqueios ficam indisponíveis em vez de usar o Redis de outra empresa', (await call('GET', '/api/blocks', { token: B.token })).status === 503);
await set({ redis_url: U_REDIS, conv_db_url: U_DB });

// ---- voltar ao padrão do servidor ----
const v = await set({ redis_url: 'clear', conv_db_url: 'clear' });
check('voltar ao padrão', v.status === 200 && v.body.redis_host === null && v.body.conv_db_host === null, JSON.stringify(v.body));
check('depois de voltar, o teste falha por falta da tabela no banco do servidor', (await call('POST', '/api/admin/companies/2/check-history', { token: A.token, body: {} })).body?.ok === false);
await redisGlobal.flushall();
await call('POST', '/api/blocks', { token: B.token, body: { phone: '(32) 99999-2222', duration: '24h' } });
check('depois de voltar, o bloqueio vai para o Redis do servidor', (await redisGlobal.keys('*')).some((k) => k.includes('553299992222')));

// limpeza
await call('PUT', '/api/admin/companies/2/chat-table', { token: A.token, body: { chat_table: '' } });
await redisGlobal.flushall(); redisGlobal.disconnect(); redisProprio.disconnect();
execSync('redis-cli -p 56381 shutdown nosave 2>/dev/null || true');
psql(BASE_DB, 'drop database if exists conv_proprio with (force)');
console.log(`conexoes: ${ok} ok, ${fail} falhas`);
process.exit(fail ? 1 : 0);
