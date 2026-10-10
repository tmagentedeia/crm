// Telefone: o mesmo número com ou sem o 9 extra é um só cliente e uma só mensagem de campanha. Uso: BASE=http://localhost:3999 DATABASE_URL=... node test/telefone_9.mjs
import { execSync } from 'child_process';
import { writeFileSync } from 'fs';
import { TELEFONE_ACERTO_SQL } from '../src/phone.js';
const BASE = process.env.BASE || 'http://localhost:3999';
let ok = 0, fail = 0;
const check = (name, cond, extra = '') => { cond ? ok++ : (fail++, console.log('FALHOU:', name, extra)); };
const call = async (method, path, { token, body } = {}) => {
  const headers = { 'content-type': 'application/json' };
  if (token) headers.authorization = 'Bearer ' + token;
  const r = await fetch(BASE + path, { method, headers, body: body ? JSON.stringify(body) : undefined });
  let j = null; try { j = await r.json(); } catch {}
  return { status: r.status, body: j };
};
const psql = (sql) => execSync(`psql "${process.env.DATABASE_URL}" -tAc "${sql}"`).toString().trim();
const psqlArq = (sql) => { writeFileSync('/tmp/tel9.sql', sql); return execSync(`psql "${process.env.DATABASE_URL}" -v ON_ERROR_STOP=1 -tA -f /tmp/tel9.sql`).toString().trim(); };
const A = (await call('POST', '/api/auth/login', { body: { email: 'demo@demo.com', password: 'demo1234' } })).body;
const m = String(Date.now() % 1000000).padStart(6, '0');
const tira9 = (n) => n.slice(0, 4) + n.slice(5);
const base = '55329' + m + '12';          // 13 dígitos, com o 9 extra

// 1) qualquer caminho que grave com o 9 sai sem o 9
psql(`insert into company_1.customers (name, phone) values ('Tel9 A', '${base}')`);
check('gravar com o 9 grava sem o 9', psql(`select phone from company_1.customers where name='Tel9 A'`) === tira9(base), psql(`select phone from company_1.customers where name='Tel9 A'`));
const certo = psql(`select phone from company_1.customers where name='Tel9 A'`);
// 2) o mesmo número com o 9 não vira outro cliente (cai no mesmo cadastro)
psql(`insert into company_1.customers (name, phone) values ('Tel9 B', '${base}') on conflict (phone) do update set name = customers.name`);
check('o mesmo número com o 9 não cria outro cliente', psql(`select count(*) from company_1.customers where phone='${certo}'`) === '1');
// alterar o telefone de um cliente para uma forma com o 9 também sai sem o 9
const outro = '55329' + m + '34';
psql(`insert into company_1.customers (name, phone) values ('Tel9 C', '553200${m}')`);
psql(`update company_1.customers set phone='${outro}' where name='Tel9 C'`);
check('alterar para a forma com o 9 também normaliza', psql(`select phone from company_1.customers where name='Tel9 C'`) === tira9(outro));
// o que não é celular brasileiro com 9 extra não muda
psql(`insert into company_1.customers (name, phone) values ('Tel9 D', '351912345${m.slice(0, 3)}')`);
check('número de fora não é mexido', psql(`select phone from company_1.customers where name='Tel9 D'`) === '351912345' + m.slice(0, 3));

// 3) cadastros antigos (já com o 9 e outro igual sem o 9): a campanha manda uma vez só
psql(`alter table company_1.customers disable trigger trg_customers_norm_phone`);
const ant = '55329' + m + '56';
psql(`insert into company_1.customers (name, phone) values ('Tel9 Velho com 9', '${ant}'), ('Tel9 Velho sem 9', '${tira9(ant)}')`);
psql(`alter table company_1.customers enable trigger trg_customers_norm_phone`);
const ids = psql(`select id from company_1.customers where name like 'Tel9 Velho%' order by id`).split('\n').map(Number);
const msgs = ['Olá {nome}, temos novidades! Se não quiser mais receber, é só avisar, tá?',
              'Oi {nome}, passando para avisar das novidades. Se preferir não receber, me avisa, ok?',
              '{nome}, novidades por aqui. Qualquer coisa é só pedir para sair, tudo bem?'];
const c = await call('POST', '/api/campaigns', { token: A.token, body: { name: 'Tel9', messages: msgs, interval_min: 10, interval_max: 15, batch_size: 30, batch_pause_min: 60, daily_limit: 100, recipients: { mode: 'selected', ids } } });
check('campanha com o mesmo número duas vezes entra uma vez só', c.status === 201 && c.body.total === 1, JSON.stringify(c.body));

// 4) acerto único dos cadastros antigos: acerta quando não há outro igual e deixa quando há
psql(`alter table company_1.customers disable trigger trg_customers_norm_phone`);
const solo = '55329' + m + '78';
psql(`insert into company_1.customers (name, phone) values ('Tel9 Solo', '${solo}')`);
psql(`alter table company_1.customers enable trigger trg_customers_norm_phone`);
psqlArq(`set search_path=company_1,public;\n${TELEFONE_ACERTO_SQL}`);
check('acerto único: cadastro antigo com o 9 e sem outro igual é acertado', psql(`select phone from company_1.customers where name='Tel9 Solo'`) === tira9(solo));
check('acerto único: com outro igual, nada é apagado nem trocado', psql(`select count(*) from company_1.customers where name like 'Tel9 Velho%'`) === '2' && psql(`select phone from company_1.customers where name='Tel9 Velho com 9'`) === ant);

// limpa o que o teste criou (outros testes contam clientes e campanhas)
await call('DELETE', `/api/campaigns/${c.body.id}`, { token: A.token });
psql(`delete from company_1.customers where name like 'Tel9 %'`);

console.log(`telefone_9: ${ok} ok, ${fail} falhas`);
process.exit(fail ? 1 : 0);
