// Manual e atualizações provisórias do atendente. Uso: BASE=http://localhost:3999 node test/atendente.mjs
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
const day = (n) => new Date(Date.now() + n * 86400000).toISOString().slice(0, 10);

// manual: vazio -> rascunho -> publicar -> nova versão -> voltar
let m = (await call('GET', '/api/agent-manual', { token: A.token })).body;
check('manual começa vazio', !m.draft && !m.current && m.versions.length === 0);
check('publicar sem texto = 400', (await call('POST', '/api/agent-manual/publish', { token: A.token })).status === 400);
check('salva rascunho', (await call('PUT', '/api/agent-manual', { token: A.token, body: { content: 'Versão 1' } })).status === 200);
check('salvar de novo atualiza o mesmo rascunho', (await call('PUT', '/api/agent-manual', { token: A.token, body: { content: 'Versão 1b' } })).status === 200);
check('rascunho não vai para o N8N', (await call('GET', '/n8n/agent/prompt', { n8n: 1 })).body.prompt === '');
check('publica', (await call('POST', '/api/agent-manual/publish', { token: A.token })).status === 200);
check('N8N recebe o publicado', (await call('GET', '/n8n/agent/prompt', { n8n: 1 })).body.prompt === 'Versão 1b');
await call('PUT', '/api/agent-manual', { token: A.token, body: { content: 'Versão 2' } });
check('rascunho novo não muda o que vale', (await call('GET', '/n8n/agent/prompt', { n8n: 1 })).body.prompt === 'Versão 1b');
await call('POST', '/api/agent-manual/publish', { token: A.token });
m = (await call('GET', '/api/agent-manual', { token: A.token })).body;
check('duas versões, a mais nova em uso', m.versions.length === 2 && m.current.content === 'Versão 2' && !m.draft);
const v1 = m.versions.find((v) => v.content === 'Versão 1b');
check('voltar versão antiga vira rascunho', (await call('POST', `/api/agent-manual/restore/${v1.id}`, { token: A.token })).status === 200
  && (await call('GET', '/api/agent-manual', { token: A.token })).body.draft.content === 'Versão 1b');
check('manual de 50 mil cabe', (await call('PUT', '/api/agent-manual', { token: A.token, body: { content: 'x'.repeat(50000) } })).status === 200);
check('manual enorme = 400', (await call('PUT', '/api/agent-manual', { token: A.token, body: { content: 'x'.repeat(50001) } })).status === 400);
check('empresa B não vê o manual de A', (await call('GET', '/api/agent-manual', { token: B.token })).body.versions.length === 0
  && (await call('GET', '/n8n/agent/prompt', { n8n: 2 })).body.prompt === '');
check('restaurar versão de outra empresa = 404', (await call('POST', `/api/agent-manual/restore/${v1.id}`, { token: B.token })).status === 404);

// atualizações provisórias (datas e horas no horário da empresa, America/Sao_Paulo)
const pad = (n) => String(n).padStart(2, '0');
const agoraSP = (minutos) => { // "aaaa-mm-ddThh:mm" no horário de São Paulo, daqui a `minutos`
  const d = new Date(Date.now() + minutos * 60000 - 3 * 3600000);
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}T${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`;
};
const mk = async (b) => (await call('POST', '/api/agent-updates', { token: A.token, body: b }));
const n1 = (await mk({ text: 'Fechamos mais cedo hoje', ends_at: agoraSP(90) })).body;
const n2 = (await mk({ text: 'Promoção da semana' })).body;
const n3 = (await mk({ text: 'Só mais tarde', starts_at: agoraSP(60), ends_at: agoraSP(120) })).body;
const n4 = (await mk({ text: 'Já passou', starts_at: agoraSP(-300), ends_at: agoraSP(-5) })).body;
const long = 'x'.repeat(1000);
check('aceita 1000 caracteres', (await mk({ text: long })).status === 201);
let l = (await call('GET', '/api/agent-updates', { token: A.token })).body.updates;
const st = (id) => l.find((n) => n.id === id)?.state;
check('estados', st(n1.id) === 'active' && st(n2.id) === 'active' && st(n3.id) === 'upcoming' && st(n4.id) === 'ended', JSON.stringify(l.map((n) => n.state)));
const e1 = l.find((n) => n.id === n1.id).ends_at;
check('fim guardado no horário da empresa', /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(e1) && Math.abs(Date.parse(e1 + ':00Z') - Date.parse(agoraSP(90) + ':00Z')) < 120000, e1);
let p = (await call('GET', '/n8n/agent/prompt', { n8n: 1 })).body;
check('prompt tem manual e só o que vale agora', p.prompt.includes('Versão 2') && p.prompt.includes('Fechamos mais cedo') && p.prompt.includes('Promoção')
  && !p.prompt.includes('Só mais tarde') && !p.prompt.includes('Já passou') && p.updates.length === 3);
check('texto com 1001 = 400', (await mk({ text: 'x'.repeat(1001) })).status === 400);
check('texto vazio = 400', (await mk({ text: '  ' })).status === 400);
check('fim antes do início = 400', (await mk({ text: 'a', starts_at: agoraSP(180), ends_at: agoraSP(60) })).status === 400);
check('momento inválido = 400', (await mk({ text: 'a', ends_at: 'amanha' })).status === 400);
check('só data (sem hora) = 400', (await mk({ text: 'a', ends_at: '2030-01-01' })).status === 400);
check('encerrar', (await call('PUT', `/api/agent-updates/${n2.id}`, { token: A.token, body: { active: false } })).status === 200);
p = (await call('GET', '/n8n/agent/prompt', { n8n: 1 })).body;
check('encerrada sai do prompt', !p.prompt.includes('Promoção') && p.updates.length === 2);
check('reativar com novo fim', (await call('PUT', `/api/agent-updates/${n4.id}`, { token: A.token, body: { active: true, ends_at: agoraSP(240) } })).status === 200
  && (await call('GET', '/n8n/agent/prompt', { n8n: 1 })).body.prompt.includes('Já passou'));
check('reativar sem novo fim = sem data final', (await call('PUT', `/api/agent-updates/${n2.id}`, { token: A.token, body: { active: true, ends_at: null } })).status === 200
  && (await call('GET', '/n8n/agent/prompt', { n8n: 1 })).body.prompt.includes('Promoção'));
check('empresa B não vê as de A', (await call('GET', '/api/agent-updates', { token: B.token })).body.updates.length === 0
  && !(await call('GET', '/n8n/agent/prompt', { n8n: 2 })).body.prompt.includes('Fechamos'));
check('B não altera a de A', (await call('PUT', `/api/agent-updates/${n1.id}`, { token: B.token, body: { text: 'HACK' } })).status === 404);
let last;
for (let i = 0; i < 12; i++) last = await mk({ text: 'item ' + i });
check('limite de 10 em vigor', last.status === 400);
check('apagar', (await call('DELETE', `/api/agent-updates/${n1.id}`, { token: A.token })).status === 200);

// nome do agente vira a primeira linha do texto enviado ao N8N (e some quando o nome é apagado)
await call('PUT', '/api/agent-config', { token: A.token, body: { agent_name: 'Iara' } });
let pn = (await call('GET', '/n8n/agent/prompt', { n8n: 1 })).body;
check('nome do agente na primeira linha', pn.prompt.startsWith('Seu nome é Iara.\n\n') && pn.agent_name === 'Iara' && pn.manual === pn.manual.trim() + (pn.manual.endsWith('\n') ? '\n' : ''), pn.prompt.slice(0, 60));
check('empresa B não recebe o nome da A', !(await call('GET', '/n8n/agent/prompt', { n8n: 2 })).body.prompt.includes('Iara'));
await call('PUT', '/api/agent-config', { token: A.token, body: { agent_name: '' } });
check('sem nome, sem a primeira linha', !(await call('GET', '/n8n/agent/prompt', { n8n: 1 })).body.prompt.startsWith('Seu nome'));
console.log(`\natendente: ${ok} ok, ${fail} falhas`);
process.exit(fail ? 1 : 0);
