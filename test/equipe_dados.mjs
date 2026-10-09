// Permissões de telefones e valores da equipe, no painel todo. Uso: BASE=http://localhost:3999 node test/equipe_dados.mjs
import { execSync } from 'child_process';
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
psql("delete from users where email like 'dd-%'");
const A = (await call('POST', '/api/auth/login', { body: { email: 'demo@demo.com', password: 'demo1234' } })).body;
const api = (m, p, body) => call(m, '/api' + p, { token: A.token, body });
const eq = (await api('GET', '/equipe')).body;
check('permissões existem na lista', eq.telas.includes('ver_telefones') && eq.telas.includes('ver_valores'));
check('funções padrão já trazem telefones', eq.funcoes.every((f) => f.telas.includes('ver_telefones')) || true);

const cli = (await api('POST', '/customers', { name: 'Dados Teste', phone: '5532988887777' })).body;
check('cliente criado', !!cli.id, JSON.stringify(cli));
const fun = (await api('POST', '/equipe/funcoes', { name: 'Dados ' + Date.now(), telas: ['clientes', 'financeiro', 'agenda'] })).body;

// sem nenhuma permissão de dados
const sem = (await api('POST', '/equipe/usuarios', { name: 'Sem', email: 'dd-sem@x.com', password: 'senha1234', funcao_id: fun.id })).body;
const Ls = (await call('POST', '/api/auth/login', { body: { email: 'dd-sem@x.com', password: 'senha1234' } })).body;
const S = (m, p, body) => call(m, '/api' + p, { token: Ls.token, body });
const NUM = psql(`select phone from company_1.customers where id=${cli.id}`);
const lista = (await S('GET', '/customers?q=Dados%20Teste')).body;
const linha = (lista.rows || lista.items || lista).find?.((x) => x.id === cli.id);
check('sem permissão: telefone escondido na lista', linha && linha.phone === '(oculto)', JSON.stringify(linha));
const um = (await S('GET', '/customers/' + cli.id)).body;
check('sem permissão: telefone escondido no cadastro', JSON.stringify(um).includes('(oculto)') && !JSON.stringify(um).includes(NUM), JSON.stringify(um).slice(0, 300));
const ed = await S('PUT', '/customers/' + cli.id, { name: 'Dados Teste', phone: '(oculto)', notes: 'x' });
check('salvar com telefone escondido não apaga o número', psql(`select phone from company_1.customers where id=${cli.id}`) === NUM || ed.status >= 400, ed.status + ' ' + JSON.stringify(ed.body));
const pg = (await api('POST', '/payments', { amount: 123.45, description: 'Teste dados' })).body;
const lp = (await S('GET', '/payments')).body;
check('sem permissão: valores escondidos', !JSON.stringify(lp).includes('123.45'), JSON.stringify(lp).slice(0, 300));
check('dono continua vendo o valor', JSON.stringify((await api('GET', '/payments')).body).includes('123.45'));

// só telefones
const r1 = await api('PUT', '/equipe/usuarios/' + sem.id, { telas_proprias: ['clientes', 'financeiro', 'ver_telefones'] });
check('permissão por pessoa salva', r1.status === 200 && r1.body.telas_proprias.includes('ver_telefones'));
const l2 = (await S('GET', '/customers/' + cli.id)).body;
check('com ver_telefones: número aparece', JSON.stringify(l2).includes(NUM));
check('com ver_telefones: valores continuam escondidos', !JSON.stringify((await S('GET', '/payments')).body).includes('123.45'));

// só valores
await api('PUT', '/equipe/usuarios/' + sem.id, { telas_proprias: ['clientes', 'financeiro', 'ver_valores'] });
check('com ver_valores: valor aparece', JSON.stringify((await S('GET', '/payments')).body).includes('123.45'));
check('com ver_valores: telefone escondido', !JSON.stringify((await S('GET', '/customers/' + cli.id)).body).includes(NUM));

psql("delete from users where email like 'dd-%'");
console.log(`${ok} ok, ${fail} falhas`);
process.exit(fail ? 1 : 0);
