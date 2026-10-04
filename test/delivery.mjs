// Módulo Delivery. Uso: BASE=http://localhost:3999 node test/delivery.mjs
import { execSync } from 'child_process';
import { abertoPelosHorarios, podeIr } from '../src/delivery.js';
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
const A = (await call('POST', '/api/auth/login', { body: { email: 'demo@demo.com', password: 'demo1234' } })).body;
const B = (await call('POST', '/api/auth/login', { body: { email: 'dois@x.com', password: 'senhasenha' } })).body;
const N8N = { 'x-api-key': process.env.N8N_API_KEY || 'k', 'x-company-id': '1' };
const tk = A.token;
const api = (m, p, body) => call(m, '/api' + p, { token: tk, body });
psql('delete from company_1.dlv_orders; delete from company_1.dlv_items; delete from company_1.dlv_categories; delete from company_1.dlv_zones; delete from company_1.dlv_couriers; delete from company_1.dlv_coupons; delete from company_1.dlv_settings; delete from agendamentos_mensagens');

// ---- horários e etapas (regras puras) ----
const seg = (h) => new Date(`2026-10-05T${h}:00-03:00`);   // segunda-feira
const ter = (h) => new Date(`2026-10-06T${h}:00-03:00`);
const horas = { 1: { open: '18:00', close: '23:00' }, 5: { open: '18:00', close: '01:00' } };
const tz = 'America/Sao_Paulo';
check('aberto dentro do horário', abertoPelosHorarios(horas, tz, seg('20:00')));
check('fechado antes de abrir', !abertoPelosHorarios(horas, tz, seg('17:59')));
check('fechado depois de fechar', !abertoPelosHorarios(horas, tz, seg('23:00')));
check('fechado em dia sem horário', !abertoPelosHorarios(horas, tz, ter('20:00')));
check('janela que passa da meia-noite (sexta → sábado)', abertoPelosHorarios(horas, tz, new Date('2026-10-10T00:30:00-03:00')) && !abertoPelosHorarios(horas, tz, new Date('2026-10-10T01:30:00-03:00')));
check('etapas: novo só confirma ou cancela', podeIr('new', 'confirmed', 'delivery') && !podeIr('new', 'preparing', 'delivery') && podeIr('new', 'cancelled', 'delivery'));
check('retirada não sai para entrega', !podeIr('ready', 'out_for_delivery', 'pickup') && podeIr('ready', 'delivered', 'pickup'));
check('etapa final não anda', !podeIr('delivered', 'cancelled', 'delivery'));

// ---- configuração ----
const s0 = (await api('GET', '/delivery/settings')).body;
check('configuração nasce com padrões', s0.open_mode === 'auto' && s0.delivery_enabled && s0.pay_pix && s0.prep_minutes === 30 && typeof s0.open_now === 'boolean');
check('modo inválido recusado', (await api('PUT', '/delivery/settings', { open_mode: 'talvez' })).status === 400);
check('horário inválido recusado', (await api('PUT', '/delivery/settings', { hours: { 1: { open: '25:00', close: '23:00' } } })).status === 400);
check('tempo inválido recusado', (await api('PUT', '/delivery/settings', { prep_minutes: -1 })).status === 400);
const s1 = (await api('PUT', '/delivery/settings', { open_mode: 'closed', closed_message: 'Voltamos às 18h', hours: { 1: { open: '18:00', close: '23:00' } }, pix_key: 'loja@pix.com', min_order: '20,00', default_fee: 5, prep_minutes: 20, delivery_minutes: 25 })).body;
check('salva configuração', s1.open_now === false && s1.min_order === 20 && s1.default_fee === 5 && s1.pix_key === 'loja@pix.com');

// ---- cardápio ----
const cat = (await api('POST', '/delivery/categories', { name: 'Pizzas' })).body;
const cat2 = (await api('POST', '/delivery/categories', { name: 'Bebidas', position: 2 })).body;
check('categoria criada', !!cat.id && !!cat2.id);
check('categoria sem nome recusada', (await api('POST', '/delivery/categories', { name: '  ' })).status === 400);
const pizza = (await api('POST', '/delivery/items', { name: 'Pizza Calabresa', description: 'Grande', price: '39,90', category_id: cat.id })).body;
const refri = (await api('POST', '/delivery/items', { name: 'Refrigerante', price: 8, category_id: cat2.id })).body;
const velho = (await api('POST', '/delivery/items', { name: 'Item Antigo', price: 10, category_id: cat2.id, active: false })).body;
check('item criado', !!pizza.id && !!refri.id);
check('preço inválido recusado', (await api('POST', '/delivery/items', { name: 'X', price: 'abc' })).status === 400);
check('preço negativo recusado', (await api('POST', '/delivery/items', { name: 'X', price: -5 })).status === 400);
const gBorda = (await api('POST', `/delivery/items/${pizza.id}/groups`, { name: 'Borda', min_select: 1, max_select: 1 })).body;
const gExtra = (await api('POST', `/delivery/items/${pizza.id}/groups`, { name: 'Extras', min_select: 0, max_select: 2 })).body;
check('grupo com mínimo maior que o máximo recusado', (await api('POST', `/delivery/items/${pizza.id}/groups`, { name: 'Y', min_select: 3, max_select: 1 })).status === 400);
const oSem = (await api('POST', `/delivery/groups/${gBorda.id}/options`, { name: 'Sem borda' })).body;
const oCat = (await api('POST', `/delivery/groups/${gBorda.id}/options`, { name: 'Catupiry', price_delta: '6,00' })).body;
const oBac = (await api('POST', `/delivery/groups/${gExtra.id}/options`, { name: 'Bacon', price_delta: 4 })).body;
const oOvo = (await api('POST', `/delivery/groups/${gExtra.id}/options`, { name: 'Ovo', price_delta: 2 })).body;
const oMil = (await api('POST', `/delivery/groups/${gExtra.id}/options`, { name: 'Milho', price_delta: 2 })).body;
const oOff = (await api('POST', `/delivery/groups/${gExtra.id}/options`, { name: 'Indisponível', price_delta: 1 })).body;
await api('PUT', `/delivery/options/${oOff.id}`, { active: false });
const menu = (await api('GET', '/delivery/menu')).body;
const pz = menu.categories.find((c) => c.name === 'Pizzas').items[0];
check('cardápio traz itens, grupos e complementos ativos', pz.price === 39.9 && pz.option_groups.length === 2 && pz.option_groups.find((g) => g.name === 'Extras').options.length === 3);
check('item desativado não aparece para o atendente', !JSON.stringify((await call('GET', '/n8n/delivery/menu', { headers: N8N })).body).includes('Item Antigo'));
check('item desativado aparece na gestão', JSON.stringify((await api('GET', '/delivery/menu?all=1')).body).includes('Item Antigo'));

// ---- pedido: validações ----
const base = { kind: 'pickup', payment_method: 'pix', name: 'Cliente Teste', phone: '32 99888-0001', items: [{ item_id: pizza.id, qty: 1, options: [oSem.id] }] };
const q1 = await api('POST', '/delivery/quote', base);
check('loja fechada recusa o pedido do atendente', q1.status === 409 && q1.body.error === 'Voltamos às 18h', JSON.stringify(q1.body));
await api('PUT', '/delivery/settings', { open_mode: 'open' });
const q2 = (await api('POST', '/delivery/quote', base)).body;
check('retirada: total = item, sem taxa', q2.subtotal === 39.9 && q2.delivery_fee === 0 && q2.total === 39.9 && q2.eta_minutes === 20, JSON.stringify(q2));
const q3 = (await api('POST', '/delivery/quote', { ...base, items: [{ item_id: pizza.id, qty: 2, options: [oCat.id, oBac.id, oOvo.id] }] })).body;
check('soma complementos e quantidade', q3.total === r(2 * (39.9 + 6 + 4 + 2)), JSON.stringify(q3));
function r(n) { return Math.round(n * 100) / 100; }
const bad = async (items, msg, st = 400) => { const x = await api('POST', '/delivery/quote', { ...base, items }); check(msg, x.status === st, JSON.stringify(x.body)); return x.body; };
await bad([{ item_id: pizza.id, qty: 1 }], 'grupo obrigatório sem escolha é recusado');
await bad([{ item_id: pizza.id, qty: 1, options: [oSem.id, oCat.id] }], 'passar do máximo do grupo é recusado');
await bad([{ item_id: pizza.id, qty: 1, options: [oSem.id, oBac.id, oOvo.id, oMil.id] }], 'passar do máximo de extras é recusado');
await bad([{ item_id: pizza.id, qty: 1, options: [oSem.id, oOff.id] }], 'complemento desativado é recusado');
await bad([{ item_id: pizza.id, qty: 1, options: [oSem.id, refri.id] }], 'complemento de outro item é recusado');
await bad([{ item_id: pizza.id, qty: 0, options: [oSem.id] }], 'quantidade zero é recusada');
await bad([{ item_id: pizza.id, qty: 100, options: [oSem.id] }], 'quantidade 100 é recusada');
await bad([{ item_id: velho.id, qty: 1 }], 'item desativado é recusado');
await bad([{ item_id: '999999', qty: 1 }], 'item inexistente é recusado');
await bad([], 'pedido vazio é recusado');
await bad([{ item_id: refri.id, qty: 1 }], 'abaixo do pedido mínimo é recusado', 409);
await api('PUT', `/delivery/items/${refri.id}`, { sold_out: true });
await bad([{ item_id: refri.id, qty: 5 }], 'item esgotado é recusado', 409);
await api('PUT', `/delivery/items/${refri.id}`, { sold_out: false });
check('preço enviado por fora é ignorado', (await api('POST', '/delivery/quote', { ...base, items: [{ item_id: pizza.id, qty: 1, options: [oSem.id], price: 1, unit_price: 1 }] })).body.total === 39.9);

// ---- entrega, bairros e taxas ----
const ent = { ...base, kind: 'delivery', street: 'Rua A', number: '10', neighborhood: 'Centro' };
const e1 = (await api('POST', '/delivery/quote', ent)).body;
check('entrega com taxa padrão', e1.delivery_fee === 5 && e1.total === 44.9 && e1.eta_minutes === 45, JSON.stringify(e1));
check('entrega sem rua é recusada', (await api('POST', '/delivery/quote', { ...ent, street: '' })).status === 400);
await api('PUT', '/delivery/settings', { free_above: 39 });
check('frete grátis acima do valor', (await api('POST', '/delivery/quote', ent)).body.delivery_fee === 0);
await api('PUT', '/delivery/settings', { free_above: null });
const z1 = (await api('POST', '/delivery/zones', { name: 'São Mateus', fee: '8,50', extra_minutes: 10 })).body;
const z2 = (await api('POST', '/delivery/zones', { name: 'Bairro Longe', fee: 15, min_order: 60 })).body;
check('bairro criado', !!z1.id && !!z2.id);
await api('PUT', '/delivery/settings', { use_zones: true });
const nz = await api('POST', '/delivery/quote', ent);
check('bairro não atendido é recusado', nz.status === 409 && /Centro/.test(nz.body.error), JSON.stringify(nz.body));
const zq = (await api('POST', '/delivery/quote', { ...ent, neighborhood: ' sao  MATEUS ' })).body;
check('bairro reconhecido sem acento nem maiúsculas, com taxa e tempo extra', zq.delivery_fee === 8.5 && zq.zone === 'São Mateus' && zq.eta_minutes === 55, JSON.stringify(zq));
check('mínimo por bairro', (await api('POST', '/delivery/quote', { ...ent, neighborhood: 'Bairro Longe' })).status === 409);
const st = (await call('GET', '/n8n/delivery/status', { headers: N8N })).body;
check('status para o atendente lista bairros e pagamentos', st.open_now === true && st.uses_zones && st.zones.length === 2 && st.payment.pix_key === 'loja@pix.com' && st.hours.includes('segunda'), JSON.stringify(st));
await api('PUT', '/delivery/settings', { use_zones: false });

// ---- cupons e pagamento ----
const cp = (await api('POST', '/delivery/coupons', { code: 'ola10', kind: 'percent', value: 10 })).body;
const cf = (await api('POST', '/delivery/coupons', { code: 'MENOS5', kind: 'fixed', value: 5, min_order: 30, max_uses: 1 })).body;
const cv = (await api('POST', '/delivery/coupons', { code: 'VELHO', kind: 'percent', value: 50, valid_until: '2020-01-01' })).body;
check('cupom criado em maiúsculas', !!cp.id && (await api('GET', '/delivery/coupons')).body.some((c) => c.code === 'OLA10'));
check('cupom com mais de 100% recusado', (await api('POST', '/delivery/coupons', { code: 'MUITO', kind: 'percent', value: 150 })).status === 400);
check('cupom de porcentagem', (await api('POST', '/delivery/quote', { ...base, coupon: 'ola10' })).body.discount === 3.99);
check('cupom vencido é recusado', (await api('POST', '/delivery/quote', { ...base, coupon: 'VELHO' })).status === 400);
check('cupom inexistente é recusado', (await api('POST', '/delivery/quote', { ...base, coupon: 'NAOEXISTE' })).status === 400);
check('forma de pagamento obrigatória', (await api('POST', '/delivery/quote', { ...base, payment_method: undefined })).status === 400);
await api('PUT', '/delivery/settings', { pay_card: false });
check('forma de pagamento desligada é recusada', (await api('POST', '/delivery/quote', { ...base, payment_method: 'card' })).status === 400);
check('troco menor que o total é recusado', (await api('POST', '/delivery/quote', { ...base, payment_method: 'cash', change_for: 20 })).status === 400);
check('troco válido', (await api('POST', '/delivery/quote', { ...base, payment_method: 'cash', change_for: 50 })).body.change_for === 50);

// ---- criar pedido, etapas e avisos ----
const fila = (n) => Number(psql(`select count(*) from agendamentos_mensagens where origem='delivery' ${n || ''}`));
await api('PUT', '/delivery/settings', { notify: true });
psql("update public.companies set whatsapp_instance='tm-loja' where id=1");
const c1 = await api('POST', '/delivery/orders', { ...ent, coupon: 'MENOS5', name: 'Maria Souza', phone: '32 98888-1111', note: 'Sem cebola' });
const ped = c1.body;
check('cria o pedido com total recalculado', c1.status === 201 && ped.status === 'new' && ped.total === 44.9 - 5 && ped.items.length === 1 && ped.pix_key === 'loja@pix.com', JSON.stringify(c1.body));
check('cupom de uso único não vale de novo', (await api('POST', '/delivery/quote', { ...base, coupon: 'MENOS5' })).status === 400);
check('cliente entra na base como lead', psql("select status from company_1.customers where phone='553288881111'") === 'lead');
check('pedido do painel não gera aviso ao criar', fila() === 0);
check('não pula etapa', (await api('POST', `/delivery/orders/${ped.id}/status`, { status: 'preparing' })).status === 409);
check('etapa inválida recusada', (await api('POST', `/delivery/orders/${ped.id}/status`, { status: 'voando' })).status === 400);
check('confirma', (await api('POST', `/delivery/orders/${ped.id}/status`, { status: 'confirmed' })).status === 200);
check('confirmação avisa o cliente com previsão', fila() === 1 && psql("select mensagem from agendamentos_mensagens where origem='delivery' order by id limit 1").includes('45 min') && psql("select instancia from agendamentos_mensagens where origem='delivery' limit 1") === 'tm-loja');
await api('POST', `/delivery/orders/${ped.id}/status`, { status: 'preparing' });
await api('POST', `/delivery/orders/${ped.id}/status`, { status: 'ready' });
check('pronto de entrega não avisa ainda', fila() === 1);
const ent1 = (await api('POST', '/delivery/couriers', { name: 'João Moto', phone: '32 97777-0000' })).body;
check('entregador criado', !!ent1.id);
check('entregador inválido recusado', (await api('POST', `/delivery/orders/${ped.id}/status`, { status: 'out_for_delivery', courier_id: '999999' })).status === 400);
check('sai para entrega com entregador', (await api('POST', `/delivery/orders/${ped.id}/status`, { status: 'out_for_delivery', courier_id: ent1.id })).status === 200);
check('aviso de saída cita o entregador', psql("select mensagem from agendamentos_mensagens where origem='delivery' order by id desc limit 1").includes('João Moto'));
check('entrega e marca como pago e cliente', (await api('POST', `/delivery/orders/${ped.id}/status`, { status: 'delivered' })).status === 200 && psql("select client_kinds::text || status from company_1.customers where phone='553288881111'").includes('buyer'));
const det = (await api('GET', `/delivery/orders/${ped.id}`)).body;
check('histórico de etapas', det.events.map((e) => e.status).join() === 'new,confirmed,preparing,ready,out_for_delivery,delivered' && det.courier_name === 'João Moto' && !!det.delivered_at, JSON.stringify(det.events));
check('pedido entregue não muda mais', (await api('POST', `/delivery/orders/${ped.id}/status`, { status: 'cancelled' })).status === 409 && (await api('PUT', `/delivery/orders/${ped.id}`, { note: 'x' })).status === 409);

// cancelar devolve o cupom
const c2 = (await api('POST', '/delivery/orders', { ...base, coupon: 'OLA10', phone: '32 98888-2222', name: 'Pedro' })).body;
check('cupom contou o uso', Number(psql("select used from company_1.dlv_coupons where code='OLA10'")) === 1);
await api('POST', `/delivery/orders/${c2.id}/status`, { status: 'cancelled', reason: 'Cliente desistiu' });
check('cancelar devolve o uso do cupom e guarda o motivo', Number(psql("select used from company_1.dlv_coupons where code='OLA10'")) === 0 && psql(`select cancel_reason from company_1.dlv_orders where id=${c2.id}`) === 'Cliente desistiu');
check('aviso de cancelamento cita o motivo', psql("select mensagem from agendamentos_mensagens where origem='delivery' order by id desc limit 1").includes('Cliente desistiu'));

// pelo atendente (n8n): confirmação automática e consulta por telefone
await api('PUT', '/delivery/settings', { auto_accept: true });
const ia = await call('POST', '/n8n/delivery/orders', { headers: N8N, body: { ...base, phone: '32 98888-3333', name: 'Ana IA' } });
check('pedido do atendente nasce confirmado quando a loja aceita sozinha', ia.status === 201 && ia.body.status === 'confirmed' && ia.body.source === 'ia', JSON.stringify(ia.body));
const porTel = (await call('GET', '/n8n/delivery/orders/by-phone/32988883333', { headers: N8N })).body;
check('atendente consulta o pedido pelo telefone', porTel.active.length === 1 && porTel.active[0].id === ia.body.id && porTel.status_names.confirmed === 'Confirmado');
await api('PUT', '/delivery/settings', { open_mode: 'closed', auto_accept: false });
check('com a loja fechada o atendente é barrado', (await call('POST', '/n8n/delivery/orders', { headers: N8N, body: { ...base, phone: '32 98888-4444' } })).status === 409);
check('sem forçar, nem o painel lança com a loja fechada', (await api('POST', '/delivery/orders', { ...base, phone: '32 98888-4444', name: 'Balcão' })).status === 409);
check('o painel pode lançar pedido mesmo fechado, forçando', (await api('POST', '/delivery/orders', { ...base, phone: '32 98888-4444', name: 'Balcão', force: true })).status === 201);
check('o atendente não consegue forçar', (await call('POST', '/n8n/delivery/orders', { headers: N8N, body: { ...base, phone: '32 98888-4445', force: true } })).status === 409);
const agend = new Date(Date.now() + 3 * 3600 * 1000).toISOString();
check('pedido agendado passa com a loja fechada', (await call('POST', '/n8n/delivery/orders', { headers: N8N, body: { ...base, phone: '32 98888-5555', name: 'Agendado', scheduled_for: agend } })).status === 201);
check('agendar no passado é recusado', (await api('POST', '/delivery/quote', { ...base, scheduled_for: '2020-01-01T10:00:00Z' })).status === 400);
await api('PUT', '/delivery/settings', { open_mode: 'open' });

// ---- listas, isolamento, relatório ----
const ativos = (await api('GET', '/delivery/orders?active=1')).body;
check('lista de pedidos ativos', ativos.length >= 3 && ativos.every((o) => !['delivered', 'cancelled'].includes(o.status)));
check('filtro por etapa', (await api('GET', '/delivery/orders?status=cancelled')).body.length === 1);
check('busca por nome', (await api('GET', '/delivery/orders?q=Maria')).body.length === 1);
check('data inválida recusada', (await api('GET', '/delivery/orders?from=ontem')).status === 400);
check('empresa 2 não enxerga o delivery da 1', (await call('GET', '/api/delivery/orders', { token: B.token })).body.length === 0 && (await call('GET', '/api/delivery/menu', { token: B.token })).body.categories.length === 0);
const rel = (await api('GET', '/delivery/report')).body;
check('relatório soma o faturamento sem cancelados', rel.summary.orders >= 4 && rel.summary.cancelled === 1 && rel.summary.delivered === 1 && rel.summary.revenue > 0 && rel.top_items[0].key === 'Pizza Calabresa', JSON.stringify(rel.summary));
check('relatório por pagamento e bairro', rel.by_payment.length >= 1 && Array.isArray(rel.by_neighborhood) && rel.by_hour.length >= 1);
check('relatório com período inválido usa o padrão', (await api('GET', '/delivery/report?from=x&to=y')).status === 200);

// ---- exclusões ----
check('apaga complemento', (await api('DELETE', `/delivery/options/${oMil.id}`)).status === 200);
check('apaga categoria sem apagar o item', (await api('DELETE', `/delivery/categories/${cat2.id}`)).status === 200 && Number(psql(`select count(*) from company_1.dlv_items where id=${refri.id}`)) === 1);
const sem = (await api('GET', '/delivery/menu')).body.categories.find((c) => c.name === 'Outros');
check('item sem categoria cai em "Outros"', !!sem && sem.items.some((i) => i.name === 'Refrigerante'));

psql('delete from company_1.dlv_orders; delete from company_1.dlv_items; delete from company_1.dlv_categories; delete from company_1.dlv_zones; delete from company_1.dlv_couriers; delete from company_1.dlv_coupons; delete from company_1.dlv_settings; delete from agendamentos_mensagens');
psql("update public.companies set whatsapp_instance=NULL where id=1");
// ---- importar cardápio de planilha ----
const imp = (rows, dry) => api('POST', '/delivery/import', { rows, dry_run: dry });
const planilha = [
  { Categoria: 'Importados', Item: 'Pizza Imp', 'Descrição': 'Grande', 'Preço': '45,50', 'Local de preparo': 'Cozinha' },
  { Categoria: 'Importados', Item: 'Suco Imp', 'Preço': '9', 'Local de preparo': 'Bar', Esgotado: 'sim' },
  { Categoria: 'Importados', Item: 'Água Imp', 'Preço': '5', 'Local de preparo': 'Sai direto' },
  { Categoria: 'Importados', Item: '', 'Preço': '5' },
  { Categoria: 'Importados', Item: 'Sem preço', 'Preço': 'abc' },
  { Categoria: 'Importados', Item: 'Local ruim', 'Preço': '5', 'Local de preparo': 'lua' },
];
const sim1 = (await imp(planilha, true)).body;
check('importar cardápio: simulação conta e aponta erros', sim1.dry_run && sim1.items.created === 3 && sim1.categories.created === 1 && sim1.errors.length === 3, JSON.stringify(sim1));
check('simulação não grava nada', (await api('GET', '/delivery/menu?all=1')).body.categories.every((c) => c.name !== 'Importados'));
const real1 = (await imp(planilha, false)).body;
check('importar cardápio de verdade', real1.items.created === 3 && real1.dry_run === false);
const mImp = (await api('GET', '/delivery/menu?all=1')).body.categories.find((c) => c.name === 'Importados');
const porNome = (n) => mImp.items.find((i) => i.name === n);
check('itens importados com preço, local de preparo e esgotado', mImp.items.length === 3 && porNome('Pizza Imp').price === 45.5 && porNome('Pizza Imp').station === 'cozinha' && porNome('Suco Imp').station === 'bar' && porNome('Suco Imp').sold_out === true && porNome('Água Imp').station === 'direto');
const real2 = (await imp([{ Categoria: 'importados', Item: 'pizza imp', 'Preço': '50', 'Local de preparo': 'Bar' }], false)).body;
check('reimportar atualiza sem duplicar (ignora maiúsculas)', real2.items.updated === 1 && real2.items.created === 0 && real2.categories.created === 0);
const mImp2 = (await api('GET', '/delivery/menu?all=1')).body.categories.find((c) => c.name === 'Importados');
check('preço e local atualizados', mImp2.items.length === 3 && mImp2.items.find((i) => i.name === 'Pizza Imp').price === 50 && mImp2.items.find((i) => i.name === 'Pizza Imp').station === 'bar');
check('importar cardápio sem linhas não quebra', (await imp([], false)).body.items.created === 0);
check('cardápio importado: isolado por empresa', !(await call('GET', '/api/delivery/menu?all=1', { token: B.token })).body.categories.some((c) => c.name === 'Importados'));

console.log(`delivery: ${ok} ok, ${fail} falhas`);
process.exit(fail ? 1 : 0);
