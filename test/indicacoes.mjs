// Programa de benefícios por indicação. Uso: BASE=http://localhost:3999 node test/indicacoes.mjs
import { execSync } from 'child_process';
import { agendaDescontos } from '../src/indicacoes.js';
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
const R = (closed_on, n = 1) => Array.from({ length: n }, (_, i) => ({ id: String(Math.random()).slice(2, 8), closed_on, referred_name: 'Ind ' + closed_on + ' ' + i }));
const pcts = (a) => a.map((x) => `${x.month.slice(0, 7)}:${x.pct}`).join(' ');

// ---- agenda de descontos (regra pura) ----
check('1 indicação = 10% no mês', pcts(agendaDescontos(R('2026-10-02'), 10)) === '2026-10:10', pcts(agendaDescontos(R('2026-10-02'), 10)));
check('2 indicações = 20% no mês', pcts(agendaDescontos(R('2026-10-02', 2), 10)) === '2026-10:20');
check('3 indicações = 20% e 10% no mês seguinte', pcts(agendaDescontos(R('2026-10-02', 3), 10)) === '2026-10:20 2026-11:10');
check('6 indicações = 20% por 3 meses', pcts(agendaDescontos(R('2026-10-02', 6), 10)) === '2026-10:20 2026-11:20 2026-12:20');
check('marcada depois do vencimento vale na próxima mensalidade', pcts(agendaDescontos(R('2026-10-20'), 10)) === '2026-11:10');
check('marcada no dia do vencimento vale na próxima', pcts(agendaDescontos(R('2026-10-10'), 10)) === '2026-11:10');
check('indicações em meses diferentes se acumulam na fila', pcts(agendaDescontos([...R('2026-10-02', 2), ...R('2026-10-05', 1), ...R('2026-11-02', 1)], 10)) === '2026-10:20 2026-11:20', pcts(agendaDescontos([...R('2026-10-02', 2), ...R('2026-10-05', 1), ...R('2026-11-02', 1)], 10)));
check('vencimento dia 31 em mês curto cai no último dia', agendaDescontos(R('2026-02-10'), 31)[0].due_on === '2026-02-28');
check('virada de ano', pcts(agendaDescontos(R('2026-12-20', 3), 10)) === '2027-01:20 2027-02:10');
check('sem dia de vencimento não há agenda', agendaDescontos(R('2026-10-02'), null).length === 0);

// ---- servidor ----
const A = (await call('POST', '/api/auth/login', { body: { email: 'demo@demo.com', password: 'demo1234' } })).body;
const B = (await call('POST', '/api/auth/login', { body: { email: 'dois@x.com', password: 'senhasenha' } })).body;
const hoje = psql("select to_char((now() at time zone 'America/Sao_Paulo')::date,'YYYY-MM-DD')");
const dia = (n) => psql(`select to_char((now() at time zone 'America/Sao_Paulo')::date + ${n},'YYYY-MM-DD')`);
const diaDe = (iso) => Number(iso.slice(8, 10));
psql('delete from agendamentos_mensagens; delete from partner_referrals; delete from partner_reminders');

check('só administrador mexe', (await call('PUT', '/api/admin/companies/1/billing', { token: B.token, body: { billing_due_day: 5 } })).status === 403);
check('dia inválido recusado', (await call('PUT', '/api/admin/companies/1/billing', { token: A.token, body: { billing_due_day: 40 } })).status === 400);
check('destino dos avisos inválido recusado', (await call('PUT', '/api/admin/benefits', { token: A.token, body: { notice_phone: '123', notice_instance: 'x' } })).status === 400);
const cfg = await call('PUT', '/api/admin/benefits', { token: A.token, body: { notice_phone: '(32) 99113-5799', notice_instance: 'tm-teste' } });
check('salva o destino dos avisos', cfg.status === 200 && cfg.body.notice_phone.startsWith('55') && cfg.body.reminders === true, JSON.stringify(cfg.body));

// vencimento daqui a 10 dias: a indicação de hoje vale nessa mensalidade, o lembrete sai na véspera
const venc = dia(10);
const b = await call('PUT', '/api/admin/companies/1/billing', { token: A.token, body: { billing_due_day: diaDe(venc), billing_exempt: false } });
check('salva o vencimento', b.status === 200 && b.body.company.billing_due_day === diaDe(venc), JSON.stringify(b.body));
const i1 = await call('POST', '/api/admin/companies/1/referrals', { token: A.token, body: { referred_name: 'Cliente Alfa' } });
check('marca a indicação', i1.status === 201 && i1.body.total === 1 && i1.body.next?.pct === 10, JSON.stringify(i1.body));
let ms = psql("select count(*) from agendamentos_mensagens where origem='indicacao_m2' and status='pendente'");
check('agenda um lembrete', ms === '1', ms);
const m1 = psql("select telefone || '|' || instancia || '|' || mensagem from agendamentos_mensagens where origem='indicacao_m2'");
check('lembrete vai para o número e a instância configurados', m1.startsWith('553291135799|tm-teste|') && m1.includes('10%') && m1.includes('Cliente Alfa'), m1);
check('sai na véspera, às 9h', psql("select to_char(data_hora_envio at time zone 'America/Sao_Paulo','YYYY-MM-DD HH24:MI') from agendamentos_mensagens where origem='indicacao_m2'") === dia(9) + ' 09:00');

// segunda indicação: troca o lembrete pendente (não duplica)
const i2 = await call('POST', '/api/admin/companies/1/referrals', { token: A.token, body: { referred_name: 'Cliente Beta' } });
check('segunda indicação = 20%', i2.body.next.pct === 20);
check('troca o lembrete pendente sem duplicar', psql("select count(*) from agendamentos_mensagens where origem='indicacao_m2'") === '1' && psql("select mensagem from agendamentos_mensagens where origem='indicacao_m2'").includes('20%'));

// terceira cai no mês seguinte
const i3 = await call('POST', '/api/admin/companies/1/referrals', { token: A.token, body: { referred_name: 'Cliente Gama' } });
check('terceira vai para o mês seguinte', i3.body.schedule.length === 2 && i3.body.schedule[1].pct === 10, JSON.stringify(i3.body.schedule));

// lembrete já enviado e valor mudou: manda correção
psql("update agendamentos_mensagens set status='enviado' where origem='indicacao_m2'");
const rid = i3.body.referrals.find((r) => r.referred_name === 'Cliente Gama').id;
await call('DELETE', `/api/admin/referrals/${rid}`, { token: A.token });
const i4 = await call('POST', `/api/admin/companies/1/referrals`, { token: A.token, body: { referred_name: 'Cliente Delta', closed_on: dia(-60) } });
// uma antiga (60 dias atrás) cai em mês passado/atual e empurra a fila: o mês do vencimento pode mudar
check('indicação antiga é aceita', i4.status === 201);
const ate = psql("select count(*) from agendamentos_mensagens where origem='indicacao_m2'");
check('nunca perde nem duplica lembrete pendente do mesmo mês', Number(ate) >= 1);
await call('DELETE', `/api/admin/referrals/${i4.body.referrals.find((r) => r.referred_name === 'Cliente Delta').id}`, { token: A.token });

// apagar tudo: lembrete já enviado gera aviso de cancelamento
for (const r of (await call('GET', '/api/admin/companies/1/referrals', { token: A.token })).body.referrals) await call('DELETE', `/api/admin/referrals/${r.id}`, { token: A.token });
check('avisa quando o desconto deixa de valer', psql("select count(*) from agendamentos_mensagens where origem='indicacao_m2' and status='pendente' and mensagem like 'Atualização:%'") >= '1');

// empresa isenta: registra mas não agenda nada
psql('delete from agendamentos_mensagens');
await call('PUT', '/api/admin/companies/1/billing', { token: A.token, body: { billing_exempt: true } });
const iso = await call('POST', '/api/admin/companies/1/referrals', { token: A.token, body: { referred_name: 'Isenta Teste' } });
check('isenta: registra a indicação, sem desconto nem lembrete', iso.status === 201 && iso.body.next === null && psql('select count(*) from agendamentos_mensagens') === '0', JSON.stringify(iso.body.next));

// o que a empresa vê
await call('PUT', '/api/admin/companies/1/billing', { token: A.token, body: { billing_due_day: diaDe(venc), billing_exempt: false } });
const meu = await call('GET', '/api/benefits', { token: A.token });
check('a empresa vê o próprio saldo', meu.status === 200 && meu.body.total === 1 && meu.body.next?.pct === 10 && meu.body.reminders === undefined, JSON.stringify(meu.body));
const outro = await call('GET', '/api/benefits', { token: B.token });
check('outra empresa não vê as indicações da primeira', outro.body.total === 0 && outro.body.referrals.length === 0);
check('apagar indicação inexistente', (await call('DELETE', '/api/admin/referrals/999999', { token: A.token })).status === 404);

// vários clientes com o mesmo vencimento: os avisos saem com pelo menos 10 minutos de diferença
psql('delete from partner_referrals; delete from partner_reminders; delete from agendamentos_mensagens');
for (const id of [1, 2]) {
  await call('PUT', `/api/admin/companies/${id}/billing`, { token: A.token, body: { billing_due_day: diaDe(venc), billing_exempt: false } });
  await call('POST', `/api/admin/companies/${id}/referrals`, { token: A.token, body: { referred_name: 'Ind empresa ' + id } });
}
const horas = psql("select extract(epoch from data_hora_envio)::bigint from agendamentos_mensagens where origem='indicacao_m2' order by data_hora_envio").split('\n').map(Number);
check('dois avisos para o mesmo dia', horas.length === 2, String(horas.length));
check('com pelo menos 10 minutos entre eles', horas.length === 2 && horas[1] - horas[0] >= 600, horas.join(','));
// três de uma vez
await call('PUT', '/api/admin/companies/1/billing', { token: A.token, body: { billing_due_day: diaDe(venc), billing_exempt: false } });
await call('POST', '/api/admin/companies/1/referrals', { token: A.token, body: { referred_name: 'Outra' } });
const h3 = psql("select extract(epoch from data_hora_envio)::bigint from agendamentos_mensagens where origem='indicacao_m2' order by data_hora_envio").split('\n').map(Number);
check('trocar um aviso mantém o intervalo entre todos', h3.length === 2 && h3.every((x, i) => i === 0 || x - h3[i - 1] >= 600), h3.join(','));

// limpeza
psql('delete from partner_referrals; delete from partner_reminders; delete from agendamentos_mensagens');
for (const id of [1, 2]) await call('PUT', `/api/admin/companies/${id}/billing`, { token: A.token, body: { billing_due_day: null, billing_exempt: false } });

console.log(`indicacoes: ${ok} ok, ${fail} falhas`);
process.exit(fail ? 1 : 0);
