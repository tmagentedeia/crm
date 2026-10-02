// Campanhas no modo "painel aciona o fluxo" (CAMPAIGN_WEBHOOK_URL). Uso: BASE=http://localhost:3996 HOOK_PORT=3997 node test/campanhas_push.mjs
import http from 'http';
import { execSync } from 'child_process';
const BASE = process.env.BASE || 'http://localhost:3996';
const HOOK_PORT = Number(process.env.HOOK_PORT || 3997);
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

// webhook de mentira (faz o papel do N8N)
const recebidos = []; let resposta = 200;
const srv = http.createServer((req, res) => {
  let b = ''; req.on('data', (c) => (b += c)); req.on('end', () => { recebidos.push(JSON.parse(b || '{}')); res.statusCode = resposta; res.end('{}'); });
}).listen(HOOK_PORT);
const esperar = async (cond, ms = 12000) => { const t = Date.now(); while (Date.now() - t < ms) { if (cond()) return true; await new Promise((r) => setTimeout(r, 250)); } return false; };

// limpa campanhas antigas e põe a empresa num fuso onde agora é meio-dia
for (const c of (await call('GET', '/api/campaigns', { token: A.token })).body) {
  if (['running', 'paused'].includes(c.status)) await call('POST', `/api/campaigns/${c.id}/stop`, { token: A.token });
  await call('DELETE', `/api/campaigns/${c.id}`, { token: A.token });
}
const off = (12 - new Date().getUTCHours() + 24) % 24;
psql(`update public.companies set timezone='${off <= 12 ? `Etc/GMT-${off}` : `Etc/GMT+${24 - off}`}' where id=1`);

const ids = [];
for (let i = 0; i < 4; i++) ids.push((await call('POST', '/api/customers', { token: A.token, body: { name: 'Push ' + i, phone: '3299000020' + i } })).body.id);
const msgs = ['Olá {nome}, novidades! Se não quiser mais receber, é só avisar, tá?', 'Oi {nome}, novidades. Se preferir não receber, me avisa, ok?', '{nome}, novidades por aqui. Qualquer coisa é só pedir para sair, tudo bem?'];
const cr = await call('POST', '/api/campaigns', { token: A.token, body: { name: 'Push', messages: msgs, interval_min: 5, interval_max: 10, batch_size: 30, batch_pause_min: 60, daily_limit: 100, recipients: { mode: 'selected', ids } } });
const cid = cr.body.id;
// o endereço é por empresa, definido pela Administração
const putWh = (token, url) => call('PUT', '/api/admin/companies/1/campaign-webhook', { token, body: { url } });
check('endereço inválido recusado', (await putWh(A.token, 'não é endereço')).status === 400);
const B = (await call('POST', '/api/auth/login', { body: { email: 'dois@x.com', password: 'senhasenha' } })).body;
check('quem não é administrador não define', (await putWh(B.token, `http://127.0.0.1:${HOOK_PORT}/hook`)).status === 403);
check('define o endereço da empresa', (await putWh(A.token, `http://127.0.0.1:${HOOK_PORT}/hook`)).status === 200);
check('aparece na lista da administração', (await call('GET', '/api/admin/companies', { token: A.token })).body.find((c) => Number(c.id) === 1)?.campaign_webhook_url?.endsWith('/hook'));
await call('POST', `/api/campaigns/${cid}/start`, { token: A.token, body: { accept: true } });

// 1) o painel aciona sozinho, sem ninguém pedir
check('painel aciona o fluxo sozinho', await esperar(() => recebidos.length >= 1), 'nada recebido');
const m = recebidos[0] || {};
check('aviso traz o necessário', m.company_id === 1 && m.recipient_id && m.phone && m.text && /(tá|ok|tudo bem)\s*\?$/i.test(m.text) && 'instance' in m, JSON.stringify(m));
await new Promise((r) => setTimeout(r, 3000));
check('só um por vez (respeita o intervalo)', recebidos.length === 1, String(recebidos.length));
check('fica "enviando" até o fluxo informar', psql(`select status from company_1.campaign_recipients where id=${m.recipient_id}`) === 'sending');
check('fluxo informa sucesso', (await call('POST', `/n8n/campaigns/recipients/${m.recipient_id}/report`, { headers: N8N, body: { ok: true } })).status === 200);
check('marcado como enviado', psql(`select status from company_1.campaign_recipients where id=${m.recipient_id}`) === 'sent');

// 2) o fluxo está fora do ar (erro): marca como falho e não insiste
resposta = 500;
psql(`update company_1.campaigns set next_send_at=now() where id=${cid}`);
check('segundo acionamento', await esperar(() => recebidos.length >= 2));
await esperar(() => psql(`select count(*) from company_1.campaign_recipients where campaign_id=${cid} and status='failed'`) === '1');
check('erro do fluxo = falho', psql(`select count(*) from company_1.campaign_recipients where campaign_id=${cid} and status='failed'`) === '1');
await new Promise((r) => setTimeout(r, 2500));
check('não reenvia o que falhou', recebidos.length === 2);

// 3) pausada não aciona
await call('POST', `/api/campaigns/${cid}/pause`, { token: A.token });
psql(`update company_1.campaigns set next_send_at=now() where id=${cid}`);
await new Promise((r) => setTimeout(r, 2500));
check('pausada não aciona', recebidos.length === 2);

await call('POST', `/api/campaigns/${cid}/stop`, { token: A.token });
psql(`update public.companies set timezone='America/Sao_Paulo', campaign_webhook_url=NULL where id=1`);
srv.close();
console.log(`campanhas_push: ${ok} ok, ${fail} falhas`);
process.exit(fail ? 1 : 0);
