// Espelho dos contatos: envia só o que mudou depois de ligar, devagar, repete se falhar, "copiar todos" funciona.
// Uso: BASE=http://localhost:3999 DATABASE_URL=... node test/espelho_contatos.mjs  (servidor com ESPELHO_TICK_MS=300 ESPELHO_POR_VEZ=4)
import http from 'http';
import { execSync } from 'child_process';
const BASE = process.env.BASE || 'http://localhost:3999';
let ok = 0, fail = 0;
const check = (n, c, x = '') => { c ? ok++ : (fail++, console.log('FALHOU:', n, x)); };
const call = async (m, p, { token, body, h } = {}) => {
  const headers = { 'content-type': 'application/json', ...(h || {}) }; if (token) headers.authorization = 'Bearer ' + token;
  const r = await fetch(BASE + p, { method: m, headers, body: body ? JSON.stringify(body) : undefined });
  let j = null; try { j = await r.json(); } catch {} return { status: r.status, body: j };
};
const psql = (s) => execSync(`psql "${process.env.DATABASE_URL}" -tAc "${s}"`).toString().trim();
const dorme = (ms) => new Promise((r) => setTimeout(r, ms));
const recebidos = []; let falhar = false;
const srv = http.createServer((q, s) => { let b = ''; q.on('data', (d) => b += d); q.on('end', () => { if (falhar) { s.statusCode = 500; return s.end('x'); } recebidos.push(JSON.parse(b)); s.end('ok'); }); });
await new Promise((r) => srv.listen(53100, r));
const URL = 'http://localhost:53100/hook';
const A = (await call('POST', '/api/auth/login', { body: { email: 'demo@demo.com', password: 'demo1234' } })).body;
const t = A.token, cid = A.company.id, T = `company_${cid}.customers`, h = { 'x-api-key': 'k', 'x-company-id': String(cid) };
await call('PUT', `/api/admin/companies/${cid}/contact-mirror`, { token: t, body: { on: false, url: '' } });
const antes = await call('POST', '/n8n/customers/contact', { h, body: { phone: '5532944' + String(Date.now() % 1000000).padStart(6, '0'), name: 'Antes Ligar' } });
let r = await call('PUT', `/api/admin/companies/${cid}/contact-mirror`, { token: t, body: { on: true } });
check('não liga sem endereço', r.status === 400);
r = await call('PUT', `/api/admin/companies/${cid}/contact-mirror`, { token: t, body: { url: 'ftp://x' } });
check('endereço inválido recusado', r.status === 400);
r = await call('PUT', `/api/admin/companies/${cid}/contact-mirror`, { token: t, body: { url: URL, on: true } });
check('liga com endereço', r.status === 200 && r.body.on === true, JSON.stringify(r));
await dorme(1500);
check('o passado não é copiado ao ligar', !recebidos.some((x) => x.id === Number(antes.body.id)), JSON.stringify(recebidos));
const fone = '5532933' + String(Date.now() % 1000000).padStart(6, '0');
const novo = await call('POST', '/n8n/customers/contact', { h, body: { phone: fone, name: 'Maria Teste Silva' } });
await dorme(1500);
let got = recebidos.find((x) => x.id === Number(novo.body.id));
check('contato novo é enviado', !!got, JSON.stringify(recebidos));
check('formato do envio', got && got.name === 'Maria' && got.last_name === 'Teste Silva' && got.status === 'Lead' && got.event === 'contact' && got.company_id === Number(cid), JSON.stringify(got));
const n1 = recebidos.length; await dorme(1000);
check('não repete o que já foi', recebidos.length === n1);
await call('POST', '/n8n/customers/update-contact', { h, body: { phone: novo.body.phone || fone, subject: 'Quer orçamento de show' } });
await dorme(1500);
got = recebidos.filter((x) => x.id === Number(novo.body.id)).pop();
check('alteração reenvia (assunto)', got && got.subject === 'Quer orçamento de show', JSON.stringify(got));
// falha: continua pendente e repete
falhar = true;
psql(`update ${T} set city='Juiz de Fora' where id=${novo.body.id}`);
await dorme(1200);
check('com falha segue pendente', psql(`select mirror_pending from ${T} where id=${novo.body.id}`) === 't');
falhar = false; await dorme(1500);
check('volta a enviar quando o fluxo responde', psql(`select mirror_pending from ${T} where id=${novo.body.id}`) === 'f' && recebidos.filter((x) => x.id === Number(novo.body.id)).pop().city === 'Juiz de Fora');
// copiar todos
const total = Number(psql(`select count(*) from ${T} where phone is not null`));
r = await call('POST', `/api/admin/companies/${cid}/contact-mirror/send-all`, { token: t });
check('copiar todos enfileira a base', r.status === 200 && r.body.total === total, JSON.stringify(r));
const base = recebidos.length;
await dorme(4000);
check('a fila anda devagar (poucos por rodada)', recebidos.length - base > 0 && recebidos.length - base < total || total <= 4, `${recebidos.length - base}/${total}`);
// desligado, nada sai
r = await call('PUT', `/api/admin/companies/${cid}/contact-mirror`, { token: t, body: { on: false } });
await dorme(800); const n2 = recebidos.length; await dorme(1200);
check('desligado não envia', recebidos.length === n2);
// quem não é administrador
const S = await call('POST', '/api/auth/register', { body: { company_name: 'Outra', name: 'X', email: `e${Date.now()}@x.com`, password: 'senhasenha' } });
r = await call('PUT', `/api/admin/companies/${cid}/contact-mirror`, { token: S.body.token, body: { on: true } });
check('não-admin barrado', r.status === 403);
srv.close();
console.log(`espelho_contatos: ${ok} ok, ${fail} falhas`); process.exit(fail ? 1 : 0);
