// Parcerias entre programas de assinatura. Uso: BASE=http://localhost:3999 node test/parcerias.mjs
import { execSync } from 'child_process';
const BASE = process.env.BASE || 'http://localhost:3999';
let ok = 0, fail = 0;
const check = (name, cond, extra = '') => { cond ? ok++ : (fail++, console.log('FALHOU:', name, extra)); };
const call = async (method, path, { token, body, headers: h } = {}) => {
  const headers = { 'content-type': 'application/json', ...h };
  if (token) headers.authorization = 'Bearer ' + token;
  const r = await fetch(BASE + path, { method, headers, body: body ? JSON.stringify(body) : undefined });
  let j = null; try { j = await r.json(); } catch {}
  return { status: r.status, body: j };
};
const sql = (s) => execSync(`psql "${process.env.DATABASE_URL}" -tAc "${s}"`).toString().trim();
const login = async (email, password) => (await call('POST', '/api/auth/login', { body: { email, password } })).body.token;
const A = await login('demo@demo.com', 'demo1234');
const adm = (m, p, b) => call(m, '/api' + p, { token: A, body: b });

// limpeza de rodadas anteriores
sql("delete from public.program_partnerships; delete from public.users where email like 'parc-%@x.com'; delete from public.companies where name like 'Parceira %'");
sql("update public.companies set modules = coalesce(modules,'{}'::jsonb) || jsonb_build_object('clube', true, 'casa_de_shows', true) where id=1");
sql("set search_path to company_1, public; delete from customers where phone like '%32966660001' or phone like '%3266660002'");

const mk = async (nome, email) => (await adm('POST', '/admin/companies', { name: nome, owner_name: 'Dono ' + nome, email, password: 'senha1234', modules: { clube: true, casa_de_shows: true } })).body;
const b = await mk('Parceira B', 'parc-b@x.com');
const c = await mk('Parceira C', 'parc-c@x.com');
const semClube = await mk('Parceira D', 'parc-d@x.com');
sql(`update public.companies set modules = jsonb_build_object('clube', false) where id=${semClube.id}`);
const TB = await login('parc-b@x.com', 'senha1234'), TC = await login('parc-c@x.com', 'senha1234'), TD = await login('parc-d@x.com', 'senha1234');
const B = (m, p, body) => call(m, '/api' + p, { token: TB, body });
const C = (m, p, body) => call(m, '/api' + p, { token: TC, body });
const D = (m, p, body) => call(m, '/api' + p, { token: TD, body });
const N8N = { 'x-api-key': process.env.N8N_API_KEY || 'k', 'x-company-id': String(b.id) };

// ---- lista de programas ----
const progs = (await B('GET', '/club/partnerships/programs')).body;
check('lista os programas de outras empresas', progs.some((x) => x.company_id === '1') && progs.some((x) => x.company_id === String(c.id)) && !progs.some((x) => x.company_id === String(b.id)), JSON.stringify(progs.map((x) => x.company_id)));
check('empresa sem programa não aparece', !progs.some((x) => x.company_id === String(semClube.id)));
check('o programa vem com o nome', progs.every((x) => x.program_name));

// ---- proposta ----
check('proposta exige o benefício', (await B('POST', '/club/partnerships', { partner_id: c.id })).status === 400);
check('desconto inválido', (await B('POST', '/club/partnerships', { partner_id: c.id, benefit_text: 'x', discount_percent: 150 })).status === 400);
check('programa inexistente', (await B('POST', '/club/partnerships', { partner_id: semClube.id, benefit_text: 'x' })).status === 404);
check('não propõe a si mesma', (await B('POST', '/club/partnerships', { partner_id: b.id, benefit_text: 'x' })).status === 400);
check('n8n não propõe', (await call('POST', '/n8n/club/partnerships', { headers: N8N, body: { partner_id: c.id, benefit_text: 'x' } })).status === 403);
let p = await B('POST', '/club/partnerships', { partner_id: 1, benefit_text: '10% nos ingressos para quem é do seu programa', discount_percent: 10, companions: 1 });
check('envia a proposta', p.status === 201 && p.body.status === 'pending' && p.body.outgoing === true && p.body.my_offer.discount_percent === 10 && p.body.their_offer === null, JSON.stringify(p.body));
const pid = p.body.id;
check('proposta repetida é recusada', (await B('POST', '/club/partnerships', { partner_id: 1, benefit_text: 'outra' })).status === 409);
check('contrária também', (await adm('POST', '/club/partnerships', { partner_id: b.id, benefit_text: 'outra' })).status === 409);

// ---- quem recebe ----
const rec = (await adm('GET', '/club/partnerships')).body.find((x) => x.id === pid);
check('chega para quem recebe', rec && rec.incoming === true && rec.partner_name === 'Parceira B' && rec.their_offer.benefit_text.includes('10%'), JSON.stringify(rec));
check('outra empresa não vê', !(await C('GET', '/club/partnerships')).body.some((x) => x.id === pid));
check('outra empresa não responde', (await C('POST', `/club/partnerships/${pid}/respond`, { accept: true })).status === 404);
check('quem propôs não responde', (await B('POST', `/club/partnerships/${pid}/respond`, { accept: true })).status === 404);
check('resposta precisa de sim ou não', (await adm('POST', `/club/partnerships/${pid}/respond`, {})).status === 400);
check('benefício em troca inválido', (await adm('POST', `/club/partnerships/${pid}/respond`, { accept: true, benefit_text: 'x', discount_percent: 0 })).status === 400);
check('antes de aceitar nada vale', (await call('GET', '/api/club/partnerships/check?phone=32966660001', { token: TB })).body.length === 0);
// aceita sem oferecer nada em troca
let r = await adm('POST', `/club/partnerships/${pid}/respond`, { accept: true });
check('aceita sem contrapartida', r.status === 200 && r.body.status === 'active' && r.body.my_offer === null && r.body.their_offer, JSON.stringify(r.body));
check('não responde duas vezes', (await adm('POST', `/club/partnerships/${pid}/respond`, { accept: true })).status === 404);

// ---- benefício vale para membro do programa parceiro ----
sql("set search_path to company_1, public; insert into customers (name, phone, status, source, club_status) values ('Membro Parceiro','553266660001','client','manual','member') on conflict (phone) do update set club_status='member'");
let chk = (await B('GET', '/club/partnerships/check?phone=32966660001')).body;
check('membro do parceiro recebe o benefício', chk.length === 1 && chk[0].discount_percent === 10 && chk[0].companions === 1 && chk[0].partner === 'Empresa Demo', JSON.stringify(chk));
check('quem não é membro não recebe', (await B('GET', '/club/partnerships/check?phone=32966660002')).body.length === 0);
check('a consulta do lado de quem não dá benefício vem vazia', (await adm('GET', '/club/partnerships/check?phone=32966660001')).body.length === 0);
check('telefone inválido', (await B('GET', '/club/partnerships/check?phone=12')).status === 400);
check('o agente consulta pela chave', (await call('GET', '/n8n/club/partnerships/check?phone=32966660001', { headers: N8N })).body.length === 1);
sql("set search_path to company_1, public; update customers set club_status='former' where phone='553266660001'");
check('ex-membro perde o benefício', (await B('GET', '/club/partnerships/check?phone=32966660001')).body.length === 0);
sql("set search_path to company_1, public; update customers set club_status='member' where phone='553266660001'");

// ---- desconto na venda de ingresso ----
const ev = (await B('POST', '/events', { title: 'Show Parceria', starts_at: new Date(Date.now() + 10 * 864e5).toISOString() })).body;
await B('PUT', `/casa-de-shows/events/${ev.id}/conditions`, { price: 100 });
const setor = (await B('POST', '/casa-de-shows/sectors', { name: 'Pista Parceria', space: 100 })).body;
await B('POST', '/casa-de-shows/table-types', { name: 'Mesa Parceria', seats: 4, space: 1 });
let pr = (await call('GET', `/api/casa-de-shows/events/${ev.id}/price?phone=32966660001&people=3`, { token: TB })).body;
check('o preço reconhece o membro do programa parceiro', pr.club && pr.club.member === true && pr.club.via && pr.club.via.includes('Empresa Demo'), JSON.stringify(pr.club));
check('desconto para ele e 1 acompanhante', pr.club_discount === 20 && pr.total === 280, JSON.stringify(pr));
pr = (await call('GET', `/api/casa-de-shows/events/${ev.id}/price?phone=32966660002&people=3`, { token: TB })).body;
check('quem não é membro paga cheio', pr.club_discount === 0 && pr.total === 300, JSON.stringify(pr));
const v = (await B('POST', '/casa-de-shows/sales', { event_id: ev.id, sector_id: setor.id, name: 'Comprador', phone: '32966660001', people: 2 })).body;
check('a venda leva o desconto do parceiro', v.club_discount === 20 && v.total === 180, JSON.stringify(v));
// benefício só em texto não vira desconto
const t = (await B('PUT', `/club/partnerships/${pid}/offer`, { benefit_text: 'Brinde na entrada' })).body;
check('muda o próprio benefício', t.my_offer.benefit_text === 'Brinde na entrada' && t.my_offer.discount_percent === null, JSON.stringify(t));
pr = (await call('GET', `/api/casa-de-shows/events/${ev.id}/price?phone=32966660001&people=2`, { token: TB })).body;
check('benefício sem % não desconta', pr.total === 200, JSON.stringify(pr));
await B('PUT', `/club/partnerships/${pid}/offer`, { benefit_text: '10% de volta', discount_percent: 10, companions: 1 });

// ---- contraproposta depois e encerramento ----
const o2 = (await adm('PUT', `/club/partnerships/${pid}/offer`, { benefit_text: '10% nos serviços', discount_percent: 10 })).body;
check('quem aceitou sem nada pode oferecer depois', o2.my_offer && o2.their_offer);
check('outra empresa não mexe na oferta', (await C('PUT', `/club/partnerships/${pid}/offer`, { benefit_text: 'x' })).status === 404);
check('texto do atendente lista a parceria', (await call('GET', '/api/agent/prompt', { token: TB })).body.prompt.includes('PARCERIAS'));
check('encerrar é só de quem participa', (await C('POST', `/club/partnerships/${pid}/end`)).status === 404);
check('encerra a parceria', (await B('POST', `/club/partnerships/${pid}/end`)).status === 200);
check('depois de encerrar nada vale', (await B('GET', '/club/partnerships/check?phone=32966660001')).body.length === 0);
pr = (await call('GET', `/api/casa-de-shows/events/${ev.id}/price?phone=32966660001&people=2`, { token: TB })).body;
check('e o desconto some do preço', pr.total === 200, JSON.stringify(pr));
check('parceria encerrada sai da lista aberta', !(await B('GET', '/club/partnerships/programs')).body.find((x) => x.company_id === '1').partnership);

// ---- recusa e cancelamento ----
p = await C('POST', '/club/partnerships', { partner_id: b.id, benefit_text: 'Proposta de C' });
check('nova proposta depois de encerrar', p.status === 201);
check('quem recebe recusa', (await B('POST', `/club/partnerships/${p.body.id}/respond`, { accept: false })).status === 200);
check('recusada não aparece', !(await B('GET', '/club/partnerships')).body.some((x) => x.id === p.body.id));
p = await C('POST', '/club/partnerships', { partner_id: b.id, benefit_text: 'Outra de C' });
check('quem propôs cancela', (await C('POST', `/club/partnerships/${p.body.id}/end`)).status === 200);
p = await C('POST', '/club/partnerships', { partner_id: b.id, benefit_text: 'Mais uma de C' });
check('quem recebeu não cancela, só recusa', (await B('POST', `/club/partnerships/${p.body.id}/end`)).status === 409);
check('empresa sem programa não propõe a ninguém inexistente', (await D('POST', '/club/partnerships', { partner_id: 999999, benefit_text: 'x' })).status === 404);

// ---- só os assinantes ----
const ms = (await adm('GET', '/club/members')).body;
check('lista só os assinantes', ms.every((x) => x.club_status === 'member') && ms.some((x) => x.phone === '553266660001'), JSON.stringify(ms.length));
check('busca entre os assinantes', (await adm('GET', '/club/members?search=Parceiro')).body.length >= 1 && (await adm('GET', '/club/members?search=zzzzzz')).body.length === 0);

// limpeza
sql("delete from public.program_partnerships; delete from public.users where email like 'parc-%@x.com'; delete from public.companies where name like 'Parceira %'");
sql("set search_path to company_1, public; delete from customers where phone like '%3266660001'");
sql("update public.companies set modules = modules - 'clube' - 'casa_de_shows' where id=1");
console.log(`parcerias: ${ok} ok, ${fail} falhas`);
process.exit(fail ? 1 : 0);
