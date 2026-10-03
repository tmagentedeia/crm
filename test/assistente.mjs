// Assistente (opcional por empresa): manual e atualizações próprios, separados do atendente. Uso: BASE=http://localhost:3999 node test/assistente.mjs
const BASE = process.env.BASE || 'http://localhost:3999';
const KEY = process.env.N8N_API_KEY || 'k';
let ok = 0, fail = 0;
const check = (name, cond, extra = '') => { cond ? ok++ : (fail++, console.log('FALHOU:', name, extra)); };
const call = async (method, path, { token, n8n, body } = {}) => {
  const headers = { 'content-type': 'application/json' };
  if (token) headers.authorization = 'Bearer ' + token;
  if (n8n !== undefined) { headers['x-api-key'] = KEY; headers['x-company-id'] = String(n8n); }
  const r = await fetch(BASE + path, { method, headers, body: body ? JSON.stringify(body) : undefined });
  let j = null; try { j = await r.json(); } catch {}
  return { status: r.status, body: j };
};
const login = async (e, p) => (await call('POST', '/api/auth/login', { body: { email: e, password: p } })).body;
const A = await login('demo@demo.com', 'demo1234');
const B = await login('dois@x.com', 'senhasenha');

// desligado (padrão): nada é entregue ao fluxo da Maria
let p = (await call('GET', '/n8n/assistant/prompt', { n8n: 1 })).body;
check('desligado: não entrega nada', p.enabled === false && p.prompt === '');
const em = (await call('GET', '/api/company', { token: A.token })).body;
check('módulo assistente começa desligado', em.modules?.assistente !== true);

// escrever e publicar o manual do assistente
check('salva rascunho do assistente', (await call('PUT', '/api/assistant-manual', { token: A.token, body: { content: 'Regra da Maria 1' } })).status === 200);
check('publicar', (await call('POST', '/api/assistant-manual/publish', { token: A.token })).status === 200);
p = (await call('GET', '/n8n/assistant/prompt', { n8n: 1 })).body;
check('publicado mas ainda desligado: nada entregue', p.enabled === false && p.prompt === '');

// liga pelo administrador
check('liga o assistente', (await call('PUT', '/api/admin/companies/1/modules', { token: A.token, body: { modules: { assistente: true } } })).status === 200);
p = (await call('GET', '/n8n/assistant/prompt', { n8n: 1 })).body;
check('ligado: entrega o manual do assistente', p.enabled === true && p.prompt.includes('Regra da Maria 1'), JSON.stringify(p));
check('sem nome do atendente no assistente', p.agent_name === null);

// separado do atendente
await call('PUT', '/api/agent-manual', { token: A.token, body: { content: 'Só do atendente' } });
await call('POST', '/api/agent-manual/publish', { token: A.token });
const pa = (await call('GET', '/n8n/agent/prompt', { n8n: 1 })).body;
check('atendente não recebe o manual do assistente', pa.prompt.includes('Só do atendente') && !pa.prompt.includes('Regra da Maria'));
p = (await call('GET', '/n8n/assistant/prompt', { n8n: 1 })).body;
check('assistente não recebe o manual do atendente', !p.prompt.includes('Só do atendente'));

// atualizações provisórias do assistente
const u = await call('POST', '/api/assistant-updates', { token: A.token, body: { text: 'Hoje não agendar nada' } });
check('cria atualização do assistente', u.status === 201);
p = (await call('GET', '/n8n/assistant/prompt', { n8n: 1 })).body;
check('atualização vale e vem antes', p.updates.length === 1 && p.prompt.indexOf('Hoje não agendar nada') < p.prompt.indexOf('Regra da Maria 1'));
check('atendente não vê a atualização do assistente', !JSON.stringify((await call('GET', '/n8n/agent/prompt', { n8n: 1 })).body).includes('Hoje não agendar nada'));
check('encerra', (await call('PUT', `/api/assistant-updates/${u.body.id}`, { token: A.token, body: { active: false } })).status === 200);
check('encerrada some do prompt', (await call('GET', '/n8n/assistant/prompt', { n8n: 1 })).body.updates.length === 0);

// outra empresa não enxerga
check('empresa B desligada e sem manual', (await call('GET', '/n8n/assistant/prompt', { n8n: 2 })).body.enabled === false
  && (await call('GET', '/api/assistant-manual', { token: B.token })).body.versions.length === 0);

// desliga de novo: volta a não entregar
await call('PUT', '/api/admin/companies/1/modules', { token: A.token, body: { modules: { assistente: false } } });
check('desligou: não entrega mais', (await call('GET', '/n8n/assistant/prompt', { n8n: 1 })).body.enabled === false);

console.log(`assistente: ${ok} ok, ${fail} falhas`);
process.exit(fail ? 1 : 0);
