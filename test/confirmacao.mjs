// Agendamento sob confirmação (pending → confirmar/recusar). Uso: BASE=http://localhost:3999 node test/confirmacao.mjs
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
const A = await login('demo@demo.com', 'demo1234'); // administrador, empresa 1
const B = await login('dois@x.com', 'senhasenha');   // empresa 2, modo automático

const base = async (T) => {
  const pr = (await call('GET', '/api/professionals', { token: T.token })).body.find((x) => x.active && (x.does_service_ids || []).length);
  const cu = (await call('GET', '/api/customers', { token: T.token })).body[0];
  return pr && cu ? { professional_id: pr.id, service_id: pr.does_service_ids[0], customer_id: cu.id } : null;
};
const a = await base(A);
if (!a) { console.log('aviso: sem profissional/cliente na demo, teste pulado'); process.exit(0); }
const dia = (n, h) => { const d = new Date(Date.UTC(2031, 0, n, h)); return d.toISOString(); };
const novo = (T, extra) => call('POST', '/api/appointments', { token: T.token, body: { ...a, ...extra } });

// modo automático (padrão): o agente marca direto
let r = await novo(A, { source: 'ia', starts_at: dia(5, 13) });
check('modo automático: ia agenda direto', r.status === 201 && r.body.status === 'scheduled', JSON.stringify(r));

// liga "sob confirmação" sem mexer no limite de profissionais
const antes = (await call('GET', '/api/admin/companies', { token: A.token })).body.find((x) => x.id === A.company.id);
check('modo inválido = 400', (await call('PUT', `/api/admin/companies/${A.company.id}`, { token: A.token, body: { booking_mode: 'xis' } })).status === 400);
const put = await call('PUT', `/api/admin/companies/${A.company.id}`, { token: A.token, body: { booking_mode: 'confirm' } });
check('liga sob confirmação', put.status === 200 && put.body.booking_mode === 'confirm', JSON.stringify(put));
check('limite de profissionais não foi mexido', put.body.max_professionals === antes.max_professionals);
check('/booking-mode lê o modo', (await call('GET', '/api/booking-mode', { token: A.token })).body.booking_mode === 'confirm');
check('/booking-mode traz telefone de aviso', 'notify_phone' in (await call('GET', '/api/booking-mode', { token: A.token })).body);
check('empresa comum não altera o modo', (await call('PUT', `/api/admin/companies/${A.company.id}`, { token: B.token, body: { booking_mode: 'auto' } })).status === 403);

// o que o agente marca fica aguardando
const p1 = await novo(A, { source: 'ia', starts_at: dia(6, 13) });
check('ia agenda como aguardando', p1.status === 201 && p1.body.status === 'pending', JSON.stringify(p1));
check('horário aguardando já ocupa a agenda', (await novo(A, { source: 'manual', starts_at: dia(6, 13) })).status === 409);
const man = await novo(A, { source: 'manual', starts_at: dia(7, 13) });
check('marcação manual do painel já nasce agendada', man.status === 201 && man.body.status === 'scheduled');

// confirmar: vale a primeira resposta
check('decisão inválida = 400', (await call('POST', `/api/appointments/${p1.body.id}/respond`, { token: A.token, body: { decision: 'talvez' } })).status === 400);
const c1 = await call('POST', `/api/appointments/${p1.body.id}/respond`, { token: A.token, body: { decision: 'confirm' } });
check('confirmar → agendado', c1.status === 200 && c1.body.status === 'scheduled', JSON.stringify(c1));
const c2 = await call('POST', `/api/appointments/${p1.body.id}/respond`, { token: A.token, body: { decision: 'reject' } });
check('segunda resposta = 409 com a situação atual', c2.status === 409 && c2.body.ja_respondido === true && c2.body.status === 'scheduled', JSON.stringify(c2));

// recusar libera o horário
const p2 = await novo(A, { source: 'ia', starts_at: dia(8, 13) });
const rj = await call('POST', `/api/appointments/${p2.body.id}/respond`, { token: A.token, body: { decision: 'reject' } });
check('recusar → cancelado', rj.status === 200 && rj.body.status === 'cancelled');
check('horário recusado volta a ficar livre', (await novo(A, { source: 'ia', starts_at: dia(8, 13) })).status === 201);

// agendamento que não existe / de outra empresa
check('inexistente = 404', (await call('POST', '/api/appointments/99999999/respond', { token: A.token, body: { decision: 'confirm' } })).status === 404);
const p3 = await novo(A, { source: 'ia', starts_at: dia(9, 13) });
check('outra empresa não responde = 404', (await call('POST', `/api/appointments/${p3.body.id}/respond`, { token: B.token, body: { decision: 'confirm' } })).status === 404);
check('sem login = 401', (await call('POST', `/api/appointments/${p3.body.id}/respond`, { body: { decision: 'confirm' } })).status === 401);

// a empresa 2 continua automática
const b = await base(B);
if (b) {
  const rb = await call('POST', '/api/appointments', { token: B.token, body: { ...b, source: 'ia', starts_at: dia(5, 15) } });
  check('empresa em modo automático não é afetada', rb.status === 201 && rb.body.status === 'scheduled', JSON.stringify(rb));
}

// volta ao padrão
await call('PUT', `/api/admin/companies/${A.company.id}`, { token: A.token, body: { booking_mode: 'auto' } });
check('volta ao automático', (await call('GET', '/api/booking-mode', { token: A.token })).body.booking_mode === 'auto');
console.log(`confirmacao: ${ok} ok, ${fail} falhas`); process.exit(fail ? 1 : 0);
