// Lembrete a pedido do cliente (opcional por empresa, ligado por padrão). Uso: BASE=http://localhost:3999 node test/lembrete_cliente.mjs
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
const prompt = async (n) => (await call('GET', '/n8n/agent/prompt', { n8n: n })).body;
const set = (n, v) => call('PUT', `/api/admin/companies/${n}/modules`, { token: A.token, body: { modules: { lembrete_cliente: v } } });

await call('PUT', '/api/agent-manual', { token: A.token, body: { content: 'Manual do lembrete teste' } });
await call('POST', '/api/agent-manual/publish', { token: A.token });

let p = await prompt(1);
check('padrão: ligado, sem aviso no prompt', p.client_reminders === true && !p.prompt.includes('NÃO DISPONÍVEL') && p.prompt.includes('Manual do lembrete teste'), JSON.stringify(p).slice(0, 200));

check('desliga pelo administrador', (await set(1, false)).status === 200);
p = await prompt(1);
check('desligado: o atendente é instruído a não oferecer', p.client_reminders === false && p.prompt.includes('NÃO DISPONÍVEL') && /não agende/.test(p.prompt), p.prompt.slice(0, 200));
check('o manual continua no prompt', p.prompt.includes('Manual do lembrete teste'));
check('vale só para a empresa 1', (await prompt(2)).client_reminders === true);
check('empresa 1 mostra a chave desligada', (await call('GET', '/api/admin/companies', { token: A.token })).body.find((x) => Number(x.id) === 1)?.modules?.lembrete_cliente === false);

check('religa', (await set(1, true)).status === 200);
p = await prompt(1);
check('religado: volta ao normal', p.client_reminders === true && !p.prompt.includes('NÃO DISPONÍVEL'));
check('valor que não é verdadeiro/falso é recusado', (await call('PUT', '/api/admin/companies/1/modules', { token: A.token, body: { modules: { lembrete_cliente: 'nao' } } })).status === 400);

console.log(`${ok} ok, ${fail} falhas`);
process.exit(fail ? 1 : 0);
