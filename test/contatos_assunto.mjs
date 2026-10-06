// Assunto do contato, tipos de cliente da empresa e a tool "Atualizar Contato" da atendente.
// Uso: BASE=http://localhost:3999 DATABASE_URL=... node test/contatos_assunto.mjs
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
const api = (m, p, body) => call(m, '/api' + p, { token: A.token, body });
const ia = (p, body) => call('POST', '/n8n' + p, { body, h: { 'x-api-key': 'k', 'x-company-id': String(A.company.id) } });
const iaGet = (p) => call('GET', '/n8n' + p, { h: { 'x-api-key': 'k', 'x-company-id': String(A.company.id) } });
const T = `company_${A.company.id}`;

await api('PUT', '/customers/settings', { subject_label: '', kinds: [], labels: { buyer: '', hirer: '' }, agent_registers: false });
let s = (await api('GET', '/customers/settings')).body;
check('padrão: campo se chama Assunto e há comprador e contratante', s.subject_label === 'Assunto' && s.kinds.map((k) => k.label).join() === 'Comprador,Contratante' && s.agent_registers === false, JSON.stringify(s));

s = (await api('PUT', '/customers/settings', { subject_label: 'Interesse', kinds: [{ label: 'Ex-membro' }, { label: 'Parceiro' }], labels: { buyer: 'Quem comprou' } })).body;
check('empresa renomeia o campo e cria tipos', s.subject_label === 'Interesse' && s.kinds.length === 4 && s.kinds[0].label === 'Quem comprou' && s.kinds[2].label === 'Ex-membro' && s.kinds[2].auto === false, JSON.stringify(s));
const chaveParceiro = s.kinds[3].key;
let r = await api('PUT', '/customers/settings', { kinds: [{ label: 'Parceiro' }, { label: 'parceiro' }] });
check('tipo repetido é recusado', r.status === 400, JSON.stringify(r.body));
r = await api('PUT', '/customers/settings', { kinds: [{ label: 'Quem comprou' }] });
check('nome igual ao de um automático é recusado', r.status === 400);
r = await api('PUT', '/customers/settings', { subject_label: 'x'.repeat(41) });
check('nome grande demais é recusado', r.status === 400);

const fone = '5532944' + String(Date.now() % 1000000).padStart(6, '0');
r = await ia('/customers/update-contact', { phone: fone, name: 'Lia Costa', subject: 'interesse no show de 10/10' });
check('atendente cria o contato com assunto', r.status === 201 && r.body.ok && /Interesse: interesse no show/.test(r.body.message) && /Não avise/.test(r.body.message), JSON.stringify(r.body));
const id = r.body.id;
check('assunto gravado', psql(`select subject from ${T}.customers where id=${id}`) === 'interesse no show de 10/10');
r = await ia('/customers/update-contact', { phone: fone, subject: 'quer contratar um show de casamento' });
check('assunto novo substitui o atual', r.status === 200 && psql(`select subject from ${T}.customers where id=${id}`) === 'quer contratar um show de casamento');
const hist = (await api('GET', `/customers/${id}/subjects`)).body;
check('o anterior fica no histórico', hist.length === 2 && hist[1].subject === 'interesse no show de 10/10', JSON.stringify(hist));
r = await ia('/customers/update-contact', { phone: fone, subject: 'quer contratar um show de casamento' });
check('mesmo assunto não repete no histórico', (await api('GET', `/customers/${id}/subjects`)).body.length === 2);
r = await ia('/customers/update-contact', { phone: fone, kind: 'Comprador' });
check('atendente não marca tipo automático', r.body.ok === false && /Tipos disponíveis: Ex-membro, Parceiro/.test(r.body.message), JSON.stringify(r.body));
r = await ia('/customers/update-contact', { phone: fone, kind: 'ex-membro' });
check('atendente marca tipo da empresa (sem diferenciar maiúscula)', r.body.ok === true && psql(`select client_kinds::text from ${T}.customers where id=${id}`).includes('k'), JSON.stringify(r.body));
check('tipo manual não vira cliente sozinho', psql(`select status from ${T}.customers where id=${id}`) === 'lead');
r = await ia('/customers/update-contact', { phone: '123', subject: 'x' });
check('telefone inválido explicado', r.body.ok === false);

// tipos pelo painel e filtro
r = await api('POST', `/customers/${id}/kinds`, { kind: chaveParceiro, on: true });
check('painel liga tipo da empresa', r.status === 200 && r.body.client_kinds.length === 2, JSON.stringify(r.body));
r = await api('GET', `/customers?kind=${chaveParceiro}`);
check('filtro por tipo da empresa', r.body.some((c) => String(c.id) === String(id)));
r = await api('POST', `/customers/${id}/kinds`, { kind: 'inventado', on: true });
check('tipo que não existe é recusado', r.status === 400);
r = await api('PUT', `/customers/${id}`, { subject: 'mudou pelo painel' });
check('equipe edita o assunto', r.status === 200 && r.body.subject === 'mudou pelo painel');
r = await api('GET', '/customers?search=mudou%20pelo');
check('busca acha pelo assunto', r.body.some((c) => String(c.id) === String(id)), JSON.stringify(r.body).slice(0, 120));

// apagar o tipo tira dos contatos
await api('PUT', '/customers/settings', { kinds: [{ label: 'Ex-membro' }] });
check('apagar tipo tira dos contatos', !psql(`select client_kinds::text from ${T}.customers where id=${id}`).includes(chaveParceiro));

// instrução para a atendente vem do painel e só quando ligada
let p = (await iaGet('/agent/prompt')).body;
check('desligado: o prompt não fala em cadastro do contato', !/CADASTRO DO CONTATO/.test(p.prompt || ''));
await api('PUT', '/customers/settings', { agent_registers: true });
p = (await iaGet('/agent/prompt')).body;
check('ligado: o prompt manda usar a tool com o nome do campo', /CADASTRO DO CONTATO/.test(p.prompt) && /campo "Interesse"/.test(p.prompt) && /Ex-membro/.test(p.prompt), (p.prompt || '').slice(0, 200));

await api('PUT', '/customers/settings', { subject_label: '', kinds: [], labels: { buyer: '', hirer: '' }, agent_registers: false });
console.log(`contatos_assunto: ${ok} ok, ${fail} falhas`); process.exit(fail ? 1 : 0);
