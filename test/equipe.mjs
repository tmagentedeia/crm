// Funções e acessos da equipe. Uso: BASE=http://localhost:3999 node test/equipe.mjs
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
psql("delete from users where email like 'eq-%'; delete from company_funcoes");
const A = (await call('POST', '/api/auth/login', { body: { email: 'demo@demo.com', password: 'demo1234' } })).body;
const B = (await call('POST', '/api/auth/login', { body: { email: 'dois@x.com', password: 'senhasenha' } })).body;
const api = (m, p, body) => call(m, '/api' + p, { token: A.token, body });

// ---- dono monta a equipe ----
const eq = (await api('GET', '/equipe')).body;
check('funções padrão nascem', eq.funcoes.length >= 3 && eq.funcoes.some((f) => f.name === 'Recepção'));
check('dono aparece na lista', eq.usuarios.some((u) => u.role === 'owner'));
const rec = eq.funcoes.find((f) => f.name === 'Recepção');
check('sem nome é recusado', (await api('POST', '/equipe/funcoes', { name: ' ', telas: [] })).status === 400);
const f1 = (await api('POST', '/equipe/funcoes', { name: 'Só agenda', telas: ['agenda', 'tela_que_nao_existe'], inicio: 'agenda' })).body;
check('função criada ignora tela desconhecida', JSON.stringify(f1.telas) === '["agenda"]' && f1.inicio === 'agenda');
check('nome repetido recusado', (await api('POST', '/equipe/funcoes', { name: 'Só agenda', telas: [] })).status === 409);
check('senha curta recusada', (await api('POST', '/equipe/usuarios', { name: 'Ana', email: 'eq-ana@x.com', password: '123', funcao_id: f1.id })).status === 400);
check('função de outra empresa recusada', (await api('POST', '/equipe/usuarios', { name: 'Ana', email: 'eq-ana@x.com', password: 'senha1234', funcao_id: 999999 })).status === 400);
const ana = (await api('POST', '/equipe/usuarios', { name: 'Ana', email: 'eq-ana@x.com', password: 'senha1234', funcao_id: f1.id })).body;
check('pessoa criada como equipe', ana.role === 'staff' && ana.active);
check('e-mail repetido recusado', (await api('POST', '/equipe/usuarios', { name: 'Ana 2', email: 'EQ-ana@x.com', password: 'senha1234', funcao_id: f1.id })).status === 409);

// ---- a pessoa da equipe ----
const L = (await call('POST', '/api/auth/login', { body: { email: 'eq-ana@x.com', password: 'senha1234' } })).body;
const S = (m, p, body) => call(m, '/api' + p, { token: L.token, body });
check('equipe entra', !!L.token && L.user.role === 'staff');
const me = (await S('GET', '/me')).body;
check('/me traz as telas e a tela inicial', JSON.stringify(me.equipe.telas) === '["agenda"]' && me.equipe.inicio === 'agenda' && me.equipe.funcao === 'Só agenda');
check('abre a agenda', (await S('GET', '/appointments')).status === 200);
check('lê profissionais e serviços para a agenda', (await S('GET', '/professionals')).status === 200 && (await S('GET', '/services')).status === 200);
check('não altera profissionais', (await S('POST', '/professionals', { name: 'X' })).status === 403);
check('não abre recebimentos', (await S('GET', '/payments')).status === 403);
check('não abre delivery', (await S('GET', '/delivery/orders')).status === 403);
check('não abre comissões', (await S('GET', '/commissions/settings')).status === 403);
check('não altera dados da empresa', (await S('PUT', '/company', { name: 'Hackeada' })).status === 403);
check('lê dados da empresa', (await S('GET', '/company')).status === 200);
check('não mexe na equipe', (await S('GET', '/equipe')).status === 403 && (await S('POST', '/equipe/usuarios', { name: 'Z', email: 'eq-z@x.com', password: 'senha1234' })).status === 403);
check('não entra na administração', (await S('GET', '/admin/version')).status === 403);
check('não abre bloqueios', (await S('GET', '/blocks')).status === 403);
check('rota desconhecida é recusada', (await S('GET', '/qualquer-coisa')).status === 403);

// ---- exceção por pessoa ----
await api('PUT', '/equipe/usuarios/' + ana.id, { telas_proprias: ['agenda', 'financeiro'] });
check('exceção vale na hora', (await S('GET', '/payments')).status === 200);
await api('PUT', '/equipe/usuarios/' + ana.id, { telas_proprias: null });
check('voltar à lista da função tira a exceção', (await S('GET', '/payments')).status === 403);
// mudar a função muda o acesso de quem a tem
await api('PUT', '/equipe/funcoes/' + f1.id, { name: 'Só agenda', telas: ['agenda', 'delivery'], inicio: 'delivery' });
check('mudar a função vale para quem a tem', (await S('GET', '/delivery/orders')).status === 200 && (await S('GET', '/me')).body.equipe.inicio === 'delivery');
check('não apaga função em uso', (await api('DELETE', '/equipe/funcoes/' + f1.id)).status === 409);

// ---- desativar e isolamento ----
await api('PUT', '/equipe/usuarios/' + ana.id, { active: false });
check('desativada perde o acesso na hora', (await S('GET', '/appointments')).status === 401);
check('desativada não entra', (await call('POST', '/api/auth/login', { body: { email: 'eq-ana@x.com', password: 'senha1234' } })).status === 401);
await api('PUT', '/equipe/usuarios/' + ana.id, { active: true });
check('reativada volta', (await S('GET', '/appointments')).status === 200);
check('outra empresa não vê a equipe', !(await call('GET', '/api/equipe', { token: B.token })).body.usuarios.some((u) => u.email === 'eq-ana@x.com'));
check('outra empresa não mexe na pessoa', (await call('PUT', '/api/equipe/usuarios/' + ana.id, { token: B.token, body: { active: false } })).status === 404);
check('não muda o dono', (await api('PUT', '/equipe/usuarios/' + eq.usuarios.find((u) => u.role === 'owner').id, { active: false })).status === 400);
check('dono segue com tudo', (await api('GET', '/payments')).status === 200);
check('apaga a pessoa', (await api('DELETE', '/equipe/usuarios/' + ana.id)).status === 200 && (await S('GET', '/appointments')).status === 401);
console.log(`equipe: ${ok} ok, ${fail} falhas`);
process.exit(fail ? 1 : 0);
