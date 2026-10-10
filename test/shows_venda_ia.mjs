// Venda feita pelo atendente numa chamada só, envio dos ingressos em PDF (um por pessoa) e limpeza depois do evento.
// Uso: BASE=http://localhost:3999 DATABASE_URL=... node test/shows_venda_ia.mjs   (precisa do Gotenberg de mentira: FAKE_GOTENBERG_PORT=53000 node test/fake_gotenberg.mjs)
import { execSync } from 'child_process';
import http from 'http';
const BASE = process.env.BASE || 'http://localhost:3999';
let ok = 0, fail = 0;
const check = (name, cond, extra = '') => { cond ? ok++ : (fail++, console.log('FALHOU:', name, extra)); };
const call = async (method, path, { token, body, headers: h } = {}) => {
  const headers = { 'content-type': 'application/json', ...(h || {}) };
  if (token) headers.authorization = 'Bearer ' + token;
  const r = await fetch(BASE + path, { method, headers, body: body ? JSON.stringify(body) : undefined });
  let j = null; try { j = await r.json(); } catch {}
  return { status: r.status, body: j };
};
const psql = (sql) => execSync(`psql "${process.env.DATABASE_URL}" -tAc "${sql}"`).toString().trim();
const recebidos = [];
let falhar = false;
const fake = http.createServer((req, res) => {
  let d = ''; req.on('data', (c) => (d += c)); req.on('end', () => { recebidos.push({ url: req.url, body: JSON.parse(d || '{}') }); res.writeHead(falhar ? 500 : 200, { 'content-type': 'application/json' }); res.end('{}'); });
}).listen(0);
const porta = fake.address().port;

const A = (await call('POST', '/api/auth/login', { body: { email: 'demo@demo.com', password: 'demo1234' } })).body;
const api = (m, p, body) => call(m, '/api' + p, { token: A.token, body });
const ia = (m, p, body) => call(m, '/n8n' + p, { body, headers: { 'x-api-key': 'k', 'x-company-id': String(A.company.id) } });
process.env.JWT_SECRET = process.env.JWT_SECRET || 'x';
const { codigoIngresso } = await import('../src/ingresso_qr.js');
const marca = Date.now() % 100000;
psql(`update public.companies set wa_api_url='http://127.0.0.1:${porta}', wa_api_token='tok-teste' where id=1`);
psql("delete from company_1.events where title like 'Show IA %'");

const ev = (await api('POST', '/events', { title: 'Show IA ' + marca, starts_at: new Date(Date.now() + 10 * 864e5).toISOString() })).body;
const setor = (await api('POST', '/casa-de-shows/sectors', { name: 'Setor IA ' + marca, space: 8 })).body;
const mesa = (await api('POST', '/casa-de-shows/table-types', { name: 'Mesa IA ' + marca, seats: 4, space: 4 })).body;
await api('PUT', `/casa-de-shows/events/${ev.id}/conditions`, { price: 100 });
const fone = '5532988' + String(marca).padStart(6, '0').slice(-6);
const chave = (await api('POST', '/finance/keys', { key_type: 'email', key: `ia${marca}@gmail.com`, beneficiary: 'Casa' })).body;
const spm = (min) => new Date(Date.now() - min * 60000 - 3 * 3600000).toISOString().slice(0, 16).replace('T', ' ');
const pagar = async (phone, amount, key = chave.key) => (await api('POST', '/payments/check', { phone, payer_name: 'Fulano Pagador', amount, key, txid: 'E' + Math.random().toString(36).slice(2).padEnd(30, 'x'), paid_at: spm(5), purpose: 'Ingresso' })).body;

let r = await ia('POST', '/casa-de-shows/sales/register', { event: ev.title, sector: setor.name, phone: fone, amount: 200 });
check('sem nomes pede os nomes', r.status === 200 && r.body.ok === false && /nomes/.test(r.body.message), JSON.stringify(r.body));
r = await ia('POST', '/casa-de-shows/sales/register', { event: 'evento que nao existe zzz', sector: setor.name, names: ['Ana Souza'], phone: fone });
check('evento que não existe lista os eventos', r.body.ok === false && /Não achei esse evento/.test(r.body.message), JSON.stringify(r.body));
r = await ia('POST', '/casa-de-shows/sales/register', { event: ev.title, sector: 'setor que nao existe zzz', names: ['Ana Souza'], phone: fone });
check('setor que não existe lista os setores', r.body.ok === false && /Setores:/.test(r.body.message), JSON.stringify(r.body));

r = await ia('POST', '/casa-de-shows/sales/register', { event: ev.title, sector: setor.name, names: ['Ana Souza', 'Bia Souza', 'Caio Souza'], phone: fone, amount: 200, method: 'Pix' });
check('sem pagamento confirmado a venda NÃO nasce', r.body.ok === false && /NÃO há pagamento confirmado/.test(r.body.message) && psql(`select count(*) from company_1.shows_sales where phone='${fone}'`) === '0', JSON.stringify(r.body));
const emAnalise = await pagar(fone, 200, 'ninguem@outro.com');
check('comprovante em chave errada não é aceito', emAnalise.accepted === false, JSON.stringify(emAnalise));
r = await ia('POST', '/casa-de-shows/sales/register', { event: ev.title, sector: setor.name, names: ['Ana Souza', 'Bia Souza', 'Caio Souza'], phone: fone, amount: 200, method: 'Pix' });
check('comprovante não aceito também não libera a venda', r.body.ok === false && /NÃO há pagamento confirmado/.test(r.body.message), JSON.stringify(r.body));
r = await ia('POST', '/casa-de-shows/sales/register', { event: ev.title, sector: setor.name, names: ['Ana Souza', 'Bia Souza', 'Caio Souza'], amount: 200 });
check('sem telefone não cadastra', r.body.ok === false && /telefone/.test(r.body.message), JSON.stringify(r.body));
check('pagamento de R$ 100 confirmado', (await pagar(fone, 100)).accepted === true);
r = await ia('POST', '/casa-de-shows/sales/register', { event: ev.title, sector: setor.name, names: ['Ana Souza', 'Bia Souza', 'Caio Souza'], phone: fone, amount: 200, method: 'Pix' });
check('pagamento menor que a compra não libera', r.body.ok === false && /menor que/.test(r.body.message), JSON.stringify(r.body));
check('pagamento de mais R$ 100 confirmado', (await pagar(fone, 100)).accepted === true);
r = await ia('POST', '/casa-de-shows/sales/register', { event: ev.title, sector: setor.name, names: ['Ana Souza', 'Bia Souza', 'Caio Souza'], phone: fone, amount: 200, method: 'Pix' });
check('registra a venda', r.status === 201 && r.body.ok === true && r.body.people === 3, JSON.stringify(r.body));
check('a mensagem diz que o nome basta', /portaria dá presença pelo nome/.test(r.body.message || ''), r.body.message);
const sid = r.body.sale_id;
psql("delete from company_1.doc_templates where kind='ingresso'");
await api('POST', '/documents/templates/examples', {});
const lista = (await api('GET', `/event-list?event_id=${ev.id}`)).body;
check('os três nomes estão na lista', lista.rows.length === 3 && lista.rows[0].name === 'Ana Souza' && lista.rows[2].name === 'Caio Souza', JSON.stringify(lista.rows?.map((x) => x.name)));
const pags = (await api('GET', `/casa-de-shows/sales/${sid}/payments`)).body;
const pl = pags.payments || [];
check('pagamento registrado em Pix, ligado aos dois comprovantes', pl.length === 2 && pl.every((x) => x.method === 'pix' && x.payment_id) && pl.reduce((a, x) => a + Number(x.amount), 0) === 200, JSON.stringify(pags));

r = await ia('POST', '/casa-de-shows/sales/register', { event: ev.title, sector: setor.name, names: ['Ana Souza', 'Bia Souza', 'Caio Souza'], phone: fone, amount: 200, method: 'Pix' });
check('pedido repetido não duplica', r.body.ok === true && r.body.duplicate === true && String(r.body.sale_id) === String(sid), JSON.stringify(r.body));
const foneX = '5532977' + String(marca).padStart(6, '0').slice(-6);
await pagar(foneX, 600);
r = await ia('POST', '/casa-de-shows/sales/register', { event: ev.title, sector: setor.name, names: ['Dani X', 'Edu X', 'Fabi X', 'Gil X', 'Hugo X', 'Iva X'], phone: foneX, amount: 600 });
check('sem espaço explica e manda ofertar outro setor', r.body.ok === false && /Sem espaço|não comportam|Disponibilidade/.test(r.body.message), JSON.stringify(r.body));

r = await ia('GET', `/casa-de-shows/sales/by-phone?phone=${fone}`);
check('consulta pelo telefone', r.body.ok === true && r.body.sales.length === 1 && r.body.sales[0].names.length === 3 && /Ana Souza/.test(r.body.message), JSON.stringify(r.body));

// ---- ingressos ----
r = await ia('POST', '/casa-de-shows/sales/send-tickets', { number: fone + '@s.whatsapp.net', phone: fone, event: ev.title });
check('envia um ingresso por pessoa', r.body.ok === true && r.body.sent === 3, JSON.stringify(r.body));
const docs = recebidos.filter((x) => x.url === '/send/media');
check('o nome do dono está no nome do arquivo', docs.length === 3 && docs[0].body.docName === `Ingresso - ${ev.title} - Ana Souza.pdf` && docs[1].body.docName === `Ingresso - ${ev.title} - Bia Souza.pdf` && docs[2].body.docName === `Ingresso - ${ev.title} - Caio Souza.pdf`, JSON.stringify(docs.map((d) => d.body.docName)));
check('enviados como documento', docs.every((d) => d.body.type === 'document' && /\/d\/.+\.pdf$/.test(d.body.file)));
check('um arquivo guardado por pessoa', psql(`select count(*) from company_1.doc_files where sale_id=${sid} and event_id=${ev.id}`) === '3');
recebidos.length = 0;
r = await ia('POST', '/casa-de-shows/sales/send-tickets', { number: fone + '@s.whatsapp.net', phone: fone, event: ev.title });
check('reenvio reaproveita os arquivos', r.body.sent === 3 && psql(`select count(*) from company_1.doc_files where sale_id=${sid}`) === '3', JSON.stringify(r.body));

// nome trocado: o ingresso novo sai com o nome novo
await api('PUT', `/event-list/${sid}/2`, { name: 'Beatriz Souza' });
recebidos.length = 0;
r = await ia('POST', '/casa-de-shows/sales/send-tickets', { number: fone + '@s.whatsapp.net', phone: fone, event: ev.title });
check('nome trocado gera ingresso novo com o nome novo', recebidos.some((x) => x.body.docName === `Ingresso - ${ev.title} - Beatriz Souza.pdf`), JSON.stringify(recebidos.map((d) => d.body.docName)));

// ---- troca de nome: só o comprador, só nas compras dele ----
const fone2 = '5532966' + String(marca).padStart(6, '0').slice(-6);
await pagar(fone2, 200);
const outra = await ia('POST', '/casa-de-shows/sales/register', { event: ev.title, sector: setor.name, names: ['Ana Souza', 'Duda Lima'], phone: fone2, amount: 200 });
check('outro comprador com o mesmo nome na mesa dele', outra.status === 201, JSON.stringify(outra.body));
r = await ia('POST', '/casa-de-shows/sales/rename', { phone: '5532900011122', old_name: 'Ana Souza', new_name: 'Ana Maria Souza' });
check('quem não comprou não troca nada', r.body.ok === false && /não tem compra/.test(r.body.message), JSON.stringify(r.body));
r = await ia('POST', '/casa-de-shows/sales/rename', { phone: fone, old_name: 'Zeca Nunes', new_name: 'Zeca Silva' });
check('nome que não está nas compras dele lista os nomes dele', r.body.ok === false && /Ana Souza/.test(r.body.message) && !/Duda/.test(r.body.message), JSON.stringify(r.body));
r = await ia('POST', '/casa-de-shows/sales/rename', { phone: fone, old_name: 'Caio Souza', new_name: 'Caio' });
check('novo nome precisa de sobrenome', r.body.ok === false && /sobrenome/.test(r.body.message), JSON.stringify(r.body));
r = await ia('POST', '/casa-de-shows/sales/rename', { phone: fone, old_name: 'Ana Souza', new_name: 'Ana Paula Souza' });
check('o comprador troca o próprio nome da lista', r.body.ok === true && r.body.to === 'Ana Paula Souza', JSON.stringify(r.body));
const lista2 = (await api('GET', `/event-list?event_id=${ev.id}`)).body.rows.map((x) => x.name);
check('trocou só na compra dele', lista2.includes('Ana Paula Souza') && lista2.filter((n) => n === 'Ana Souza').length === 1 && lista2.includes('Duda Lima'), JSON.stringify(lista2));
// o ingresso antigo (QR Code) deixa de valer; o novo vale
const qrAntigo = codigoIngresso(A.company.id, sid, 1), qrNovo = codigoIngresso(A.company.id, sid, 1, 1);
let sc = (await api('POST', '/event-list-comment/scan', { code: qrAntigo })).body;
check('QR do nome antigo não dá baixa', sc.result === 'substituido', JSON.stringify(sc));
check('e a entrada não foi marcada', psql(`select coalesce(entered_at::text,'') from company_1.shows_attendees where sale_id=${sid} and seq=1`) === '');
sc = (await api('POST', '/event-list-comment/scan', { code: qrNovo })).body;
check('QR novo dá baixa no nome novo', sc.result === 'ok' && sc.name === 'Ana Paula Souza', JSON.stringify(sc));
psql(`update company_1.shows_attendees set entered_at = null where sale_id=${sid} and seq=1`);
check('PDF antigo apagado', psql(`select count(*) from company_1.doc_files where kind='ingresso' and sale_id=${sid} and seq=1`) === '0');
r = await ia('GET', `/casa-de-shows/sales/by-phone?phone=${fone}`);
check('a consulta mostra o nome novo', /Ana Paula Souza/.test(r.body.message) && !/Ana Souza,/.test(r.body.message), r.body.message);
r = await ia('GET', `/casa-de-shows/sales/by-phone?phone=${fone2}`);
check('a compra do outro continua com o nome dele', /Ana Souza/.test(r.body.message) && !/Paula/.test(r.body.message), r.body.message);
r = await ia('POST', '/casa-de-shows/sales/rename', { phone: fone, old_name: 'Souza', new_name: 'Fulana Souza' });
check('nome parecido com mais de um pede para escolher', r.body.ok === false && /mais de um/.test(r.body.message), JSON.stringify(r.body));
psql(`insert into company_1.shows_attendees (sale_id, seq, entered_at) values (${sid}, 3, now()) on conflict (sale_id, seq) do update set entered_at = now()`);
r = await ia('POST', '/casa-de-shows/sales/rename', { phone: fone, old_name: 'Caio Souza', new_name: 'Caio Silva' });
check('quem já entrou não troca', r.body.ok === false && /já entrou/.test(r.body.message), JSON.stringify(r.body));
psql(`update company_1.shows_attendees set entered_at = null where sale_id=${sid} and seq=3`);
check('a troca ficou no histórico', Number(psql(`select count(*) from company_1.shows_attendee_log where sale_id=${sid} and detail like '%pedido pelo comprador%'`)) === 1);
psql(`update company_1.shows_attendees set name=null where sale_id=${sid} and seq=1`);

// falha no WhatsApp: o nome continua salvo e a mensagem tranquiliza
falhar = true; recebidos.length = 0;
r = await ia('POST', '/casa-de-shows/sales/send-tickets', { number: fone + '@s.whatsapp.net', phone: fone, event: ev.title });
check('falha ao enviar não derruba e tranquiliza', r.status === 200 && r.body.ok === false && /nome já está salvo/.test(r.body.message) && /portaria/.test(r.body.message), JSON.stringify(r.body));
falhar = false;
r = await ia('POST', '/casa-de-shows/sales/send-tickets', { number: '5532900000000@s.whatsapp.net', phone: '5532900000000', event: ev.title });
check('sem venda explica', r.body.ok === false && /Não achei venda/.test(r.body.message), JSON.stringify(r.body));

// ---- limpeza depois do evento ----
const { limparIngressosEncerrados } = await import('../src/documentos.js');
await limparIngressosEncerrados();
check('evento em andamento: ingressos ficam', Number(psql(`select count(*) from company_1.doc_files where event_id=${ev.id}`)) >= 3);
psql(`update company_1.events set starts_at = now() - interval '2 days', ends_at = now() - interval '1 day' where id=${ev.id}`);
psql(`insert into company_1.doc_files (kind, title, token, pdf) values ('contrato','Contrato fica','tok-contrato-${marca}','\\\\x00')`);
await limparIngressosEncerrados();
check('evento encerrado: ingressos apagados', psql(`select count(*) from company_1.doc_files where event_id=${ev.id}`) === '0');
check('contratos não são apagados', psql(`select count(*) from company_1.doc_files where token='tok-contrato-${marca}'`) === '1');
psql(`delete from company_1.doc_files where token='tok-contrato-${marca}'`);

psql("update public.companies set wa_api_url=null, wa_api_token=null where id=1");

// ---- ingresso só para venda paga ----
const foneS = '5532955' + String(marca).padStart(6, '0').slice(-6);
const setorB = (await api('POST', '/casa-de-shows/sectors', { name: 'Setor B ' + marca, space: 8 })).body;
const semPag = (await api('POST', '/casa-de-shows/sales', { event_id: ev.id, sector_id: setorB.id, name: 'Sem Pagamento', phone: foneS, people: 1 })).body;
r = await ia('POST', '/casa-de-shows/sales/send-tickets', { number: foneS + '@s.whatsapp.net', phone: foneS, sale_id: semPag.id });
check('venda sem pagamento não recebe ingresso', r.body.ok === false && /não tem pagamento confirmado/.test(r.body.message) && r.body.sent === 0, JSON.stringify(r.body) + JSON.stringify(semPag).slice(0, 200));

// ---- situação real do cliente entregue ao atendente ----
const foneT = '5532944' + String(marca).padStart(6, '0').slice(-6);
const sit = async (ph) => (await ia('GET', '/agent/prompt?phone=' + ph)).body.prompt || '';
check('cliente sem pagamento: situação diz NENHUM', /NENHUM/.test(await sit(foneT)));
await pagar(foneT, 150);
check('situação mostra o pagamento confirmado', /AINDA NÃO USADO em venda: R\$ 150,00/.test(await sit(foneT)));
check('situação de quem já comprou mostra a venda', /venda \d+, .*pago R\$ 200,00/.test(await sit(fone)));
check('sem telefone nada é acrescentado', !/SITUAÇÃO REAL/.test((await ia('GET', '/agent/prompt')).body.prompt || ''));

// ---- aviso e resposta do responsável ----
psql("update company_1.payments set status='rejected' where status in ('review','wrong_key','low_amount')");
falhar = false;
psql(`update public.companies set admin_phone='5532911112222', wa_api_url='http://127.0.0.1:${porta}', wa_api_token='tok-teste' where id=1`);
recebidos.length = 0;
const foneR = '5532933' + String(marca).padStart(6, '0').slice(-6);
const rev = await pagar(foneR, 80, 'ninguem@outro.com');
await new Promise((x) => setTimeout(x, 600));
const aviso = recebidos.find((x) => x.url === '/send/text');
check('comprovante não aceito avisa o responsável', rev.accepted === false && aviso && aviso.body.number === '553211112222' && /aguardando sua decisão/.test(aviso.body.text) && /R\$ 80,00/.test(aviso.body.text), JSON.stringify(recebidos));
r = await ia('POST', '/payments/adm-reply', { text: 'Bom dia, tudo bem?' });
check('conversa comum não é resposta', r.body.handled === false, JSON.stringify(r.body));
r = await ia('POST', '/payments/adm-reply', { text: 'Sim' });
check('"sim" aprova o comprovante avisado', r.body.handled === true && r.body.ok === true && r.body.decision === 'approved' && r.body.kind === 'payment' && r.body.client_phone === foneR.replace(/^(55\d{2})9/, '$1'), JSON.stringify(r.body));
check('depois de aprovado o pagamento conta para o cliente', /AINDA NÃO USADO em venda: R\$ 80,00/.test(await sit(foneR)));
r = await ia('POST', '/payments/adm-reply', { text: 'sim' });
check('"sim" sem aviso pendente não faz nada', r.body.handled === false, JSON.stringify(r.body));
const foneR2 = '5532922' + String(marca).padStart(6, '0').slice(-6), foneR3 = '5532921' + String(marca).padStart(6, '0').slice(-6);
const p2 = await pagar(foneR2, 40, 'ninguem@outro.com'), p3 = await pagar(foneR3, 50, 'ninguem@outro.com');
await new Promise((x) => setTimeout(x, 600));
r = await ia('POST', '/payments/adm-reply', { text: 'não' });
check('com dois pendentes pede o número', r.body.handled === true && r.body.ok === false && /#/.test(r.body.message), JSON.stringify(r.body));
r = await ia('POST', '/payments/adm-reply', { text: `não #${p2.payment_id}` });
check('"não #id" recusa o comprovante certo', r.body.ok === true && r.body.decision === 'rejected', JSON.stringify(r.body));
check('o recusado ficou recusado e o outro segue pendente', psql(`select status from company_1.payments where id=${p2.payment_id}`) === 'rejected' && psql(`select status from company_1.payments where id=${p3.payment_id}`) === 'wrong_key');


// ---- cancelamento: a atendente pede, o responsável decide ----
falhar = false; recebidos.length = 0;
psql("update company_1.payments set status='rejected' where status in ('review','wrong_key','low_amount')");
const foneC = '5532911' + String(marca).padStart(6, '0').slice(-6);
const ev2 = (await api('POST', '/events', { title: 'Show IA2 ' + marca, starts_at: new Date(Date.now() + 12 * 864e5).toISOString() })).body;
const setor2 = (await api('POST', '/casa-de-shows/sectors', { name: 'Setor C ' + marca, space: 8 })).body;
await api('PUT', `/casa-de-shows/events/${ev2.id}/conditions`, { price: 100 });
await pagar(foneC, 100);
const vc = await ia('POST', '/casa-de-shows/sales/register', { event: ev2.title, sector: setor2.name, names: ['Cida Lima'], phone: foneC, amount: 100, method: 'Pix' });
check('venda para cancelar', vc.body.ok === true, JSON.stringify(vc.body));
r = await ia('POST', '/casa-de-shows/sales/cancel-request', { phone: '5532900099999' });
check('quem não comprou não tem o que cancelar', r.body.ok === false && /Não achei compra ativa/.test(r.body.message), JSON.stringify(r.body));
r = await ia('POST', '/casa-de-shows/sales/cancel-request', { phone: foneC, reason: 'desistiu' });
await new Promise((x) => setTimeout(x, 600));
const avc = recebidos.find((x) => x.url === '/send/text' && /cancelamento/.test(x.body.text));
check('o pedido avisa o responsável (paga ou não)', r.body.ok === true && avc && /JÁ PAGA/.test(avc.body.text) && /#C\d+/.test(avc.body.text), JSON.stringify(r.body) + JSON.stringify(recebidos.map((x) => x.body.text)));
check('a atendente é orientada a NÃO dizer que cancelou', /NÃO diga que foi cancelado/.test(r.body.message));
check('a venda continua ativa até o responsável decidir', psql(`select status from company_1.shows_sales where id=${vc.body.sale_id}`) === 'confirmed');
check('pedido repetido não duplica', (await ia('POST', '/casa-de-shows/sales/cancel-request', { phone: foneC })).body.duplicate === true);
check('situação do cliente mostra o pedido pendente', /aguardando o financeiro/.test(await sit(foneC)));
r = await ia('POST', '/payments/adm-reply', { text: 'não' });
check('"não" mantém a venda', r.body.handled === true && r.body.kind === 'cancel' && r.body.decision === 'rejected' && psql(`select status from company_1.shows_sales where id=${vc.body.sale_id}`) === 'confirmed', JSON.stringify(r.body));
await ia('POST', '/casa-de-shows/sales/cancel-request', { phone: foneC });
await new Promise((x) => setTimeout(x, 600));
r = await ia('POST', '/payments/adm-reply', { text: 'Sim' });
check('"sim" cancela e libera as vagas', r.body.handled === true && r.body.kind === 'cancel' && r.body.decision === 'approved' && psql(`select status from company_1.shows_sales where id=${vc.body.sale_id}`) === 'cancelled', JSON.stringify(r.body));
check('o pagamento da venda cancelada continua registrado', psql(`select count(*) from company_1.shows_sale_payments where sale_id=${vc.body.sale_id}`) === '1');
check('pagamento aprovado devolve o tipo payment', true);
// ---- ampliar a venda: o grupo avisou que ia crescer ----
{
  const foneE = '5532955' + String(marca).padStart(6, '0').slice(-6);
  await pagar(foneE, 200);
  let x = await ia('POST', '/casa-de-shows/sales/register', { event: ev2.title, sector: setor2.name, names: ['Eva Lima', 'Gil Lima'], phone: foneE, amount: 200, method: 'Pix' });
  check('venda de 2 cadastrada', x.body.ok === true && x.body.people === 2, JSON.stringify(x.body));
  const idE = x.body.sale_id;
  x = await ia('POST', '/casa-de-shows/sales/extend', { event: ev2.title, phone: foneE, names: ['Hugo Lima', 'Iris Lima'], amount: 200, method: 'Pix' });
  check('sem pagamento novo não amplia', x.body.ok === false && /NÃO há pagamento confirmado/.test(x.body.message), JSON.stringify(x.body));
  check('venda original intacta sem pagamento', psql(`select people from company_1.shows_sales where id=${idE}`) === '2');
  await pagar(foneE, 200);
  x = await ia('POST', '/casa-de-shows/sales/extend', { event: ev2.title, phone: foneE, names: ['Hugo Lima', 'Iris Lima'], amount: 200, method: 'Pix' });
  check('com pagamento a venda vira 4 pessoas', x.status === 201 && x.body.ok === true && x.body.people === 4 && String(x.body.sale_id) === String(idE), JSON.stringify(x.body));
  check('os 4 nomes ficam na lista', psql(`select guests from company_1.shows_sales where id=${idE}`).split('\n').length === 4 && /Iris Lima/.test(psql(`select guests from company_1.shows_sales where id=${idE}`)));
  check('pagamentos somam 400 e têm chave', psql(`select sum(amount)::int || '/' || count(*) filter (where pix_key_id is not null) from company_1.shows_sale_payments where sale_id=${idE}`) === '400/2');
  x = await ia('POST', '/casa-de-shows/sales/extend', { event: ev2.title, phone: foneE, names: ['Hugo Lima'], amount: 100, method: 'Pix' });
  check('repetir o nome não duplica', x.body.duplicate === true, JSON.stringify(x.body));
  await pagar(foneE, 100);
  x = await ia('POST', '/casa-de-shows/sales/extend', { event: ev2.title, phone: foneE, names: ['Jose Lima'], amount: 100, method: 'Pix' });
  check('mesa cheia: ampliar ou recusar sem estragar a venda', (x.body.ok === true && x.body.people === 5) || (x.body.ok === false && psql(`select people from company_1.shows_sales where id=${idE}`) === '4'), JSON.stringify(x.body));
}
// ---- pagamento aceito que ficou sem venda: o responsável é avisado uma vez ----
{
  const { runAs } = await import('../src/db.js');
  const { avisarPagamentosSemVenda } = await import('../src/financeiro.js');
  const foneTn = foneT.replace(/^(55\d{2})9/, '$1');
  psql("update company_1.payments set created_at = now() - interval '40 minutes' where customer_id = (select id from company_1.customers where phone='" + foneTn + "')");
  psql("update company_1.payments set orphan_alerted_at = now() where orphan_alerted_at is null and customer_id is distinct from (select id from company_1.customers where phone='" + foneTn + "')");
  recebidos.length = 0;
  const n1 = await runAs(1, () => avisarPagamentosSemVenda());
  const av = recebidos.find((x) => x.url === '/send/text');
  check('pagamento sem venda avisa o responsável', n1 === 1 && av && /SEM venda cadastrada/.test(av.body.text) && /R\$ 150,00/.test(av.body.text), JSON.stringify(recebidos));
  recebidos.length = 0;
  check('o aviso não se repete', (await runAs(1, () => avisarPagamentosSemVenda())) === 0 && !recebidos.length);
  check('a situação manda cadastrar a venda', /cadastre a venda/i.test(await sit(foneT)));
}
check('venda da atendente mostra a chave Pix do comprovante', psql("select count(*) from company_1.shows_sale_payments sp join company_1.payments p on p.id=sp.payment_id where sp.method='pix' and p.pix_key_id is not null and sp.pix_key_id is distinct from p.pix_key_id") === '0' && Number(psql("select count(*) from company_1.shows_sale_payments sp where sp.method='pix' and sp.payment_id is not null and sp.pix_key_id is not null")) > 0);
fake.close();
await api('DELETE', `/finance/keys/${chave.id}`);
console.log(`shows_venda_ia: ${ok} ok, ${fail} falhas`);
process.exit(fail ? 1 : 0);
