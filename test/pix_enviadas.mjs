// Chaves Pix enviadas ao cliente: a conferência aceita a chave que ele recebeu, mesmo depois de desativada. Uso: BASE=http://localhost:3999 node test/pix_enviadas.mjs
const BASE = process.env.BASE || 'http://localhost:3999';
let ok = 0, fail = 0;
const check = (name, cond, extra = '') => { cond ? ok++ : (fail++, console.log('FALHOU:', name, extra)); };
const call = async (method, path, token, body) => {
  const r = await fetch(BASE + path, { method, headers: { 'content-type': 'application/json', authorization: 'Bearer ' + token }, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, body: await r.json().catch(() => null) };
};
const login = async (e, p) => (await (await fetch(BASE + '/api/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: e, password: p }) })).json()).token;
const A = await login('demo@demo.com', 'demo1234');
const T = (m, p, b) => call(m, p, A, b);
const sp = (minAtras) => new Date(Date.now() - minAtras * 60000 - 3 * 3600000).toISOString().slice(0, 16).replace('T', ' ');
const sufixo = Math.random().toString(36).slice(2, 8);

const kA = (await T('POST', '/api/finance/keys', { key_type: 'email', key: `prevenda${sufixo}a@gmail.com`, beneficiary: 'Thiago' })).body;
const kB = (await T('POST', '/api/finance/keys', { key_type: 'email', key: `prevenda${sufixo}b@gmail.com`, beneficiary: 'Thiago' })).body;
check('cadastrou as chaves', kA.id && kB.id);

const fone = '553288887777', outro = '553288886666';
const guard = async (phone) => (await T('GET', '/api/finance/pix-guard?phone=' + phone)).body;
let g = await guard(fone);
check('guard lista as chaves', g.keys.some((k) => k.key_id === kA.id) && g.keys.some((k) => k.key_id === kB.id));
check('sem envio: nenhuma enviada', g.last_sent_key_id === null && g.keys.every((k) => k.last_sent_at === null));

check('registrar exige telefone e texto', (await T('POST', '/api/finance/pix-sent', { text: 'x' })).status === 400);
check('texto sem chave não registra nada', (await T('POST', '/api/finance/pix-sent', { phone: fone, text: 'oi, tudo bem?' })).body.recorded.length === 0);
const r1 = (await T('POST', '/api/finance/pix-sent', { phone: fone, text: `Pode pagar na chave\n${kA.key.toUpperCase()}` })).body;
check('registra a chave A (outra grafia)', r1.recorded.length === 1 && r1.recorded[0] === kA.id, JSON.stringify(r1));
g = await guard(fone);
check('guard mostra A como enviada e a última', g.last_sent_key_id === kA.id && g.keys.find((k) => k.key_id === kA.id).last_sent_at);
check('outro cliente não tem envio', (await guard(outro)).last_sent_key_id === null);

await T('POST', '/api/finance/pix-sent', { phone: fone, text: kB.key });
g = await guard(fone);
check('a última enviada passa a ser B', g.last_sent_key_id === kB.id, JSON.stringify(g.last_sent_key_id));

// comprovante
const pago = async (phone, key) => (await T('POST', '/api/payments/check', {
  phone, payer_name: 'Fulano de Tal', amount: 30, key, txid: 'E' + Math.random().toString(36).slice(2).padEnd(30, 'x'), paid_at: sp(10), purpose: 'Ingresso' })).body;
check('chave ativa aceita', (await pago(fone, kA.key)).accepted === true);
await T('PUT', '/api/finance/keys/' + kA.id, { active: false });
const enviado = await pago(fone, kA.key);
check('chave desativada, mas enviada a este cliente: aceita', enviado.accepted === true, JSON.stringify(enviado));
const nao = await pago(outro, kA.key);
check('chave desativada que NÃO foi enviada a este cliente: recusada', nao.status === 'wrong_key', JSON.stringify(nao));
check('sem telefone: desativada continua recusada', (await pago('', kA.key)).status === 'wrong_key');
check('chave de fora continua recusada', (await pago(fone, 'outro@x.com')).status === 'wrong_key');

console.log(`${ok} ok, ${fail} falhas`);
process.exit(fail ? 1 : 0);
