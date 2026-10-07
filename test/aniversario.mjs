// Campanha automática de aniversariantes. Uso: BASE=http://localhost:3999 node test/aniversario.mjs
import { execSync } from 'child_process';
import { alvos } from '../src/aniversario.js';
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
const psql = (sql) => execSync(`psql "${process.env.DATABASE_URL}" -tAc "${sql}"`).toString().trim();
const A = (await call('POST', '/api/auth/login', { body: { email: 'demo@demo.com', password: 'demo1234' } })).body;
const N8N = { 'x-api-key': process.env.N8N_API_KEY || 'k', 'x-company-id': '1' };

// datas-alvo: janela de 3 dias terminando em N; 29/02 comemora em 28/02 nos anos sem bissexto
const al = alvos('2027-02-10', 18);
check('janela de 3 datas', al.length === 4 && al[0].d === 26 && al[2].m === 2, JSON.stringify(al)); // 28/02 de 2027 + 29/02 (ano comum)
check('29/02 em ano comum entra em 28/02', al.some((x) => x.m === 2 && x.d === 29));
check('29/02 em ano bissexto não duplica', alvos('2028-02-10', 19).filter((x) => x.m === 2 && x.d === 29).length === 1 && alvos('2028-02-10', 18).length === 3);

// horário comercial para o envio valer a qualquer hora
const off = (12 - new Date().getUTCHours() + 24) % 24;
const tz = off <= 12 ? `Etc/GMT-${off}` : `Etc/GMT+${24 - off}`;
psql(`update public.companies set timezone='${tz}' where id=1`);
const hoje = (dias) => psql(`select to_char((now() at time zone '${tz}')::date + ${dias}, 'DD/MM')`).split('/').map(Number); // [dia, mês]
const novo = async (name, phone, status, dias, extra = {}) => {
  const [d, m] = hoje(dias);
  const c = (await call('POST', '/api/customers', { token: A.token, body: { name, phone, ...extra } })).body;
  psql(`update company_1.customers set birth_day=${d}, birth_month=${m} where id=${c.id}`);
  if (status === 'client') psql(`update company_1.customers set status='client' where id=${c.id}`);
  return Number(c.id);
};
for (const c of (await call('GET', '/api/campaigns', { token: A.token })).body) {
  if (['running', 'paused'].includes(c.status)) await call('POST', `/api/campaigns/${c.id}/stop`, { token: A.token });
  await call('DELETE', `/api/campaigns/${c.id}`, { token: A.token });
}
psql('delete from company_1.campaign_recipients; delete from company_1.birthday_sends');
const cA = await novo('Aniv Cliente', '32990003001', 'client', 15);
const cB = await novo('Aniv Lead', '32990003002', 'lead', 15);
const cC = await novo('Aniv Longe', '32990003003', 'client', 40);
const cD = await novo('Aniv Excecao', '32990003004', 'client', 15);
await call('POST', '/api/campaigns/exclusions', { token: A.token, body: { phones: '32990003004' } });

// configuração
const g = (await call('GET', '/api/campaigns/birthday', { token: A.token })).body;
check('começa desligada, com 15 dias e texto padrão', g.enabled === false && g.days_ahead === 15 && g.messages.length === 3 && g.audience === 'clients', JSON.stringify(g));
const base = { enabled: true, days_ahead: 15, audience: 'clients', daily_limit: 20, messages: g.messages, accept: true };
check('exige o aviso para ligar', (await call('PUT', '/api/campaigns/birthday', { token: A.token, body: { ...base, accept: false } })).status === 400);
check('texto sem frase de saída recusado', (await call('PUT', '/api/campaigns/birthday', { token: A.token, body: { ...base, messages: ['a', 'b', 'c'] } })).status === 400);
check('link recusado', (await call('PUT', '/api/campaigns/birthday', { token: A.token, body: { ...base, messages: g.messages.map((m) => 'Veja www.site.com ' + m) } })).status === 400);
check('limite acima do máximo recusado', (await call('PUT', '/api/campaigns/birthday', { token: A.token, body: { ...base, daily_limit: 500 } })).status === 400);
check('dias fora da faixa recusado', (await call('PUT', '/api/campaigns/birthday', { token: A.token, body: { ...base, days_ahead: 1 } })).status === 400);

const on = await call('PUT', '/api/campaigns/birthday', { token: A.token, body: base });
check('liga', on.status === 200 && on.body.enabled === true && on.body.campanha?.status === 'running', JSON.stringify(on.body));
check('só o cliente com aniversário em 15 dias entra na fila', on.body.campanha.na_fila === 1, String(on.body.campanha?.na_fila));
const fila = psql('select phone from company_1.campaign_recipients').split('\n');
check('é o contato certo (lead, longe e exceção ficam de fora)', fila.length === 1 && fila[0].endsWith('90003001'), fila.join(','));
check('registra o ano', psql(`select count(*) from company_1.birthday_sends where customer_id=${cA}`) === '1');
const lista = (await call('GET', '/api/campaigns', { token: A.token })).body;
check('não aparece na lista de campanhas', !lista.some((c) => c.name === 'Aniversariantes'));

// segundo dia/nova rodada: não repete a mesma pessoa no mesmo ano
psql('update company_1.birthday_settings set last_run=null');
await call('PUT', '/api/campaigns/birthday', { token: A.token, body: { ...base, accept: false } });
check('uma vez por ano por pessoa', psql('select count(*) from company_1.campaign_recipients') === '1' && psql(`select count(*) from company_1.birthday_sends where customer_id=${cA}`) === '1');

// audiência "todos" inclui o lead
psql('update company_1.birthday_settings set last_run=null');
const todos = await call('PUT', '/api/campaigns/birthday', { token: A.token, body: { ...base, audience: 'all' } });
check('audiência "todos" inclui o lead', todos.body.campanha.na_fila === 2, JSON.stringify(todos.body.campanha));

// envio pelo motor das campanhas
const cl = await call('POST', '/n8n/campaigns/claim', { headers: N8N });
check('envio sai com saudação, nome e frase de saída', cl.body && /^\S+ Aniv/.test(cl.body.text || '') && /(tá|ok|tudo bem)\s*\?$/i.test(cl.body.text), JSON.stringify(cl.body));
check('segundo envio não sai colado', (await call('POST', '/n8n/campaigns/claim', { headers: N8N })).body === null);
if (cl.body?.recipient_id) await call('POST', `/n8n/campaigns/recipients/${cl.body.recipient_id}/report`, { headers: N8N, body: { ok: true } });

// uma campanha comum pode ser iniciada com a de aniversariantes ligada, e a permanente não pode ser parada pela lista
const cm = await call('POST', '/api/campaigns', { token: A.token, body: { name: 'Comum', messages: ['Olá {nome}, novidades! Se não quiser mais receber, é só avisar, tá?', 'Oi {nome}, novidades. Se preferir não receber, me avisa, ok?', '{nome}, novidades por aqui. Qualquer coisa é só pedir para sair, tudo bem?'], interval_min: 10, interval_max: 15, batch_size: 30, batch_pause_min: 60, daily_limit: 100, recipients: { mode: 'selected', ids: [cC] } } });
const st = await call('POST', `/api/campaigns/${cm.body.id}/start`, { token: A.token, body: { accept: true } });
check('campanha comum inicia junto', cm.status === 201 && st.status === 200, JSON.stringify([cm.body, st.body]));
await call('POST', `/api/campaigns/${cm.body.id}/stop`, { token: A.token });
await call('DELETE', `/api/campaigns/${cm.body.id}`, { token: A.token });
const cidB = psql("select id from company_1.campaigns where kind='birthday'");
check('a permanente não é parada pela rota comum', (await call('POST', `/api/campaigns/${cidB}/stop`, { token: A.token })).status === 409);
check('nem apagada', (await call('DELETE', `/api/campaigns/${cidB}`, { token: A.token })).status === 409);

// desligar pausa o envio
const off1 = await call('PUT', '/api/campaigns/birthday', { token: A.token, body: { ...base, enabled: false } });
check('desliga', off1.body.enabled === false && off1.body.campanha.status === 'paused');
psql(`update company_1.campaigns set next_send_at=now() where id=${cidB}`);
check('desligada não envia', (await call('POST', '/n8n/campaigns/claim', { headers: N8N })).body === null);

// ano seguinte: quem já recebeu volta a ser enfileirado (a linha antiga é reaproveitada)
psql(`delete from company_1.birthday_sends where customer_id=${cA}; update company_1.campaign_recipients set status='sent' where phone like '%90003001'; update company_1.birthday_settings set last_run=null`);
const on2 = await call('PUT', '/api/campaigns/birthday', { token: A.token, body: { ...base, audience: 'clients' } });
check('próximo ano volta para a fila', psql("select status from company_1.campaign_recipients where phone like '%90003001'") === 'pending' && psql("select count(*) from company_1.campaign_recipients where phone like '%90003001'") === '1', JSON.stringify(on2.body.campanha));

// limpeza para não interferir nos outros testes
await call('PUT', '/api/campaigns/birthday', { token: A.token, body: { ...base, enabled: false } });
psql("delete from company_1.campaign_recipients where campaign_id in (select id from company_1.campaigns where kind='birthday')");
await call('POST', '/api/campaigns/exclusions/remove', { token: A.token, body: { phone: '32990003004' } });

console.log(`aniversario: ${ok} ok, ${fail} falhas`);
process.exit(fail ? 1 : 0);
