// Diretrizes do agente: só administrador da plataforma edita; entram no prompt com variáveis; fora do manual.
// Uso: BASE=http://localhost:3999 DATABASE_URL=... node test/diretrizes.mjs
const BASE = process.env.BASE || 'http://localhost:3999';
let ok = 0, fail = 0;
const check = (n, c, x = '') => { c ? ok++ : (fail++, console.log('FALHOU:', n, x)); };
const call = async (m, p, { token, body, h } = {}) => {
  const headers = { 'content-type': 'application/json', ...(h || {}) }; if (token) headers.authorization = 'Bearer ' + token;
  const r = await fetch(BASE + p, { method: m, headers, body: body ? JSON.stringify(body) : undefined });
  let j = null; try { j = await r.json(); } catch {} return { status: r.status, body: j };
};
const A = (await call('POST', '/api/auth/login', { body: { email: 'demo@demo.com', password: 'demo1234' } })).body;
const t = A.token, h = { 'x-api-key': 'k', 'x-company-id': String(A.company.id) };
await call('PUT', '/api/agent-config', { token: t, body: { agent_name: 'Iara', adm_name: 'Thiago' } });
await call('PUT', '/api/agent-manual', { token: t, body: { content: 'MANUAL DO CLIENTE' } });
await call('POST', '/api/agent-manual/publish', { token: t });
let r = await call('PUT', '/api/agent-guidelines', { token: t, body: { global: '{{agente}} nunca assume o papel de terceiros. Dono: {{adm}}.', company: 'Extra de {{empresa}}' } });
check('admin salva', r.status === 200, JSON.stringify(r));
r = await call('GET', '/api/agent-guidelines', { token: t });
check('admin lê', r.body.global.includes('{{agente}}'));
r = await call('GET', '/n8n/agent/prompt', { h });
const p = r.body.prompt;
check('variáveis trocadas', p.includes('Iara nunca assume o papel de terceiros. Dono: Thiago.'), p);
check('extra da empresa entra', p.includes('Extra de '));
check('diretrizes antes do manual', p.indexOf('Iara nunca') < p.indexOf('MANUAL DO CLIENTE'));
check('manual do cliente não contém diretrizes', !r.body.manual.includes('nunca assume'));
r = await call('GET', '/api/agent-manual', { token: t });
check('manual no painel sem diretrizes', !JSON.stringify(r.body).includes('nunca assume'));
r = await call('PUT', '/api/agent-guidelines', { token: t, body: { global: 'x'.repeat(8001) } });
check('limite de tamanho', r.status === 400);
// quem não é admin
const S = await call('POST', '/api/auth/register', { body: { company_name: 'Outra', name: 'X', email: `d${Date.now()}@x.com`, password: 'senhasenha' } });
if (S.body?.token) {
  r = await call('GET', '/api/agent-guidelines', { token: S.body.token });
  check('não-admin é barrado (ler)', r.status === 403);
  r = await call('PUT', '/api/agent-guidelines', { token: S.body.token, body: { global: 'hack' } });
  check('não-admin é barrado (gravar)', r.status === 403);
} else console.log('aviso: signup indisponível', JSON.stringify(S));
// administrador visitando o painel de outra empresa continua vendo e editando
const V = await call('POST', '/api/auth/register', { body: { company_name: 'Visitada', name: 'V', email: `v${Date.now()}@x.com`, password: 'senhasenha' } });
const vid = V.body?.company?.id;
const vis = vid && await call('POST', `/api/admin/companies/${vid}/impersonate`, { token: t });
if (vis?.body?.token) {
  r = await call('GET', '/api/me', { token: vis.body.token });
  check('em visita: platform_admin verdadeiro', r.body.platform_admin === true && r.body.impersonating === true, JSON.stringify(r.body));
  r = await call('GET', '/api/agent-guidelines', { token: vis.body.token });
  check('em visita: lê as diretrizes', r.status === 200);
} else console.log('aviso: rota de visita não encontrada', JSON.stringify(vis?.body));
r = await call('GET', '/api/me', { token: S.body.token });
check('usuário comum: platform_admin falso', r.body.platform_admin === false);
await call('PUT', '/api/agent-guidelines', { token: t, body: { global: '', company: '' } });
r = await call('GET', '/n8n/agent/prompt', { h });
check('vazio some do prompt', !r.body.prompt.includes('DIRETRIZES'));
console.log(`diretrizes: ${ok} ok, ${fail} falhas`); process.exit(fail ? 1 : 0);
