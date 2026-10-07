// Alterar senha na tela de login (dono e equipe), sem estar logado. Uso: BASE=http://localhost:3999 node test/senha.mjs
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
const trocar = (email, current, password) => call('POST', '/api/auth/password', { body: { email, current, password } });
const psql = (sql) => execSync(`psql "${process.env.DATABASE_URL}" -tAc "${sql}"`).toString().trim();

// usa o dono da demonstração e devolve a senha original no fim (não cria empresa, para não mexer nos outros testes)
psql("delete from users where email like 'sn-%'");
const EMAIL = 'demo@demo.com', ORIG = 'demo1234', TEMP = 'demo-provisoria-77', NOVA = 'demo-nova-123';
let r0 = await login(EMAIL, ORIG);
if (r0.status !== 200) {   // uma execução anterior parou no meio: volta ao normal antes de começar
  for (const s of [TEMP, NOVA]) if ((await login(EMAIL, s)).status === 200) await trocar(EMAIL, s, ORIG);
  r0 = await login(EMAIL, ORIG);
}
check('dono da demonstração entra', r0.status === 200);
// senha provisória de partida, como a que você entrega ao cliente
check('prepara a senha provisória', (await trocar(EMAIL, ORIG, TEMP)).status === 200);

// ---- o que é recusado ----
check('sem e-mail é recusado', (await trocar('', TEMP, NOVA)).status === 400);
check('sem a senha atual é recusado', (await trocar(EMAIL, '', NOVA)).status === 400);
const errada = await trocar(EMAIL, 'senha-errada-9', NOVA);
const naoExiste = await trocar('ninguem-sn@x.com', TEMP, NOVA);
check('senha atual errada é recusada', errada.status === 401 && /incorretos/.test(errada.body?.error || ''), JSON.stringify(errada.body));
check('e-mail que não existe dá a mesma resposta (não revela cadastro)', naoExiste.status === 401 && naoExiste.body?.error === errada.body?.error, JSON.stringify(naoExiste.body));
check('senha nova curta é recusada', (await trocar(EMAIL, TEMP, '1234567')).status === 400);
check('senha nova igual à atual é recusada', (await trocar(EMAIL, TEMP, TEMP)).status === 400);
check('nada mudou nas tentativas recusadas', (await login(EMAIL, TEMP)).status === 200);

// ---- troca de verdade ----
const t = await trocar(EMAIL.toUpperCase(), TEMP, NOVA);
check('troca com e-mail e senha provisória certos funciona (e-mail sem diferenciar maiúsculas)', t.status === 200 && t.body?.ok === true, JSON.stringify(t.body));
check('não devolve sessão: a pessoa entra com a senha nova', !t.body?.token);
check('a senha provisória deixa de valer', (await login(EMAIL, TEMP)).status === 401);
check('a senha nova passa a valer', (await login(EMAIL, NOVA)).status === 200);

// ---- equipe: mesmo caminho, só com e-mail e senha ----
const dono = (await login(EMAIL, NOVA)).body.token;
const f = (await call('POST', '/api/equipe/funcoes', { token: dono, body: { name: 'Só agenda', telas: ['agenda'], inicio: 'agenda' } })).body;
const eq = await call('POST', '/api/equipe/usuarios', { token: dono, body: { name: 'Ana', email: 'sn-ana@x.com', password: 'senha-ana-001', funcao_id: f.id } });
check('equipe criada com senha provisória', eq.status === 201 || eq.status === 200, JSON.stringify(eq.body));
check('equipe troca a própria senha pela tela de login', (await trocar('sn-ana@x.com', 'senha-ana-001', 'senha-ana-002')).status === 200);
check('equipe: a provisória deixa de valer e a nova vale', (await login('sn-ana@x.com', 'senha-ana-001')).status === 401 && (await login('sn-ana@x.com', 'senha-ana-002')).status === 200);
check('a troca da equipe não mexeu na senha do dono', (await login(EMAIL, NOVA)).status === 200);
psql("update users set active=false where email='sn-ana@x.com'");
check('usuário desativado não consegue trocar a senha', (await trocar('sn-ana@x.com', 'senha-ana-002', 'senha-ana-003')).status === 401);

// devolve a senha original ao dono da demonstração
check('devolve a senha original', (await trocar(EMAIL, NOVA, ORIG)).status === 200 && (await login(EMAIL, ORIG)).status === 200);
psql("delete from users where email like 'sn-%'");
console.log(`senha: ${ok} ok, ${fail} falhas`);
process.exit(fail ? 1 : 0);
