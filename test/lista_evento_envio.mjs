// Envio da lista pelo WhatsApp (servidor falso no lugar do serviço). Uso: BASE=http://localhost:3999 node test/lista_evento_envio.mjs
// O servidor da API precisa estar de pé com LISTA_PAUSA_RAPIDA=1.
import http from 'http';
import { execSync } from 'child_process';
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
const psql = (sql) => execSync(`psql "${process.env.DATABASE_URL}" -tAc "${sql}"`).toString().trim();

const recebidos = []; let falharMedia = false;
const fake = http.createServer((req, res) => {
  let d = ''; req.on('data', (c) => d += c); req.on('end', () => {
    const corpo = JSON.parse(d || '{}');
    recebidos.push({ url: req.url, token: req.headers.token, corpo });
    if (req.url === '/send/media' && falharMedia) { res.statusCode = 404; return res.end('{}'); }
    res.setHeader('content-type', 'application/json'); res.end('{"ok":true}');
  });
});
await new Promise((r) => fake.listen(0, '127.0.0.1', r));
const porta = fake.address().port;

psql("delete from company_1.shows_list_dispatch; delete from company_1.shows_list_settings; delete from company_1.shows_attendee_log; delete from company_1.shows_attendees; delete from company_1.shows_sale_payments; delete from company_1.shows_sales where sector_id in (select id from company_1.shows_sectors where name='Setor Envio'); delete from company_1.shows_sectors where name='Setor Envio'; delete from company_1.shows_table_types where name='Mesa Envio'; delete from company_1.events where title like 'Show Envio%'");
const A = (await call('POST', '/api/auth/login', { body: { email: 'demo@demo.com', password: 'demo1234' } })).body;
const api = (m, p, body) => call(m, '/api' + p, { token: A.token, body });
const antes = psql("select coalesce(phone,'')||'|'||coalesce(admin_phone,'') from public.companies where id=1");

const ev = (await api('POST', '/events', { title: 'Show Envio', starts_at: new Date(Date.now() + 2 * 864e5).toISOString() })).body;
const setor = (await api('POST', '/casa-de-shows/sectors', { name: 'Setor Envio', space: 50 })).body;
const mesa = (await api('POST', '/casa-de-shows/table-types', { name: 'Mesa Envio', seats: 4, space: 2 })).body;
await api('POST', '/casa-de-shows/sales', { event_id: ev.id, sector_id: setor.id, table_type_id: mesa.id, name: 'Ana', phone: '32988870001', people: 2, unit_price: 100 });

// sem conexão liberada e sem administrador cadastrado
psql("update public.companies set wa_api_url=null, wa_api_token=null, admin_phone=null, phone=null where id=1");
let r = await api('POST', '/event-list/send-now', { event_id: ev.id });
check('sem conexão → 409', r.status === 409, JSON.stringify(r.body));

// cadastro do administrador pelas Configurações
r = await api('PUT', '/company', { admin_name: 'Thiago', admin_phone: '(32) 99113-5799', admin_email: 'thiago@x.com' });
check('salva dados do administrador', r.status === 200 && r.body.admin_name === 'Thiago' && r.body.admin_phone === '(32) 99113-5799' && r.body.admin_email === 'thiago@x.com', JSON.stringify(r.body));
r = await api('PUT', '/company', { admin_email: 'invalido' });
check('e-mail inválido recusado', r.status === 400);
r = await api('PUT', '/company', { name: 'Demo' });
check('outros campos não apagam o administrador', (await api('GET', '/company')).body.admin_name === 'Thiago');

psql(`update public.companies set wa_api_url='http://127.0.0.1:${porta}/', wa_api_token='chave-teste' where id=1`);
r = await api('GET', '/event-list-settings');
check('padrão: ligado, vai ao administrador', r.body.enabled === true && r.body.admin_phone === '553291135799' && r.body.recipients === 1 && r.body.connected === true, JSON.stringify(r.body));

r = await api('POST', '/event-list/send-now', { event_id: ev.id });
check('envio agora ok', r.status === 200 && r.body.recipients === 1 && r.body.spreadsheet === true, JSON.stringify(r.body));
check('texto e planilha ao administrador (com o 9)', recebidos.length === 2 && recebidos[0].url === '/send/text' && recebidos[1].url === '/send/media' && recebidos.every((x) => x.token === 'chave-teste' && x.corpo.number === '5532991135799'), JSON.stringify(recebidos.map((x) => [x.url, x.corpo.number])));
check('texto cita evento', /Show Envio/.test(recebidos[0].corpo.text));
check('planilha com a Ana', Buffer.from(recebidos[1].corpo.file, 'base64').toString().includes('Ana'));

// outras pessoas
r = await api('PUT', '/event-list-settings', { enabled: true, phones: ['32 98888-7777', '32 98888-7777'] });
check('salva extras (sem repetir)', r.status === 200 && r.body.phones.length === 1, JSON.stringify(r.body));
r = await api('PUT', '/event-list-settings', { enabled: true, phones: ['123'] });
check('telefone inválido recusado', r.status === 400);
recebidos.length = 0;
r = await api('POST', '/event-list/send-now', { event_id: ev.id });
check('dois destinatários', r.body.recipients === 2 && recebidos.filter((x) => x.url === '/send/media').length === 2 && new Set(recebidos.map((x) => x.corpo.number)).size === 2, JSON.stringify(recebidos.map((x) => x.corpo.number)));

// escolher só o telefone da empresa
psql("update public.companies set phone='32 97777-6666' where id=1");
await api('PUT', '/event-list-settings', { enabled: true, to_admin: false, to_company: true, phones: [] });
recebidos.length = 0;
r = await api('POST', '/event-list/send-now', { event_id: ev.id });
check('só telefone da empresa', r.body.recipients === 1 && recebidos.every((x) => x.corpo.number === '5532977776666'), JSON.stringify(recebidos.map((x) => x.corpo.number)));
await api('PUT', '/event-list-settings', { enabled: true, to_admin: true, to_company: true, phones: [] });
r = await api('GET', '/event-list-settings');
check('ambos', r.body.recipients === 2 && r.body.to_admin && r.body.to_company, JSON.stringify(r.body));
await api('PUT', '/event-list-settings', { enabled: true, to_admin: false, to_company: false, phones: [] });
r = await api('POST', '/event-list/send-now', { event_id: ev.id });
check('ninguém marcado → 409', r.status === 409, JSON.stringify(r.body));
await api('PUT', '/event-list-settings', { enabled: true, to_admin: true, to_company: false, phones: ['32 98888-7777', '32 98888-7777'] });
recebidos.length = 0;

// servidor sem /send/media → manda em texto
falharMedia = true; recebidos.length = 0;
r = await api('POST', '/event-list/send-now', { event_id: ev.id });
check('sem planilha cai para texto', r.status === 200 && r.body.spreadsheet === false && recebidos.some((x) => x.url === '/send/text' && /Ana/.test(x.corpo.text)), JSON.stringify(r.body));
falharMedia = false;

// só o telefone da empresa, se não houver administrador
psql("update public.companies set admin_phone=null, phone='32 97777-6666' where id=1");
r = await api('GET', '/event-list-settings');
check('sem administrador usa telefone da empresa', r.body.admin_phone === '553277776666', JSON.stringify(r.body));

// automático: casa aberta há pouco → envia uma vez só (o agendador roda a cada minuto)
psql("update public.companies set admin_phone='32991135799' where id=1");
await api('PUT', '/event-list-settings', { enabled: true, phones: [] });
psql(`update company_1.events set doors_at = now() - interval '1 minute', starts_at = now() + interval '1 hour' where id=${ev.id}`);
recebidos.length = 0;
let enviado = '';
for (let i = 0; i < 80 && !enviado; i++) { await new Promise((r) => setTimeout(r, 1500)); enviado = psql(`select ok from company_1.shows_list_dispatch where event_id=${ev.id}`); }
check('agendador enviou', enviado === 't', 'dispatch=' + enviado);
const n = recebidos.length;
await new Promise((r) => setTimeout(r, 65000));
check('não repete o envio', recebidos.length === n && n === 2, String(recebidos.length));

// desligado não envia
psql(`delete from company_1.shows_list_dispatch`);
await api('PUT', '/event-list-settings', { enabled: false, phones: [] });
recebidos.length = 0;
await new Promise((r) => setTimeout(r, 65000));
check('desligado não envia', recebidos.length === 0);

// limpeza
const [tel, adm] = antes.split('|');
psql(`update public.companies set wa_api_url=null, wa_api_token=null, phone=nullif('${tel}',''), admin_phone=nullif('${adm}',''), admin_name=null, admin_email=null where id=1`);
psql("delete from company_1.shows_list_dispatch; delete from company_1.shows_list_settings; delete from company_1.shows_attendee_log; delete from company_1.shows_attendees; delete from company_1.shows_sale_payments; delete from company_1.shows_sales where sector_id in (select id from company_1.shows_sectors where name='Setor Envio')");
await api('DELETE', `/casa-de-shows/sectors/${setor.id}`); await api('DELETE', `/casa-de-shows/table-types/${mesa.id}`); await api('DELETE', '/events/' + ev.id);
fake.close();
console.log(`${ok} ok, ${fail} falhas`);
process.exit(fail ? 1 : 0);
