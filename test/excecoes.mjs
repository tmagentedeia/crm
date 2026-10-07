// Lista de números que não recebem campanhas + ordem de envio sorteada. Uso: BASE=http://localhost:3999 node test/excecoes.mjs
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
const T = (m, p, body, t = A) => call(m, p, { token: t.token, body });

// janela de envio: meio-dia no fuso da empresa, para valer a qualquer hora
const h = new Date().getUTCHours(); const off = (12 - h + 24) % 24;
psql(`update public.companies set timezone='${off <= 12 ? `Etc/GMT-${off}` : `Etc/GMT+${24 - off}`}' where id=1`);
// nenhuma campanha ativa atrapalhando
for (const c of (await T('GET', '/api/campaigns')).body) {
  if (['running', 'paused'].includes(c.status)) await T('POST', `/api/campaigns/${c.id}/stop`);
  await T('DELETE', '/api/campaigns/' + c.id);   // abre espaço no limite de campanhas guardadas
}

// cadastro de exceções
const ids = [];
for (let i = 0; i < 6; i++) ids.push((await T('POST', '/api/customers', { name: 'Exc ' + i, phone: '3299000030' + i })).body.id);
check('sem número = 400', (await T('POST', '/api/campaigns/exclusions', { phones: '' })).status === 400);
check('número inválido = 400', (await T('POST', '/api/campaigns/exclusions', { phones: 'abc' })).status === 400);
const add = (await T('POST', '/api/campaigns/exclusions', { phones: '(32) 99000-0300\n32 99000-0301, 12', note: 'meu número' })).body;
check('adiciona 2 e ignora o inválido', add.added === 2 && add.invalid.join() === '12', JSON.stringify(add));
check('repetido não duplica', (await T('POST', '/api/campaigns/exclusions', { phones: '32990000300' })).body.already === 1);
const lista = (await T('GET', '/api/campaigns/exclusions')).body;
check('lista mostra quem é o contato', lista.length === 2 && lista.some((x) => x.name === 'Exc 0' && x.note === 'meu número'), JSON.stringify(lista));
check('outra empresa não vê a lista', (await T('GET', '/api/campaigns/exclusions', null, B)).body.length === 0);
check('ficha avisa', (await T('GET', '/api/customers/' + ids[0])).body.campaign_excluded === true && (await T('GET', '/api/customers/' + ids[2])).body.campaign_excluded === false);

// campanha: o público já vem sem as exceções
const msgs = ['Olá {nome}, temos novidades! Se não quiser mais receber, é só avisar, tá?',
              'Oi {nome}, passando para avisar das novidades. Se preferir não receber, me avisa, ok?',
              '{nome}, novidades por aqui. Qualquer coisa é só pedir para sair, tudo bem?'];
const cfg = { name: 'Exceções', messages: msgs, interval_min: 10, interval_max: 15, batch_size: 30, batch_pause_min: 60, daily_limit: 100, recipients: { mode: 'selected', ids } };
const sim = (await T('POST', '/api/campaigns/simulate', cfg)).body;
check('simulação conta sem as exceções', sim.total === 4 && sim.ignorados === 2, JSON.stringify(sim));
const rascunho = (await T('POST', '/api/campaigns', cfg)).body;
check('rascunho sem as exceções', rascunho.total === 4 && rascunho.ignorados === 2, JSON.stringify(rascunho));
const det = (await T('GET', '/api/campaigns/' + rascunho.id)).body;
check('destinatários não incluem as exceções', det.recipients.length === 4 && !det.recipients.some((r) => r.name === 'Exc 0' || r.name === 'Exc 1'), JSON.stringify(det.recipients.map((r) => r.name)));

// exceção incluída depois de a campanha montada: também é pulada no envio
check('inicia', (await T('POST', `/api/campaigns/${rascunho.id}/start`, { accept: true })).status === 200);
await T('POST', '/api/campaigns/exclusions', { phones: '32990000302' });
const enviados = [];
for (let i = 0; i < 4; i++) {
  psql(`update company_1.campaigns set next_send_at=now() where id=${rascunho.id}`);
  const c = (await call('POST', '/n8n/campaigns/claim', { headers: N8N })).body;
  if (!c) break;
  enviados.push(c.name);
  await call('POST', `/n8n/campaigns/recipients/${c.recipient_id}/report`, { headers: N8N, body: { ok: true } });
}
check('quem entrou na lista depois não recebe', enviados.length === 3 && !enviados.includes('Exc 2'), JSON.stringify(enviados));
check('fica marcado como não enviado', psql(`select count(*) from company_1.campaign_recipients where campaign_id=${rascunho.id} and status='cancelled' and error='Na lista de exceções'`) === '1');

// ordem sorteada: em várias campanhas de 6 contatos, o primeiro nem sempre é o primeiro do cadastro
await T('POST', `/api/campaigns/${rascunho.id}/stop`);
let primeiroDiferente = false;
for (let t = 0; t < 12 && !primeiroDiferente; t++) {
  const d = (await T('POST', '/api/campaigns', { ...cfg, name: 'Ordem ' + t, recipients: { mode: 'selected', ids: ids.slice(2).concat(ids.slice(0, 0)) } })).body;
  await T('POST', `/api/campaigns/${d.id}/start`, { accept: true });
  const c = (await call('POST', '/n8n/campaigns/claim', { headers: N8N })).body;
  if (c && c.name !== 'Exc 3') primeiroDiferente = true; // Exc 2 está na lista; Exc 3 é o primeiro do cadastro entre os restantes
  await T('POST', `/api/campaigns/${d.id}/stop`);
}
check('ordem de envio é sorteada', primeiroDiferente);

// continuar de onde parou: nova campanha só com quem não recebeu
check('sem sobra, não cria continuação', (await T('POST', `/api/campaigns/${rascunho.id}/duplicate`, { restantes: true })).status === 409);
const p3 = (await T('POST', '/api/campaigns', { ...cfg, name: 'Parte', recipients: { mode: 'selected', ids: ids.slice(3) } })).body;
await T('POST', `/api/campaigns/${p3.id}/start`, { accept: true });
const um = (await call('POST', '/n8n/campaigns/claim', { headers: N8N })).body;
await call('POST', `/n8n/campaigns/recipients/${um.recipient_id}/report`, { headers: N8N, body: { ok: true } });
check('não continua enquanto roda', (await T('POST', `/api/campaigns/${p3.id}/duplicate`, { restantes: true })).status === 409);
await T('POST', `/api/campaigns/${p3.id}/stop`);
const cont = await T('POST', `/api/campaigns/${p3.id}/duplicate`, { restantes: true });
check('continuação criada', cont.status === 201, JSON.stringify(cont.body));
const contDet = (await T('GET', '/api/campaigns/' + cont.body.id)).body;
check('continuação só tem quem faltou', contDet.recipients.length === 2 && contDet.recipients.every((r) => r.status === 'pending') && !contDet.recipients.some((r) => r.name === um.name), JSON.stringify(contDet.recipients));

// tirar da lista
check('tira pelo número', (await T('POST', '/api/campaigns/exclusions/remove', { phone: '32990000300' })).status === 200 && (await T('GET', '/api/customers/' + ids[0])).body.campaign_excluded === false);
const resto = (await T('GET', '/api/campaigns/exclusions')).body;
check('apagar em massa', (await T('POST', '/api/campaigns/exclusions/bulk-delete', { ids: resto.map((x) => x.id) })).body.deleted === resto.length);
check('lista vazia', (await T('GET', '/api/campaigns/exclusions')).body.length === 0);

console.log(`excecoes: ${ok} ok, ${fail} falhas`);
process.exit(fail ? 1 : 0);
