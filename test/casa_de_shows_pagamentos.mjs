// Pagamentos das reservas da Casa de Shows. Uso: BASE=http://localhost:3999 node test/casa_de_shows_pagamentos.mjs
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
const psql = (sql) => execSync(`psql "${process.env.DATABASE_URL}" -tAc "${sql}"`).toString().trim();
psql("set search_path to company_1, public; delete from company_1.shows_res_payments; delete from company_1.payments where txid like 'E2E-PAGTO%'; delete from company_1.pix_keys where key like '%.pagto@x.com'; delete from company_1.shows_reservations where occasion_date='2031-05-17'");
const A = (await call('POST', '/api/auth/login', { body: { email: 'demo@demo.com', password: 'demo1234' } })).body;
const api = (m, p, body) => call(m, '/api' + p, { token: A.token, body });
const N8N = { 'x-api-key': process.env.N8N_API_KEY || 'k', 'x-company-id': '1' };

const setor = (await api('POST', '/casa-de-shows/sectors', { name: 'Pista Pagto', space: 100 })).body;
const dia = '2031-05-17';
const reserva = async (nome, people, preco) => (await api('POST', '/casa-de-shows/reservations', { date: dia, sector_id: setor.id, name: nome, people, unit_price: preco })).body;
const r1 = await reserva('Comprador Um', 4, 50);   // 200
const r2 = await reserva('Comprador Dois', 2, 50); // 100
const r3 = await reserva('Convidada', 2, 50);      // cortesia
check('reservas criadas', r1.id && r2.id && r3.id, JSON.stringify(r1));
check('reserva nova sem pagamento', r1.paid === 0 && r1.courtesy === false);

const kT = (await api('POST', '/finance/keys', { key_type: 'email', key: 'thiago.pagto@x.com', beneficiary: 'Thiago' })).body;
const kF = (await api('POST', '/finance/keys', { key_type: 'email', key: 'fred.pagto@x.com', beneficiary: 'Fred' })).body;
const P = (path, body) => api('POST', `/casa-de-shows/reservations/${path}/payments`, body);

check('forma inválida', (await P(r1.id, { method: 'cheque', amount: 10 })).status === 400);
check('sem valor', (await P(r1.id, { method: 'dinheiro' })).status === 400 && (await P(r1.id, { method: 'dinheiro', amount: 0 })).status === 400);
check('reserva inexistente', (await P('999999', { method: 'dinheiro', amount: 10 })).status === 404);
check('chave Pix inexistente', (await P(r1.id, { method: 'pix', amount: 10, pix_key_id: '999999' })).status === 400);
check('chave Pix em dinheiro recusada', (await P(r1.id, { method: 'dinheiro', amount: 10, pix_key_id: kT.id })).status === 400);

const p1 = await P(r1.id, { method: 'pix', amount: 120, pix_key_id: kT.id });
check('Pix parcial com chave', p1.status === 201 && p1.body.amount === 120 && p1.body.beneficiary === 'Thiago', JSON.stringify(p1.body));
let ls = (await api('GET', `/casa-de-shows/reservations?date=${dia}`)).body;
check('lista mostra o pago', ls.find((x) => x.id === r1.id).paid === 120);

// comprovante validado em Recebimentos
const pid = psql(`set search_path to company_1, public; insert into company_1.payments (txid, payer_name, amount, pix_key_id, status, category) values ('E2E-PAGTO-1','Comprador Um',80,${kF.id},'accepted','outro') returning id`).split('\n').find((l) => /^\d+$/.test(l));
const pidRecusado = psql(`set search_path to company_1, public; insert into company_1.payments (txid, amount, status) values ('E2E-PAGTO-2',80,'duplicate') returning id`).split('\n').find((l) => /^\d+$/.test(l));
check('comprovante recusado não vale', (await P(r1.id, { method: 'pix', payment_id: pidRecusado })).status === 400);
check('comprovante inexistente', (await P(r1.id, { method: 'pix', payment_id: '999999' })).status === 400);
const p2 = await P(r1.id, { method: 'pix', payment_id: pid });
check('comprovante traz valor e chave', p2.status === 201 && p2.body.amount === 80 && p2.body.beneficiary === 'Fred' && String(p2.body.payment_id) === String(pid), JSON.stringify(p2.body));
check('mesmo comprovante não paga duas reservas', (await P(r2.id, { method: 'pix', payment_id: pid })).status === 409);

ls = (await api('GET', `/casa-de-shows/reservations?date=${dia}`)).body;
check('pago somado (120+80=200)', ls.find((x) => x.id === r1.id).paid === 200);

check('dinheiro parcial na segunda', (await P(r2.id, { method: 'dinheiro', amount: 40 })).status === 201);
const c = await P(r3.id, { method: 'cortesia' });
check('cortesia vale zero', c.status === 201 && c.body.amount === 0);
ls = (await api('GET', `/casa-de-shows/reservations?date=${dia}`)).body;
check('cortesia marcada e fora do pago', ls.find((x) => x.id === r3.id).courtesy === true && ls.find((x) => x.id === r3.id).paid === 0);

const s = (await api('GET', `/casa-de-shows/payments/summary?date=${dia}`)).body;
check('previsto 200+100+100', s.expected === 400 && s.reservations === 3 && s.people === 8, JSON.stringify(s));
check('recebido 240', s.received === 240, JSON.stringify(s));
check('por forma', s.by_method.find((m) => m.method === 'pix').total === 200 && s.by_method.find((m) => m.method === 'dinheiro').total === 40 && s.by_method.find((m) => m.method === 'cortesia').n === 1);
check('por chave/beneficiário', s.by_pix_key.length === 2 && s.by_pix_key.find((k) => k.beneficiary === 'Thiago').total === 120 && s.by_pix_key.find((k) => k.beneficiary === 'Fred').total === 80, JSON.stringify(s.by_pix_key));
check('situação: 1 pago, 1 parcial, 1 cortesia', s.paid === 1 && s.partial === 1 && s.courtesy === 1 && s.pending === 0 && s.open_amount === 60, JSON.stringify(s));
check('data inválida', (await api('GET', '/casa-de-shows/payments/summary?date=abc')).status === 400);

const det = (await api('GET', `/casa-de-shows/reservations/${r1.id}/payments`)).body;
check('detalhe da reserva', det.total === 200 && det.paid === 200 && det.payments.length === 2);

check('atendente lança e consulta', (await call('POST', `/n8n/casa-de-shows/reservations/${r2.id}/payments`, { headers: N8N, body: { method: 'cartao', amount: 60 } })).status === 201 && (await call('GET', `/n8n/casa-de-shows/payments/summary?date=${dia}`, { headers: N8N })).status === 200);
check('atendente não apaga', (await call('DELETE', `/n8n/casa-de-shows/payments/${p1.body.id}`, { headers: N8N })).status === 403);
check('apagar pagamento', (await api('DELETE', `/casa-de-shows/payments/${p1.body.id}`)).status === 200 && (await api('DELETE', `/casa-de-shows/payments/${p1.body.id}`)).status === 404);
check('liberar comprovante depois de apagar', (await api('DELETE', `/casa-de-shows/payments/${p2.body.id}`)).status === 200 && (await P(r2.id, { method: 'pix', payment_id: pid })).status === 201);

const s2 = (await api('GET', `/casa-de-shows/payments/summary?date=${dia}`)).body;
check('reserva cancelada sai do resumo', (await api('PUT', `/casa-de-shows/reservations/${r2.id}`, { status: 'cancelled' })).status === 200 && (await api('GET', `/casa-de-shows/payments/summary?date=${dia}`)).body.reservations === 2 && s2.reservations === 3);
check('apagar reserva leva os pagamentos', (await api('DELETE', `/casa-de-shows/reservations/${r1.id}`)).status === 200 && psql(`select count(*) from company_1.shows_res_payments where reservation_id=${r1.id}`) === '0');
psql("set search_path to company_1, public; delete from company_1.shows_res_payments; delete from company_1.payments where txid like 'E2E-PAGTO%'; delete from company_1.pix_keys where key like '%.pagto@x.com'; delete from company_1.shows_reservations where occasion_date='2031-05-17'");
console.log(`casa_de_shows_pagamentos: ${ok} ok, ${fail} falhas`);
process.exit(fail ? 1 : 0);
