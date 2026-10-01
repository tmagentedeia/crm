// Atendimentos bloqueados (painel <-> Redis). Uso: BASE=http://localhost:3999 REDIS_URL=redis://127.0.0.1:56379 node test/bloqueios.mjs
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
const A = await login('demo@demo.com', 'demo1234'); // administrador, empresa 1
const B = await login('dois@x.com', 'senhasenha');   // empresa 2
const redis = new Redis(process.env.REDIS_URL);
await redis.flushall();

// sem instância configurada
check('sem instância = 409', (await call('GET', '/api/blocks', { token: A.token })).status === 409);
check('só administrador configura', (await call('PUT', '/api/admin/companies/1/blocks-config', { token: B.token, body: { whatsapp_instance: 'x' } })).status === 403);
check('instância inválida', (await call('PUT', '/api/admin/companies/1/blocks-config', { token: A.token, body: { whatsapp_instance: 'a*b' } })).status === 400);
check('prefixo inválido', (await call('PUT', '/api/admin/companies/1/blocks-config', { token: A.token, body: { whatsapp_instance: 'tm-agentes', redis_prefix: 'a b' } })).status === 400);
check('configura empresa 1 (sem prefixo)', (await call('PUT', '/api/admin/companies/1/blocks-config', { token: A.token, body: { whatsapp_instance: 'tm-agentes', redis_prefix: '' } })).status === 200);
check('configura empresa 2 (com prefixo)', (await call('PUT', '/api/admin/companies/2/blocks-config', { token: A.token, body: { whatsapp_instance: 'tm-agentes', redis_prefix: 'dois:' } })).status === 200 && (await call('GET', '/api/admin/companies', { token: A.token })).body.find((c) => Number(c.id) === 2).redis_prefix === 'dois');

// chaves como o atendente grava
await redis.set('ia_forced:tm-agentes:553291135799', '1', 'EX', 315360000);        // /off = para sempre
await redis.set('ia_forced:tm-agentes:553288887777', 'true', 'EX', 43200);          // bloqueio automático por repetição
await redis.set('ia_blocked:tm-agentes:553277776666', '1', 'EX', 86400);            // pausa
await redis.set('ia_forced:tm-agentes:553299990000', '1', 'EX', 3600);              // = cliente "Cliente Extra" (empresa 1)
await redis.set('ia_forced:outra-instancia:553200000001', '1', 'EX', 3600);         // outra instância: não aparece
await redis.set('dois:ia_forced:tm-agentes:553255554444', '1', 'EX', 3600);         // da empresa 2

const l1 = (await call('GET', '/api/blocks', { token: A.token })).body;
const por = (l, id) => l.find((x) => x.id === id);
check('lista da empresa 1 tem 4 contatos', l1.length === 4, JSON.stringify(l1));
check('/off aparece como para sempre', por(l1, '553291135799')?.permanente === true && por(l1, '553291135799')?.motivo === 'manual');
check('bloqueio automático identificado', por(l1, '553288887777')?.motivo === 'automatico' && por(l1, '553288887777')?.permanente === false);
check('pausa identificada', por(l1, '553277776666')?.motivo === 'pausa');
check('mostra o tempo restante', por(l1, '553299990000')?.segundos > 3500 && por(l1, '553299990000')?.segundos <= 3600);
check('mostra o nome do cliente cadastrado', por(l1, '553299990000')?.nome === 'Cliente Extra', JSON.stringify(por(l1, '553299990000')));
check('não mostra outra instância', !por(l1, '553200000001'));
check('não mostra chaves de outra empresa', !por(l1, '553255554444'));
const l2 = (await call('GET', '/api/blocks', { token: B.token })).body;
check('empresa 2 só enxerga a dela', l2.length === 1 && l2[0].id === '553255554444', JSON.stringify(l2));

// adicionar pelo telefone
check('telefone inválido', (await call('POST', '/api/blocks', { token: A.token, body: { phone: '123', duration: 'forever' } })).status === 400);
check('duração inválida', (await call('POST', '/api/blocks', { token: A.token, body: { phone: '(32) 99999-1111', duration: 'x' } })).status === 400);
const add = await call('POST', '/api/blocks', { token: A.token, body: { phone: '(32) 99999-1111', duration: 'forever' } });
check('bloqueia pelo telefone', add.status === 201 && add.body.id === '553299991111', JSON.stringify(add));
const ttl = await redis.ttl('ia_forced:tm-agentes:553299991111');
check('gravou no formato do atendente (valor 1, 10 anos)', (await redis.get('ia_forced:tm-agentes:553299991111')) === '1' && ttl > 300000000, String(ttl));
await call('POST', '/api/blocks', { token: A.token, body: { phone: '32 8888-2222', duration: '24h' } });
const t2 = await redis.ttl('ia_forced:tm-agentes:553288882222');
check('bloqueio de 24 horas', t2 > 86000 && t2 <= 86400, String(t2));
check('empresa 2 grava com o prefixo dela', (await call('POST', '/api/blocks', { token: B.token, body: { phone: '32 8888-3333', duration: '24h' } })).status === 201 && (await redis.exists('dois:ia_forced:tm-agentes:553288883333')) === 1);
check('empresa 1 não vê o que a 2 criou', !por((await call('GET', '/api/blocks', { token: A.token })).body, '553288883333'));

// liberar apaga bloqueio geral e pausa
await redis.set('ia_blocked:tm-agentes:553291135799', '1', 'EX', 86400);
check('libera', (await call('DELETE', '/api/blocks/553291135799', { token: A.token })).status === 200);
check('apagou as duas chaves', (await redis.exists('ia_forced:tm-agentes:553291135799', 'ia_blocked:tm-agentes:553291135799')) === 0);
check('não libera contato de outra empresa', (await call('DELETE', '/api/blocks/553255554444', { token: A.token })).status === 200 && (await redis.exists('dois:ia_forced:tm-agentes:553255554444')) === 1);
check('id com curinga é recusado', (await call('DELETE', '/api/blocks/55*', { token: A.token })).status === 400);
check('sem login = 401', (await call('GET', '/api/blocks')).status === 401);
await redis.quit();
console.log(`bloqueios: ${ok} ok, ${fail} falhas`); process.exit(fail ? 1 : 0);
