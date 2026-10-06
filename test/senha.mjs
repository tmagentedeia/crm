// Cada pessoa troca a própria senha (dono e equipe). Uso: BASE=http://localhost:3999 JWT_SECRET=x node test/senha.mjs
import jwt from 'jsonwebtoken';
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
const login = (email, password) => call('POST', '/api/auth/login', { body: { email, password } });
const trocar = (token, current, password) => call('POST', '/api/auth/password', { token, body: { current, password } });
const psql = (sql) => execSync(`psql "${process.env.DATABASE_URL}" -tAc "${sql}"`).toString().trim();

// usa o dono da demonstração e devolve a senha original no fim (não cria empresa, para não mexer nos outros testes)
psql("delete from users where email like 'sn-%'");
const ORIG = 'demo1234', TEMP = 'demo-antiga-77';
let r0 = await login('demo@demo.com', ORIG);
if (r0.status !== 200) {   // uma execução anterior parou no meio: volta ao normal antes de começar
  const sobra = await login('demo@demo.com', 'demo-nova-123');
  if (sobra.status === 200) await trocar(sobra.body.token, 'demo-nova-123', ORIG);
  r0 = await login('demo@demo.com', ORIG);
}
check('dono da demonstração entra', r0.status === 200);
const dono = r0.body.token;
// prepara uma senha de partida diferente da original, para provar a troca de ponta a ponta
check('prepara a senha de partida', (await trocar(dono, ORIG, TEMP)).status === 200);

check('sem login é recusado', (await call('POST', '/api/auth/password', { body: { current: 'a', password: 'demo-nova-123' } })).status === 401);
check('sem a senha atual é recusado', (await trocar(dono, '', 'demo-nova-123')).status === 400);
const errada = await trocar(dono, 'senha-errada-9', 'demo-nova-123');
check('senha atual errada é recusada', errada.status === 400 && /atual está incorreta/.test(errada.body?.error || ''), JSON.stringify(errada.body));
check('senha nova curta é recusada', (await trocar(dono, 'demo-antiga-77', '1234567')).status === 400);
check('senha nova igual à atual é recusada', (await trocar(dono, 'demo-antiga-77', 'demo-antiga-77')).status === 400);
check('nada mudou nas tentativas recusadas', (await login('demo@demo.com', 'demo-antiga-77')).status === 200);

const ok1 = await trocar(dono, 'demo-antiga-77', 'demo-nova-123');
check('troca com a senha atual certa funciona', ok1.status === 200 && ok1.body.ok === true && !!ok1.body.token, JSON.stringify(ok1.body));
check('o token devolvido é da mesma pessoa', jwt.decode(ok1.body.token)?.id === jwt.decode(dono).id);
check('a senha antiga deixa de valer', (await login('demo@demo.com', 'demo-antiga-77')).status === 401);
check('a senha nova passa a valer', (await login('demo@demo.com', 'demo-nova-123')).status === 200);
check('a sessão continua funcionando', (await call('GET', '/api/company', { token: ok1.body.token })).status === 200);

// acesso temporário do administrador: não troca a senha de quem não é ele
const p = jwt.decode(dono);
const imp = jwt.sign({ id: p.id, companyId: p.companyId, role: p.role, imp: 1 }, process.env.JWT_SECRET, { expiresIn: '1h' });
const viaAdmin = await trocar(imp, 'demo-nova-123', 'demo-outra-456');
check('administrador em "Abrir painel" não troca a senha', viaAdmin.status === 403, JSON.stringify(viaAdmin.body));
check('e a senha continua a mesma', (await login('demo@demo.com', 'demo-nova-123')).status === 200);

// pessoa da equipe troca a própria senha, mesmo sem acesso a nenhuma tela de configuração
const f = (await call('POST', '/api/equipe/funcoes', { token: dono, body: { name: 'Só agenda', telas: ['agenda'], inicio: 'agenda' } })).body;
const eq = await call('POST', '/api/equipe/usuarios', { token: dono, body: { name: 'Ana', email: 'sn-ana@x.com', password: 'senha-ana-001', funcao_id: f.id } });
check('equipe criada', eq.status === 201 || eq.status === 200, JSON.stringify(eq.body));
const ana = (await login('sn-ana@x.com', 'senha-ana-001')).body;
check('equipe sem tela de configuração continua barrada nelas', (await call('PUT', '/api/company', { token: ana.token, body: { name: 'x' } })).status === 403);
check('equipe com senha atual errada é recusada', (await trocar(ana.token, 'senha-errada-9', 'senha-ana-002')).status === 400);
const anaOk = await trocar(ana.token, 'senha-ana-001', 'senha-ana-002');
check('equipe troca a própria senha', anaOk.status === 200, JSON.stringify(anaOk.body));
check('equipe: senha antiga deixa de valer e a nova vale', (await login('sn-ana@x.com', 'senha-ana-001')).status === 401 && (await login('sn-ana@x.com', 'senha-ana-002')).status === 200);
check('a troca da equipe não mexeu na senha do dono', (await login('demo@demo.com', 'demo-nova-123')).status === 200);

// devolve a senha original ao dono da demonstração
const volta = await login('demo@demo.com', 'demo-nova-123');
check('devolve a senha original', (await trocar(volta.body.token, 'demo-nova-123', ORIG)).status === 200 && (await login('demo@demo.com', ORIG)).status === 200);
psql("delete from users where email like 'sn-%'");
console.log(`senha: ${ok} ok, ${fail} falhas`);
process.exit(fail ? 1 : 0);
