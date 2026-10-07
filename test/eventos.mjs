// Módulo Eventos. Uso: BASE=http://localhost:3999 node test/eventos.mjs
import { execSync } from 'child_process';
const BASE = process.env.BASE || 'http://localhost:3999';
let ok = 0, fail = 0;
const check = (name, cond, extra = '') => { cond ? ok++ : (fail++, console.log('FALHOU:', name, extra)); };
const call = async (method, path, token, body) => {
  const r = await fetch(BASE + path, { method, headers: { 'content-type': 'application/json', authorization: 'Bearer ' + token }, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, body: await r.json().catch(() => null) };
};
const login = async (e, p) => (await (await fetch(BASE + '/api/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: e, password: p }) })).json()).token;
const A = await login('demo@demo.com', 'demo1234');
const B = await login('dois@x.com', 'senhasenha');
const T = (m, p, b, t = A) => call(m, p, t, b);
const em = (dias, h = 0) => new Date(Date.now() + dias * 864e5 + h * 36e5).toISOString();

execSync(`psql "${process.env.DATABASE_URL}" -qc "delete from company_1.events"`);   // começa sem eventos de outros testes
check('sem nome = 400', (await T('POST', '/api/events', { starts_at: em(5) })).status === 400);
check('sem data = 400', (await T('POST', '/api/events', { title: 'x' })).status === 400);
check('fim antes do início = 400', (await T('POST', '/api/events', { title: 'x', starts_at: em(5), ends_at: em(4) })).status === 400);

const e1 = (await T('POST', '/api/events', { title: 'Live de aniversário', starts_at: em(10), place: 'YouTube', external_id: 'yt-evt-1' })).body;
const e2 = (await T('POST', '/api/events', { title: 'Reunião', starts_at: em(3), ends_at: em(3, 2), notes: 'levar contrato' })).body;
const e3 = (await T('POST', '/api/events', { title: 'Evento antigo', starts_at: em(-20), ends_at: em(-20, 2) })).body;
check('criou', e1.id && e2.id && e3.id, JSON.stringify([e1, e2, e3]));
check('identificação repetida = 409', (await T('POST', '/api/events', { title: 'y', starts_at: em(11), external_id: 'yt-evt-1' })).status === 409);

const prox = (await T('GET', '/api/events')).body;
check('próximos em ordem, sem o passado', prox.map((x) => x.id).join() === [e2.id, e1.id].join(), JSON.stringify(prox.map((x) => x.title)));
check('passados', (await T('GET', '/api/events?quando=passados')).body.map((x) => x.id).join() === String(e3.id));
check('todos', (await T('GET', '/api/events?quando=todos')).body.length === 3);
const nx = (await T('GET', '/api/events/next')).body;
check('próximo evento', nx.found && nx.event.id === e2.id);

check('editar', (await T('PUT', '/api/events/' + e1.id, { title: 'Live de 5 anos', starts_at: em(12) })).body.title === 'Live de 5 anos');
check('editar mantém o resto', (await T('GET', '/api/events?quando=todos')).body.find((x) => x.id === e1.id).place === 'YouTube');
check('limpar local', (await T('PUT', '/api/events/' + e1.id, { place: '' })).body.place === null);
check('editar inexistente = 404', (await T('PUT', '/api/events/999999', { title: 'x' })).status === 404);

check('outra empresa não vê', (await T('GET', '/api/events?quando=todos', null, B)).body.length === 0);
check('outra empresa não apaga', (await T('POST', '/api/events/bulk-delete', { ids: [e1.id] }, B)).body.deleted === 0);
check('via N8N também funciona', (await fetch(BASE + '/n8n/events/next', { headers: { 'x-api-key': 'k', 'x-company-id': '1' } })).status === 200);

check('apagar um', (await T('DELETE', '/api/events/' + e3.id)).status === 200 && (await T('DELETE', '/api/events/' + e3.id)).status === 404);
check('sem seleção = 400', (await T('POST', '/api/events/bulk-delete', { ids: [] })).status === 400);
check('simulação', (await T('POST', '/api/events/bulk-delete', { ids: [e1.id, e2.id], dry_run: true })).body.found === 2);
check('apagar em massa', (await T('POST', '/api/events/bulk-delete', { ids: [e1.id, e2.id] })).body.deleted === 2);
check('lista vazia', (await T('GET', '/api/events?quando=todos')).body.length === 0);

console.log(`eventos: ${ok} ok, ${fail} falhas`);
process.exit(fail ? 1 : 0);
