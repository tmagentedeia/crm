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
psql("delete from company_1.appointments"); psql("delete from company_1.customers where phone like '553298888000%'");
const prof = psql('select id from company_1.professionals where active order by id limit 1');
const serv = psql("select id from company_1.services where kind='service' order by id limit 1");
const cli = (nome, tel) => psql(`insert into company_1.customers (name, phone) values ('${nome}', '${tel}') returning id`).split('\n')[0];
const agenda = (cliente, minutos, status = 'scheduled') => psql(`insert into company_1.appointments (professional_id, customer_id, service_id, starts_at, ends_at, price, source, status, created_at) values (${prof}, ${cliente}, ${serv}, now() + interval '${minutos} minutes', now() + interval '${minutos + 3} minutes', 50, 'manual', '${status}', now() - interval '1 day') returning id`).split('\n')[0];
const enviouPara = (tel) => recebidos.filter((x) => x.url === '/send/text' && x.corpo.number === tel);

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
await espera(1200);
check('não repete o aviso', enviouPara('5532988880001').length === 1);

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
check('depois das tentativas não fica insistindo', psql(`select reminder_sent_at is not null from company_1.appointments where id=${a8}`) === 't');
falhar = false;

psql("update public.companies set wa_api_url=null, wa_api_token=null, reminder_minutes=null, reminder_text=null where id=1");
psql("delete from company_1.appointments"); psql("delete from company_1.customers where phone like '553298888000%'");
fake.close();
console.log(`lembretes: ${ok} ok, ${fail} falhas`);
process.exit(fail ? 1 : 0);
