// Campanha enviada pelo painel entra na memória do atendente com a marca de mensagem do responsável; lembrete não.
// Uso: DATABASE_URL=... N8N_DATABASE_URL=... node test/campanhas_memoria.mjs
import { execSync } from 'child_process';
let ok = 0, fail = 0;
const check = (name, cond, extra = '') => { cond ? ok++ : (fail++, console.log('FALHOU:', name, extra)); };
const psql = (sql) => execSync(`psql "${process.env.DATABASE_URL}" -tA`, { input: sql }).toString().trim();
const { gravarNaConversa, MARCA_RESPONSAVEL } = await import('../src/campaigns.js');

check('a marca é a mesma que o fluxo usa nas mensagens digitadas', MARCA_RESPONSAVEL === '[MENSAGEM PRIORITÁRIA digitada pelo ADM]');
psql("drop table if exists chat_marca_teste; create table chat_marca_teste (id serial primary key, session_id text not null, message jsonb not null)");
const orig = psql("select coalesce(chat_table,'')||'|'||coalesce(whatsapp_instance,'') from public.companies where id=1");
psql("update public.companies set chat_table='chat_marca_teste', whatsapp_instance='demo-marca' where id=1");

const c1 = await gravarNaConversa(1, { phone: '5532988887771', text: 'Oi Rita! Tem Baile do Miranda sábado.' }, null, { comoResponsavel: true });
const c2 = await gravarNaConversa(1, { phone: '5532988887772', text: 'Lembrete: amanhã às 10h.' }, null);
const txt = (tel) => psql(`select message->>'content' from chat_marca_teste where session_id='demo-marca ${tel} chats'`);
check('campanha gravada', c1 === true && c2 === true);
check('campanha entra com a marca do responsável antes do texto', txt('5532988887771') === '[MENSAGEM PRIORITÁRIA digitada pelo ADM] Oi Rita! Tem Baile do Miranda sábado.', txt('5532988887771'));
check('campanha continua como mensagem do atendente (tipo ai)', psql("select message->>'type' from chat_marca_teste where session_id='demo-marca 5532988887771 chats'") === 'ai');
check('lembrete e outras mensagens do painel entram sem marca', txt('5532988887772') === 'Lembrete: amanhã às 10h.', txt('5532988887772'));

psql("drop table chat_marca_teste");
const [t, i] = orig.split('|');
psql(`update public.companies set chat_table=${t ? `'${t}'` : 'null'}, whatsapp_instance=${i ? `'${i}'` : 'null'} where id=1`);
console.log(`${ok} ok, ${fail} falhas`);
process.exit(fail ? 1 : 0);
