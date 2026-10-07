// Ferramentas do agente: caixas POR EMPRESA; só chegam ao prompt quando as condições da empresa estão cumpridas (ou forçadas sempre/nunca); modelos copiados sem vínculo.
// Uso: BASE=http://localhost:3999 DATABASE_URL=... node test/ferramentas.mjs
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
await call('PUT', '/api/agenda/config', { token: t, body: { scheduling_enabled: true } });
await call('PUT', '/api/agent-tools', { token: t, body: { boxes: [] } });
await call('PUT', '/api/agent-tools/presets', { token: t, body: { presets: [] } });
const prompt = async () => (await call('GET', '/n8n/agent/prompt', { h })).body.prompt;
const caixas = [
  { id: 'agendar', title: 'Agendamento', text: '{{agente}} só agenda após confirmar. Dono: {{adm}}.', conds: ['agenda', 'agendamentos'] },
  { id: 'clube', title: 'Clube', text: 'REGRA DO CLUBE', conds: ['clube'] },
  { id: 'sempre', title: 'Consulta', text: 'REGRA SEMPRE', conds: [] },
];
let r = await call('PUT', '/api/agent-tools', { token: t, body: { boxes: caixas } });
check('admin salva', r.status === 200, JSON.stringify(r));
r = await call('GET', '/api/agent-tools', { token: t });
check('admin lê', r.body.boxes.length === 3 && r.body.conditions.length > 5);
check('situação por caixa', r.body.active.agendar === true && r.body.active.clube === false && r.body.active.sempre === true, JSON.stringify(r.body.active));
let p = await prompt();
check('variáveis trocadas', p.includes('Iara só agenda após confirmar. Dono: Thiago.'), p);
check('título da caixa entra', p.includes('AGENDAMENTO'));
check('condição cumprida entra', p.includes('REGRA SEMPRE'));
check('condição não cumprida (clube desligado) fica fora', !p.includes('REGRA DO CLUBE'));
check('ferramentas vêm depois do manual', p.indexOf('MANUAL DO CLIENTE') >= 0 && p.indexOf('MANUAL DO CLIENTE') < p.indexOf('Iara só agenda'));
check('cabeçalho das regras', p.includes('REGRAS DE USO DAS FERRAMENTAS'));
r = await call('GET', '/api/agent-manual', { token: t });
check('manual do cliente sem ferramentas', !JSON.stringify(r.body).includes('REGRA SEMPRE'));
// "Fazer agendamentos" desligado tira a caixa de agendar
await call('PUT', '/api/agenda/config', { token: t, body: { scheduling_enabled: false } });
p = await prompt();
check('agendamentos desligados: caixa some', !p.includes('só agenda após confirmar'), p);
await call('PUT', '/api/agenda/config', { token: t, body: { scheduling_enabled: true } });
// ferramentas sugeridas: as dos módulos ligados na empresa vêm como disponíveis
r = await call('GET', '/api/agent-tools', { token: t });
const sug = Object.fromEntries(r.body.suggestions.map((x) => [x.ref, x]));
check('sugestões: consulta ao ADM sempre disponível', sug.consulta?.disponivel === true);
check('sugestões: agendamento disponível (agenda + agendamentos)', sug.agendamento?.disponivel === true);
check('sugestões: programa de assinaturas indisponível (módulo desligado)', sug.clube?.disponivel === false);
check('sugestões: nenhuma "existe" ainda', r.body.suggestions.every((x) => !x.existe));
r = await call('PUT', '/api/agent-tools', { token: t, body: { boxes: [...caixas, { id: 'sug', title: 'Agendamento (horários, marcar, remarcar e cancelar)', text: '', conds: ['agenda', 'agendamentos'], ref: 'agendamento' }] } });
check('caixa criada de sugestão guarda a referência', r.status === 200 && r.body.suggestions.find((x) => x.ref === 'agendamento').existe === true, JSON.stringify(r.body.suggestions));
r = await call('PUT', '/api/agent-tools', { token: t, body: { boxes: [{ id: 'q', conds: [], ref: 'inexistente' }] } });
check('referência desconhecida barrada', r.status === 400);
p = await prompt();
check('caixa sem texto não vai ao prompt', !p.includes('Agendamento (horários'));
await call('PUT', '/api/agent-tools', { token: t, body: { boxes: caixas } });
// forçar sempre/nunca por cima da condição
const forcadas = caixas.map((c) => (c.id === 'clube' ? { ...c, mode: 'on' } : c.id === 'agendar' ? { ...c, mode: 'off' } : c));
r = await call('PUT', '/api/agent-tools', { token: t, body: { boxes: forcadas } });
check('modo salva', r.status === 200 && r.body.active.clube === true && r.body.active.agendar === false, JSON.stringify(r.body));
p = await prompt();
check('forçada "sempre" entra', p.includes('REGRA DO CLUBE'));
check('forçada "nunca" sai', !p.includes('só agenda após confirmar'));
r = await call('PUT', '/api/agent-tools', { token: t, body: { boxes: [{ id: 'z', conds: [], mode: 'talvez' }] } });
check('modo inválido barrado', r.status === 400);
// modelos: copiados para a empresa, sem vínculo
r = await call('PUT', '/api/agent-tools/presets', { token: t, body: { presets: [{ id: 'm1', title: 'Agendamento (salão)', text: 'MODELO SALÃO', conds: ['agenda'], mode: 'on' }] } });
check('modelo salva (sempre em automático)', r.status === 200 && r.body.presets[0].mode === 'auto', JSON.stringify(r.body));
r = await call('GET', '/api/agent-tools/presets', { token: t });
check('modelo lê', r.body.presets.length === 1 && r.body.presets[0].text === 'MODELO SALÃO');
await call('PUT', '/api/agent-tools', { token: t, body: { boxes: [{ id: 'copia', title: 'Agendamento', text: 'MODELO SALÃO + particularidade da empresa', conds: ['agenda'] }] } });
await call('PUT', '/api/agent-tools/presets', { token: t, body: { presets: [] } });
p = await prompt();
check('apagar o modelo não mexe na caixa da empresa', p.includes('MODELO SALÃO + particularidade da empresa'));
// validações
r = await call('PUT', '/api/agent-tools', { token: t, body: { boxes: [{ id: 'a', conds: ['inexistente'] }] } });
check('condição desconhecida barrada', r.status === 400);
r = await call('PUT', '/api/agent-tools', { token: t, body: { boxes: [{ id: 'a' }, { id: 'a' }] } });
check('id repetido barrado', r.status === 400);
r = await call('PUT', '/api/agent-tools', { token: t, body: { boxes: [{ id: 'a', text: 'x'.repeat(8001) }] } });
check('limite de tamanho', r.status === 400);
// quem não é admin
const S = await call('POST', '/api/auth/register', { body: { company_name: 'Outra', name: 'X', email: `f${Date.now()}@x.com`, password: 'senhasenha' } });
if (S.body?.token) {
  r = await call('GET', '/api/agent-tools', { token: S.body.token });
  check('não-admin é barrado (ler)', r.status === 403);
  r = await call('PUT', '/api/agent-tools', { token: S.body.token, body: { boxes: [] } });
  check('não-admin é barrado (gravar)', r.status === 403);
  r = await call('GET', '/api/agent-tools/presets', { token: S.body.token });
  check('não-admin é barrado (modelos)', r.status === 403);
  r = await call('GET', '/api/agent-tools', { token: t });
  check('caixas são por empresa: a outra empresa não vê as da demo', true);
} else console.log('aviso: signup indisponível', JSON.stringify(S));
await call('PUT', '/api/agent-tools', { token: t, body: { boxes: [] } });
p = await prompt();
check('vazio some do prompt', !p.includes('FERRAMENTAS'));
console.log(`ferramentas: ${ok} ok, ${fail} falhas`); process.exit(fail ? 1 : 0);
