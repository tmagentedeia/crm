// Aba Agendamentos do Atendente: lista, edita e cancela as mensagens que ainda vão sair (tabela agendamentos_mensagens).
// Uso: BASE=http://localhost:3999 DATABASE_URL=... node test/agendamentos.mjs
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
const login = async (e, p) => (await call('POST', '/api/auth/login', { body: { email: e, password: p } })).body;
const A = await login('demo@demo.com', 'demo1234');
const t = A.token;

const ADM = '5532991135799';
psql("delete from agendamentos_mensagens");
psql(`update public.companies set whatsapp_instance='tm-ag', admin_phone='(32) 99113-5799', timezone='America/Sao_Paulo' where id=1`);
const ins = (tel, msg, inst, origem, status = 'pendente', nome = 'null') =>
  psql(`insert into agendamentos_mensagens (telefone, mensagem, data_hora_envio, instancia, nome, origem, status) values ('${tel}', '${msg}', now() + interval '2 days', '${inst}', ${nome === 'null' ? 'null' : `'${nome}'`}, ${origem === 'null' ? 'null' : `'${origem}'`}, '${status}') returning id`).split('\n')[0];
const status = (id) => psql(`select status from agendamentos_mensagens where id=${id}`);

const pessoal = ins(ADM, 'Lembrete: pagar o boleto', 'tm-ag', 'null');
const contato = ins('553288887777', 'Oi Maria, confirmando amanha', 'tm-ag', 'null', 'pendente', 'Maria Souza');
const cliente = ins('553277776666', 'Lembrete do cliente', 'tm-ag', 'lembrete_cliente', 'pendente', 'Joao');
const delivery = ins('553211112222', 'Seu pedido saiu', 'tm-ag', 'delivery');
const indic = ins(ADM, 'Lembrete de desconto', 'tm-ag', 'indicacao_m2');
const outra = ins('553299990000', 'De outra instancia', 'tm-outra', 'null');
const enviado = ins('553244445555', 'Ja enviado', 'tm-ag', 'null', 'enviado');

check('sem login: 401', (await call('GET', '/api/scheduled-messages')).status === 401);

let l = await call('GET', '/api/scheduled-messages', { token: t });
const ids = (l.body?.items || []).map((x) => x.id);
check('lista só os 3 tipos pendentes da própria instância', l.status === 200 && ids.length === 3 && [pessoal, contato, cliente].every((i) => ids.includes(i)), JSON.stringify(ids));
check('não mostra aviso do painel, outra instância nem enviado', ![delivery, indic, outra, enviado].some((i) => ids.includes(i)));
const tipo = (id) => l.body.items.find((x) => x.id === id)?.tipo;
check('tipos: pessoal, contato e cliente', tipo(pessoal) === 'pessoal' && tipo(contato) === 'contato' && tipo(cliente) === 'cliente', [tipo(pessoal), tipo(contato), tipo(cliente)].join());
check('traz nome e telefone', l.body.items.find((x) => x.id === contato).nome === 'Maria Souza' && l.body.items.find((x) => x.id === contato).phone === '553288887777');

// editar
let r = await call('PUT', '/api/scheduled-messages/' + contato, { token: t, body: { send_at: '2099-01-15T10:30', text: '  Novo texto  ' } });
check('edita data e texto', r.status === 200 && r.body.text === 'Novo texto', JSON.stringify(r.body));
check('data gravada no horário da empresa', psql(`select to_char(data_hora_envio at time zone 'America/Sao_Paulo','YYYY-MM-DD HH24:MI') from agendamentos_mensagens where id=${contato}`) === '2099-01-15 10:30');
check('texto gravado sem espaços nas pontas', psql(`select mensagem from agendamentos_mensagens where id=${contato}`) === 'Novo texto');
check('só o texto: mantém a data', (await call('PUT', '/api/scheduled-messages/' + contato, { token: t, body: { text: 'Outro texto' } })).status === 200
  && psql(`select to_char(data_hora_envio at time zone 'America/Sao_Paulo','YYYY-MM-DD HH24:MI') from agendamentos_mensagens where id=${contato}`) === '2099-01-15 10:30');
check('só a data: mantém o texto', (await call('PUT', '/api/scheduled-messages/' + contato, { token: t, body: { send_at: '2099-02-01T08:00' } })).status === 200
  && psql(`select mensagem from agendamentos_mensagens where id=${contato}`) === 'Outro texto');
check('data no passado é recusada', (await call('PUT', '/api/scheduled-messages/' + contato, { token: t, body: { send_at: '2020-01-01T10:00' } })).status === 400);
check('data inválida é recusada', (await call('PUT', '/api/scheduled-messages/' + contato, { token: t, body: { send_at: 'amanhã' } })).status === 400);
check('texto vazio é recusado', (await call('PUT', '/api/scheduled-messages/' + contato, { token: t, body: { text: '   ' } })).status === 400);
check('texto grande demais é recusado', (await call('PUT', '/api/scheduled-messages/' + contato, { token: t, body: { text: 'a'.repeat(4001) } })).status === 400);
check('sem nada para alterar: 400', (await call('PUT', '/api/scheduled-messages/' + contato, { token: t, body: {} })).status === 400);
check('apóstrofo e aspas no texto passam inteiros', (await call('PUT', '/api/scheduled-messages/' + contato, { token: t, body: { text: `d'Água "ok"; drop table x;--` } })).status === 200
  && psql(`select mensagem from agendamentos_mensagens where id=${contato}`) === `d'Água "ok"; drop table x;--`);

// o que não é da empresa ou não é pendente não muda
const antes = psql(`select mensagem from agendamentos_mensagens where id=${outra}`);
check('outra instância: não edita (409)', (await call('PUT', '/api/scheduled-messages/' + outra, { token: t, body: { text: 'invasão' } })).status === 409 && psql(`select mensagem from agendamentos_mensagens where id=${outra}`) === antes);
check('aviso do painel: não edita', (await call('PUT', '/api/scheduled-messages/' + delivery, { token: t, body: { text: 'x' } })).status === 409);
check('já enviado: não edita', (await call('PUT', '/api/scheduled-messages/' + enviado, { token: t, body: { text: 'x' } })).status === 409);
check('outra instância: não cancela (409)', (await call('POST', `/api/scheduled-messages/${outra}/cancel`, { token: t })).status === 409 && status(outra) === 'pendente');
check('aviso do painel: não cancela', (await call('POST', `/api/scheduled-messages/${indic}/cancel`, { token: t })).status === 409 && status(indic) === 'pendente');
check('id que não é número: 400', (await call('POST', '/api/scheduled-messages/abc/cancel', { token: t })).status === 400);

// cancelar um
r = await call('POST', `/api/scheduled-messages/${pessoal}/cancel`, { token: t });
check('cancela um', r.status === 200 && status(pessoal) === 'cancelado');
check('cancelar de novo: 409', (await call('POST', `/api/scheduled-messages/${pessoal}/cancel`, { token: t })).status === 409);
check('cancelado não pode ser editado', (await call('PUT', '/api/scheduled-messages/' + pessoal, { token: t, body: { text: 'x' } })).status === 409);

// cancelar em massa: só o que é da empresa e está pendente
const outro2 = ins('553255554444', 'Outro contato', 'tm-ag', 'null');
r = await call('POST', '/api/scheduled-messages/bulk-cancel', { token: t, body: { ids: [contato, cliente, outro2, outra, delivery, enviado, pessoal, 'x', -5] } });
check('em massa cancela só o permitido', r.status === 200 && r.body.cancelled === 3 && [contato, cliente, outro2].every((i) => r.body.ids.includes(i)), JSON.stringify(r.body));
check('em massa: outros ficam como estavam', status(outra) === 'pendente' && status(delivery) === 'pendente' && status(enviado) === 'enviado');
check('em massa sem itens: 400', (await call('POST', '/api/scheduled-messages/bulk-cancel', { token: t, body: { ids: [] } })).status === 400);
l = await call('GET', '/api/scheduled-messages', { token: t });
check('depois de cancelar a lista fica vazia', l.status === 200 && l.body.items.length === 0, JSON.stringify(l.body));

// empresa sem instância ligada
psql(`update public.companies set whatsapp_instance=null where id=1`);
check('sem instância: avisa em vez de listar tudo (409)', (await call('GET', '/api/scheduled-messages', { token: t })).status === 409);
psql(`update public.companies set whatsapp_instance='tm-ag' where id=1`);

psql("delete from agendamentos_mensagens");
console.log(`${ok} ok, ${fail} falhas`);
process.exit(fail ? 1 : 0);
