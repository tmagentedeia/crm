// A agente avisa que alguém conversou: cria o contato se não existe e nunca altera quem já está no cadastro.
// Uso: BASE=http://localhost:3999 DATABASE_URL=... node test/contatos_agente.mjs
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
const A = (await call('POST', '/api/auth/login', { body: { email: 'demo@demo.com', password: 'demo1234' } })).body;
const ia = (b) => call('POST', '/n8n/customers/contact', { body: b, h: { 'x-api-key': 'k', 'x-company-id': String(A.company.id) } });
const fone = '5532955' + String(Date.now() % 1000000).padStart(6, '0');
let r = await ia({ phone: fone, name: 'Maria das Dores Silva', chat_id: fone + '@s.whatsapp.net' });
check('contato novo é criado', r.status === 201 && r.body.created === true, JSON.stringify(r));
const id = r.body.id; const T = `company_${A.company.id}.customers`;
check('nome e sobrenome separados, como lead', psql(`select name||'|'||last_name||'|'||status from ${T} where id=${id}`) === 'Maria|das Dores Silva|lead');
psql(`update ${T} set name='Mariazinha', last_name='Souza', status='client', notes='VIP' where id=${id}`);
r = await ia({ phone: fone, name: 'Outro Nome Qualquer' });
check('quem já existe não é alterado', r.status === 200 && r.body.created === false && psql(`select name||'|'||last_name||'|'||status||'|'||notes from ${T} where id=${id}`) === 'Mariazinha|Souza|client|VIP', JSON.stringify(r));
check('não duplica', psql(`select count(*) from ${T} where phone=(select phone from ${T} where id=${id})`) === '1');
r = await ia({ phone: '123', name: 'X' });
check('telefone inválido é recusado', r.status === 400);
r = await ia({ phone: fone });
check('sem nome também funciona', r.status === 200);
console.log(`contatos_agente: ${ok} ok, ${fail} falhas`); process.exit(fail ? 1 : 0);
