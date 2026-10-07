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
// celular com o 9 extra, como o WhatsApp mostra: criar e achar têm que concordar em qualquer formato
const get = (p) => call('GET', p, { h: { 'x-api-key': 'k', 'x-company-id': String(A.company.id) } });
const sufixo = String(Date.now() % 10000).padStart(4, '0');
const com9 = '5532998' + '77' + sufixo, guardado = '553298' + '77' + sufixo;
r = await ia({ phone: `+55 32 9 98${'77'}-${sufixo}`.replace('98', '98'), name: 'André Celular' });
check('celular com 9 é criado sem o 9', r.status === 201 && psql(`select phone from ${T} where id=${r.body.id}`) === guardado, JSON.stringify(r.body));
check('por telefone acha com o 9 (só dígitos)', (await get(`/n8n/customers/by-phone/${com9}`)).status === 200);
check('por telefone acha sem o 9', (await get(`/n8n/customers/by-phone/${guardado}`)).status === 200);
check('por telefone acha formatado', (await get(`/n8n/customers/by-phone/${encodeURIComponent(`+55 32 9 98${'77'}-${sufixo}`)}`)).status === 200);
check('busca por texto acha pelo telefone com o 9', (await get(`/n8n/customers?search=${com9}`)).body?.some((x) => x.phone === guardado));
check('busca por texto acha pelo telefone formatado', (await get(`/n8n/customers?search=${encodeURIComponent(`+55 32 9 98${'77'}-${sufixo}`)}`)).body?.some((x) => x.phone === guardado));
check('busca por nome continua achando', (await get('/n8n/customers?search=' + encodeURIComponent('André Celular'))).body?.some((x) => x.phone === guardado));
check('busca por pedaço do número continua achando', (await get(`/n8n/customers?search=77${sufixo}`)).body?.some((x) => x.phone === guardado));
check('agendamentos por telefone aceitam o número com 9', (await get(`/n8n/appointments?phone=${com9}`)).status === 200);
check('fila de espera por telefone aceita o número com 9', (await get(`/n8n/waitlist?phone=${com9}`)).status === 200);
console.log(`contatos_agente: ${ok} ok, ${fail} falhas`); process.exit(fail ? 1 : 0);
