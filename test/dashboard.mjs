// Dashboard: resumo de atendimentos, pedidos de música, valores recebidos e ingressos. Uso: BASE=http://localhost:3999 node test/dashboard.mjs
import { execFileSync } from 'child_process';
const BASE = process.env.BASE || 'http://localhost:3999';
let ok = 0, fail = 0;
const check = (name, cond, extra = '') => { cond ? ok++ : (fail++, console.log('FALHOU:', name, extra)); };
const login = await (await fetch(BASE + '/api/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: 'demo@demo.com', password: 'demo1234' }) })).json();
const get = async (days) => (await fetch(`${BASE}/api/dashboard?days=${days}`, { headers: { authorization: 'Bearer ' + login.token } })).json();
const d = await get(365);
check('mantém atendimentos e faturamento', Number.isInteger(d.atendimentos) && d.faturamento !== undefined);
check('pedidos de música', d.pedidos && Number.isInteger(d.pedidos.total) && d.pedidos.atendidos <= d.pedidos.total, JSON.stringify(d.pedidos));
check('músicas mais pedidas', Array.isArray(d.musicas) && d.musicas.length <= 10);
check('valores recebidos', d.recebido && typeof d.recebido.total === 'number' && Number.isInteger(d.recebido.aceitos), JSON.stringify(d.recebido));
check('ingressos vendidos', d.ingressos && Number.isInteger(d.ingressos.vendas) && Number.isInteger(d.ingressos.pessoas) && typeof d.ingressos.total === 'number', JSON.stringify(d.ingressos));
const curto = await get(1);
check('período menor não passa do maior', curto.pedidos.total <= d.pedidos.total && curto.recebido.total <= d.recebido.total + 0.001);
// gráfico por dia da semana: o cliente escolhe a métrica e o período
const semana = async (metric, days) => {
  const r = await fetch(`${BASE}/api/dashboard/weekday?metric=${metric}&days=${days}`, { headers: { authorization: 'Bearer ' + login.token } });
  return { status: r.status, ...(await r.json()) };
};
const soma = (s) => s.por_dia_semana.reduce((t, x) => t + x.total, 0);
const dias07 = (s) => s.por_dia_semana.every((x) => Number.isInteger(x.weekday) && x.weekday >= 0 && x.weekday <= 6 && Number.isInteger(x.total));
check('métrica desconhecida é recusada', (await semana('qualquer', 30)).status === 400);
const sAgenda = await semana('agendamentos', 365);
check('agendamentos por dia da semana batem com o total realizado', sAgenda.status === 200 && dias07(sAgenda) && soma(sAgenda) === d.atendimentos, `${soma(sAgenda)} x ${d.atendimentos}`);
const sIng = await semana('ingressos', 365);
check('vendas de ingresso por dia da semana batem com o total de vendas', sIng.status === 200 && dias07(sIng) && soma(sIng) === d.ingressos.vendas, `${soma(sIng)} x ${d.ingressos.vendas}`);
check('período omitido vale 30 dias e o padrão é atendimentos', (await semana('agendamentos', '')).days === 30 && (await fetch(`${BASE}/api/dashboard/weekday`, { headers: { authorization: 'Bearer ' + login.token } }).then((r) => r.json())).metric === 'atendimentos');
check('período muito grande é limitado a 365 dias', (await semana('agendamentos', 99999)).days === 365);
// atendimentos = pessoas que conversaram com o agente (histórico no banco do N8N)
const psql = (sql) => execFileSync('psql', [process.env.DATABASE_URL, '-qAtc', sql]).toString();
const put = async (body) => (await fetch(`${BASE}/api/admin/companies/1/chat-table`, { method: 'PUT', headers: { 'content-type': 'application/json', authorization: 'Bearer ' + login.token }, body: JSON.stringify(body) })).json();
const inst = psql("select coalesce(whatsapp_instance,'') from public.companies where id=1").trim();
psql("update public.companies set whatsapp_instance='zz-inst' where id=1");
psql("drop table if exists public.chat_zz; create table public.chat_zz (id serial primary key, session_id text, message jsonb, created_at timestamptz default now())");
psql(`insert into public.chat_zz (session_id, message, created_at) values
  ('zz-inst 5511111 chats','{"type":"human"}', now()),
  ('zz-inst 5511111 chats','{"type":"ai"}', now()),
  ('zz-inst 5522222 chats','{"type":"human"}', now() - interval '3 days'),
  ('zz-inst 5533333 chats','{"type":"ai"}', now()),
  ('outra-inst 5544444 chats','{"type":"human"}', now()),
  ('zz-inst 5555555 chats','{"type":"human"}', now() - interval '60 days')`);
check('tabela inválida é recusada', (await put({ chat_table: 'chat; drop' })).error !== undefined);
check('sem tabela escolhida não há card de conversas', (await put({ chat_table: '' })).chat_table === null && (await get(30)).conversas === null);
await put({ chat_table: 'chat_zz' });
check('conta quem falou nos últimos 30 dias, só da instância e só mensagens do cliente', (await get(30)).conversas?.total === 2, JSON.stringify((await get(30)).conversas));
check('1 dia: só quem falou hoje', (await get(1)).conversas?.total === 1);
check('365 dias inclui a conversa antiga', (await get(365)).conversas?.total === 3);
// atendimentos por dia da semana (horário de Brasília): mesma regra de quem conta (instância, só mensagens do cliente)
const dow = (intervalo) => Number(psql(`select extract(dow from (now() - interval '${intervalo}') at time zone 'America/Sao_Paulo')::int`).trim());
const hoje = dow('0 days'), tresDias = dow('3 days');
const sAt = await semana('atendimentos', 30);
check('atendimentos por dia da semana: cada pessoa no dia em que falou', sAt.status === 200 && !sAt.indisponivel && soma(sAt) === 2
  && sAt.por_dia_semana.find((x) => x.weekday === hoje)?.total === 1 && sAt.por_dia_semana.find((x) => x.weekday === tresDias)?.total === 1, JSON.stringify(sAt));
check('atendimentos por dia da semana: 1 dia só traz quem falou hoje', soma(await semana('atendimentos', 1)) === 1);
check('atendimentos por dia da semana: 365 dias inclui a conversa antiga', soma(await semana('atendimentos', 365)) === 3);
// tabela com data sem fuso (como o N8N costuma criar): a hora do relógio do banco é convertida para Brasília
psql("drop table if exists public.chat_zz2; create table public.chat_zz2 (id serial primary key, session_id text, message jsonb, created_at timestamp default now())");
psql(`insert into public.chat_zz2 (session_id, message) values ('zz-inst 5566666 chats','{"type":"human"}')`);
await put({ chat_table: 'chat_zz2' });
const sSemFuso = await semana('atendimentos', 7);
check('data sem fuso entra no dia certo da semana', soma(sSemFuso) === 1 && sSemFuso.por_dia_semana[0].weekday === hoje, JSON.stringify(sSemFuso));
psql("drop table if exists public.chat_zz2");
await put({ chat_table: 'chat_zz' });
psql("alter table public.chat_zz drop column created_at");
check('atendimentos por dia da semana: tabela sem data avisa em vez de inventar', (await semana('atendimentos', 30)).indisponivel === true);
check('tabela sem data avisa em vez de inventar número', (await get(30)).conversas?.total === null && (await get(30)).conversas?.motivo === 'sem_data');
await put({ chat_table: 'nao_existe' });
check('tabela inexistente não derruba o dashboard', (await get(30)).conversas?.total === null && (await get(30)).atendimentos !== undefined);
check('atendimentos por dia da semana: tabela inexistente não derruba', (await semana('atendimentos', 30)).indisponivel === true);
await put({ chat_table: '' });
check('atendimentos por dia da semana: sem tabela escolhida avisa que a contagem ainda não começou', (await semana('atendimentos', 30)).indisponivel === true);
psql("drop table if exists public.chat_zz");
psql(`update public.companies set whatsapp_instance=${inst ? `'${inst}'` : 'null'} where id=1`);
console.log(`dashboard: ${ok} ok, ${fail} falhas`);
process.exit(fail ? 1 : 0);
