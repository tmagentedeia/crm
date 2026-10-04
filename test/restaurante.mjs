// Módulo Restaurante. Uso: BASE=http://localhost:3999 node test/restaurante.mjs
import { execSync } from 'child_process';
import { totais, comissao } from '../src/restaurante.js';
const BASE = process.env.BASE || 'http://localhost:3999';
let ok = 0, fail = 0;
const check = (name, cond, extra = '') => { cond ? ok++ : (fail++, console.log('FALHOU:', name, extra)); };
const call = async (method, path, { token, body, headers: h } = {}) => {
  const headers = { 'content-type': 'application/json', ...h };
  if (token) headers.authorization = 'Bearer ' + token;
  const r = await fetch(BASE + path, { method, headers, body: body ? JSON.stringify(body) : undefined });
  let j = null; try { j = await r.json(); } catch {}
  return { status: r.status, body: j };
};
const psql = (sql) => execSync(`psql "${process.env.DATABASE_URL}" -tAc "${sql}"`).toString().trim();
psql("delete from company_1.rst_payments; delete from company_1.rst_tab_items; delete from company_1.rst_tabs; delete from company_1.rst_tables; delete from company_1.dlv_items; delete from company_1.dlv_categories; delete from users where email like 'rs-%'; delete from company_funcoes");
psql("update companies set modules = modules || jsonb_build_object('restaurante', true) where id=1");
const A = (await call('POST', '/api/auth/login', { body: { email: 'demo@demo.com', password: 'demo1234' } })).body;
const B = (await call('POST', '/api/auth/login', { body: { email: 'dois@x.com', password: 'senhasenha' } })).body;
const api = (m, p, body) => call(m, '/api' + p, { token: A.token, body });

// ---- regras puras ----
const t0 = totais([{ total: 100, status: 'sent' }, { total: 50, status: 'cancelled' }], { fee_pct: 10, discount: 5, people: 4 }, [{ amount: 30 }]);
check('totais: cancelado não conta, taxa e desconto', t0.subtotal === 100 && t0.fee === 10 && t0.discount === 5 && t0.total === 105 && t0.paid === 30 && t0.remaining === 75 && t0.per_person === 26.25);
check('totais: desconto não passa da conta', totais([{ total: 10, status: 'sent' }], { fee_pct: 0, discount: 99, people: 1 }, []).total === 0);
check('comissão sobre vendas e, se quiser, sobre a taxa', comissao(100, 10, { commission_pct: 10, commission_on_fee: false }) === 10 && comissao(100, 10, { commission_pct: 10, commission_on_fee: true }) === 11);

// ---- equipe do restaurante ----
const eq = (await api('GET', '/equipe')).body;
const fGarcom = eq.funcoes.find((f) => f.name === 'Garçom'), fCoz = eq.funcoes.find((f) => f.name === 'Cozinha'), fCx = eq.funcoes.find((f) => f.name === 'Caixa do restaurante');
check('funções do restaurante nascem prontas', fGarcom && fCoz && fCx && fCx.telas.includes('rst_caixa'));
const mk = async (nome, f) => { const u = (await api('POST', '/equipe/usuarios', { name: nome, email: `rs-${nome.toLowerCase()}@x.com`, password: 'senha1234', funcao_id: f.id })).body;
  const l = (await call('POST', '/api/auth/login', { body: { email: `rs-${nome.toLowerCase()}@x.com`, password: 'senha1234' } })).body; return { id: u.id, token: l.token }; };
const ana = await mk('Ana', fGarcom), bia = await mk('Bia', fGarcom), cris = await mk('Cris', fCoz), dani = await mk('Dani', fCx);
const as = (u) => (m, p, body) => call(m, '/api' + p, { token: u.token, body });
const [Ana, Bia, Cris, Dani] = [as(ana), as(bia), as(cris), as(dani)];

// ---- mesas e cardápio ----
check('garçom não cria mesa', (await Ana('POST', '/restaurant/table-defs', { name: 'X' })).status === 403);
check('várias mesas de uma vez', (await api('POST', '/restaurant/table-defs', { from: 1, to: 5, prefix: 'Mesa', seats: 4 })).body.created === 5);
check('mesa repetida recusada', (await api('POST', '/restaurant/table-defs', { name: 'Mesa 1' })).status === 409);
check('intervalo inválido recusado', (await api('POST', '/restaurant/table-defs', { from: 5, to: 2 })).status === 400);
const cat = (await api('POST', '/delivery/categories', { name: 'Pratos' })).body.id;
const prato = (await api('POST', '/delivery/items', { name: 'Filé', price: '40', category_id: cat, station: 'cozinha' })).body.id;
const refri = (await api('POST', '/delivery/items', { name: 'Refrigerante', price: '8', category_id: cat, station: 'bar' })).body.id;
const agua = (await api('POST', '/delivery/items', { name: 'Água', price: '5', category_id: cat, station: 'direto' })).body.id;
const sobr = (await api('POST', '/delivery/items', { name: 'Pudim', price: '20', category_id: cat })).body.id;
check('local de preparo inválido recusado', (await api('POST', '/delivery/items', { name: 'Y', price: '1', station: 'lua' })).status === 400);
const grp = (await api('POST', `/delivery/items/${prato}/groups`, { name: 'Ponto', min_select: 1, max_select: 1 })).body.id;
const opMal = (await api('POST', `/delivery/groups/${grp}/options`, { name: 'Ao ponto', price_delta: 0 })).body.id;
const opExtra = (await api('POST', `/delivery/groups/${grp}/options`, { name: 'Com ovo', price_delta: 5 })).body.id;
const menu = (await Ana('GET', '/restaurant/menu')).body;
check('garçom lê o cardápio com o local de preparo', menu.categories[0].items.find((i) => i.name === 'Refrigerante').station === 'bar');
check('cozinha não lê o cardápio de lançamento', (await Cris('GET', '/restaurant/menu')).status === 403);

// ---- comandas ----
const mesas = (await Ana('GET', '/restaurant/tables')).body;
const m1 = mesas.tables.find((m) => m.name === 'Mesa 1').id, m2 = mesas.tables.find((m) => m.name === 'Mesa 2').id;
check('garçom vê as mesas e a taxa padrão', mesas.tables.length === 5 && mesas.settings.service_fee_pct === 10);
check('abrir sem mesa nem nome é recusado', (await Ana('POST', '/restaurant/tabs', {})).status === 400);
const tAna = (await Ana('POST', '/restaurant/tabs', { table_id: m1, people: 2 })).body;
check('comanda aberta no nome do garçom', tAna.waiter_name === 'Ana' && tAna.status === 'open' && tAna.fee_pct === 10 && tAna.people === 2);
check('mesa ocupada não abre outra', (await Bia('POST', '/restaurant/tabs', { table_id: m1 })).status === 409);
const tBia = (await Bia('POST', '/restaurant/tabs', { table_id: m2 })).body;
check('outro garçom abre outra mesa', tBia.id && tBia.waiter_name === 'Bia');
check('garçom não vê comanda de outro', (await Bia('GET', '/restaurant/tabs/' + tAna.id)).status === 403 && (await Bia('POST', `/restaurant/tabs/${tAna.id}/items`, { items: [{ item_id: agua, qty: 1 }] })).status === 403);
check('lista do garçom só tem as dele', (await Ana('GET', '/restaurant/tabs')).body.length === 1 && (await Dani('GET', '/restaurant/tabs')).body.length === 2);
check('mesa ocupada aparece com o garçom', (await Bia('GET', '/restaurant/tables')).body.tables.find((m) => m.id === m1).tab.waiter_name === 'Ana');

// itens: o servidor calcula o preço
check('item sem escolher o ponto é recusado', (await Ana('POST', `/restaurant/tabs/${tAna.id}/items`, { items: [{ item_id: prato, qty: 1 }] })).status === 400);
check('item inexistente recusado', (await Ana('POST', `/restaurant/tabs/${tAna.id}/items`, { items: [{ item_id: '999999', qty: 1 }] })).status === 400);
check('lista vazia recusada', (await Ana('POST', `/restaurant/tabs/${tAna.id}/items`, { items: [] })).status === 400);
const lanc = (await Ana('POST', `/restaurant/tabs/${tAna.id}/items`, { items: [
  { item_id: prato, qty: 2, options: [opExtra], note: 'sem cebola', unit_price: 1 }, { item_id: refri, qty: 1 }, { item_id: agua, qty: 1 }, { item_id: sobr, qty: 1 }] })).body;
check('preço calculado no servidor (ignora o que vem de fora)', lanc.items[0].unit_price === 45 && lanc.items[0].total === 90 && lanc.items[0].note === 'sem cebola');
check('cada item vai para sua fila', lanc.items.map((i) => i.status).join() === 'sent,sent,ready,sent' && lanc.items[2].station === 'direto');
check('totais da comanda', lanc.totals.subtotal === 123 && lanc.totals.fee === 12.3 && lanc.totals.total === 135.3);
await api('PUT', `/delivery/items/${sobr}`, { sold_out: true });
check('esgotado não é lançado', (await Ana('POST', `/restaurant/tabs/${tAna.id}/items`, { items: [{ item_id: sobr, qty: 1 }] })).status === 409);

// ---- cozinha e bar ----
check('garçom não vê a fila da cozinha', (await Ana('GET', '/restaurant/kitchen')).status === 403);
const fila = (await Cris('GET', '/restaurant/kitchen')).body;
check('cozinha vê os itens com a mesa e o garçom', fila.length === 3 && fila[0].where === 'Mesa 1' && fila[0].waiter_name === 'Ana' && !fila.some((i) => i.name === 'Água'));
check('filtro por bar', (await Cris('GET', '/restaurant/kitchen?station=bar')).body.map((i) => i.name).join() === 'Refrigerante');
const [iPrato, iRefri, iAgua, iSobr] = lanc.items.map((i) => i.id);
check('garçom não começa o preparo', (await Ana('POST', `/restaurant/items/${iPrato}/status`, { status: 'preparing' })).status === 403);
check('cozinha começa o preparo', (await Cris('POST', `/restaurant/items/${iPrato}/status`, { status: 'preparing' })).status === 200);
check('garçom não cancela item em preparo', (await Ana('POST', `/restaurant/items/${iPrato}/status`, { status: 'cancelled', reason: 'x' })).status === 403);
check('garçom desfaz o que acabou de lançar', (await Ana('POST', `/restaurant/items/${iSobr}/status`, { status: 'cancelled', reason: 'cliente desistiu' })).status === 200);
check('outro garçom não cancela o item do colega', (await Bia('POST', `/restaurant/items/${iRefri}/status`, { status: 'cancelled', reason: 'x' })).status === 403);
check('pronto exige a cozinha', (await Ana('POST', `/restaurant/items/${iRefri}/status`, { status: 'ready' })).status === 403 && (await Cris('POST', `/restaurant/items/${iRefri}/status`, { status: 'ready' })).status === 200);
check('item entregue não volta a "novo"', (await Cris('POST', `/restaurant/items/${iRefri}/status`, { status: 'sent' })).status === 400);
const prontos = (await Ana('GET', '/restaurant/ready')).body;
check('garçom vê o que está pronto para levar', prontos.map((i) => i.name).sort().join() === 'Refrigerante,Água' && (await Bia('GET', '/restaurant/ready')).body.length === 0);
check('outro garçom não entrega o item do colega', (await Bia('POST', `/restaurant/items/${iAgua}/status`, { status: 'served' })).status === 403);
check('garçom entrega na mesa', (await Ana('POST', `/restaurant/items/${iAgua}/status`, { status: 'served' })).status === 200 && (await Ana('POST', `/restaurant/items/${iRefri}/status`, { status: 'served' })).status === 200);
check('não pula etapa (servir o que não ficou pronto)', (await Ana('POST', `/restaurant/items/${iPrato}/status`, { status: 'served' })).status === 409);
const aposCancel = (await Ana('GET', '/restaurant/tabs/' + tAna.id)).body;
check('item cancelado sai da conta', aposCancel.totals.subtotal === 103 && aposCancel.items[3].status === 'cancelled' && aposCancel.items[3].cancel_reason === 'cliente desistiu');

// ---- caixa ----
check('garçom não mexe no caixa', (await Ana('POST', `/restaurant/tabs/${tAna.id}/payments`, { method: 'pix', amount: 10 })).status === 403
  && (await Ana('PUT', `/restaurant/tabs/${tAna.id}`, { discount: 50 })).status === 403 && (await Ana('GET', '/restaurant/report?from=2020-01-01&to=2099-01-01')).status === 403);
check('garçom pode mudar o número de pessoas', (await Ana('PUT', `/restaurant/tabs/${tAna.id}`, { people: 2, label: 'Aniversário' })).body.label === 'Aniversário');
const dc = (await Dani('PUT', `/restaurant/tabs/${tAna.id}`, { discount: 3.3 })).body;
check('caixa dá desconto', dc.totals.fee === 10.3 && dc.totals.total === 110 && dc.totals.per_person === 55);
check('taxa inválida recusada', (await Dani('PUT', `/restaurant/tabs/${tAna.id}`, { fee_pct: 90 })).status === 400);
check('forma de pagamento inválida', (await Dani('POST', `/restaurant/tabs/${tAna.id}/payments`, { method: 'cheque', amount: 10 })).status === 400);
check('pagamento maior que o restante recusado', (await Dani('POST', `/restaurant/tabs/${tAna.id}/payments`, { method: 'pix', amount: 111 })).status === 400);
const p1 = (await Dani('POST', `/restaurant/tabs/${tAna.id}/payments`, { method: 'pix', amount: 60 })).body;
check('pagamento parcial (conta dividida)', p1.totals.paid === 60 && p1.totals.remaining === 50);
check('não encerra com conta em aberto', (await Dani('POST', `/restaurant/tabs/${tAna.id}/close`)).status === 409);
const p2 = (await Dani('POST', `/restaurant/tabs/${tAna.id}/payments`, { method: 'dinheiro', amount: 50 })).body;
check('conta quitada', p2.totals.remaining === 0 && p2.payments.length === 2);
check('item ainda na cozinha pede confirmação', (await Dani('POST', `/restaurant/tabs/${tAna.id}/close`)).status === 409);
await Cris('POST', `/restaurant/items/${iPrato}/status`, { status: 'ready' });
await Ana('POST', `/restaurant/items/${iPrato}/status`, { status: 'served' });
const fim = (await Dani('POST', `/restaurant/tabs/${tAna.id}/close`)).body;
check('comanda encerrada', fim.status === 'closed' && fim.closed_by === 'Dani');
check('depois de encerrar não lança nem paga', (await Ana('POST', `/restaurant/tabs/${tAna.id}/items`, { items: [{ item_id: agua, qty: 1 }] })).status === 409 && (await Dani('DELETE', `/restaurant/payments/${p1.payments[0].id}`)).status === 409);
const reab = await Bia('POST', '/restaurant/tabs', { table_id: m1 });
check('mesa liberada abre de novo', reab.status === 201);
await Dani('POST', `/restaurant/tabs/${reab.body.id}/cancel`, { reason: 'teste' });

// cancelar comanda e comanda avulsa (balcão)
const avulsa = (await Ana('POST', '/restaurant/tabs', { label: 'Balcão' })).body;
check('comanda avulsa sem mesa', avulsa.label === 'Balcão' && avulsa.table_id === null && (await Ana('GET', '/restaurant/tables')).body.loose.length === 1);
check('garçom não cancela comanda', (await Ana('POST', `/restaurant/tabs/${avulsa.id}/cancel`, { reason: 'x' })).status === 403);
check('cancelar exige motivo', (await Dani('POST', `/restaurant/tabs/${avulsa.id}/cancel`, {})).status === 400);
check('caixa cancela a comanda', (await Dani('POST', `/restaurant/tabs/${avulsa.id}/cancel`, { reason: 'engano' })).status === 200);
// troca de garçom
const trocada = (await Dani('PUT', `/restaurant/tabs/${tBia.id}`, { waiter_id: ana.id })).body;
check('caixa passa a comanda para outro garçom', trocada.waiter_name === 'Ana' && (await Bia('GET', '/restaurant/tabs/' + tBia.id)).status === 403);

// ---- gestão, relatório e comissão ----
check('garçom não muda a configuração', (await Ana('PUT', '/restaurant/settings', { commission_pct: 50 })).status === 403);
check('comissão inválida recusada', (await api('PUT', '/restaurant/settings', { commission_pct: 150 })).status === 400);
await api('PUT', '/restaurant/settings', { commission_pct: 10, commission_on_fee: false, service_fee_pct: 10 });
const rel = (await Dani('GET', '/restaurant/report?from=2020-01-01&to=2099-12-31')).body;
check('relatório: totais do período', rel.tabs === 1 && rel.sales === 103 && rel.fee === 10.3 && rel.discounts === 3.3 && rel.total === 110 && rel.average_ticket === 110);
check('relatório: comissão da Ana sobre as vendas', rel.by_waiter.length === 1 && rel.by_waiter[0].name === 'Ana' && rel.by_waiter[0].commission === 10.3 && rel.commission_total === 10.3);
check('relatório: por forma de pagamento e itens', rel.by_method.find((m) => m.method === 'pix').total === 60 && rel.by_method.find((m) => m.method === 'dinheiro').total === 50 && rel.top_items[0].name === 'Filé' && rel.top_items[0].qty === 2);
await api('PUT', '/restaurant/settings', { commission_on_fee: true });
check('comissão também sobre a taxa de serviço', (await Dani('GET', '/restaurant/report?from=2020-01-01&to=2099-12-31')).body.by_waiter[0].commission === 11.33);
check('relatório sem período recusado', (await Dani('GET', '/restaurant/report')).status === 400);
check('histórico de comandas encerradas', (await Dani('GET', '/restaurant/tabs?status=closed&from=2020-01-01&to=2099-12-31')).body.length === 1);
check('mesa com histórico só sai de cena', (await api('DELETE', '/restaurant/table-defs/' + m1)).body.archived === true);
check('mesa sem histórico é apagada', (await api('DELETE', '/restaurant/table-defs/' + mesas.tables.find((m) => m.name === 'Mesa 5').id)).body.archived === false);

// ---- acesso e isolamento ----
check('garçom não entra no delivery nem nos clientes', (await Ana('GET', '/delivery/orders')).status === 403 && (await Ana('GET', '/customers')).status === 403);
check('cozinha não abre salão nem caixa', (await Cris('GET', '/restaurant/tables')).status === 403 && (await Cris('GET', '/restaurant/waiters')).status === 403);
check('o atendente (n8n) não usa o restaurante', (await call('GET', '/n8n/restaurant/tables', { headers: { 'x-api-key': process.env.N8N_API_KEY || 'k', 'x-company-id': '1' } })).status === 403);
check('outra empresa não vê as mesas', (await call('GET', '/api/restaurant/tables', { token: B.token })).body?.tables?.length === 0);
check('outra empresa não acessa a comanda', (await call('GET', '/api/restaurant/tabs/' + tAna.id, { token: B.token })).status === 404);
console.log(`restaurante: ${ok} ok, ${fail} falhas`);
process.exit(fail ? 1 : 0);
