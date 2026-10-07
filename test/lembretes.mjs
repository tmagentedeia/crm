// Lembrete de agendamento enviado pelo painel (servidor falso no lugar do WhatsApp).
// Uso: BASE=http://localhost:3999 node test/lembretes.mjs   (servidor com LEMBRETE_TICK_MS=300 LISTA_PAUSA_RAPIDA=1)
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
const psql = (sql) => execSync(`psql "${process.env.DATABASE_URL}" -tAc "${sql.replace(/"/g, '\\"')}"`).toString().trim();
const espera = (ms) => new Promise((r) => setTimeout(r, ms));

const recebidos = []; let falhar = false;
const fake = http.createServer((req, res) => {
  let d = ''; req.on('data', (c) => d += c); req.on('end', () => {
    recebidos.push({ url: req.url, token: req.headers.token, corpo: JSON.parse(d || '{}') });
    if (falhar) { res.statusCode = 500; return res.end('{}'); }
    res.setHeader('content-type', 'application/json'); res.end('{"ok":true}');
  });
});
await new Promise((r) => fake.listen(0, '127.0.0.1', r));
const porta = fake.address().port;

const A = (await call('POST', '/api/auth/login', { body: { email: 'demo@demo.com', password: 'demo1234' } })).body;
const api = (m, p, body) => call(m, '/api' + p, { token: A.token, body });
psql("delete from company_1.appointment_reminders; delete from company_1.appointments"); psql("delete from company_1.customers where phone like '55329888800%'");
const prof = psql('select id from company_1.professionals where active order by id limit 1');
const serv = psql("select id from company_1.services where kind='service' order by id limit 1");
const cli = (nome, tel) => psql(`insert into company_1.customers (name, phone) values ('${nome}', '${tel}') returning id`).split('\n')[0];
const agenda = (cliente, minutos, status = 'scheduled') => psql(`insert into company_1.appointments (professional_id, customer_id, service_id, starts_at, ends_at, price, source, status, created_at) values (${prof}, ${cliente}, ${serv}, now() + interval '${minutos} minutes', now() + interval '${minutos + 3} minutes', 50, 'manual', '${status}', now() - interval '1 day') returning id`).split('\n')[0];
const enviouPara = (tel) => recebidos.filter((x) => x.url === '/send/text' && x.corpo.number === tel);

// histórico da conversa do atendente (tabela de teste no mesmo banco)
psql("drop table if exists chat_lembrete_teste; create table chat_lembrete_teste (id serial primary key, session_id text not null, message jsonb not null)");
const instOrig = psql("select coalesce(whatsapp_instance,'') from public.companies where id=1");
psql("update public.companies set chat_table='chat_lembrete_teste', whatsapp_instance='demo-lembrete' where id=1");

// desligado e sem conexão: nada sai
const c1 = cli('Maria Souza', '5532988880001'); const a1 = agenda(c1, 120);
psql("update public.companies set wa_api_url=null, wa_api_token=null, reminder_minutes=120, reminder_text=null where id=1");
await espera(1200);
check('sem conexão do WhatsApp: nada é enviado', recebidos.length === 0 && psql(`select reminder_sent_at is null from company_1.appointments where id=${a1}`) === 't');

// com conexão: envia uma vez, com a mensagem padrão
psql(`update public.companies set wa_api_url='http://127.0.0.1:${porta}/', wa_api_token='chave-lembrete' where id=1`);
await espera(1800);
let m = enviouPara('5532988880001');
check('lembrete enviado ao cliente', m.length === 1 && m[0].token === 'chave-lembrete', JSON.stringify(recebidos));
check('mensagem padrão com nome, dia e hora', m[0] && /Maria/.test(m[0].corpo.text) && /hoje|amanhã|dia \d\d\/\d\d/.test(m[0].corpo.text) && /\d\dh\d\d/.test(m[0].corpo.text) && !/\{/.test(m[0].corpo.text), m[0]?.corpo.text);
check('marca o agendamento como avisado', psql(`select reminder_sent_at is not null from company_1.appointments where id=${a1}`) === 't');
check('lembrete registrado como enviado, com o texto', psql(`select status||'|'||left(coalesce(sent_text,''),4) from company_1.appointment_reminders where appointment_id=${a1}`) === 'sent|Olá,');
await espera(1200);
check('a mensagem entrou no histórico da conversa do atendente', Number(psql("select count(*) from chat_lembrete_teste where session_id='demo-lembrete 5532988880001 chats' and message->>'type'='ai' and message->>'content' like 'Olá, Maria%'")) === 1);
check('lembrete registra que gravou na memória', psql(`select memory_saved from company_1.appointment_reminders where appointment_id=${a1}`) === 't');
check('não repete o aviso', enviouPara('5532988880001').length === 1);

// lista de agendados e enviados, edição individual
const c9 = cli('Edita Prado', '5532988880009'); const a9 = agenda(c9, 410);
const c10 = cli('Cancela Neves', '5532988880010'); agenda(c10, 420);
const c11 = cli('Lote Rocha', '5532988880011'); agenda(c11, 430);
const c12 = cli('Lote Duarte', '5532988880012'); agenda(c12, 440);
let lst = (await api('GET', '/reminders')).body;
check('lista traz o que está agendado', lst.enabled === true && lst.connected === true && lst.scheduled.length === 4 && lst.scheduled.every((x) => /^Olá, /.test(x.preview)), JSON.stringify(lst.scheduled.map((x) => x.customer_name)));
check('lista traz o que já foi enviado, com o texto', lst.history.some((x) => x.status === 'sent' && x.customer_name === 'Maria Souza' && /Maria/.test(x.sent_text)));
const idDe = (nome) => lst.scheduled.find((x) => x.customer_name === nome)?.id;
check('edita o texto de um cliente só', (await api('PUT', `/reminders/${idDe('Edita Prado')}`, { text: 'Oi {nome}, nos vemos {dia} às {hora}!' })).status === 200);
lst = (await api('GET', '/reminders')).body;
check('prévia mostra o texto editado', /^Oi Edita, nos vemos/.test(lst.scheduled.find((x) => x.customer_name === 'Edita Prado').preview) && lst.scheduled.find((x) => x.customer_name === 'Edita Prado').custom === true);
check('os outros continuam com o texto da empresa', /^Olá, Cancela/.test(lst.scheduled.find((x) => x.customer_name === 'Cancela Neves').preview));
check('texto grande demais é recusado', (await api('PUT', `/reminders/${idDe('Edita Prado')}`, { text: 'x'.repeat(801) })).status === 400);
check('cancela o aviso de um cliente', (await api('POST', `/reminders/${idDe('Cancela Neves')}/cancel`)).status === 200);
check('cancelar de novo é recusado', (await api('POST', `/reminders/${idDe('Cancela Neves')}/cancel`)).status === 409);
check('enviar agora', (await api('POST', `/reminders/${idDe('Edita Prado')}/send`)).status === 200);
m = enviouPara('5532988880009');
check('saiu com o texto editado, antes da hora', m.length === 1 && /^Oi Edita, nos vemos/.test(m[0].corpo.text), m[0]?.corpo.text);
lst = (await api('GET', '/reminders')).body;
check('cancelado e enviado vão para o histórico', lst.history.some((x) => x.customer_name === 'Cancela Neves' && x.status === 'cancelled') && lst.history.some((x) => x.customer_name === 'Edita Prado' && x.status === 'sent') && lst.scheduled.length === 2);
check('cancela vários de uma vez', (await api('POST', '/reminders/bulk-cancel', { ids: lst.scheduled.map((x) => x.id) })).body.cancelled === 2);
lst = (await api('GET', '/reminders')).body;
check('nenhum agendado sobrou', lst.scheduled.length === 0);
const antigos = lst.history.filter((x) => x.status === 'cancelled').map((x) => x.id);
check('limpa o histórico (simulação)', (await api('POST', '/reminders/bulk-delete', { ids: antigos, dry_run: true })).body.found === antigos.length);
check('limpa o histórico', (await api('POST', '/reminders/bulk-delete', { ids: antigos })).body.deleted === antigos.length);
check('não apaga o que ainda vai ser enviado', (await api('POST', '/reminders/bulk-delete', { ids: [] })).status === 400);
psql("delete from company_1.appointments where starts_at > now() + interval '300 minutes'");

// mensagem personalizada
await api('PUT', '/company', { reminder_text: '{nome}, te esperamos {dia} às {hora} na {empresa}!' });
check('mensagem personalizada fica salva', (await api('GET', '/company')).body.reminder_text === '{nome}, te esperamos {dia} às {hora} na {empresa}!');
check('mensagem grande demais é recusada', (await api('PUT', '/company', { reminder_text: 'x'.repeat(801) })).status === 400);
const c2 = cli('Joana Lima', '5532988880002'); agenda(c2, 95);
await espera(1800);
m = enviouPara('5532988880002');
check('usa a mensagem personalizada', m.length === 1 && /^Joana, te esperamos .* às \d\dh\d\d na /.test(m[0].corpo.text), m[0]?.corpo.text);

// quem não deve receber
const c3 = cli('Recente Silva', '5532988880003');
psql(`insert into company_1.appointments (professional_id, customer_id, service_id, starts_at, ends_at, price, source, status, created_at) values (${prof}, ${c3}, ${serv}, now() + interval '99 minutes', now() + interval '102 minutes', 50, 'manual', 'scheduled', now())`);
const c4 = cli('Cancelado Souza', '5532988880004'); agenda(c4, 103, 'cancelled');
const c5 = cli('Longe Costa', '5532988880005'); agenda(c5, 600);
const c6 = cli('Aguardando Reis', '5532988880006'); agenda(c6, 107, 'pending');
await espera(1500);
check('quem acabou de marcar não recebe', enviouPara('5532988880003').length === 0);
check('cancelado não recebe', enviouPara('5532988880004').length === 0);
check('horário distante não recebe agora', enviouPara('5532988880005').length === 0);
check('aguardando confirmação não recebe', enviouPara('5532988880006').length === 0);

// lembrete desligado
await api('PUT', '/company', { reminder_minutes: null });
const c7 = cli('Desligado Dias', '5532988880007'); agenda(c7, 111);
await espera(1200);
check('lembrete desligado: nada sai', enviouPara('5532988880007').length === 0);
await api('PUT', '/company', { reminder_minutes: 120 });

// o WhatsApp falha: tenta de novo, no máximo 3 vezes
falhar = true;
const c8 = cli('Falha Alves', '5532988880008'); const a8 = agenda(c8, 115);
await espera(3000);
check('falha: tenta no máximo 3 vezes', enviouPara('5532988880008').length === 3, String(enviouPara('5532988880008').length));
check('depois das tentativas fica como não enviado, com o motivo', psql(`select status||'|'||coalesce(note,'') from company_1.appointment_reminders where appointment_id=${a8}`).startsWith('failed|'));
falhar = false;

// corrigir o horário de um agendamento (fica registrado; lembrete e aviso ao cliente acompanham)
const cE = cli('Edita Lima', '5532988880020'); const aE = agenda(cE, 777);
await espera(1500);
const alvo = new Date(Date.now() + 1111 * 60000).toISOString();
const antes = psql(`select extract(epoch from (ends_at - starts_at)) from company_1.appointments where id=${aE}`);
let ed = await api('POST', `/appointments/${aE}/edit`, { starts_at: alvo, notify: true });
check('editar horário responde 200', ed.status === 200, JSON.stringify(ed.body));
check('horário novo gravado e duração mantida', psql(`select (abs(extract(epoch from (starts_at - '${alvo}'::timestamptz))) < 1) and extract(epoch from (ends_at - starts_at)) = ${antes} from company_1.appointments where id=${aE}`) === 't');
const hist = await api('GET', `/appointments/${aE}/edits`);
check('histórico guarda quem, de e para', hist.body?.length === 1 && hist.body[0].edited_by && hist.body[0].notified === true, JSON.stringify(hist.body));
check('lista de agendamentos informa quantas vezes foi alterado', (await api('GET', '/appointments?from=' + new Date().toISOString())).body.find((x) => String(x.id) === aE)?.edits === 1);
check('lembrete ainda não enviado acompanha o novo horário', psql(`select abs(extract(epoch from (starts_at - '${alvo}'::timestamptz))) < 1 and abs(extract(epoch from (send_at - ('${alvo}'::timestamptz - interval '120 minutes')))) < 1 from company_1.appointment_reminders where appointment_id=${aE}`) === 't');
const av = enviouPara('5532988880020').filter((x) => /alterado/.test(x.corpo.text));
check('cliente avisado da mudança', av.length === 1 && /Edita/.test(av[0].corpo.text) && !/\{/.test(av[0].corpo.text), JSON.stringify(av));
await espera(1000);
check('o aviso entrou no histórico da conversa', Number(psql("select count(*) from chat_lembrete_teste where message->>'content' like '%foi alterado%'")) === 1);
ed = await api('POST', `/appointments/${aE}/edit`, { starts_at: new Date(Date.now() + 1222 * 60000).toISOString() });
check('sem pedir aviso, o cliente não recebe mensagem', ed.status === 200 && ed.body.notified === false && enviouPara('5532988880020').filter((x) => /alterado/.test(x.corpo.text)).length === 1);
const cF = cli('Outro Cliente', '5532988880021'); const aF = agenda(cF, 2000);
ed = await api('POST', `/appointments/${aF}/edit`, { starts_at: new Date(Date.now() + 1222 * 60000).toISOString() });
check('horário já ocupado: recusa (409)', ed.status === 409, JSON.stringify(ed.body));
psql(`update company_1.appointments set status='cancelled' where id=${aF}`);
ed = await api('POST', `/appointments/${aF}/edit`, { starts_at: new Date(Date.now() + 3000 * 60000).toISOString() });
check('agendamento cancelado não pode ser alterado', ed.status === 409, JSON.stringify(ed.body));
check('data inválida: 400', (await api('POST', `/appointments/${aE}/edit`, { starts_at: 'xx' })).status === 400);

psql(`update public.companies set wa_api_url=null, wa_api_token=null, reminder_minutes=null, reminder_text=null, chat_table=null, whatsapp_instance='${instOrig}' where id=1`);
psql("drop table if exists chat_lembrete_teste");
psql("delete from company_1.appointment_reminders; delete from company_1.appointments"); psql("delete from company_1.customers where phone like '55329888800%'");
fake.close();
console.log(`lembretes: ${ok} ok, ${fail} falhas`);
process.exit(fail ? 1 : 0);
