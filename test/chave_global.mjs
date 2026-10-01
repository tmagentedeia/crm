// Com ALLOW_GLOBAL_KEY=false a chave global deixa de valer nas rotas /n8n: só a chave da empresa vale.
// Roda contra um segundo servidor, iniciado com ALLOW_GLOBAL_KEY=false (ver test/rodar.sh).
const BASE = process.env.BASE || 'http://localhost:3998';
const KEY = process.env.N8N_API_KEY || 'k';
let ok = 0, fail = 0;
const check = (name, cond, extra = '') => { cond ? ok++ : (fail++, console.log('FALHOU:', name, extra)); };
const json = async (method, path, { token, body } = {}) => {
  const r = await fetch(BASE + path, {
    method,
    headers: { 'content-type': 'application/json', ...(token ? { authorization: 'Bearer ' + token } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: r.status, body: await r.json().catch(() => null) };
};
const status = (key, empresa) => fetch(BASE + '/n8n/professionals', {
  headers: { ...(key ? { 'x-api-key': key } : {}), ...(empresa ? { 'x-company-id': String(empresa) } : {}) },
}).then((r) => r.status);

const A = (await json('POST', '/api/auth/login', { body: { email: 'demo@demo.com', password: 'demo1234' } })).body;
const k = (await json('POST', '/api/admin/companies/1/api-key', { token: A.token })).body;
check('chave da empresa gerada', !!k?.api_key, JSON.stringify(k));

check('chave global NÃO vale mais (empresa existente)', (await status(KEY, 1)) === 401);
check('chave global NÃO vale mais (empresa inexistente: 401, não 404)', (await status(KEY, 999)) === 401);
check('chave global sem x-company-id = 401, não 400', (await status(KEY, null)) === 401);
check('chave da empresa continua valendo', (await status(k.api_key, 1)) === 200);
check('chave da empresa 1 não vale na 2', (await status(k.api_key, 2)) === 401);
check('o painel continua funcionando', (await json('GET', '/api/company', { token: A.token })).status === 200);

console.log(`\n${ok} ok, ${fail} falhas`);
process.exit(fail ? 1 : 0);
