// Exclusão de verdade de serviços e profissionais. Uso: BASE=http://localhost:3999 node test/exclusao.mjs
const BASE = process.env.BASE || 'http://localhost:3999';
let ok = 0, fail = 0;
const check = (name, cond, extra = '') => { cond ? ok++ : (fail++, console.log('FALHOU:', name, extra)); };
const call = async (method, path, { token, body } = {}) => {
  const headers = { 'content-type': 'application/json' };
  if (token) headers.authorization = 'Bearer ' + token;
  const r = await fetch(BASE + path, { method, headers, body: body ? JSON.stringify(body) : undefined });
  let j = null; try { j = await r.json(); } catch {}
  return { status: r.status, body: j };
};
const login = async (e, p) => (await call('POST', '/api/auth/login', { body: { email: e, password: p } })).body;
const A = await login('demo@demo.com', 'demo1234');
const B = await login('dois@x.com', 'senhasenha');

// serviço e profissional novos, sem histórico: podem ser excluídos
const sv = (await call('POST', '/api/services', { token: A.token, body: { name: 'Corte teste', price: 10, duration_min: 30 } })).body;
check('exclui serviço sem histórico', (await call('DELETE', `/api/services/${sv.id}/permanent`, { token: A.token })).status === 200);
check('serviço sumiu da lista', !(await call('GET', '/api/services', { token: A.token })).body.some((x) => x.id === sv.id));
check('excluir de novo = 404', (await call('DELETE', `/api/services/${sv.id}/permanent`, { token: A.token })).status === 404);
const pr = (await call('POST', '/api/professionals', { token: A.token, body: { name: 'Prof teste', color: '#123456', category_ids: [] } }));
if (pr.status === 201) {
  check('exclui profissional sem histórico', (await call('DELETE', `/api/professionals/${pr.body.id}/permanent`, { token: A.token })).status === 200);
}

// serviço e profissional com agendamentos no histórico: só ficam desativados
const lista = (await call('GET', '/api/services', { token: A.token })).body;
const ags = (await call('GET', '/api/appointments', { token: A.token })).body;
const usado = ags.length ? ags[0] : null;
if (usado) {
  const r1 = await call('DELETE', `/api/services/${usado.service_id}/permanent`, { token: A.token });
  check('serviço com histórico não é excluído', r1.status === 409 && /histórico/.test(r1.body.error), JSON.stringify(r1));
  const r2 = await call('DELETE', `/api/professionals/${usado.professional_id}/permanent`, { token: A.token });
  check('profissional com histórico não é excluído', r2.status === 409, JSON.stringify(r2));
  check('409 avisa que tem histórico', r1.body.tem_historico === true);
  // com ?com_historico=1 apaga junto os agendamentos
  const r3 = await call('DELETE', `/api/services/${usado.service_id}/permanent?com_historico=1`, { token: A.token });
  check('serviço com histórico é excluído com com_historico=1', r3.status === 200 && r3.body.agendamentos_apagados >= 1, JSON.stringify(r3));
  const restam = (await call('GET', '/api/appointments', { token: A.token })).body;
  check('agendamentos do serviço sumiram', !restam.some((x) => x.service_id === usado.service_id));
  const r4 = await call('DELETE', `/api/professionals/${usado.professional_id}/permanent?com_historico=1`, { token: A.token });
  check('profissional com histórico é excluído com com_historico=1', r4.status === 200, JSON.stringify(r4));
} else console.log('aviso: sem agendamentos na demo, testes de histórico pulados');

// isolamento: a empresa 2 não apaga nada da empresa 1
const alvo = lista.find((x) => x.id) ;
check('empresa 2 não exclui serviço da empresa 1', (await call('DELETE', `/api/services/${alvo.id}/permanent`, { token: B.token })).status === 404);
check('sem login = 401', (await call('DELETE', '/api/services/1/permanent')).status === 401);
console.log(`exclusao: ${ok} ok, ${fail} falhas`); process.exit(fail ? 1 : 0);
