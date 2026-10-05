// Ingresso com QR Code e leitura na portaria. Uso: BASE=http://localhost:3999 node test/ingresso_qr.mjs (precisa do fake_gotenberg e GOTENBERG_URL no servidor)
import { execSync } from 'child_process';
const BASE = process.env.BASE || 'http://localhost:3999';
let ok = 0, fail = 0;
const check = (name, cond, extra = '') => { cond ? ok++ : (fail++, console.log('FALHOU:', name, extra)); };
const call = async (method, path, { token, body } = {}) => {
  const headers = { 'content-type': 'application/json' };
  if (token) headers.authorization = 'Bearer ' + token;
  const r = await fetch(BASE + path, { method, headers, body: body ? JSON.stringify(body) : undefined });
  const raw = await r.text();
  let j = null; try { j = JSON.parse(raw); } catch {}
  return { status: r.status, body: j, raw };
};
const psql = (sql) => execSync(`psql "${process.env.DATABASE_URL}" -tAc "${sql}"`).toString().trim();
const limpa = () => {
  psql("delete from company_1.shows_attendee_log; delete from company_1.shows_attendees; delete from company_1.shows_sale_payments; delete from company_1.shows_sales where sector_id in (select id from company_1.shows_sectors where name like 'Setor QR%'); delete from company_1.shows_sectors where name like 'Setor QR%'; delete from company_1.shows_table_types where name like 'Mesa QR%'; delete from company_1.events where title like 'Show QR%'; delete from public.users where email like 'qr-%@x.com'; delete from public.company_funcoes where name like 'QR %'");
};
limpa();
const A = (await call('POST', '/api/auth/login', { body: { email: 'demo@demo.com', password: 'demo1234' } })).body;
const api = (m, p, body) => call(m, '/api' + p, { token: A.token, body });
const modelo = await api('POST', '/documents/templates', { name: 'Ingresso QR teste', kind: 'ingresso', is_default: true, html: '<html><body><h1>{{evento}}</h1><p>{{nome}} · {{setor}} · {{mesa}} · {{pessoa}}</p></body></html>' });
check('modelo de teste criado', modelo.status === 201, JSON.stringify(modelo.body));
const funcao = async (nome, telas) => (await api('POST', '/equipe/funcoes', { name: nome, telas })).body;
const pessoa = async (nome, email, f) => { await api('POST', '/equipe/usuarios', { name: nome, email, password: 'senha1234', funcao_id: f.id }); return (await call('POST', '/api/auth/login', { body: { email, password: 'senha1234' } })).body.token; };
const tLeitor = await pessoa('Lia', 'qr-leitor@x.com', await funcao('QR Leitor', ['lista_evento']));
const tComent = await pessoa('Paulo', 'qr-coment@x.com', await funcao('QR Coment', ['lista_evento_comentarista']));
const tEditor = await pessoa('Ada', 'qr-editor@x.com', await funcao('QR Editor', ['lista_evento_editor']));
const as = (t) => (m, p, body) => call(m, '/api' + p, { token: t, body });
const leitor = as(tLeitor), coment = as(tComent), editor = as(tEditor);

const ev = (await api('POST', '/events', { title: 'Show QR', starts_at: new Date(Date.now() + 5 * 864e5).toISOString() })).body;
const ev2 = (await api('POST', '/events', { title: 'Show QR Outro', starts_at: new Date(Date.now() + 6 * 864e5).toISOString() })).body;
const setor = (await api('POST', '/casa-de-shows/sectors', { name: 'Setor QR', space: 50 })).body;
const mesa = (await api('POST', '/casa-de-shows/table-types', { name: 'Mesa QR 4', seats: 4, space: 2 })).body;
const venda = (await api('POST', '/casa-de-shows/sales', { event_id: ev.id, sector_id: setor.id, table_type_id: mesa.id, name: 'Ana', phone: '32988880077', people: 2, guests: 'Ana\nBia', unit_price: 100 })).body;
const pdf = async (url) => (await fetch(url)).text();

// ingresso de uma pessoa
let r = await editor('POST', `/event-list/${venda.id}/2/ticket`);
check('editor gera ingresso', r.status === 201 && r.body.url && r.body.name === 'Bia', JSON.stringify(r.body));
const html = await pdf(r.body.url);
const codigo = (html.match(/TMI-\d+-\d+-\d+-[0-9a-f]{12}/) || [])[0];
check('PDF tem QR e código da pessoa', !!codigo && html.includes('data:image/svg+xml;base64,') && codigo.includes(`-${venda.id}-2-`), html.slice(0, 200));
check('PDF tem o nome e o evento', html.includes('Bia') && html.includes('Show QR'));
r = await coment('POST', `/event-list/${venda.id}/2/ticket`); check('comentarista não gera ingresso', r.status === 403);
r = await editor('POST', `/event-list/${venda.id}/9/ticket`); check('pessoa que não existe → 404', r.status === 404);
r = await editor('POST', `/event-list/${venda.id}/tickets`);
check('todos os ingressos da venda', r.status === 201 && r.body.tickets.length === 2 && r.body.tickets[0].name === 'Ana', JSON.stringify(r.body));
r = await api('POST', '/documents/generate', { template: 'ingresso', sale_id: venda.id, seq: 1, text: 'x' });
check('documents/generate com sale_id', r.status === 201 && (await pdf(r.body.url)).includes('data:image/svg+xml'), JSON.stringify(r.body));

// leitura
r = await leitor('POST', '/event-list-comment/scan', { code: codigo }); check('leitor não marca entrada', r.status === 403);
r = await coment('POST', '/event-list-comment/scan', { code: codigo, event_id: ev.id });
check('1ª leitura marca a entrada', r.body.result === 'ok' && r.body.name === 'Bia' && r.body.sector === 'Setor QR' && r.body.payment === 'pending', JSON.stringify(r.body));
r = await coment('POST', '/event-list-comment/scan', { code: codigo, event_id: ev.id });
check('2ª leitura avisa que já entrou', r.body.result === 'ja_entrou' && r.body.entered_by === 'Paulo', JSON.stringify(r.body));
const lista = (await api('GET', `/event-list?event_id=${ev.id}`)).body;
check('lista mostra Bia dentro e Ana fora', lista.rows.find((x) => x.seq === 2).entered_at && !lista.rows.find((x) => x.seq === 1).entered_at);
const log = (await api('GET', `/event-list/log?event_id=${ev.id}`)).body;
check('registro diz QR Code', log.some((x) => x.action === 'entrada' && x.detail === 'QR Code'));
r = await coment('POST', '/event-list-comment/scan', { code: codigo.slice(0, -1) + (codigo.endsWith('0') ? '1' : '0') });
check('assinatura errada → inválido', r.body.result === 'invalido', JSON.stringify(r.body));
r = await coment('POST', '/event-list-comment/scan', { code: 'qualquer coisa' }); check('lixo → inválido', r.body.result === 'invalido');
r = await coment('POST', '/event-list-comment/scan', { code: codigo.replace(/^TMI-\d+/, 'TMI-999') }); check('outra empresa → inválido', r.body.result === 'invalido');
const html1 = await pdf((await editor('POST', `/event-list/${venda.id}/1/ticket`)).body.url);
const cod1 = html1.match(/TMI-\d+-\d+-\d+-[0-9a-f]{12}/)[0];
r = await coment('POST', '/event-list-comment/scan', { code: cod1, event_id: ev2.id });
check('outro evento é avisado e não marca', r.body.result === 'outro_evento' && !(await api('GET', `/event-list?event_id=${ev.id}`)).body.rows.find((x) => x.seq === 1).entered_at, JSON.stringify(r.body));
await api('PUT', `/casa-de-shows/sales/${venda.id}`, { status: 'cancelled' });
psql(`update company_1.shows_sales set status='cancelled' where id=${venda.id}`);
r = await coment('POST', '/event-list-comment/scan', { code: cod1 }); check('venda cancelada → cancelado', r.body.result === 'cancelado', JSON.stringify(r.body));
r = await editor('POST', `/event-list/${venda.id}/1/ticket`); check('não gera ingresso de venda cancelada', r.status === 409);

await api('DELETE', '/documents/templates/' + modelo.body.id);
psql('delete from company_1.doc_files');
limpa();
console.log(`${ok} ok, ${fail} falhas`);
process.exit(fail ? 1 : 0);
