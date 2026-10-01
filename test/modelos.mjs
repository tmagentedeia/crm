// Modelos de empresa. Uso: BASE=http://localhost:3999 node test/modelos.mjs (roda depois de isolamento e atendente)
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
const A = await login('demo@demo.com', 'demo1234'); // administrador, empresa 1
const B = await login('dois@x.com', 'senhasenha');   // empresa comum

// a empresa 1 precisa ter manual publicado e configuração própria
await call('PUT', '/api/agent-manual', { token: A.token, body: { content: 'Manual do modelo' } });
await call('POST', '/api/agent-manual/publish', { token: A.token });
await call('PUT', '/api/company', { token: A.token, body: { inactive_days: 45, reminder_minutes: 180, name: 'Empresa Demo', phone: '32999990000' } });
const svA = (await call('GET', '/api/services', { token: A.token })).body;
const catA = (await call('GET', '/api/categories', { token: A.token })).body;

check('não administrador não vê modelos', (await call('GET', '/api/admin/templates', { token: B.token })).status === 403);
check('não administrador não salva modelo', (await call('POST', '/api/admin/templates', { token: B.token, body: { company_id: 1, name: 'x' } })).status === 403);
check('modelo sem nome = 400', (await call('POST', '/api/admin/templates', { token: A.token, body: { company_id: 1, name: ' ' } })).status === 400);
check('empresa inexistente = 404', (await call('POST', '/api/admin/templates', { token: A.token, body: { company_id: 999, name: 'x' } })).status === 404);
await call('PUT', '/api/company', { token: A.token, body: { menu_custom: { profissionais: { icon: '💇', label: 'Equipe' } } } });
const t = await call('POST', '/api/admin/templates', { token: A.token, body: { company_id: 1, name: 'Modelo Teste', description: 'para teste' } });
check('salva modelo', t.status === 201, JSON.stringify(t));
check('nome repetido = 409', (await call('POST', '/api/admin/templates', { token: A.token, body: { company_id: 1, name: 'Modelo Teste' } })).status === 409);
const lista = (await call('GET', '/api/admin/templates', { token: A.token })).body;
const m = lista.find((x) => x.name === 'Modelo Teste');
check('lista traz contagens', m && m.servicos === svA.length && m.categorias === catA.length && m.tem_manual === true, JSON.stringify(m));
check('lista não expõe os dados', !('data' in m));

// cria empresa a partir do modelo
const mods = { agenda: true, clientes: false, dashboard: true, atendente: true };
const nova = await call('POST', '/api/admin/companies', { token: A.token, body: { name: 'Filial Modelo', owner_name: 'Dono Novo', email: 'novo@x.com', password: 'senhasenha', modules: mods, template_id: m.id } });
check('cria empresa com modelo', nova.status === 201, JSON.stringify(nova));
const N = await login('novo@x.com', 'senhasenha');
const svN = (await call('GET', '/api/services', { token: N.token })).body;
const catN = (await call('GET', '/api/categories', { token: N.token })).body;
const key = (arr) => arr.map((s) => `${s.name}|${s.price}|${s.duration_min}|${s.category || ''}`).sort().join(';');
check('menu personalizado vai junto no modelo', N.company.menu_custom?.profissionais?.label === 'Equipe' && N.company.menu_custom?.profissionais?.icon === '💇', JSON.stringify(N.company.menu_custom));
check('serviços copiados', svN.length === svA.length && key(svN) === key(svA), key(svN) + ' <> ' + key(svA));
check('categorias copiadas', catN.map((c) => c.name).sort().join() === catA.map((c) => c.name).sort().join());
check('sem clientes', (await call('GET', '/api/customers', { token: N.token })).body.length === 0);
check('sem profissionais', (await call('GET', '/api/professionals', { token: N.token })).body.length === 0);
check('sem agendamentos', (await call('GET', '/api/appointments', { token: N.token })).body.length === 0);
await call('PUT', '/api/company', { token: A.token, body: { menu_custom: {} } });
check('manual já publicado', (await call('GET', '/n8n/agent/prompt', { n8n: nova.body.id })).body.prompt === 'Manual do modelo');
check('sem atualizações provisórias herdadas', (await call('GET', '/n8n/agent/prompt', { n8n: nova.body.id })).body.updates.length === 0);
const cfg = (await call('GET', '/api/company', { token: N.token })).body;
check('configurações copiadas, identidade não', cfg.inactive_days === 45 && cfg.reminder_minutes === 180 && cfg.name === 'Filial Modelo' && !cfg.phone && !cfg.logo, JSON.stringify(cfg));
check('módulos vêm do que foi pedido', cfg.modules.clientes === false && cfg.modules.agenda === true);
check('empresa original intacta', (await call('GET', '/api/services', { token: A.token })).body.length === svA.length);
const svB = (await call('GET', '/api/services', { token: B.token })).body; check('empresa nova isolada das outras', !svB.some((x) => svA.some((a) => a.name === x.name)), JSON.stringify(svB.map((x) => x.name)));

// sem modelo continua em branco; modelo inválido não cria nada
const branca = await call('POST', '/api/admin/companies', { token: A.token, body: { name: 'Branca', owner_name: 'X', email: 'branca@x.com', password: 'senhasenha' } });
check('sem modelo = empresa em branco', branca.status === 201 && (await call('GET', '/api/services', { token: (await login('branca@x.com', 'senhasenha')).token })).body.length === 0);
const ruim = await call('POST', '/api/admin/companies', { token: A.token, body: { name: 'Ruim', owner_name: 'X', email: 'ruim@x.com', password: 'senhasenha', template_id: 99999 } });
check('modelo inexistente = 400 e nada criado', ruim.status === 400 && !(await login('ruim@x.com', 'senhasenha')).token);


// ---- menu padrão das empresas novas (só para empresa criada sem modelo)
check('não administrador não define menu padrão', (await call('PUT', '/api/admin/default-menu', { token: B.token, body: { company_id: 1 } })).status === 403);
check('empresa inexistente = 404', (await call('PUT', '/api/admin/default-menu', { token: A.token, body: { company_id: 999 } })).status === 404);
await call('PUT', '/api/company', { token: A.token, body: { menu_custom: { fila: { icon: '🕒', label: 'Espera' } } } });
const dm = await call('PUT', '/api/admin/default-menu', { token: A.token, body: { company_id: 1 } });
check('define o menu da empresa 1 como padrão', dm.status === 200 && dm.body.menu_custom.fila.label === 'Espera', JSON.stringify(dm.body));
check('administrador lê o menu padrão', (await call('GET', '/api/admin/default-menu', { token: A.token })).body.menu_custom.fila.icon === '🕒');
const semModelo = await call('POST', '/api/admin/companies', { token: A.token, body: { name: 'Sem Modelo', owner_name: 'Dona', email: 'sem@x.com', password: 'senhasenha' } });
const S1 = await login('sem@x.com', 'senhasenha');
check('empresa sem modelo nasce com o menu padrão', semModelo.status === 201 && S1.company.menu_custom?.fila?.label === 'Espera', JSON.stringify(S1.company));
const comModelo = await call('POST', '/api/admin/companies', { token: A.token, body: { name: 'Com Modelo', owner_name: 'Dono', email: 'com@x.com', password: 'senhasenha', template_id: m.id } });
const S2 = await login('com@x.com', 'senhasenha');
check('empresa de modelo usa o menu do modelo, não o padrão', comModelo.status === 201 && !S2.company.menu_custom?.fila, JSON.stringify(S2.company.menu_custom));
check('empresas que já existiam não mudam', !(await call('GET', '/api/company', { token: B.token })).body.menu_custom?.fila);
check('voltar ao menu original', Object.keys((await call('PUT', '/api/admin/default-menu', { token: A.token, body: { clear: true } })).body.menu_custom).length === 0);
const aposLimpar = await call('POST', '/api/admin/companies', { token: A.token, body: { name: 'Sem Modelo 2', owner_name: 'Dona', email: 'sem2@x.com', password: 'senhasenha' } });
check('depois de limpar, empresa nova nasce com o menu original', Object.keys((await login('sem2@x.com', 'senhasenha')).company.menu_custom || {}).length === 0 && aposLimpar.status === 201);
await call('PUT', '/api/company', { token: A.token, body: { menu_custom: {} } });
check('apagar modelo', (await call('DELETE', `/api/admin/templates/${m.id}`, { token: A.token })).status === 200
  && !(await call('GET', '/api/admin/templates', { token: A.token })).body.some((x) => x.id === m.id));
check('empresa criada continua depois de apagar o modelo', (await call('GET', '/api/services', { token: N.token })).body.length === svA.length);

console.log(`\nmodelos: ${ok} ok, ${fail} falhas`);
process.exit(fail ? 1 : 0);
