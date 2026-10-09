// Lista do evento (uma linha por pessoa) e acessos. Uso: BASE=http://localhost:3999 node test/lista_evento.mjs
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
  return { status: r.status, body: j, raw, type: r.headers.get('content-type') || '' };
};
const psql = (sql) => execSync(`psql "${process.env.DATABASE_URL}" -tAc "${sql}"`).toString().trim();
psql("set search_path to company_1, public; delete from company_1.shows_attendee_log; delete from company_1.shows_attendees; delete from company_1.shows_sale_payments; delete from company_1.shows_sales where sector_id in (select id from company_1.shows_sectors where name like 'Setor Lista%'); delete from company_1.shows_sectors where name like 'Setor Lista%'; delete from company_1.shows_table_types where name like 'Mesa Lista%'; delete from company_1.events where title like 'Show Lista%'; delete from company_1.customers where phone like '%3288860001' or phone like '%3288860002'");
const psqlGlobal = (sql) => execSync(`psql "${process.env.DATABASE_URL}" -tAc "${sql}"`).toString().trim();
psqlGlobal("delete from public.users where email like 'lista-%@x.com'; delete from public.company_funcoes where name like 'Lista %'");

const A = (await call('POST', '/api/auth/login', { body: { email: 'demo@demo.com', password: 'demo1234' } })).body;
const api = (m, p, body) => call(m, '/api' + p, { token: A.token, body });
const funcao = async (nome, telas) => (await api('POST', '/equipe/funcoes', { name: nome, telas })).body;
const pessoa = async (nome, email, f) => { await api('POST', '/equipe/usuarios', { name: nome, email, password: 'senha1234', funcao_id: f.id }); return (await call('POST', '/api/auth/login', { body: { email, password: 'senha1234' } })).body.token; };
const fLeitor = await funcao('Lista Leitor', ['lista_evento']);
const fComentarista = await funcao('Lista Comentarista', ['lista_evento_comentarista']);
const fEditor = await funcao('Lista Editor', ['lista_evento_editor', 'lista_evento_telefone']);
const fEditorSemFone = await funcao('Lista Editor sem telefone', ['lista_evento_editor']);
const fNada = await funcao('Lista Nada', ['clientes']);
const tLeitor = await pessoa('Lia Leitora', 'lista-leitor@x.com', fLeitor);
const tComentarista = await pessoa('Paulo Comentarista', 'lista-comentarista@x.com', fComentarista);
const tEditor = await pessoa('Ada Editor', 'lista-editor@x.com', fEditor);
const tEditorSemFone = await pessoa('Edu Editor', 'lista-editor-sf@x.com', fEditorSemFone);
const tNada = await pessoa('Nina Nada', 'lista-nada@x.com', fNada);
const as = (t) => (m, p, body) => call(m, '/api' + p, { token: t, body });
const editorSemFone = as(tEditorSemFone);
const leitor = as(tLeitor), comentarista = as(tComentarista), editor = as(tEditor), nada = as(tNada);

const ev = (await api('POST', '/events', { title: 'Show Lista', starts_at: new Date(Date.now() + 10 * 864e5).toISOString() })).body;
const setor = (await api('POST', '/casa-de-shows/sectors', { name: 'Setor Lista', space: 50 })).body;
const mesa = (await api('POST', '/casa-de-shows/table-types', { name: 'Mesa Lista 4', seats: 4, space: 2 })).body;
const venda = async (b) => (await api('POST', '/casa-de-shows/sales', { event_id: ev.id, sector_id: setor.id, table_type_id: mesa.id, ...b })).body;
const ana = await venda({ name: 'Ana', phone: '32988860001', people: 3, guests: 'Ana\nBia', unit_price: 100 });
const carlos = await venda({ name: 'Carlos', phone: '32988860002', people: 1, unit_price: 100 });
const cancelada = await venda({ name: 'Cancelada', people: 2, unit_price: 100 });
await api('PUT', `/casa-de-shows/sales/${cancelada.id}`, { status: 'cancelled' });
await api('POST', `/casa-de-shows/sales/${ana.id}/payments`, { method: 'dinheiro', amount: 150 });
await api('POST', `/casa-de-shows/sales/${carlos.id}/payments`, { method: 'dinheiro', amount: 100 });

// ---- a lista ----
let l = (await api('GET', `/event-list?event_id=${ev.id}`)).body;
check('uma linha por pessoa, sem as canceladas', l.rows.length === 4 && l.summary.people === 4, JSON.stringify(l.summary));
check('nomes: lista da venda, comprador e acompanhante', l.rows[0].name === 'Ana' && l.rows[1].name === 'Bia' && l.rows[2].name === 'Acompanhante de Ana' && l.rows[3].name === 'Carlos', JSON.stringify(l.rows.map((x) => x.name)));
check('colunas da planilha', l.rows[0].sector === 'Setor Lista' && l.rows[0].table === '1 × Mesa Lista 4' && l.rows[0].unit_price === 100 && /32988860001|3288860001/.test(l.rows[0].phone), JSON.stringify(l.rows[0]));
check('pagamento por venda', l.rows[0].payment === 'partial' && l.rows[3].payment === 'paid', JSON.stringify([l.rows[0].payment, l.rows[3].payment]));
check('ninguém entrou ainda', l.summary.entered === 0 && l.summary.pending_payment === 3);
check('evento obrigatório', (await api('GET', '/event-list')).status === 400);
check('evento inexistente', (await api('GET', '/event-list?event_id=999999')).status === 404);

// ---- leitor: só consulta ----
check('leitor vê a lista', (await leitor('GET', `/event-list?event_id=${ev.id}`)).status === 200);
check('leitor escolhe o evento', (await leitor('GET', '/events?quando=proximos')).status === 200);
check('leitor baixa a planilha', (await leitor('GET', `/event-list/export?event_id=${ev.id}`)).status === 200);
check('leitor não edita', (await leitor('PUT', `/event-list/${ana.id}/1`, { name: 'X' })).status === 403);
check('leitor não marca entrada', (await leitor('PUT', `/event-list-comment/${ana.id}/1/entry`, { entered: true })).status === 403);
check('leitor não anota', (await leitor('PUT', `/event-list-comment/${ana.id}/1/note`, { note: 'x' })).status === 403);
check('leitor não vê as vendas da Casa de Shows', (await leitor('GET', `/casa-de-shows/sales?event_id=${ev.id}`)).status === 403);
check('quem não tem a tela não vê a lista', (await nada('GET', `/event-list?event_id=${ev.id}`)).status === 403);

// ---- comentarista: entrada e observações ----
check('comentarista vê a lista', (await comentarista('GET', `/event-list?event_id=${ev.id}`)).status === 200);
check('comentarista marca entrada', (await comentarista('PUT', `/event-list-comment/${ana.id}/1/entry`, { entered: true })).status === 200);
check('comentarista anota', (await comentarista('PUT', `/event-list-comment/${ana.id}/2/note`, { note: 'Chega mais tarde' })).status === 200);
check('comentarista não edita nome', (await comentarista('PUT', `/event-list/${ana.id}/1`, { name: 'X' })).status === 403);
check('comentarista não mexe nas vendas', (await comentarista('PUT', `/casa-de-shows/sales/${ana.id}`, { people: 2 })).status === 403);
l = (await api('GET', `/event-list?event_id=${ev.id}`)).body;
check('entrada registrada com quem marcou', l.rows[0].entered_at && l.rows[0].entered_by === 'Paulo Comentarista' && l.summary.entered === 1, JSON.stringify(l.rows[0]));
check('observação da portaria registrada', l.rows[1].door_note === 'Chega mais tarde' && l.rows[1].note === '');
check('entrada exige verdadeiro ou falso', (await comentarista('PUT', `/event-list-comment/${ana.id}/1/entry`, { entered: 'sim' })).status === 400);
check('pessoa além da venda', (await comentarista('PUT', `/event-list-comment/${carlos.id}/2/entry`, { entered: true })).status === 404);
check('venda cancelada', (await comentarista('PUT', `/event-list-comment/${cancelada.id}/1/entry`, { entered: true })).status === 409);
check('desfazer entrada', (await comentarista('PUT', `/event-list-comment/${ana.id}/1/entry`, { entered: false })).status === 200 && (await api('GET', `/event-list?event_id=${ev.id}`)).body.summary.entered === 0);
check('marcar a venda inteira', (await comentarista('PUT', `/event-list-comment/${ana.id}/entry`, { entered: true })).status === 200 && (await api('GET', `/event-list?event_id=${ev.id}`)).body.summary.entered === 3);

// ---- editor: edita tudo ----
check('editor edita nome, telefone e observação', (await editor('PUT', `/event-list/${ana.id}/3`, { name: 'Cris', phone: '32988860002', note: 'Vegetariana' })).status === 200);
l = (await api('GET', `/event-list?event_id=${ev.id}`)).body;
check('edição aparece na lista', l.rows[2].name === 'Cris' && l.rows[2].named && l.rows[2].note === 'Vegetariana' && /3288860002$/.test(l.rows[2].phone), JSON.stringify(l.rows[2]));
check('nome vazio volta ao padrão', (await editor('PUT', `/event-list/${ana.id}/3`, { name: '' })).status === 200 && (await api('GET', `/event-list?event_id=${ev.id}`)).body.rows[2].name === 'Acompanhante de Ana');
check('telefone inválido', (await editor('PUT', `/event-list/${ana.id}/3`, { phone: '12' })).status === 400);
check('nome com símbolo inválido', (await editor('PUT', `/event-list/${ana.id}/3`, { name: '<b>x</b>' })).status === 400);
check('editor também marca entrada', (await editor('PUT', `/event-list-comment/${carlos.id}/1/entry`, { entered: true })).status === 200);
check('editor não mexe nas vendas', (await editor('PUT', `/casa-de-shows/sales/${ana.id}`, { people: 2 })).status === 403);

// ---- registro de mudanças ----
const log = (await api('GET', `/event-list/log?event_id=${ev.id}`)).body;
check('registro guarda quem fez o quê', log.some((x) => x.actor === 'Paulo Comentarista' && x.action === 'entrada') && log.some((x) => x.actor === 'Paulo Comentarista' && x.action === 'comentario' && x.person === 'Bia') && log.some((x) => x.actor === 'Ada Editor' && x.action === 'edicao' && /Vegetariana/.test(x.detail)), JSON.stringify(log.slice(0, 3)));
check('leitor também consulta o registro', (await leitor('GET', `/event-list/log?event_id=${ev.id}`)).status === 200);
check('registro com entrada desfeita', log.some((x) => x.action === 'entrada_desfeita'));

// ---- planilha ----
const ex = await api('GET', `/event-list/export?event_id=${ev.id}`);
check('planilha em CSV com acentos', ex.status === 200 && /text\/csv/.test(ex.type) && ex.raw.replace(/^﻿/, '').startsWith('Nome;Setor;Mesa;Telefone;Valor;Pagamento;Entrou;Observações'), ex.raw.slice(0, 120));
check('planilha com uma linha por pessoa', ex.raw.trim().split('\r\n').length === 5 && /Bia;Setor Lista/.test(ex.raw) && /Carlos;.*;Pago;Sim;/.test(ex.raw), ex.raw);

// ---- telefone é permissão à parte ----
const semFone = (await editorSemFone('GET', `/event-list?event_id=${ev.id}`)).body;
check('sem a permissão a lista vem sem telefone', semFone.phone_hidden === true && semFone.rows.every((x) => x.phone === null), JSON.stringify(semFone.rows[0]));
check('com a permissão a lista traz o telefone', l.phone_hidden === false && /3288860001/.test(l.rows[0].phone));
check('leitor sem a permissão também não vê', (await leitor('GET', `/event-list?event_id=${ev.id}`)).body.rows.every((x) => x.phone === null));
check('sem a permissão não edita telefone', (await editorSemFone('PUT', `/event-list/${ana.id}/3`, { phone: '32988860002' })).status === 403);
check('sem a permissão edita o nome normalmente', (await editorSemFone('PUT', `/event-list/${ana.id}/3`, { note: 'ok' })).status === 200);
await editorSemFone('PUT', `/event-list/${ana.id}/3`, { note: '' });
check('a planilha exportada sem a permissão não tem a coluna de telefone', await (async () => { const r = await fetch(BASE + `/api/event-list/export?event_id=${ev.id}`, { headers: { authorization: 'Bearer ' + tEditorSemFone } }); const t = await r.text(); return r.status === 200 && !/Telefone/.test(t) && !/3288860001/.test(t); })());

// ---- telas na equipe ----
const eq = (await api('GET', '/equipe')).body;
check('as três telas da lista existem na equipe', ['lista_evento', 'lista_evento_comentarista', 'lista_evento_editor'].every((t) => eq.telas.includes(t)));
const me = (await call('GET', '/api/me', { token: tComentarista })).body;
check('a pessoa vê as telas que tem', me.equipe && me.equipe.telas.includes('lista_evento_comentarista'), JSON.stringify(me));

// ---- marcação feita sem internet e abertura da casa ----
const umaHora = new Date(Date.now() - 36e5).toISOString();
check('entrada enviada depois guarda a hora em que foi marcada', (await comentarista('PUT', `/event-list-comment/${ana.id}/2/entry`, { entered: true, at: umaHora })).status === 200
  && Math.abs(new Date((await api('GET', `/event-list?event_id=${ev.id}`)).body.rows.find((x) => x.key === `${ana.id}:2`).entered_at) - new Date(umaHora)) < 2000);
await comentarista('PUT', `/event-list-comment/${ana.id}/2/entry`, { entered: false });
await comentarista('PUT', `/event-list-comment/${ana.id}/2/entry`, { entered: true, at: new Date(Date.now() + 36e5).toISOString() });
check('hora no futuro é ignorada', new Date((await api('GET', `/event-list?event_id=${ev.id}`)).body.rows.find((x) => x.key === `${ana.id}:2`).entered_at) <= new Date());
const abre = new Date(Date.now() + 24 * 36e5).toISOString(), comeca = new Date(Date.now() + 26 * 36e5).toISOString();
const e2 = (await api('POST', '/events', { title: 'Show Lista Abertura', starts_at: comeca, doors_at: abre })).body;
check('evento guarda a abertura da casa', e2.id && new Date(e2.doors_at).getTime() === new Date(abre).getTime(), JSON.stringify(e2));
check('abertura depois do show é recusada', (await api('PUT', '/events/' + e2.id, { doors_at: new Date(Date.now() + 30 * 36e5).toISOString() })).status === 400);
check('abertura pode ser apagada', (await api('PUT', '/events/' + e2.id, { doors_at: null })).body.doors_at === null);
await api('DELETE', '/events/' + e2.id);

// ---- excluir pessoas da lista (só o editor) ----
const rm = (itens, extra = {}) => editor('POST', '/event-list/bulk-delete', { ids: itens.map((i) => `${i.sale_id}:${i.seq}`), ...extra });
const lista = async () => (await api('GET', `/event-list?event_id=${ev.id}`)).body.rows;
const v3 = await venda({ name: 'Vera', phone: '32988860010', people: 3, guests: 'Vera\nBeto\nCadu', unit_price: 100 });
await editor('PUT', `/event-list/${v3.id}/2`, { note: 'obs do Beto' });
await editor('PUT', `/event-list/${v3.id}/3`, { name: 'Cadu Lima' });
const antes = (await lista()).length;
check('leitor não exclui', (await leitor('POST', '/event-list/bulk-delete', { ids: [`${v3.id}:2`] })).status === 403);
check('comentarista não exclui', (await comentarista('POST', '/event-list/bulk-delete', { ids: [`${v3.id}:2`] })).status === 403);
check('sem escolher ninguém: erro', (await rm([])).status === 400);
const previa = await rm([{ sale_id: v3.id, seq: 2 }], { dry_run: true });
const pc = previa.body.purchases?.[0] || {};
check('a prévia mostra de que compra a pessoa faz parte, sem apagar nada', previa.status === 200 && pc.buyer === 'Vera' && pc.people === 3 && pc.remove === 1 && pc.remaining === 2 && pc.delete_sale === false && pc.needs_buyer === false && (await lista()).length === antes, JSON.stringify(previa.body));
let xr = await rm([{ sale_id: v3.id, seq: 2 }]);
check('tira uma pessoa da venda', xr.status === 200 && xr.body.deleted === 1 && xr.body.sales_deleted === 0, JSON.stringify(xr.body));
let lv = (await lista()).filter((r) => String(r.sale_id) === String(v3.id));
check('a venda fica com uma pessoa a menos', lv.length === 2 && psql(`select people from company_1.shows_sales where id=${v3.id}`) === '2');
check('quem ficou mantém a posição e o nome', lv[0].seq === 1 && lv[0].name === 'Vera' && lv[1].seq === 3 && lv[1].name === 'Cadu Lima', JSON.stringify(lv.map((r) => [r.seq, r.name])));
check('quem ficou continua com a mesma posição (o ingresso dela segue valendo)', (await editor('PUT', `/event-list/${v3.id}/3`, { note: 'ok' })).status === 200);
check('a posição tirada não existe mais', (await editor('PUT', `/event-list/${v3.id}/2`, { note: 'x' })).status === 404);
check('a observação da pessoa tirada vai embora', !lv.some((r) => r.note === 'obs do Beto'));
check('a lista de nomes da venda perde a linha dela', psql(`select replace(guests, chr(10), '|') from company_1.shows_sales where id=${v3.id}`) === 'Vera|Cadu');
check('o QR Code de quem ficou não muda', psql(`select qr_ver from company_1.shows_attendees where sale_id=${v3.id} and seq=3`) === '0');
check('marcar a venda inteira como entrou funciona com a posição vaga', (await editor('PUT', `/event-list-comment/${v3.id}/entry`, { entered: true })).status === 200 && (await lista()).filter((r) => String(r.sale_id) === String(v3.id) && r.entered_at).length === 2);
await editor('PUT', `/event-list-comment/${v3.id}/entry`, { entered: false });
check('a exclusão fica no registro de quem mexeu', (await api('GET', `/event-list/log?event_id=${ev.id}`)).body.some((e) => e.action === 'exclusao' && e.person === 'Beto'));
check('pessoa que não existe mais é pulada, sem derrubar', (await rm([{ sale_id: v3.id, seq: 2 }])).body.skipped.length === 1);
check('venda inexistente é pulada', (await rm([{ sale_id: 99999999, seq: 1 }])).body.skipped.length === 1);
check('pessoa inválida: erro', (await editor('POST', '/event-list/bulk-delete', { ids: ['x'] })).status === 400);
// tirar o comprador: o título passa para outro nome e telefone
const pb = await rm([{ sale_id: v3.id, seq: 1 }], { dry_run: true });
check('a prévia avisa que falta o novo comprador', pb.body.purchases[0].needs_buyer === true && pb.body.purchases[0].remaining === 1, JSON.stringify(pb.body));
xr = await rm([{ sale_id: v3.id, seq: 1 }]);
check('sem novo comprador, não tira o comprador', xr.body.deleted === 0 && xr.body.skipped.length === 1 && (await lista()).filter((r) => String(r.sale_id) === String(v3.id)).length === 2, JSON.stringify(xr.body));
xr = await rm([{ sale_id: v3.id, seq: 1 }], { buyers: { [v3.id]: { name: 'Marta Souza', phone: '(32) 98888-6099' } } });
lv = (await lista()).filter((r) => String(r.sale_id) === String(v3.id));
check('o título de comprador passa para o nome e telefone informados', xr.body.deleted === 1 && lv.length === 1 && lv[0].seq === 3 && lv[0].name === 'Cadu Lima' && lv[0].buyer === 'Marta Souza' && psql(`select phone from company_1.shows_sales where id=${v3.id}`) === '553288886099', JSON.stringify([xr.body, lv]));
// várias de uma vez, em vendas diferentes
const w2 = await venda({ name: 'Wilson', phone: '32988860011', people: 2, unit_price: 100 });
xr = await rm([{ sale_id: w2.id, seq: 1 }, { sale_id: w2.id, seq: 2 }, { sale_id: v3.id, seq: 3 }]);
check('várias de uma vez: sem ninguém e sem convidados a venda é apagada', xr.body.deleted === 3 && xr.body.sales_deleted === 2, JSON.stringify(xr.body));
check('as vendas sem ninguém somem do banco', psql(`select count(*) from company_1.shows_sales where id in (${w2.id}, ${v3.id})`) === '0');
check('o total da lista caiu pelas três pessoas', (await lista()).length === antes - 3);
// anfitrião de mesa reservada: a mesa e os convidados ficam
const anf = await venda({ name: 'Anfitrião', phone: '32988860020', people: 1, unit_price: 100 });
const conv = await venda({ name: 'Convidada', phone: '32988860021', people: 2, unit_price: 100 });
psql(`update company_1.shows_sales set held=true where id=${anf.id}`);
psql(`update company_1.shows_sales set host_sale_id=${anf.id} where id=${conv.id}`);
const pa = await rm([{ sale_id: anf.id, seq: 1 }], { dry_run: true });
check('a prévia do anfitrião com convidados pede novo comprador e não apaga a venda', pa.body.purchases[0].needs_buyer === true && pa.body.purchases[0].delete_sale === false && pa.body.purchases[0].table_guests === 1, JSON.stringify(pa.body));
check('anfitrião sem novo comprador não é apagado', (await rm([{ sale_id: anf.id, seq: 1 }])).body.skipped.length === 1);
xr = await rm([{ sale_id: anf.id, seq: 1 }], { buyers: { [anf.id]: { name: 'Novo Anfitrião', phone: '32988860030' } } });
const la = (await lista()).filter((r) => String(r.sale_id) === String(anf.id));
check('o anfitrião é trocado e a mesa continua com os convidados', xr.body.deleted === 1 && la.length === 1 && la[0].name === 'Novo Anfitrião' && psql(`select count(*) from company_1.shows_sales where host_sale_id=${anf.id}`) === '1', JSON.stringify([xr.body, la]));
// apagar a mesa toda (anfitrião e convidados de uma vez): não pede novo comprador
const anf2 = await venda({ name: 'Dono da Mesa', phone: '32988860040', people: 2, unit_price: 100 });
const conv2 = await venda({ name: 'Convidado 2', phone: '32988860041', people: 1, unit_price: 100 });
psql(`update company_1.shows_sales set held=true where id=${anf2.id}`);
psql(`update company_1.shows_sales set host_sale_id=${anf2.id} where id=${conv2.id}`);
const toda = [{ sale_id: anf2.id, seq: 1 }, { sale_id: anf2.id, seq: 2 }, { sale_id: conv2.id, seq: 1 }];
const pm = await rm(toda, { dry_run: true });
check('a prévia da mesa toda não pede novo comprador', pm.body.purchases.every((c) => c.needs_buyer === false && c.delete_sale === true), JSON.stringify(pm.body));
xr = await rm(toda);
check('apaga a mesa toda de uma vez', xr.body.deleted === 3 && xr.body.sales_deleted === 2 && psql(`select count(*) from company_1.shows_sales where id in (${anf2.id}, ${conv2.id})`) === '0', JSON.stringify(xr.body));


// limpeza
psql("set search_path to company_1, public; delete from shows_attendee_log; delete from shows_attendees; delete from shows_sale_payments; update shows_sales set host_sale_id = null; delete from shows_sales where sector_id in (select id from shows_sectors where name = 'Setor Lista'); delete from customers where phone like '%3288860001' or phone like '%3288860002'");
await api('DELETE', `/casa-de-shows/sectors/${setor.id}`); await api('DELETE', `/casa-de-shows/table-types/${mesa.id}`); await api('DELETE', '/events/' + ev.id);
psqlGlobal("delete from public.users where email like 'lista-%@x.com'; delete from public.company_funcoes where name like 'Lista %'");
console.log(`${ok} ok, ${fail} falhas`);
process.exit(fail ? 1 : 0);
