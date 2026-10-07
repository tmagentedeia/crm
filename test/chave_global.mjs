// Com ALLOW_GLOBAL_KEY=false a chave global deixa de valer nas rotas /n8n: só a chave da empresa vale.
// Roda contra um segundo servidor, iniciado com ALLOW_GLOBAL_KEY=false (ver test/rodar.sh).
const BASE = process.env.BASE || 'http://localhost:3998';
const KEY = process.env.N8N_API_KEY || 'k';
let ok = 0, fail = 0;
const check = (name, cond, extra = '') => { cond ? ok++ : (fail++, console.log('FALHOU:', name, extra)); };
const json = async (method, path, { token, body } = {}) => {
  const r = await fetch(BASE + path, {
    method,
    headers: { 'content-type': 'application/json', ...(token ? { authorization: 'Bearer ' + token } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: r.status, body: await r.json().catch(() => null) };
};
const status = (key, empresa) => fetch(BASE + '/n8n/professionals', {
  headers: { ...(key ? { 'x-api-key': key } : {}), ...(empresa ? { 'x-company-id': String(empresa) } : {}) },
}).then((r) => r.status);

const A = (await json('POST', '/api/auth/login', { body: { email: 'demo@demo.com', password: 'demo1234' } })).body;
const k = (await json('POST', '/api/admin/companies/1/api-key', { token: A.token })).body;
check('chave da empresa gerada', !!k?.api_key, JSON.stringify(k));

check('chave global NÃO vale mais (empresa existente)', (await status(KEY, 1)) === 401);
check('chave global NÃO vale mais (empresa inexistente: 401, não 404)', (await status(KEY, 999)) === 401);
check('chave global sem x-company-id = 401, não 400', (await status(KEY, null)) === 401);
check('chave da empresa continua valendo', (await status(k.api_key, 1)) === 200);
check('chave da empresa 1 não vale na 2', (await status(k.api_key, 2)) === 401);
check('o painel continua funcionando', (await json('GET', '/api/company', { token: A.token })).status === 200);

// espelho com a agenda do Google: a chave global só serve para gravar/limpar o ID do evento
import { execSync } from 'child_process';
const psql = (s) => execSync(`psql "${process.env.DATABASE_URL}" -tAc "${s}"`).toString().trim();
const prof = psql('select id from company_1.professionals order by id limit 1'), serv = psql("select id from company_1.services where kind='service' order by id limit 1");
psql("insert into company_1.customers (name, phone) values ('Espelho Teste','5532977770001') on conflict (phone) do nothing");
const idAp = psql(`insert into company_1.appointments (professional_id, customer_id, service_id, starts_at, ends_at, price, source, status) values (${prof}, (select id from company_1.customers where phone='5532977770001'), ${serv}, now() + interval '3000 minutes', now() + interval '3030 minutes', 10, 'manual', 'scheduled') returning id`).split('\n')[0];
const espelho = (key, empresa, corpo, id = idAp) => fetch(BASE + '/n8n/espelho/appointments/' + id, {
  method: 'PATCH', headers: { 'content-type': 'application/json', ...(key ? { 'x-api-key': key } : {}), ...(empresa ? { 'x-company-id': String(empresa) } : {}) }, body: JSON.stringify(corpo),
}).then(async (r) => ({ status: r.status, body: await r.json().catch(() => null) }));
check('espelho: chave global grava o ID do evento', (await espelho(KEY, 1, { google_event_id: 'evt123' })).status === 200 && psql(`select google_event_id from company_1.appointments where id=${idAp}`) === 'evt123');
check('espelho: ID vazio limpa', (await espelho(KEY, 1, { google_event_id: '' })).status === 200 && psql(`select coalesce(google_event_id,'-') from company_1.appointments where id=${idAp}`) === '-');
check('espelho: sem chave = 401', (await espelho(null, 1, { google_event_id: 'x' })).status === 401);
check('espelho: chave da empresa não vale aqui (só a do aviso)', (await espelho(k.api_key, 1, { google_event_id: 'x' })).status === 401);
check('espelho: empresa inexistente = 401', (await espelho(KEY, 999, { google_event_id: 'x' })).status === 401);
check('espelho: agendamento de outra empresa não é alterado (404)', (await espelho(KEY, 2, { google_event_id: 'x' })).status === 404);
check('espelho: corpo inválido = 400', (await espelho(KEY, 1, { nome: 'x' })).status === 400);
check('espelho: a chave global continua sem valer nas outras rotas', (await status(KEY, 1)) === 401);
psql(`delete from company_1.appointments where id=${idAp}`); psql("delete from company_1.customers where phone='5532977770001'");

console.log(`\n${ok} ok, ${fail} falhas`);
process.exit(fail ? 1 : 0);
