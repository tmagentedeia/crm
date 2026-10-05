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
psql("alter table public.chat_zz drop column created_at");
check('tabela sem data avisa em vez de inventar número', (await get(30)).conversas?.total === null && (await get(30)).conversas?.motivo === 'sem_data');
await put({ chat_table: 'nao_existe' });
check('tabela inexistente não derruba o dashboard', (await get(30)).conversas?.total === null && (await get(30)).atendimentos !== undefined);
await put({ chat_table: '' });
psql("drop table if exists public.chat_zz");
psql(`update public.companies set whatsapp_instance=${inst ? `'${inst}'` : 'null'} where id=1`);
console.log(`dashboard: ${ok} ok, ${fail} falhas`);
process.exit(fail ? 1 : 0);
