// Contatos: assunto único (migração), primeira letra maiúscula, ordenar por assunto e edição em lote.
// Uso: BASE=http://localhost:3999 DATABASE_URL=... node test/contatos_lote.mjs
import { execSync } from 'child_process';
const BASE = process.env.BASE || 'http://localhost:3999';
let ok = 0, fail = 0;
const check = (n, c, x = '') => { c ? ok++ : (fail++, console.log('FALHOU:', n, x)); };
const call = async (m, p, { token, body } = {}) => {
  const headers = { 'content-type': 'application/json' }; if (token) headers.authorization = 'Bearer ' + token;
  const r = await fetch(BASE + p, { method: m, headers, body: body ? JSON.stringify(body) : undefined });
  let j = null; try { j = await r.json(); } catch {} return { status: r.status, body: j };
};
const psql = (s) => execSync(`psql "${process.env.DATABASE_URL}" -tA`, { input: s }).toString().trim();
const A = (await call('POST', '/api/auth/login', { body: { email: 'demo@demo.com', password: 'demo1234' } })).body;
const api = (m, p, body) => call(m, '/api' + p, { token: A.token, body });
const T = `company_${A.company.id}`;
psql(`delete from ${T}.customers where phone like '55329999777%'`);

// criar 4 contatos
const ids = [];
for (let i = 0; i < 4; i++) {
  const r = await api('POST', '/customers', { name: 'Lote ' + String.fromCharCode(65 + i), phone: '55329999777'+ i + '0', status: 'lead' });
  ids.push(r.body?.id);
}
check('contatos criados', ids.every(Boolean), JSON.stringify(ids));

// maiúscula na primeira letra
await api('PUT', '/customers/' + ids[0], { subject: 'baile do Miranda' });
check('assunto gravado com a 1ª letra maiúscula', psql(`select subject from ${T}.customers where id=${ids[0]}`) === 'Baile do Miranda');

// migração: "Assunto" que veio como campo personalizado passa para o campo próprio
psql(`update ${T}.customers set subject=null, extra='{"Assunto":"show do Djavan","Cidade extra":"x"}' where id=${ids[1]}; update ${T}.customers set subject='Já tem', extra='{" assunto ":"outro"}' where id=${ids[2]}`);
psql(`update public.tenant_versions set version=57 where company_id=${A.company.id}`);
execSync('node src/migrate.js', { env: process.env });
check('migração: texto vai para o assunto', psql(`select subject from ${T}.customers where id=${ids[1]}`) === 'show do Djavan');
check('migração: tira o "Assunto" dos campos personalizados e mantém os outros', psql(`select extra::text from ${T}.customers where id=${ids[1]}`) === '{"Cidade extra": "x"}');
check('migração: não troca assunto que já existia', psql(`select subject || '|' || extra::text from ${T}.customers where id=${ids[2]}`) === 'Já tem|{}');

// ordenar por assunto
psql(`update ${T}.customers set subject='Zebra' where id=${ids[3]}`);
const sub = (await api('GET', '/customers?sort=subject&dir=asc')).body.filter((c) => ids.includes(c.id)).map((c) => c.subject);
check('A a Z', JSON.stringify(sub) === JSON.stringify([...sub].sort((a, b) => (a || '￿').toLowerCase().localeCompare((b || '￿').toLowerCase(), 'pt'))), JSON.stringify(sub));
const sd = (await api('GET', '/customers?sort=subject&dir=desc')).body.filter((c) => ids.includes(c.id)).map((c) => c.subject);
check('Z a A começa por Zebra', sd[0] === 'Zebra', JSON.stringify(sd));

// edição em lote
let r = await api('POST', '/customers/bulk-update', { ids, status: 'client', subject: 'baile do Miranda', city: 'Juiz de Fora', state: 'mg', notes: 'veio pelo anúncio' });
check('lote: aceito', r.status === 200 && r.body.updated === 4, JSON.stringify(r));
const linhas = psql(`select status||'|'||subject||'|'||city||'|'||state||'|'||notes from ${T}.customers where id in (${ids.join(',')})`).split('\n');
check('lote: todos receberam os valores (assunto com maiúscula, UF em maiúsculas)', linhas.length === 4 && linhas.every((l) => l === 'client|Baile do Miranda|Juiz de Fora|MG|veio pelo anúncio'), linhas.join(' / '));
check('lote: nome e telefone intactos', psql(`select name from ${T}.customers where id=${ids[0]}`) === 'Lote A');
r = await api('POST', '/customers/bulk-update', { ids: ids.slice(0, 2), status: 'lead' });
check('lote: só mexe no que foi enviado', r.status === 200 && psql(`select status||'|'||city from ${T}.customers where id=${ids[0]}`) === 'lead|Juiz de Fora' && psql(`select status from ${T}.customers where id=${ids[2]}`) === 'client');
r = await api('POST', '/customers/bulk-update', { ids, subject: '' });
check('lote: vazio apaga o assunto', r.status === 200 && psql(`select count(*) from ${T}.customers where id in (${ids.join(',')}) and subject is not null`) === '0');
check('lote: sem seleção = 400', (await api('POST', '/customers/bulk-update', { ids: [], city: 'x' })).status === 400);
check('lote: sem campo = 400', (await api('POST', '/customers/bulk-update', { ids })).status === 400);
check('lote: tipo inválido = 400', (await api('POST', '/customers/bulk-update', { ids, status: 'vip' })).status === 400);
check('lote: estado inválido = 400', (await api('POST', '/customers/bulk-update', { ids, state: 'Minas' })).status === 400);

// tipo "Não enviar": entra na lista de números que não recebem campanhas
const ex0 = psql(`select count(*) from ${T}.campaign_exclusions where phone in (select phone from ${T}.customers where id in (${ids[0]},${ids[1]}))`);
const bo = await api('POST', '/customers/bulk-update', { ids: [ids[0], ids[1]], status: 'optout' });
check('editar em lote para Não enviar', bo.status === 200 && bo.body.updated === 2, JSON.stringify(bo.body));
check('os dois entram na lista de números que não recebem campanhas', ex0 === '0' && psql(`select count(*) from ${T}.campaign_exclusions where phone in (select phone from ${T}.customers where id in (${ids[0]},${ids[1]}))`) === '2');
const fo = (await api('GET', '/customers?status=optout')).body.filter((c) => ids.includes(c.id));
check('filtro Não enviar lista só eles', fo.length === 2 && fo.every((c) => c.campaign_excluded));
check('filtro Leads e Clientes não repetem quem é Não enviar', [(await api('GET', '/customers?status=lead')).body, (await api('GET', '/customers?status=client')).body].every((l) => !l.some((c) => c.id === ids[0] || c.id === ids[1])));
const antes2 = psql(`select status from ${T}.customers where id=${ids[2]}`);
const pu = await api('PUT', '/customers/' + ids[2], { status: 'optout', notes: 'pediu para sair' });
check('editar um contato para Não enviar', pu.status === 200 && pu.body.campaign_excluded === true, JSON.stringify(pu.body));
check('ele continua com o tipo de antes por baixo', psql(`select status from ${T}.customers where id=${ids[2]}`) === antes2);
await api('PUT', '/customers/' + ids[2], { status: 'client' });
check('escolher Cliente de novo libera o envio', psql(`select count(*) from ${T}.campaign_exclusions where phone=(select phone from ${T}.customers where id=${ids[2]})`) === '0');
const ag = await (await fetch(BASE + '/n8n/customers/opt-out', { method: 'POST', headers: { 'content-type': 'application/json', 'x-api-key': 'k', 'x-company-id': String(A.company.id) }, body: JSON.stringify({ phone: '5532999977730', name: 'Pediu Sair' }) })).json();
check('a atendente marca Não enviar', ag.ok === true && psql(`select count(*) from ${T}.campaign_exclusions where phone='553299977730'`) === '1', JSON.stringify(ag));
psql(`delete from ${T}.campaign_exclusions where phone='553299977730'; delete from ${T}.customers where phone='553299977730'`);
// telefone repetido: o painel não deixa cadastrar nem trocar para um número que já existe
const rep = await api('POST', '/customers', { name: 'Repetido', phone: '55329999777' + '00', status: 'lead' });
check('cadastro com telefone repetido é recusado', rep.status === 409 && /Já existe/.test(rep.body?.error || ''), JSON.stringify(rep.body));
const rep9 = await api('POST', '/customers', { name: 'Repetido 9', phone: '(32) 9 9997-7700', status: 'lead' });
check('mesmo número escrito de outro jeito também', rep9.status === 409, JSON.stringify(rep9.body));
const troca = await api('PUT', '/customers/' + ids[1], { phone: '5532999977700' });
check('trocar para telefone de outro contato é recusado', troca.status === 409, JSON.stringify(troca.body));
check('o nome do contato original não foi alterado', psql(`select name from ${T}.customers where id=${ids[0]}`) === 'Lote A');
psql(`delete from ${T}.campaign_exclusions where phone in (select phone from ${T}.customers where id in (${ids.join(',')}))`);
psql(`delete from ${T}.customers where id in (${ids.join(',')})`);
console.log(`${ok} ok, ${fail} falhas`);
process.exit(fail ? 1 : 0);
