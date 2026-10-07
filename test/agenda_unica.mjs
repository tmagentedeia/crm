// Agenda única: empresa sem profissional cadastrado atende por uma agenda com o nome da empresa.
// Uso: BASE=http://localhost:3999 node test/agenda_unica.mjs  (cria uma empresa nova; rodar por último)
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
const reg = await call('POST', '/api/auth/register', { body: { company_name: 'Clínica Solo', name: 'Dona', email: `solo${Date.now()}@x.com`, password: 'senhasenha1' } });
check('empresa nova criada', reg.status === 201, JSON.stringify(reg.body));
const T = reg.body.token;
const get = (p) => call('GET', '/api/' + p, { token: T });
const put = (b) => call('PUT', '/api/agenda/config', { token: T, body: b });

const reg2 = await call('POST', '/api/auth/register', { body: { company_name: 'Clínica Dupla', name: 'Dona', email: `dupla${Date.now()}@x.com`, password: 'senhasenha1' } });
const par = await Promise.all([1, 2, 3, 4].map(() => call('GET', '/api/professionals', { token: reg2.body.token })));
check('telas abrindo ao mesmo tempo não duplicam a agenda', par.every((x) => x.status === 200) && (await call('GET', '/api/professionals', { token: reg2.body.token })).body.length === 1);
let pr = await get('professionals');
check('sem profissional: aparece a agenda da empresa', pr.body.length === 1 && pr.body[0].name === 'Clínica Solo', JSON.stringify(pr.body));
check('não exige categoria', (pr.body[0].category_ids || []).length === 0);
pr = await get('professionals');
check('não duplica na segunda vez', pr.body.length === 1);
// agenda do Google da empresa (espelho): o campo volta para a agenda única
check('agenda do Google começa vazia', (await get('agenda/config')).body.google_calendar_id === null);
check('salva o ID da agenda do Google', (await put({ google_calendar_id: 'clinica@gmail.com' })).status === 200 && (await get('agenda/config')).body.google_calendar_id === 'clinica@gmail.com');
check('aceita o link da agenda colado', (await put({ google_calendar_id: 'https://calendar.google.com/calendar/u/0?cid=bWluaGFAZ21haWwuY29t' })).status === 200 && (await get('agenda/config')).body.google_calendar_id === 'minha@gmail.com');
check('o agendamento leva o ID para o espelho', (await get('professionals')).body[0].google_calendar_id === 'minha@gmail.com');
check('salvar outra opção não apaga a agenda do Google', (await put({ scheduling_enabled: true })).status === 200 && (await get('agenda/config')).body.google_calendar_id === 'minha@gmail.com');
check('vazio remove', (await put({ google_calendar_id: '' })).status === 200 && (await get('agenda/config')).body.google_calendar_id === null);
const idUnica = pr.body[0].id;

const sv = await call('POST', '/api/services', { token: T, body: { name: 'Consulta', price: 100, duration_min: 30 } });
check('serviço sem categoria criado', sv.status === 201, JSON.stringify(sv.body));
const cu = await call('POST', '/api/customers', { token: T, body: { name: 'Fulano', phone: '5532988887777' } });
const amanha = new Date(Date.now() + 2 * 86400000); while (amanha.getDay() === 0) amanha.setDate(amanha.getDate() + 1);
const dia = amanha.toISOString().slice(0, 10);
const av = await get(`availability?date=${dia}&service_id=${sv.body.id}`);
check('horários livres vêm da agenda única', av.body.length > 0 && av.body[0].professional_id === idUnica, JSON.stringify(av.body).slice(0, 200));

const min = (h) => Number(h.slice(0, 2)) * 60 + Number(h.slice(3, 5));
check('horários oferecidos andam na duração do serviço (30 min)', av.body.length > 1 && av.body.every((x, i) => i === 0 || min(x.time) - min(av.body[i - 1].time) === 30), JSON.stringify(av.body.map((x) => x.time).slice(0, 6)));
const sv45 = await call('POST', '/api/services', { token: T, body: { name: 'Longa', price: 100, duration_min: 45 } });
const av45 = await get(`availability?date=${dia}&service_id=${sv45.body.id}`);
check('serviço de 45 min oferece de 45 em 45', av45.body.length > 1 && av45.body.every((x, i) => i === 0 || min(x.time) - min(av45.body[i - 1].time) === 45), JSON.stringify(av45.body.map((x) => x.time).slice(0, 6)));

const ap = await call('POST', '/api/appointments', { token: T, body: { customer_id: cu.body.id, service_id: sv.body.id, starts_at: av.body[0].starts_at } });
check('agenda sem informar profissional', ap.status === 201 && ap.body.professional_id === idUnica, JSON.stringify(ap.body));

// horário de atendimento da empresa e liga/desliga dos agendamentos
let cf = await get('agenda/config');
check('config da agenda: empresa sem profissional, agendamentos ligados', cf.body.solo === true && cf.body.scheduling_enabled === true && cf.body.schedules.length === 6, JSON.stringify(cf.body));
check('salva o horário da empresa', (await put({ schedules: [{ weekday: 2, start_time: '10:00', end_time: '12:00' }] })).status === 200);
cf = await get('agenda/config');
check('horário salvo vale', cf.body.schedules.length === 1 && cf.body.schedules[0].weekday === 2 && String(cf.body.schedules[0].start_time).startsWith('10:00'), JSON.stringify(cf.body.schedules));
check('desativa agendamentos', (await put({ scheduling_enabled: false })).status === 200 && (await get('agenda/config')).body.scheduling_enabled === false);
check('desativado: horários livres recusados', (await get(`availability?date=${dia}&service_id=${sv.body.id}`)).status === 409);
check('desativado: agendar recusado', (await call('POST', '/api/appointments', { token: T, body: { customer_id: cu.body.id, service_id: sv.body.id, starts_at: av.body[0].starts_at } })).status === 409);
check('reativa agendamentos', (await put({ scheduling_enabled: true })).status === 200 && (await get(`availability?date=${dia}&service_id=${sv.body.id}`)).status === 200);
await put({ schedules: [1, 2, 3, 4, 5, 6].map((weekday) => ({ weekday, start_time: '09:00', end_time: '18:00' })) });
{
  const ult = async (id) => { const r = (await get(`availability?date=${dia}&service_id=${id}`)).body; return r.length ? r[r.length - 1].time : null; };
  check('serviço de 30 min: último horário é 17:30 (expediente até 18:00)', (await ult(sv.body.id)) === '17:30', await ult(sv.body.id));
  check('serviço de 45 min: último horário termina até as 18:00', (await ult(sv45.body.id)) === '17:15', await ult(sv45.body.id));
}

// entra o primeiro profissional de verdade: a agenda única sai de cena
const cat = await call('POST', '/api/categories', { token: T, body: { name: 'Geral' } });
const novo = await call('POST', '/api/professionals', { token: T, body: { name: 'Dra. Ana', category_ids: [cat.body.id] } });
check('profissional de verdade continua exigindo categoria', (await call('POST', '/api/professionals', { token: T, body: { name: 'X', category_ids: [] } })).status === 400);
check('profissional criado', novo.status === 201, JSON.stringify(novo.body));
pr = await get('professionals');
check('com profissional, horário da empresa deixa de valer', (await get('agenda/config')).body.solo === false && (await put({ schedules: [] })).status === 400);
check('com profissional, a agenda única some da lista', pr.body.length === 1 && pr.body[0].name === 'Dra. Ana', JSON.stringify(pr.body.map((x) => x.name)));
console.log(`${ok} ok, ${fail} falhas`);
process.exit(fail ? 1 : 0);
