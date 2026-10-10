// Campanhas: regras de segurança, aceite, envio um a um, falhas e isolamento. Uso: BASE=http://localhost:3999 node test/campanhas.mjs
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
const login = async (e, p) => (await call('POST', '/api/auth/login', { body: { email: e, password: p } })).body;
const A = await login('demo@demo.com', 'demo1234');
const B = await login('dois@x.com', 'senhasenha');
const psql = (sql) => execSync(`psql "${process.env.DATABASE_URL}" -tAc "${sql}"`).toString().trim();
const N8N = { 'x-api-key': process.env.N8N_API_KEY || 'k', 'x-company-id': '1' };

// janela de envio: coloca a empresa num fuso onde agora é meio-dia, para o teste valer a qualquer hora
const h = new Date().getUTCHours();
const off = (12 - h + 24) % 24;                       // horas a somar ao UTC para dar ~12h
const zone = off <= 12 ? `Etc/GMT-${off}` : `Etc/GMT+${24 - off}`;
psql(`update public.companies set timezone='${zone}' where id=1`);

const ids = [];
for (let i = 0; i < 6; i++) {
  const c = await call('POST', '/api/customers', { token: A.token, body: { name: 'Camp ' + i, phone: '3299000010' + i } });
  ids.push(c.body.id);
}
const msgs = ['Olá {nome}, temos novidades! Se não quiser mais receber, é só avisar, tá?',
              'Oi {nome}, passando para avisar das novidades. Se preferir não receber, me avisa, ok?',
              '{nome}, novidades por aqui. Qualquer coisa é só pedir para sair, tudo bem?'];
const ok_cfg = { name: 'Teste', messages: msgs, interval_min: 10, interval_max: 15,
                 batch_size: 30, batch_pause_min: 60, daily_limit: 100, recipients: { mode: 'selected', ids } };
const post = (body) => call('POST', '/api/campaigns', { token: A.token, body });

// regras no servidor
check('sem pergunta no fim', (await post({ ...ok_cfg, messages: [msgs[0], msgs[1], 'Olá, novidades.'] })).status === 400);
check('só 2 versões', (await post({ ...ok_cfg, messages: msgs.slice(0, 2) })).status === 400);
check('intervalo máximo abaixo de 10 recusado', (await post({ ...ok_cfg, interval_max: 6 })).status === 400);
check('mínimo abaixo de 10', (await post({ ...ok_cfg, interval_min: 5 })).status === 400);
check('lote acima de 30', (await post({ ...ok_cfg, batch_size: 31 })).status === 400);
check('pausa abaixo de 60', (await post({ ...ok_cfg, batch_pause_min: 30 })).status === 400);
check('limite diário acima de 100', (await post({ ...ok_cfg, daily_limit: 101 })).status === 400);
check('sem contatos', (await post({ ...ok_cfg, recipients: { mode: 'selected', ids: [] } })).status === 400);

// saudações e cumprimentos
const fr = (await call('GET', '/api/campaigns/phrases', { token: A.token })).body;
check('padrões', fr.greetings.length === 3 && fr.compliments.length >= 20 && fr.minimos.compliments === 20, JSON.stringify(fr.minimos));
const put = (g, k) => call('PUT', '/api/campaigns/phrases', { token: A.token, body: { greetings: g, compliments: k } });
check('menos de 3 saudações recusado', (await put(['Oi', 'Ei'], fr.compliments)).status === 400);
check('menos de 20 cumprimentos recusado', (await put(fr.greetings, fr.compliments.slice(0, 19))).status === 400);
check('repetidos não contam', (await put(['Oi', 'oi', 'OI', 'Ei'], fr.compliments)).status === 400);
const meus = fr.compliments.slice(0, 20);
const salvo = await put(['Oi', 'Ei', 'Olá', 'Opa'], meus);
check('edita (4 saudações, 20 cumprimentos)', salvo.status === 200 && salvo.body.greetings.length === 4 && salvo.body.compliments.length === 20 && salvo.body.personalizada);
check('outra empresa tem os padrões', (await call('GET', '/api/campaigns/phrases', { token: B.token })).body.personalizada === false);

// simulação
const sim = await call('POST', '/api/campaigns/simulate', { token: A.token, body: { ...ok_cfg, total: 500 } });
check('simulação', sim.status === 200 && sim.body.per_day > 55 && sim.body.per_day <= 70 && sim.body.days >= 7, JSON.stringify(sim.body));
const simLink = await call('POST', '/api/campaigns/simulate', { token: A.token, body: { ...ok_cfg, messages: ['veja https://x.com tá?', msgs[1], msgs[2]] } });
check('aviso de link', simLink.body.has_link === true);

// rascunho, aceite e envio
const cr = await post(ok_cfg);
check('cria rascunho', cr.status === 201 && cr.body.total === 6, JSON.stringify(cr));
const cid = cr.body.id;
check('start sem aceite', (await call('POST', `/api/campaigns/${cid}/start`, { token: A.token, body: {} })).status === 400);
check('claim com rascunho não envia', (await call('POST', '/n8n/campaigns/claim', { headers: N8N })).body === null);
check('start com aceite', (await call('POST', `/api/campaigns/${cid}/start`, { token: A.token, body: { accept: true } })).status === 200);
check('aceite registrado', psql(`select accepted_at is not null from company_1.campaigns where id=${cid}`) === 't');

const det0 = (await call('GET', `/api/campaigns/${cid}`, { token: A.token })).body;
check('logo após o play: sem horário a mostrar', det0.proximo_envio.motivo === null && det0.last_play_at, JSON.stringify(det0.proximo_envio));
const c1 = (await call('POST', '/n8n/campaigns/claim', { headers: N8N })).body;
const det1 = (await call('GET', `/api/campaigns/${cid}`, { token: A.token })).body;
check('depois do sorteio: mostra o horário', det1.proximo_envio.motivo === 'sorteado' && new Date(det1.proximo_envio.at) > new Date(), JSON.stringify(det1.proximo_envio));
check('detalhes: ritmo, janela e totais', det1.details && det1.details.window.start === 7 && det1.details.window.end === 22 && det1.details.totals.all === det1.recipients.length && det1.details.daily_limit_applied <= det1.daily_limit, JSON.stringify(det1.details));
check('claim devolve mensagem', c1 && c1.phone && /(tá|ok|tudo bem)\s*\?$/i.test(c1.text), JSON.stringify(c1));
check('começa com saudação, nome e cumprimento', c1 && /^(Oi|Ei|Olá|Opa) Camp! /.test(c1.text) && meus.some((m) => c1.text.includes(' ' + m + ' ')), c1 && c1.text);
check('claim seguido espera o intervalo', (await call('POST', '/n8n/campaigns/claim', { headers: N8N })).body === null);
const gap = Number(psql(`select extract(epoch from next_send_at-now()) from company_1.campaigns where id=${cid}`));
check('intervalo entre 10 e 15 min', gap > 9.5 * 60 && gap <= 15 * 60 + 5, String(gap));
check('relatório de sucesso', (await call('POST', `/n8n/campaigns/recipients/${c1.recipient_id}/report`, { headers: N8N, body: { ok: true } })).status === 200);
check('relatório repetido recusado', (await call('POST', `/n8n/campaigns/recipients/${c1.recipient_id}/report`, { headers: N8N, body: { ok: true } })).status === 404);

// 3 falhas seguidas pausam
for (let i = 0; i < 3; i++) {
  psql(`update company_1.campaigns set next_send_at=now() where id=${cid}`);
  const c = (await call('POST', '/n8n/campaigns/claim', { headers: N8N })).body;
  check('claim ' + i, !!c);
  if (c) await call('POST', `/n8n/campaigns/recipients/${c.recipient_id}/report`, { headers: N8N, body: { ok: false, error: 'x' } });
}
check('pausa por falhas', psql(`select status from company_1.campaigns where id=${cid}`) === 'paused');
check('falha não é reenviada', psql(`select count(*) from company_1.campaign_recipients where campaign_id=${cid} and status='failed'`) === '3');
psql(`update company_1.campaigns set next_send_at=now() where id=${cid}`);
check('pausada não envia', (await call('POST', '/n8n/campaigns/claim', { headers: N8N })).body === null);

// editar com a campanha pausada: quem já foi tratado fica, a fila muda
const putC = (body) => call('PUT', `/api/campaigns/${cid}`, { token: A.token, body });
const e1 = await putC({ ...ok_cfg, name: 'Editada pausada', interval_min: 11, interval_max: 14, recipients: { mode: 'selected', ids: ids.slice(0, 1) } });
const de = (await call('GET', `/api/campaigns/${cid}`, { token: A.token })).body;
check('editar pausada aceito e continua pausada', e1.status === 200 && de.status === 'paused' && de.name === 'Editada pausada' && de.interval_min === 11, JSON.stringify(e1.body));
check('quem já falhou continua no histórico', de.recipients.filter((x) => x.status === 'failed').length === 3);
check('fila só tem quem continua marcado', de.recipients.filter((x) => x.status === 'pending').every((x) => x.customer_id === ids[0]));
const e2 = await putC({ ...ok_cfg, recipients: { mode: 'selected', ids } });
const de2 = (await call('GET', `/api/campaigns/${cid}`, { token: A.token })).body;
check('marcar de novo recoloca na fila, sem repetir quem já falhou', e2.status === 200 && de2.recipients.length === 6 && de2.recipients.filter((x) => x.status === 'failed').length === 3 && de2.recipients.filter((x) => x.status === 'sent').length === 1 && de2.recipients.filter((x) => x.status === 'pending').length === 2, JSON.stringify(de2.recipients.map((x) => x.status)));
check('editar pausada respeita as regras (sem pausa de lote < 60)', (await putC({ ...ok_cfg, batch_pause_min: 30 })).status === 400);

// fora do horário (22h às 7h): o próximo envio é às 7h
const noite = (off + 11) % 24; // fuso onde agora é ~23h
psql(`update public.companies set timezone='${noite <= 12 ? `Etc/GMT-${noite}` : `Etc/GMT+${24 - noite}`}' where id=1`);
psql(`update company_1.campaigns set status='running', next_send_at=now() where id=${cid}`);
const detN = (await call('GET', `/api/campaigns/${cid}`, { token: A.token })).body;
const tzN = psql('select timezone from public.companies where id=1');
const horaN = Number(new Intl.DateTimeFormat('en-GB', { hour: '2-digit', hour12: false, timeZone: tzN }).format(new Date(detN.proximo_envio.at))) % 24;
const horaAgora = Number(new Intl.DateTimeFormat('en-GB', { hour: '2-digit', hour12: false, timeZone: tzN }).format(new Date())) % 24;
check('de noite: previsto para as 7h', horaAgora >= 22 || horaAgora < 7 ? (detN.proximo_envio.motivo === 'fora_do_horario' && horaN === 7) : true, JSON.stringify([horaAgora, horaN, detN.proximo_envio]));
psql(`update public.companies set timezone='${zone}' where id=1`);

// só uma ativa por vez + duplicar
const dup = await call('POST', `/api/campaigns/${cid}/duplicate`, { token: A.token });
check('duplicar', dup.status === 201);
const dd = (await call('GET', `/api/campaigns/${dup.body.id}`, { token: A.token })).body;
check('cópia é rascunho com os mesmos contatos', dd.status === 'draft' && dd.recipients.length === 6 && dd.messages.length === 3 && dd.recipients.every((x) => x.status === 'pending'));
check('segunda ativa recusada', (await call('POST', `/api/campaigns/${dup.body.id}/start`, { token: A.token, body: { accept: true } })).status === 409);

// limite do dia e janela
await call('POST', `/api/campaigns/${cid}/resume`, { token: A.token });
check('editar em andamento é recusado', (await putC({ ...ok_cfg })).status === 409);
psql(`update company_1.campaigns set next_send_at=now(), daily_limit=1 where id=${cid}`);
check('limite diário respeitado', (await call('POST', '/n8n/campaigns/claim', { headers: N8N })).body === null);
psql(`update company_1.campaigns set daily_limit=100 where id=${cid}`);
psql(`update public.companies set timezone='Etc/GMT-${(off + 12) % 24 <= 12 ? (off + 12) % 24 : 0}' where id=1`);
const hr = Number(psql(`select extract(hour from now() at time zone (select timezone from public.companies where id=1))`));
if (hr < 7 || hr >= 22) check('fora da janela não envia', (await call('POST', '/n8n/campaigns/claim', { headers: N8N })).body === null);
psql(`update public.companies set timezone='${zone}' where id=1`);

// sem nome no cadastro: pula o nome
psql(`update company_1.campaign_recipients set name=NULL where campaign_id=${cid} and status='pending'`);
psql(`update company_1.campaigns set next_send_at=now(), consecutive_failures=0, status='running' where id=${cid}`);
const semNome = (await call('POST', '/n8n/campaigns/claim', { headers: N8N })).body;
check('sem nome: só a saudação', semNome && /^(Oi|Ei|Olá|Opa)! /.test(semNome.text), semNome && semNome.text);
if (semNome) await call('POST', `/n8n/campaigns/recipients/${semNome.recipient_id}/report`, { headers: N8N, body: { ok: true } });

// parar cancela o que falta (a cópia, já com a original parada, pode iniciar)
check('stop', (await call('POST', `/api/campaigns/${cid}/stop`, { token: A.token })).status === 200);
check('stop cancela pendentes', psql(`select count(*) from company_1.campaign_recipients where campaign_id=${cid} and status='pending'`) === '0');

check('após parar, a cópia inicia', (await call('POST', `/api/campaigns/${dup.body.id}/start`, { token: A.token, body: { accept: true } })).status === 200);

// limite de 10 campanhas guardadas
let n = Number(psql('select count(*) from company_1.campaigns'));
for (; n < 10; n++) check('encher até 10', (await call('POST', `/api/campaigns/${cid}/duplicate`, { token: A.token })).status === 201);
check('11ª recusada (duplicar)', (await call('POST', `/api/campaigns/${cid}/duplicate`, { token: A.token })).status === 409);
check('11ª recusada (nova)', (await post(ok_cfg)).status === 409);

// isolamento
check('outra empresa não vê', (await call('GET', '/api/campaigns', { token: B.token })).body.length === 0);
check('outra empresa não abre', (await call('GET', `/api/campaigns/${cid}`, { token: B.token })).status === 404);

// limites por empresa: o administrador define na Administração; valem como teto (por dia) e piso (intervalo) ao criar campanhas
psql("delete from company_1.campaigns where status='draft'");   // abre espaço: cada empresa guarda no máximo 10
const lim = async (tk) => (await call('GET', '/api/campaigns/limits', { token: tk })).body;
const adm = (tk, body) => call('PUT', '/api/admin/companies/1', { token: tk, body });
const L0 = await lim(A.token);
check('limites padrão: 100 por dia e 10 minutos', L0.daily_max === 100 && L0.interval_min === 10, JSON.stringify(L0));
check('sem login não lê', (await call('GET', '/api/campaigns/limits')).status === 401);
check('o cliente não altera pela administração', (await adm(B.token, { campaign_daily_max: 10 })).status === 403);
check('valores fora da faixa são recusados', (await adm(A.token, { campaign_daily_max: 0 })).status === 400 && (await adm(A.token, { campaign_daily_max: 1001 })).status === 400
  && (await adm(A.token, { campaign_interval_min: 0 })).status === 400 && (await adm(A.token, { campaign_interval_min: 121 })).status === 400 && (await adm(A.token, { campaign_daily_max: 'abc' })).status === 400);
const salvoL = await adm(A.token, { campaign_daily_max: 30, campaign_interval_min: 15 });
check('administrador define os limites da empresa', salvoL.status === 200 && salvoL.body.campaign_daily_max === 30 && salvoL.body.campaign_interval_min === 15, JSON.stringify(salvoL.body));
const listaAdm = (await call('GET', '/api/admin/companies', { token: A.token })).body;
check('a lista da administração traz os limites', listaAdm.find((c) => c.id === 1 || c.id === '1')?.campaign_daily_max === 30);
check('o cliente vê os limites novos', (await lim(A.token)).daily_max === 30 && (await lim(A.token)).interval_min === 15);
check('outra empresa (nova, com Campanhas ligado) começa no 1º degrau da liberação progressiva', (await lim(B.token)).daily_max === 50 && (await lim(B.token)).interval_min === 15);
check('campanha acima do limite diário da empresa é recusada', (await post({ ...ok_cfg, interval_min: 15, interval_max: 20, daily_limit: 31 })).status === 400);
check('intervalo abaixo do mínimo da empresa é recusado', (await post({ ...ok_cfg, interval_min: 10, interval_max: 20, daily_limit: 30 })).status === 400);
const dentro = await post({ ...ok_cfg, interval_min: 15, interval_max: 20, daily_limit: 30 });
check('dentro dos limites da empresa é aceita', dentro.status === 201 || dentro.status === 200, JSON.stringify(dentro.body));
check('mexer só em um deles mantém o outro', (await adm(A.token, { campaign_daily_max: 200 })).body.campaign_interval_min === 15);
const maior = await post({ ...ok_cfg, name: 'Maior', interval_min: 15, interval_max: 20, daily_limit: 150 });
check('limite diário maior que 100 passa quando o administrador liberou', maior.status === 201 || maior.status === 200, JSON.stringify(maior.body));
check('simulação usa os limites da empresa', (await call('POST', '/api/campaigns/simulate', { token: A.token, body: { ...ok_cfg, interval_min: 15, interval_max: 20, daily_limit: 150, total: 10 } })).body.limits?.DAILY_MAX === 200);
check('vazio volta ao padrão', (await adm(A.token, { campaign_daily_max: null, campaign_interval_min: '' })).body.campaign_daily_max === null && (await lim(A.token)).daily_max === 100 && (await lim(A.token)).interval_min === 10);
check('de volta ao padrão, 101 é recusado de novo', (await post({ ...ok_cfg, daily_limit: 101 })).status === 400);

psql(`update public.companies set timezone='America/Sao_Paulo' where id=1`);
// rodízio: passa por todos antes de repetir
const { takeFromBag } = await import('../src/campaigns.js');
let bag = null; const vistos = new Set(); const lista = ['a', 'b', 'c'];
for (let i = 0; i < 3; i++) { const r = takeFromBag(bag, lista); bag = r.bag; vistos.add(r.item); }
check('rodízio sem repetir', vistos.size === 3);
const r4 = takeFromBag(bag, lista);
check('rodízio recomeça', lista.includes(r4.item) && r4.bag.length === 2);

// detalhes: intervalos reais entre envios
psql(`update company_1.campaigns set interval_min=3, interval_max=10 where id=${cid}`);
psql(`update company_1.campaign_recipients set sent_at = now() - interval '30 hours' - (id % 40) * interval '1 hour' where campaign_id=${cid} and status='sent'`);   // envios anteriores ficam longe, fora da conta dos intervalos
psql(`with r as (select id, row_number() over (order by id) n from company_1.campaign_recipients where campaign_id=${cid}) update company_1.campaign_recipients x set status='sent', sent_at = now() - (case r.n when 1 then interval '300 minutes' when 2 then interval '294 minutes' when 3 then interval '291 minutes' end) from r where x.id=r.id and r.n<=3`);
const detR = (await call('GET', `/api/campaigns/${cid}`, { token: A.token })).body.details;
check('detalhes: intervalo real médio, menor e maior', detR.gaps && detR.gaps.count === 2 && detR.gaps.avg === 4.5 && detR.gaps.min === 3 && detR.gaps.max === 6, JSON.stringify(detR.gaps));
check('detalhes: envios por dia somam os enviados', detR.per_day.reduce((a, x) => a + x.count, 0) === detR.totals.sent && detR.totals.sent >= 3 && detR.first_sent_at && detR.last_sent_at, JSON.stringify(detR.per_day));
// faixa de horário da campanha (dentro do limite das 7h às 22h)
const pw = (w) => post({ ...ok_cfg, name: 'Janela', ...w });
check('faixa começando antes das 7h é recusada', (await pw({ window_start: 6, window_end: 12 })).status === 400);
check('faixa terminando depois das 22h é recusada', (await pw({ window_start: 9, window_end: 23 })).status === 400);
check('faixa com o fim antes do início é recusada', (await pw({ window_start: 12, window_end: 12 })).status === 400);
check('faixa só com o início é recusada', (await pw({ window_start: 9 })).status === 400);
const cw = await pw({ window_start: 9, window_end: 12 });
check('faixa dentro do limite é aceita', cw.status === 201, JSON.stringify(cw.body));
const gw = (await call('GET', `/api/campaigns/${cw.body.id}`, { token: A.token })).body;
check('a faixa fica guardada e aparece nos detalhes', gw.window_start === 9 && gw.window_end === 12 && gw.details.window.start === 9 && gw.details.window.end === 12, JSON.stringify(gw.details?.window));
check('sem escolher faixa vale o limite inteiro', (await call('GET', `/api/campaigns/${cid}`, { token: A.token })).body.details.window.start === 7);
const dw = await call('POST', `/api/campaigns/${cw.body.id}/duplicate`, { token: A.token, body: {} });
const gd = (await call('GET', `/api/campaigns/${dw.body.id}`, { token: A.token })).body;
check('duplicar mantém a faixa de horário', gd.window_start === 9 && gd.window_end === 12);
const sw = await call('POST', '/api/campaigns/simulate', { token: A.token, body: { ...ok_cfg, window_start: 9, window_end: 10, total: 100 } });
check('previsão considera a faixa escolhida', sw.status === 200 && sw.body.per_day < (await call('POST', '/api/campaigns/simulate', { token: A.token, body: { ...ok_cfg, total: 100 } })).body.per_day, JSON.stringify(sw.body));
await call('DELETE', `/api/campaigns/${cw.body.id}`, { token: A.token }); await call('DELETE', `/api/campaigns/${dw.body.id}`, { token: A.token });

console.log(`campanhas: ${ok} ok, ${fail} falhas`);
process.exit(fail ? 1 : 0);
