// A Maria lê o manual e troca UMA caixa por vez, pelas rotas do N8N. Uso: BASE=http://localhost:3999 node test/maria_manual.mjs
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
const M = { n8n: 1 };

// monta e publica um manual de 3 caixas pelo painel
const manual = 'REGRAS DA CASA\nSeja simpática.\n=====\nHORÁRIOS\nSeg a sex, 9h às 18h.\n=====\nPREÇOS\nCorte: R$ 50.';
await call('PUT', '/api/agent-manual', { token: A.token, body: { content: manual } });
await call('POST', '/api/agent-manual/publish', { token: A.token });

let l = (await call('GET', '/n8n/agent-manual/caixas', M)).body;
check('lista 3 caixas com títulos', l.total === 3 && l.caixas.map((c) => c.titulo).join('|') === 'REGRAS DA CASA|HORÁRIOS|PREÇOS', JSON.stringify(l));
let c = (await call('GET', '/n8n/agent-manual/caixa?titulo=' + encodeURIComponent('horários'), M)).body;
check('lê uma caixa pelo título (sem diferenciar maiúsculas)', c.n === 2 && c.texto.includes('9h às 18h'), JSON.stringify(c));
check('lê pelo número', (await call('GET', '/n8n/agent-manual/caixa?n=3', M)).body.titulo === 'PREÇOS');
check('título inexistente = 404', (await call('GET', '/n8n/agent-manual/caixa?titulo=NADA', M)).status === 404);
check('número fora = 404', (await call('GET', '/n8n/agent-manual/caixa?n=9', M)).status === 404);

// troca só a caixa 2
const r = await call('PUT', '/n8n/agent-manual/caixa', { ...M, body: { titulo: 'HORÁRIOS', texto: 'HORÁRIOS\nSeg a sáb, 9h às 19h.' } });
check('troca uma caixa', r.status === 200 && r.body.n === 2 && r.body.antes.includes('18h') && r.body.depois.includes('19h'), JSON.stringify(r.body));
const pr = (await call('GET', '/n8n/agent/prompt', M)).body;
check('as outras caixas ficam intactas', pr.manual.includes('Seja simpática.') && pr.manual.includes('Corte: R$ 50.') && pr.manual.includes('9h às 19h') && !pr.manual.includes('18h'), pr.manual);
const pn = (await call('GET', '/api/agent-manual', { token: A.token })).body;
check('mesma estrutura de 3 caixas no painel', pn.current.content.split('\n=====\n').length === 3 && pn.versions.length >= 2, pn.current.content);

// recusas
check('texto vazio = 400', (await call('PUT', '/n8n/agent-manual/caixa', { ...M, body: { titulo: 'PREÇOS', texto: '  ' } })).status === 400);
check('texto com separador = 400', (await call('PUT', '/n8n/agent-manual/caixa', { ...M, body: { titulo: 'PREÇOS', texto: 'A\n=====\nB' } })).status === 400);
check('título inexistente na troca = 404', (await call('PUT', '/n8n/agent-manual/caixa', { ...M, body: { titulo: 'XYZ', texto: 'oi' } })).status === 404);
check('sem título nem número = 400', (await call('PUT', '/n8n/agent-manual/caixa', { ...M, body: { texto: 'oi' } })).status === 400);
check('manual enorme = 400', (await call('PUT', '/n8n/agent-manual/caixa', { ...M, body: { n: 3, texto: 'x'.repeat(50001) } })).status === 400);

// título repetido pede o número
await call('PUT', '/api/agent-manual', { token: A.token, body: { content: 'REGRA\na\n=====\nREGRA\nb' } });
await call('POST', '/api/agent-manual/publish', { token: A.token });
check('título repetido = 409', (await call('PUT', '/n8n/agent-manual/caixa', { ...M, body: { titulo: 'REGRA', texto: 'REGRA\nz' } })).status === 409);
check('pelo número resolve', (await call('PUT', '/n8n/agent-manual/caixa', { ...M, body: { n: 2, texto: 'REGRA\nz' } })).status === 200);

// rascunho aberto no painel bloqueia a troca
await call('PUT', '/api/agent-manual', { token: A.token, body: { content: 'rascunho novo' } });
check('com rascunho aberto = 409', (await call('PUT', '/n8n/agent-manual/caixa', { ...M, body: { n: 1, texto: 'REGRA\nq' } })).status === 409);

// o assistente não tem essas rotas (a Maria só mexe no manual do atendente)
check('assistente sem rota de troca', (await call('PUT', '/n8n/assistant-manual/caixa', { ...M, body: { n: 1, texto: 'x' } })).status === 404);

// outra empresa não enxerga
check('empresa 2 não vê as caixas da 1', (await call('GET', '/n8n/agent-manual/caixas', { n8n: 2 })).body.total === 0);

// atualizações provisórias pelas rotas do N8N: criar, alterar, encerrar
const u = await call('POST', '/n8n/agent-updates', { ...M, body: { text: 'Hoje fechamos às 15h' } });
check('cria atualização', u.status === 201);
check('altera o texto', (await call('PUT', `/n8n/agent-updates/${u.body.id}`, { ...M, body: { text: 'Hoje fechamos às 16h' } })).status === 200);
check('aparece no prompt', (await call('GET', '/n8n/agent/prompt', M)).body.updates.some((x) => x.text === 'Hoje fechamos às 16h'));
check('encerra', (await call('PUT', `/n8n/agent-updates/${u.body.id}`, { ...M, body: { active: false } })).status === 200);
check('encerrada some', !(await call('GET', '/n8n/agent/prompt', M)).body.updates.some((x) => x.text === 'Hoje fechamos às 16h'));

console.log(`maria_manual: ${ok} ok, ${fail} falhas`);
process.exit(fail ? 1 : 0);
