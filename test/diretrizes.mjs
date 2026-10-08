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
// caixas do editor: a linha de separação não chega ao agente
await call('PUT', '/api/agent-guidelines', { token: t, body: { global: 'REGRA UM\n{{agente}} é educada.\n=====\nREGRA DOIS\nSem inventar.', company: '' } });
r = await call('GET', '/n8n/agent/prompt', { h });
check('separador das caixas não vai ao agente', !r.body.prompt.includes('=====') && r.body.prompt.includes('REGRA DOIS') && r.body.prompt.includes('Iara é educada.'), r.body.prompt);
await call('PUT', '/api/agent-guidelines', { token: t, body: { global: '{{agente}} nunca assume o papel de terceiros. Dono: {{adm}}.', company: 'Extra de {{empresa}}' } });
r = await call('PUT', '/api/agent-guidelines', { token: t, body: { global: 'x'.repeat(10001) } });
check('limite de tamanho', r.status === 400);
// Maria (só pela chave do N8N): lê e troca UMA caixa da parte da EMPRESA; a parte global nunca passa por aqui
await call('PUT', '/api/agent-guidelines', { token: t, body: { global: 'GLOBAL A\nregra da plataforma', company: 'CAIXA UM\nSem gírias.\n=====\nCAIXA DOIS\nSem promessas.' } });
const lc = await call('GET', '/n8n/agent-guidelines/caixas', { h });
check('Maria lista as caixas da empresa', lc.status === 200 && lc.body.total === 2 && lc.body.caixas.map((x) => x.titulo).join('|') === 'CAIXA UM|CAIXA DOIS', JSON.stringify(lc.body));
check('Maria não enxerga a parte global', !JSON.stringify(lc.body).includes('GLOBAL A'));
r = await call('GET', '/n8n/agent-guidelines/caixa?titulo=' + encodeURIComponent('caixa dois'), { h });
check('Maria lê uma caixa pelo título', r.status === 200 && r.body.n === 2 && r.body.texto.includes('Sem promessas.'), JSON.stringify(r.body));
r = await call('PUT', '/n8n/agent-guidelines/caixa', { h, body: { titulo: 'CAIXA UM', texto: 'CAIXA UM\nSem gírias e sem palavrões.' } });
check('Maria troca uma caixa', r.status === 200 && r.body.n === 1 && r.body.antes.includes('Sem gírias.') && r.body.depois.includes('palavrões'), JSON.stringify(r.body));
const ad = (await call('GET', '/api/agent-guidelines', { token: t })).body;
check('só essa caixa mudou e a global ficou igual', ad.company.includes('palavrões') && ad.company.includes('Sem promessas.') && ad.company.split('\n=====\n').length === 2 && ad.global.startsWith('GLOBAL A'), JSON.stringify(ad));
check('a mudança chega ao prompt', (await call('GET', '/n8n/agent/prompt', { h })).body.prompt.includes('palavrões'));
check('Maria: texto vazio = 400', (await call('PUT', '/n8n/agent-guidelines/caixa', { h, body: { n: 1, texto: '  ' } })).status === 400);
check('Maria: separador no texto = 400', (await call('PUT', '/n8n/agent-guidelines/caixa', { h, body: { n: 1, texto: 'A\n=====\nB' } })).status === 400);
check('Maria: título inexistente = 404', (await call('PUT', '/n8n/agent-guidelines/caixa', { h, body: { titulo: 'NADA', texto: 'oi' } })).status === 404);
check('Maria: sem título nem número = 400', (await call('PUT', '/n8n/agent-guidelines/caixa', { h, body: { texto: 'oi' } })).status === 400);
check('Maria: passar do limite = 400', (await call('PUT', '/n8n/agent-guidelines/caixa', { h, body: { n: 2, texto: 'x'.repeat(10001) } })).status === 400);
check('quem está logado no painel não usa a rota da Maria (403)', (await call('GET', '/api/agent-guidelines/caixas', { token: t })).status === 403
  && (await call('PUT', '/api/agent-guidelines/caixa', { token: t, body: { n: 1, texto: 'hack' } })).status === 403);
check('outra empresa não enxerga as caixas desta', (await call('GET', '/n8n/agent-guidelines/caixas', { h: { 'x-api-key': 'k', 'x-company-id': '2' } })).body.total === 0);
await call('PUT', '/api/agent-guidelines', { token: t, body: { company: '' } });
check('sem diretrizes próprias: lista vazia e leitura 404', (await call('GET', '/n8n/agent-guidelines/caixas', { h })).body.total === 0 && (await call('GET', '/n8n/agent-guidelines/caixa?n=1', { h })).status === 404);
await call('PUT', '/api/agent-guidelines', { token: t, body: { global: '{{agente}} nunca assume o papel de terceiros. Dono: {{adm}}.', company: 'Extra de {{empresa}}' } });
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
