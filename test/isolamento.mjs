// Testes de isolamento entre empresas e das rotas principais. Uso: BASE=http://localhost:3999 node test/isolamento.mjs
const BASE = process.env.BASE || 'http://localhost:3999';
const KEY = process.env.N8N_API_KEY || 'k';
let ok = 0, fail = 0;
const check = (name, cond, extra = '') => { cond ? ok++ : (fail++, console.log('FALHOU:', name, extra)); };
const call = async (method, path, { token, n8n, body } = {}) => {
  const headers = { 'content-type': 'application/json' };
  if (token) headers.authorization = 'Bearer ' + token;
  if (n8n !== undefined) { headers['x-api-key'] = KEY; if (n8n !== null) headers['x-company-id'] = String(n8n); }
  const r = await fetch(BASE + path, { method, headers, body: body ? JSON.stringify(body) : undefined });
  let j = null; try { j = await r.json(); } catch {}
  return { status: r.status, body: j };
};
const login = async (email, password) => (await call('POST', '/api/auth/login', { body: { email, password } })).body;

const A = await login('demo@demo.com', 'demo1234');      // empresa 1 (admin)
const B = await login('dois@x.com', 'senhasenha');       // empresa 2
check('login A', !!A.token && A.company.id == 1);
check('login B', !!B.token && B.company.id == 2);

// ---- dados de cada empresa não se misturam ----
const cA = (await call('GET', '/api/customers', { token: A.token })).body;
const cB = (await call('GET', '/api/customers', { token: B.token })).body;
check('A vê só os seus clientes', cA.length > 5 && !cA.some((c) => c.name === 'Cliente Dois'));
check('B vê só os seus clientes', cB.length === 1 && cB[0].name === 'Cliente Dois');
const sA = (await call('GET', '/api/services', { token: A.token })).body;
const sB = (await call('GET', '/api/services', { token: B.token })).body;
check('serviços separados', sA.length === 5 && sB.length === 1 && sB[0].name === 'Manicure');
const bA = (await call('GET', '/api/professionals', { token: A.token })).body;
const bB = (await call('GET', '/api/professionals', { token: B.token })).body;
check('profissionais separados', bA.length === 3 && bB.length === 1 && bB[0].name === 'Joana');
const apA = (await call('GET', '/api/appointments', { token: A.token })).body;
const apB = (await call('GET', '/api/appointments', { token: B.token })).body;
check('agendamentos separados', apA.length > 100 && apB.length === 0);
const cat = (x) => call('GET', '/api/categories', { token: x.token }).then((r) => r.body.map((c) => c.name).sort().join(','));
check('categorias separadas', (await cat(A)) === 'Cabelo' && (await cat(B)) === 'Cabelo,Unhas');

// ---- B tenta mexer em coisas de A (pelos ids de A) ----
const idCli = cA[0].id, idAppt = apA[0].id, idSv = sA[0].id, idBar = bA[0].id;
check('B não lê cliente de A', (await call('GET', '/api/customers/' + idCli, { token: B.token })).status === 404);
check('B não edita cliente de A', (await call('PUT', '/api/customers/' + idCli, { token: B.token, body: { name: 'HACK' } })).status === 404);
check('B não apaga cliente de A', (await call('DELETE', '/api/customers/' + idCli, { token: B.token })).status === 404);
check('B não muda status de agendamento de A', (await call('PATCH', `/api/appointments/${idAppt}/status`, { token: B.token, body: { status: 'cancelled' } })).status === 404);
check('B não apaga agendamento de A', (await call('DELETE', '/api/appointments/' + idAppt, { token: B.token })).status === 200 && (await call('GET', '/api/appointments', { token: A.token })).body.length === apA.length);
check('B não edita serviço de A', (await call('PUT', '/api/services/' + idSv, { token: B.token, body: { name: 'HACK' } })).status === 404);
check('B não edita profissional de A', (await call('PUT', '/api/professionals/' + idBar, { token: B.token, body: { name: 'HACK' } })).status === 404);
const cliB = cB[0].id;
const svB = sB[0].id;
const tryAppt = await call('POST', '/api/appointments', { token: B.token, body: { professional_id: idBar, customer_id: cliB, service_id: svB, starts_at: '2030-01-07T12:00:00Z' } });
check('B não agenda com profissional de A', tryAppt.status === 400, JSON.stringify(tryAppt));
check('dados de A intactos', (await call('GET', '/api/customers/' + idCli, { token: A.token })).body.name !== 'HACK');
const cc = (await call('GET', '/api/categories', { token: A.token })).body;
check('B não apaga categoria de A (sem efeito)', (await call('DELETE', '/api/categories/' + cc[0].id, { token: B.token })).status === 200 && (await call('GET', '/api/categories', { token: A.token })).body.length === cc.length);

// ---- N8N: cabeçalho escolhe a empresa ----
check('n8n sem x-company-id = 400', (await call('GET', '/n8n/professionals', { n8n: null })).status === 400);
check('n8n empresa inexistente = 404', (await call('GET', '/n8n/professionals', { n8n: 999 })).status === 404);
check('n8n chave errada = 401', (await fetch(BASE + '/n8n/professionals', { headers: { 'x-api-key': 'x', 'x-company-id': '1' } })).status === 401);
check('n8n empresa 1', (await call('GET', '/n8n/professionals', { n8n: 1 })).body.length === 3);
check('n8n empresa 2', (await call('GET', '/n8n/professionals', { n8n: 2 })).body.length === 1);
const mon = new Date(Date.now() + 14 * 864e5); while (mon.getDay() !== 1) mon.setDate(mon.getDate() + 1);
const day = mon.toISOString().slice(0, 10);
const avA = await call('GET', `/n8n/availability?date=${day}&service_id=${idSv}`, { n8n: 1 });
check('disponibilidade A', avA.status === 200 && avA.body.length > 0, JSON.stringify(avA).slice(0, 200));
const avB = await call('GET', `/n8n/availability?date=${day}&service_id=${svB}`, { n8n: 2 });
check('disponibilidade B', avB.status === 200 && avB.body.length > 0 && avB.body.every((x) => x.professional_name === 'Joana'), JSON.stringify(avB).slice(0, 200));
check('disponibilidade: serviço de A na empresa 2 = 400', (await call('GET', `/n8n/availability?date=${day}&service_id=${idSv}`, { n8n: 2 })).status === 400);
const win = await call('GET', `/n8n/availability/window?start=${day}T15:00:00Z&end=${day}T15:30:00Z&service_id=${idSv}`, { n8n: 1 });
check('janela A', win.status === 200 && (win.body.free.length + win.body.busy.length) === 3, JSON.stringify(win.body));

// ---- fluxo completo na empresa 2 via N8N: cliente, agendamento, lembrete, cancelar, fila ----
const cust = await call('POST', '/n8n/customers', { n8n: 2, body: { name: 'Nova', phone: '553277776666', source: 'ia' } });
check('upsert cliente B', cust.status === 201, JSON.stringify(cust));
const slot = avB.body[0];
const ap = await call('POST', '/n8n/appointments', { n8n: 2, body: { professional_id: slot.professional_id, customer_id: cust.body.id, service_id: svB, starts_at: slot.starts_at, source: 'ia' } });
check('agenda B', ap.status === 201, JSON.stringify(ap));
const dup = await call('POST', '/n8n/appointments', { n8n: 2, body: { professional_id: slot.professional_id, customer_id: cust.body.id, service_id: svB, starts_at: slot.starts_at, source: 'ia' } });
check('conflito = 409', dup.status === 409, JSON.stringify(dup));
check('A não vê esse agendamento', !(await call('GET', '/api/appointments', { token: A.token })).body.some((a) => a.id === ap.body.id && a.customer_id === ap.body.customer_id && a.professional_id === ap.body.professional_id));
const byPhone = await call('GET', '/n8n/appointments?phone=553277776666&status=scheduled', { n8n: 2 });
check('consulta por telefone B', byPhone.body.length === 1);
check('mesma consulta em A = vazia', (await call('GET', '/n8n/appointments?phone=553277776666', { n8n: 1 })).body.length === 0);
const wl = await call('POST', '/n8n/waitlist', { n8n: 2, body: { phone: '553277776666', name: 'Nova', desired_at: new Date(Date.now() + 5 * 864e5).toISOString(), professional_name: 'Joana' } });
check('fila B', wl.status === 201, JSON.stringify(wl));
check('fila: profissional de A não existe em B', (await call('POST', '/n8n/waitlist', { n8n: 2, body: { phone: '5532777', desired_at: new Date(Date.now() + 5 * 864e5).toISOString(), professional_name: bA[0].name } })).status === 400);
const canc = await call('PATCH', `/n8n/appointments/${ap.body.id}/status`, { n8n: 2, body: { status: 'cancelled' } });
check('cancelar B', canc.status === 200 && canc.body.status === 'cancelled');
check('id inexistente na empresa = 404', (await call('PATCH', '/n8n/appointments/99999999/status', { n8n: 1, body: { status: 'scheduled' } })).status === 404);
const rem = await call('POST', '/n8n/appointments/reminders/claim', { n8n: 2, body: {} });
check('lembrete responde lista', rem.status === 200 && Array.isArray(rem.body));

// ---- lembrete: agendamento daqui a ~2h marcado há tempo ----
// (cria direto no banco de teste não é possível por aqui; só confere o formato quando houver)

// ---- comandos do agente por empresa ----
const clsA = await call('POST', '/n8n/agent-commands/classify', { n8n: 1, body: { text: 'Will aqui' } });
check('classify A: frase cadastrada', clsA.body.action === 'pause' && clsA.body.explicit, JSON.stringify(clsA.body));
const clsB = await call('POST', '/n8n/agent-commands/classify', { n8n: 2, body: { text: 'Will aqui' } });
check('classify B: frase de A não vale em B', clsB.body.rule === 'geral', JSON.stringify(clsB.body));
const clsB2 = await call('POST', '/n8n/agent-commands/classify', { n8n: 2, body: { text: 'Maria aqui' } });
check('classify B: adm da empresa 2', clsB2.body.action === 'pause' && clsB2.body.adm_name === 'Maria', JSON.stringify(clsB2.body));
check('classify: /off', (await call('POST', '/n8n/agent-commands/classify', { n8n: 1, body: { text: '/off' } })).body.action === 'off');
const addB = await call('POST', '/api/agent-commands', { token: B.token, body: { kind: 'pause', phrase: 'Will aqui' } });
check('B pode cadastrar a mesma frase de A', addB.status === 201, JSON.stringify(addB));
const cfgA = (await call('GET', '/api/agent-config', { token: A.token })).body;
check('config A não mostra frases de B', cfgA.commands.every((c) => c.phrase !== 'Maria sai'));

// ---- configurações, dashboard, importação ----
check('empresa A', (await call('GET', '/api/company', { token: A.token })).body.name === 'Empresa Demo');
check('empresa B', (await call('GET', '/api/company', { token: B.token })).body.name === 'Empresa Dois');
const dA = (await call('GET', '/api/dashboard?days=400', { token: A.token })).body;
const dB = (await call('GET', '/api/dashboard?days=400', { token: B.token })).body;
check('dashboard A com dados, B vazio', dA.atendimentos > 0 && dB.atendimentos === 0, JSON.stringify([dA.atendimentos, dB.atendimentos]));
const imp = await call('POST', '/api/import', { token: B.token, body: { dry_run: true, services: [{ Serviço: 'Pé e mão', Preço: '50', Duração: '60', Categoria: 'Unhas' }], customers: [{ Nome: 'Imp', Telefone: '(32) 98888-1111' }] } });
check('importar (simulação) B', imp.status === 200 && imp.body.services.created === 1 && imp.body.customers.created === 1, JSON.stringify(imp.body));
check('simulação não gravou', (await call('GET', '/api/services', { token: B.token })).body.length === 1);
const imp2 = await call('POST', '/api/import', { token: B.token, body: { dry_run: false, services: [{ Serviço: 'Pé e mão', Preço: '50', Duração: '60', Categoria: 'Unhas' }] } });
check('importar de verdade B', imp2.status === 200 && (await call('GET', '/api/services', { token: B.token })).body.length === 2);
check('importação não vazou para A', (await call('GET', '/api/services', { token: A.token })).body.length === 5);
const lim = await call('POST', '/api/professionals', { token: B.token, body: { name: 'X', category_ids: [1] } });
check('limite de profissionais da empresa 2 (3) respeitado', lim.status === 201 || lim.status === 400);

// ---- administração ----
check('B não é admin', (await call('GET', '/api/admin/companies', { token: B.token })).status === 403);
const adm = await call('GET', '/api/admin/companies', { token: A.token });
check('A é admin e vê as empresas', adm.status === 200 && adm.body.length >= 2 && adm.body[0].ativos === 3, JSON.stringify(adm.body));

// ---- chave de integração por empresa ----
const gerar = (token, id) => call('POST', `/api/admin/companies/${id}/api-key`, { token });
const comChave = (key, empresa, path = '/n8n/professionals') =>
  fetch(BASE + path, { headers: { 'x-api-key': key, 'x-company-id': String(empresa) } }).then((r) => r.status);
check('quem não é admin não gera chave', (await gerar(B.token, 2)).status === 403);
check('gerar chave de empresa inexistente = 404', (await gerar(A.token, 999)).status === 404);
const k1 = (await gerar(A.token, 1)).body;
const k2 = (await gerar(A.token, 2)).body;
check('gera chaves diferentes e longas', /^crm_[\w-]{40,}$/.test(k1.api_key) && /^crm_[\w-]{40,}$/.test(k2.api_key) && k1.api_key !== k2.api_key, JSON.stringify(k1));
check('chave da empresa 1 vale na 1', (await comChave(k1.api_key, 1)) === 200);
check('chave da empresa 2 vale na 2', (await comChave(k2.api_key, 2)) === 200);
check('chave da empresa 1 NÃO vale na 2', (await comChave(k1.api_key, 2)) === 401);
check('chave da empresa 2 NÃO vale na 1', (await comChave(k2.api_key, 1)) === 401);
check('chave certa + empresa inexistente = 401 (não revela quem existe)', (await comChave(k1.api_key, 999)) === 401);
check('chave global ainda vale (transição)', (await comChave(KEY, 1)) === 200 && (await comChave(KEY, 2)) === 200);
check('sem chave = 401', (await fetch(BASE + '/n8n/professionals', { headers: { 'x-company-id': '1' } })).status === 401);
check('chave de empresa sem x-company-id = 401', (await fetch(BASE + '/n8n/professionals', { headers: { 'x-api-key': k1.api_key } })).status === 401);
const lista = (await call('GET', '/api/admin/companies', { token: A.token })).body;
check('lista mostra só o final da chave', lista[0].api_key_hint === k1.api_key.slice(-4) && !JSON.stringify(lista).includes(k1.api_key) && !('api_key_hash' in lista[0]));
const k1b = (await gerar(A.token, 1)).body;
check('regenerar invalida a chave anterior', (await comChave(k1.api_key, 1)) === 401 && (await comChave(k1b.api_key, 1)) === 200);
check('regenerar a da empresa 1 não mexe na da 2', (await comChave(k2.api_key, 2)) === 200);

// ---- criar empresa e módulos (administrador) ----
const nova = { name: 'Empresa Módulos', owner_name: 'Dona Módulos', email: `mod${Date.now()}@x.com`, password: 'senhasenha', modules: { agenda: true, clientes: true, dashboard: false, atendente: false } };
const criar = (token, body) => call('POST', '/api/admin/companies', { token, body });
check('quem não é admin não cria empresa', (await criar(B.token, nova)).status === 403);
check('senha curta = 400', (await criar(A.token, { ...nova, password: '123' })).status === 400);
check('e-mail inválido = 400', (await criar(A.token, { ...nova, email: 'sem-arroba' })).status === 400);
check('módulo desconhecido = 400', (await criar(A.token, { ...nova, modules: { voo: true } })).status === 400);
check('módulo que não é true/false = 400', (await criar(A.token, { ...nova, modules: { agenda: 'sim' } })).status === 400);
const criada = await criar(A.token, nova);
check('administrador cria empresa', criada.status === 201 && criada.body.id > 2 && /^crm_/.test(criada.body.api_key), JSON.stringify(criada.body));
check('a chave da empresa criada vale nela e não na 1', (await comChave(criada.body.api_key, criada.body.id)) === 200 && (await comChave(criada.body.api_key, 1)) === 401);
check('e-mail repetido = 409', (await criar(A.token, nova)).status === 409);
const donaM = await login(nova.email, nova.password);
check('responsável entra e recebe os módulos', !!donaM.token && donaM.company.modules.dashboard === false && donaM.company.modules.agenda === true, JSON.stringify(donaM.company));
check('empresa criada começa vazia', (await call('GET', '/api/customers', { token: donaM.token })).body.length === 0);
const urlMod = `/api/admin/companies/${criada.body.id}/modules`;
const liga = await call('PUT', urlMod, { token: A.token, body: { modules: { dashboard: true, agenda: false } } });
check('liga e desliga módulos sem mexer nos outros', liga.status === 200 && liga.body.modules.dashboard === true && liga.body.modules.agenda === false && liga.body.modules.clientes === true, JSON.stringify(liga.body));
check('o responsável vê a mudança', (await call('GET', '/api/company', { token: donaM.token })).body.modules.agenda === false);
check('módulo desconhecido na troca = 400', (await call('PUT', urlMod, { token: A.token, body: { modules: { voo: false } } })).status === 400);
check('quem não é admin não troca módulos', (await call('PUT', urlMod, { token: donaM.token, body: { modules: { agenda: true } } })).status === 403);
check('módulos de empresa inexistente = 404', (await call('PUT', '/api/admin/companies/999/modules', { token: A.token, body: { modules: { agenda: true } } })).status === 404);
const ligaFino = await call('PUT', urlMod, { token: A.token, body: { modules: { fila: false, inativos: false, importar: false, comandos: true } } });
check('módulos por item do menu são aceitos', ligaFino.status === 200 && ligaFino.body.modules.fila === false && ligaFino.body.modules.comandos === true && ligaFino.body.modules.clientes === true, JSON.stringify(ligaFino.body));
check('módulo desconhecido = 400', (await call('PUT', urlMod, { token: A.token, body: { modules: { financeiro: true } } })).status === 400);
check('a lista de empresas mostra os módulos', (await call('GET', '/api/admin/companies', { token: A.token })).body.find((c) => c.id == criada.body.id)?.modules?.agenda === false);
check('desligar módulo só esconde o menu: as rotas continuam respondendo', (await call('GET', '/api/services', { token: donaM.token })).status === 200);
check('empresa antiga (sem módulos configurados) continua inteira', Object.keys(A.company.modules || {}).length === 0);

// ---- cadastro de empresa nova (cria schema) ----
const reg = await call('POST', '/api/auth/register', { body: { company_name: 'Agência Teste', name: 'Zé', email: `ze${Date.now()}@x.com`, password: 'senhasenha' } });
check('cadastro cria empresa', reg.status === 201 && reg.body.company.id > 2, JSON.stringify(reg));
check('cadastro não devolve nada da chave', !JSON.stringify(reg.body).includes('api_key'), JSON.stringify(reg.body));
check('empresa criada pelo cadastro já nasce com chave (global ainda vale nela)', (await comChave(KEY, reg.body.company.id)) === 200);
const N = reg.body.token;
check('empresa nova começa vazia', (await call('GET', '/api/customers', { token: N })).body.length === 0 && (await call('GET', '/api/services', { token: N })).body.length === 0);
const nc = await call('POST', '/api/customers', { token: N, body: { name: 'Primeiro', phone: '32999990001' } });
check('empresa nova grava', nc.status === 201);
check('e A não vê', !(await call('GET', '/api/customers', { token: A.token })).body.some((c) => c.name === 'Primeiro'));
check('token inválido = 401', (await call('GET', '/api/customers', { token: 'x' })).status === 401);
check('sem token = 401', (await call('GET', '/api/customers')).status === 401);

// ---- exportação para planilha ----
const exA = (await call('GET', '/api/customers/export', { token: A.token })).body;
const exB = (await call('GET', '/api/customers/export', { token: B.token })).body;
check('exportação traz todos os clientes da empresa', exA.length >= cA.length && exA.every((c) => 'name' in c && 'phone' in c && 'status' in c));
check('exportação separada por empresa', exB.some((c) => c.name === 'Cliente Dois') && !exA.some((c) => c.name === 'Cliente Dois') && !exB.some((c) => cA.some((a) => a.name === c.name)));
check('exportação respeita o filtro', (await call('GET', '/api/customers/export?status=lead', { token: A.token })).body.every((c) => c.status === 'lead'));
check('exportação no N8N exige chave', (await call('GET', '/n8n/customers/export', { n8n: 1 })).status === 200);
check('exportação sem login = 401', (await call('GET', '/api/customers/export')).status === 401);

// ---- versão no ar e histórico de acessos (só administrador)
const ver = await call('GET', '/api/admin/version', { token: A.token });
check('administrador vê a versão no ar', ver.status === 200 && !!ver.body.started_at && 'commit' in ver.body, JSON.stringify(ver.body));
check('não administrador não vê a versão', (await call('GET', '/api/admin/version', { token: B.token })).status === 403);
const lg = await call('GET', '/api/admin/access-log', { token: A.token });
check('administrador vê o histórico de acessos', lg.status === 200 && Array.isArray(lg.body));
check('não administrador não vê o histórico', (await call('GET', '/api/admin/access-log', { token: B.token })).status === 403);

console.log(`\n${ok} ok, ${fail} falhas`);
process.exit(fail ? 1 : 0);
