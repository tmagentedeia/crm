// Sessão do painel: renova com o uso, não renova acesso temporário nem usuário removido. Uso: BASE=http://localhost:3999 JWT_SECRET=x node test/sessao.mjs
import jwt from 'jsonwebtoken';
const BASE = process.env.BASE || 'http://localhost:3999';
let ok = 0, fail = 0;
const check = (name, cond, extra = '') => { cond ? ok++ : (fail++, console.log('FALHOU:', name, extra)); };
const get = (token) => fetch(BASE + '/api/customers', { headers: { authorization: 'Bearer ' + token } });
const novo = (await (await fetch(BASE + '/api/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: 'demo@demo.com', password: 'demo1234' }) })).json()).token;
const p = jwt.decode(novo);
const exp = (t) => jwt.decode(t).exp - jwt.decode(t).iat;

check('login dura 30 dias', exp(novo) === 30 * 24 * 3600, String(exp(novo)));
const r0 = await get(novo);
check('login recente não renova', r0.status === 200 && !r0.headers.get('x-new-token'));

const velho = jwt.sign({ id: p.id, companyId: p.companyId, role: p.role, iat: Math.floor(Date.now() / 1000) - 2 * 24 * 3600 }, process.env.JWT_SECRET, { expiresIn: '10d' });
const r1 = await get(velho);
const nt = r1.headers.get('x-new-token');
check('login com mais de 1 dia devolve sessão nova', r1.status === 200 && !!nt);
check('sessão nova vale 30 dias e é da mesma pessoa', nt && exp(nt) === 30 * 24 * 3600 && jwt.decode(nt).id === p.id && jwt.decode(nt).companyId === p.companyId);
check('sessão nova funciona', nt && (await get(nt)).status === 200);

const imp = jwt.sign({ id: p.id, companyId: p.companyId, role: p.role, imp: 1, iat: Math.floor(Date.now() / 1000) - 2 * 24 * 3600 }, process.env.JWT_SECRET, { expiresIn: '10d' });
const r2 = await get(imp);
check('acesso temporário do administrador não renova', r2.status === 200 && !r2.headers.get('x-new-token'));

const fantasma = jwt.sign({ id: 99999999, companyId: p.companyId, role: p.role, iat: Math.floor(Date.now() / 1000) - 2 * 24 * 3600 }, process.env.JWT_SECRET, { expiresIn: '10d' });
const r3 = await get(fantasma);
check('usuário que não existe mais não renova', !r3.headers.get('x-new-token'));

const expirado = jwt.sign({ id: p.id, companyId: p.companyId, role: p.role, iat: Math.floor(Date.now() / 1000) - 40 * 24 * 3600 }, process.env.JWT_SECRET, { expiresIn: '30d' });
const r4 = await get(expirado);
const j4 = await r4.json();
check('sessão vencida = 401 com a mensagem esperada pela tela', r4.status === 401 && /Sessão inválida/.test(j4.error));
console.log(`sessao: ${ok} ok, ${fail} falhas`);
process.exit(fail ? 1 : 0);
