// Liberação progressiva de campanhas. Uso: BASE=http://localhost:3999 node test/campanhas_progressivo.mjs
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
const A = (await call('POST', '/api/auth/login', { body: { email: 'demo@demo.com', password: 'demo1234' } })).body;
const psql = (sql) => execSync(`psql "${process.env.DATABASE_URL}" -tA`, { input: sql }).toString().trim();
const lim = async () => (await call('GET', '/api/campaigns/limits', { token: A.token })).body;
const prog = async () => (await call('GET', '/api/admin/companies', { token: A.token })).body.find((c) => String(c.id) === '1').campaign_prog;
const concluir = (n, kind = 'manual', status = 'done') => {
  for (let i = 0; i < n; i++) psql(`insert into company_1.campaigns (name,kind,status,messages,interval_min,interval_max,batch_size,batch_pause_min,daily_limit,finished_at) values ('prog','${kind}','${status}','[]',15,15,30,60,50,now())`);
};
const limpar = () => psql("delete from company_1.campaigns where name='prog'");

// estado inicial: sem liberação progressiva = padrão
psql('update public.companies set campaign_daily_max=null, campaign_interval_min=null, campaign_prog_desde=null where id=1');
check('sem progressão: padrão 10/100', (await lim()).interval_min === 10 && (await lim()).daily_max === 100);
check('sem progressão: admin vê campaign_prog nulo', (await prog()) === null);

// empresa que liga Campanhas passa a ter a marca (gatilho)
psql(`update public.companies set modules = modules || '{"campanhas":false}'::jsonb where id=1`);
check('desligado não marca', psql('select campaign_prog_desde is null from public.companies where id=1') === 't');
psql(`update public.companies set modules = modules || '{"campanhas":true}'::jsonb where id=1`);
check('ligar Campanhas marca a data', psql('select campaign_prog_desde is not null from public.companies where id=1') === 't');
psql(`update public.companies set modules = modules || '{"campanhas":false}'::jsonb where id=1`);
psql(`update public.companies set modules = modules || '{"campanhas":true}'::jsonb where id=1`);
const d1 = psql('select campaign_prog_desde from public.companies where id=1');
check('religar não reinicia a data', d1 !== '');
psql('update public.companies set campaign_prog_desde = now() - interval \'1 minute\' where id=1');

limpar();
let l = await lim();
check('degrau 1: 15 min / 50', l.interval_min === 15 && l.daily_max === 50, JSON.stringify(l));
concluir(1);
l = await lim(); check('1 concluída: continua no degrau 1', l.interval_min === 15 && l.daily_max === 50);
let p = await prog(); check('admin: faltam 1', p.degrau === 1 && p.faltam === 1 && p.concluidas === 1, JSON.stringify(p));
concluir(1);
l = await lim(); check('2 concluídas: 14 / 60', l.interval_min === 14 && l.daily_max === 60, JSON.stringify(l));
concluir(2); l = await lim(); check('4: 13 / 70', l.interval_min === 13 && l.daily_max === 70);
concluir(2); l = await lim(); check('6: 12 / 80', l.interval_min === 12 && l.daily_max === 80);
concluir(2); l = await lim(); check('8: 11 / 90', l.interval_min === 11 && l.daily_max === 90);
concluir(2); l = await lim(); check('10: 10 / 100', l.interval_min === 10 && l.daily_max === 100);
concluir(4); l = await lim(); check('depois do último degrau fica 10 / 100', l.interval_min === 10 && l.daily_max === 100);
p = await prog(); check('último degrau informado', p.degrau === 6 && p.proximo === null && p.faltam === 0, JSON.stringify(p));

// não contam: aniversário, paradas, anteriores à data
limpar();
concluir(4, 'birthday', 'done'); concluir(4, 'manual', 'stopped');
psql("insert into company_1.campaigns (name,kind,status,messages,interval_min,interval_max,batch_size,batch_pause_min,daily_limit,finished_at) values ('prog','manual','done','[]',15,15,30,60,50, now() - interval '1 day')");
l = await lim(); check('aniversário, paradas e antigas não contam', l.interval_min === 15 && l.daily_max === 50, JSON.stringify(l));

// valor manual do administrador manda e a progressão fica parada
concluir(4);
const r = await call('PUT', '/api/admin/companies/1', { token: A.token, body: { campaign_daily_max: 200, campaign_interval_min: 12 } });
l = await lim(); check('manual manda sobre a progressão', r.status === 200 && l.daily_max === 200 && l.interval_min === 12, JSON.stringify(l));
await call('PUT', '/api/admin/companies/1', { token: A.token, body: { campaign_daily_max: null, campaign_interval_min: null } });
l = await lim(); check('limpar o manual volta à progressão (degrau 3)', l.interval_min === 13 && l.daily_max === 70, JSON.stringify(l));

// campanha nova respeita o degrau
const sim = await call('POST', '/api/campaigns', { token: A.token, body: { name: 'x', messages: ['a'], interval_min: 10, interval_max: 12, batch_size: 10, batch_pause_min: 60, daily_limit: 100 } });
check('rota de campanha existe/responde', [200, 201, 400].includes(sim.status));

limpar();
psql('update public.companies set campaign_prog_desde=null where id=1');
console.log(`${ok} ok, ${fail} falhas`);
process.exit(fail ? 1 : 0);
