// Módulo Delivery (independente): cardápio com complementos, taxas por bairro, cupons, entregadores, pedidos com etapas,
// avisos ao cliente pelo WhatsApp e relatórios. O atendente (IA) usa as mesmas rotas em /n8n: consulta o cardápio e o
// status da loja, calcula o total (quote), grava o pedido e responde "cadê meu pedido?". Todos os preços são recalculados
// aqui, a partir do cardápio — nunca se confia no valor que vem de fora.
import { q, qg, tx, currentCompany } from './db.js';
import { normPhone } from './phone.js';
import { msgPool, lembretesLigados } from './indicacoes.js';

export const DELIVERY_SQL = `
  CREATE TABLE IF NOT EXISTS dlv_settings (
    id               INT PRIMARY KEY CHECK (id = 1),
    open_mode        TEXT NOT NULL DEFAULT 'auto' CHECK (open_mode IN ('auto','open','closed')),
    hours            JSONB NOT NULL DEFAULT '{}',
    delivery_enabled BOOLEAN NOT NULL DEFAULT true,
    pickup_enabled   BOOLEAN NOT NULL DEFAULT true,
    min_order        NUMERIC(10,2) NOT NULL DEFAULT 0,
    default_fee      NUMERIC(10,2) NOT NULL DEFAULT 0,
    free_above       NUMERIC(10,2),
    use_zones        BOOLEAN NOT NULL DEFAULT false,
    prep_minutes     INT NOT NULL DEFAULT 30,
    delivery_minutes INT NOT NULL DEFAULT 30,
    pay_pix          BOOLEAN NOT NULL DEFAULT true,
    pay_cash         BOOLEAN NOT NULL DEFAULT true,
    pay_card         BOOLEAN NOT NULL DEFAULT true,
    pix_key          TEXT,
    auto_accept      BOOLEAN NOT NULL DEFAULT false,
    accept_scheduled BOOLEAN NOT NULL DEFAULT true,
    notify           BOOLEAN NOT NULL DEFAULT true,
    closed_message   TEXT,
    messages         JSONB NOT NULL DEFAULT '{}'
  );
  CREATE TABLE IF NOT EXISTS dlv_categories (
    id       BIGSERIAL PRIMARY KEY,
    name     TEXT NOT NULL,
    position INT NOT NULL DEFAULT 0,
    active   BOOLEAN NOT NULL DEFAULT true
  );
  CREATE TABLE IF NOT EXISTS dlv_items (
    id          BIGSERIAL PRIMARY KEY,
    category_id BIGINT REFERENCES dlv_categories(id) ON DELETE SET NULL,
    name        TEXT NOT NULL,
    description TEXT,
    price       NUMERIC(10,2) NOT NULL CHECK (price >= 0),
    active      BOOLEAN NOT NULL DEFAULT true,
    sold_out    BOOLEAN NOT NULL DEFAULT false,
    position    INT NOT NULL DEFAULT 0,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
  );
  CREATE TABLE IF NOT EXISTS dlv_option_groups (
    id         BIGSERIAL PRIMARY KEY,
    item_id    BIGINT NOT NULL REFERENCES dlv_items(id) ON DELETE CASCADE,
    name       TEXT NOT NULL,
    min_select INT NOT NULL DEFAULT 0 CHECK (min_select >= 0),
    max_select INT NOT NULL DEFAULT 1 CHECK (max_select >= 1),
    position   INT NOT NULL DEFAULT 0
  );
  CREATE TABLE IF NOT EXISTS dlv_options (
    id          BIGSERIAL PRIMARY KEY,
    group_id    BIGINT NOT NULL REFERENCES dlv_option_groups(id) ON DELETE CASCADE,
    name        TEXT NOT NULL,
    price_delta NUMERIC(10,2) NOT NULL DEFAULT 0,
    active      BOOLEAN NOT NULL DEFAULT true,
    position    INT NOT NULL DEFAULT 0
  );
  CREATE TABLE IF NOT EXISTS dlv_zones (
    id            BIGSERIAL PRIMARY KEY,
    name          TEXT NOT NULL,
    fee           NUMERIC(10,2) NOT NULL DEFAULT 0 CHECK (fee >= 0),
    min_order     NUMERIC(10,2),
    extra_minutes INT NOT NULL DEFAULT 0,
    active        BOOLEAN NOT NULL DEFAULT true
  );
  CREATE TABLE IF NOT EXISTS dlv_couriers (
    id     BIGSERIAL PRIMARY KEY,
    name   TEXT NOT NULL,
    phone  TEXT,
    active BOOLEAN NOT NULL DEFAULT true
  );
  CREATE TABLE IF NOT EXISTS dlv_coupons (
    id          BIGSERIAL PRIMARY KEY,
    code        TEXT NOT NULL UNIQUE,
    kind        TEXT NOT NULL CHECK (kind IN ('percent','fixed')),
    value       NUMERIC(10,2) NOT NULL CHECK (value > 0),
    min_order   NUMERIC(10,2) NOT NULL DEFAULT 0,
    max_uses    INT,
    used        INT NOT NULL DEFAULT 0,
    valid_until DATE,
    active      BOOLEAN NOT NULL DEFAULT true
  );
  CREATE TABLE IF NOT EXISTS dlv_orders (
    id             BIGSERIAL PRIMARY KEY,
    customer_id    BIGINT REFERENCES customers(id) ON DELETE SET NULL,
    customer_name  TEXT,
    phone          TEXT,
    kind           TEXT NOT NULL CHECK (kind IN ('delivery','pickup')),
    status         TEXT NOT NULL DEFAULT 'new' CHECK (status IN ('new','confirmed','preparing','ready','out_for_delivery','delivered','cancelled')),
    street         TEXT,
    number         TEXT,
    complement     TEXT,
    neighborhood   TEXT,
    reference      TEXT,
    zone_id        BIGINT REFERENCES dlv_zones(id) ON DELETE SET NULL,
    subtotal       NUMERIC(10,2) NOT NULL,
    fee            NUMERIC(10,2) NOT NULL DEFAULT 0,
    discount       NUMERIC(10,2) NOT NULL DEFAULT 0,
    total          NUMERIC(10,2) NOT NULL,
    coupon_code    TEXT,
    payment_method TEXT NOT NULL CHECK (payment_method IN ('pix','cash','card')),
    change_for     NUMERIC(10,2),
    paid           BOOLEAN NOT NULL DEFAULT false,
    note           TEXT,
    cancel_reason  TEXT,
    courier_id     BIGINT REFERENCES dlv_couriers(id) ON DELETE SET NULL,
    scheduled_for  TIMESTAMPTZ,
    eta_minutes    INT,
    source         TEXT NOT NULL DEFAULT 'manual',
    created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
    confirmed_at   TIMESTAMPTZ,
    dispatched_at  TIMESTAMPTZ,
    delivered_at   TIMESTAMPTZ,
    cancelled_at   TIMESTAMPTZ
  );
  CREATE INDEX IF NOT EXISTS idx_dlv_orders_status ON dlv_orders (status, created_at DESC);
  CREATE INDEX IF NOT EXISTS idx_dlv_orders_phone ON dlv_orders (phone, created_at DESC);
  CREATE TABLE IF NOT EXISTS dlv_order_items (
    id         BIGSERIAL PRIMARY KEY,
    order_id   BIGINT NOT NULL REFERENCES dlv_orders(id) ON DELETE CASCADE,
    item_id    BIGINT REFERENCES dlv_items(id) ON DELETE SET NULL,
    name       TEXT NOT NULL,
    qty        INT NOT NULL CHECK (qty > 0),
    unit_price NUMERIC(10,2) NOT NULL,
    options    JSONB NOT NULL DEFAULT '[]',
    note       TEXT,
    total      NUMERIC(10,2) NOT NULL
  );
  CREATE TABLE IF NOT EXISTS dlv_order_events (
    id       BIGSERIAL PRIMARY KEY,
    order_id BIGINT NOT NULL REFERENCES dlv_orders(id) ON DELETE CASCADE,
    status   TEXT NOT NULL,
    note     TEXT,
    at       TIMESTAMPTZ NOT NULL DEFAULT now()
  );`;

// ---------- utilitários ----------
export const ETAPAS = ['new', 'confirmed', 'preparing', 'ready', 'out_for_delivery', 'delivered', 'cancelled'];
export const NOMES_ETAPA = { new: 'Novo', confirmed: 'Confirmado', preparing: 'Em preparo', ready: 'Pronto', out_for_delivery: 'Saiu para entrega', delivered: 'Entregue', cancelled: 'Cancelado' };
const FINAIS = ['delivered', 'cancelled'];
const SEGUINTES = {
  new: ['confirmed', 'cancelled'], confirmed: ['preparing', 'cancelled'], preparing: ['ready', 'cancelled'],
  ready: ['out_for_delivery', 'delivered', 'cancelled'], out_for_delivery: ['delivered', 'cancelled'], delivered: [], cancelled: [],
};
export const podeIr = (de, para, tipo) => SEGUINTES[de]?.includes(para) && !(para === 'out_for_delivery' && tipo === 'pickup');

const r2 = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;
const txt = (v, max, { vazio = true } = {}) => { const s = String(v ?? '').trim(); if (!vazio && !s) return null; return s.length <= max && !/[\u0000-\u0008\u000b-\u001f<>]/.test(s) ? s : null; };
const idOk = (v) => (/^\d+$/.test(String(v ?? '')) ? String(v) : null);
const dinheiro = (v, { max = 99999 } = {}) => {
  if (v === undefined || v === null || v === '') return null;
  const n = Number(String(v).replace(/[R$\s]/g, '').replace(',', '.'));
  return Number.isFinite(n) && n >= 0 && n <= max ? r2(n) : undefined;       // undefined = inválido
};
const inteiro = (v, min, max) => { const n = Number(v); return Number.isInteger(n) && n >= min && n <= max ? n : null; };
const semAcento = (s) => String(s ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/\s+/g, ' ').trim();
const dataOk = (v) => /^\d{4}-\d{2}-\d{2}$/.test(String(v || '')) && !isNaN(new Date(v + 'T00:00:00Z')) ? String(v) : null;
const brl = (n) => 'R$ ' + Number(n).toFixed(2).replace('.', ',');
const quem = (req) => ((req.baseUrl || '').includes('n8n') ? 'ia' : 'manual');
const DIAS = ['domingo', 'segunda', 'terça', 'quarta', 'quinta', 'sexta', 'sábado'];

const fusoDaEmpresa = async () => (await qg('SELECT timezone FROM companies WHERE id=$1', [currentCompany()])).rows[0]?.timezone || 'America/Sao_Paulo';

// Momento local (dia da semana 0-6 e minutos desde 00:00) no fuso da empresa
export function momentoLocal(tz, agora = new Date()) {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: tz, weekday: 'short', hour: '2-digit', minute: '2-digit', hour12: false }).formatToParts(agora).map((x) => [x.type, x.value]));
  const dia = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(p.weekday);
  return { dia, min: (Number(p.hour) % 24) * 60 + Number(p.minute) };
}
const emMin = (hhmm) => { const m = String(hhmm || '').match(/^(\d{2}):(\d{2})$/); return m && Number(m[1]) < 24 && Number(m[2]) < 60 ? Number(m[1]) * 60 + Number(m[2]) : null; };
// hours = { "0": { open: "18:00", close: "23:00" }, ... } (0 = domingo; sem a chave, fechado). Fechar depois da meia-noite vale (18:00 → 01:00).
export function abertoPelosHorarios(hours, tz, agora = new Date()) {
  const { dia, min } = momentoLocal(tz, agora);
  const hoje = hours?.[dia], ontem = hours?.[(dia + 6) % 7];
  const a = emMin(hoje?.open), f = emMin(hoje?.close);
  if (a !== null && f !== null) { if (a < f ? min >= a && min < f : min >= a) return true; }   // abriu hoje e ainda não fechou (ou virou a noite)
  const oa = emMin(ontem?.open), of = emMin(ontem?.close);
  return oa !== null && of !== null && of <= oa && min < of;                                    // janela de ontem que passou da meia-noite
}
export function textoHorarios(hours) {
  const linhas = [];
  for (let d = 0; d < 7; d++) { const h = hours?.[d]; if (emMin(h?.open) !== null && emMin(h?.close) !== null) linhas.push(`${DIAS[d]}: ${h.open} às ${h.close}`); }
  return linhas.join('; ');
}

const PADRAO_MSG = {
  confirmed: 'Olá, {nome}! Seu pedido #{pedido} foi confirmado. Previsão: {eta} min. Total: {total}.',
  ready: 'Olá, {nome}! Seu pedido #{pedido} está pronto para retirada.',
  out_for_delivery: 'Olá, {nome}! Seu pedido #{pedido} saiu para entrega{entregador}. Bom apetite!',
  delivered: 'Pedido #{pedido} entregue. Obrigado, {nome}! Se precisar de algo, é só chamar.',
  cancelled: 'Olá, {nome}. Seu pedido #{pedido} foi cancelado.{motivo}',
};
const MSG_CHAVES = Object.keys(PADRAO_MSG);

async function configuracao() {
  let s = (await q('SELECT * FROM dlv_settings WHERE id=1')).rows[0];
  if (!s) s = (await q('INSERT INTO dlv_settings (id) VALUES (1) ON CONFLICT (id) DO UPDATE SET id=1 RETURNING *')).rows[0];
  return s;
}
const numeros = (s) => ({ ...s, min_order: Number(s.min_order), default_fee: Number(s.default_fee), free_above: s.free_above === null ? null : Number(s.free_above) });

async function estadoDaLoja(s) {
  const tz = await fusoDaEmpresa();
  const pelosHorarios = abertoPelosHorarios(s.hours, tz);
  const aberta = s.open_mode === 'open' ? true : s.open_mode === 'closed' ? false : pelosHorarios;
  return { open_now: aberta, mode: s.open_mode, tz };
}

// ---------- avisos ao cliente (fila de mensagens agendadas do WhatsApp) ----------
async function avisarCliente(o, evento, extra = {}) {
  try {
    const s = await configuracao();
    if (!s.notify || !o.phone || !lembretesLigados()) return;
    const inst = (await qg('SELECT whatsapp_instance FROM companies WHERE id=$1', [currentCompany()])).rows[0]?.whatsapp_instance;
    const pool = msgPool();
    if (!inst || !pool) return;
    const modelo = String(s.messages?.[evento] || PADRAO_MSG[evento] || '').trim();
    if (!modelo) return;
    const nome = (o.customer_name || '').split(' ')[0] || 'cliente';
    const texto = modelo
      .replaceAll('{nome}', nome).replaceAll('{pedido}', String(o.id)).replaceAll('{total}', brl(o.total))
      .replaceAll('{eta}', String(o.eta_minutes ?? '')).replaceAll('{entregador}', extra.entregador ? ` com ${extra.entregador}` : '')
      .replaceAll('{motivo}', extra.motivo ? ` Motivo: ${extra.motivo}.` : '');
    await pool.query(`INSERT INTO agendamentos_mensagens (telefone, mensagem, data_hora_envio, instancia, nome, origem) VALUES ($1,$2,now(),$3,$4,'delivery')`,
      [o.phone, texto, inst, `Pedido ${o.id}`.slice(0, 120)]);
  } catch (e) { console.error('delivery:', e.message); }
}

// ---------- cálculo do pedido ----------
class ErroPedido extends Error { constructor(msg, status = 400) { super(msg); this.status = status; } }

async function cardapioDe(ids) {
  const itens = (await q('SELECT * FROM dlv_items WHERE id = ANY($1::bigint[])', [ids])).rows;
  const grupos = (await q('SELECT * FROM dlv_option_groups WHERE item_id = ANY($1::bigint[]) ORDER BY position, id', [ids])).rows;
  const opcoes = grupos.length ? (await q('SELECT * FROM dlv_options WHERE group_id = ANY($1::bigint[])', [grupos.map((g) => g.id)])).rows : [];
  return { itens, grupos, opcoes };
}

// Confere os itens escolhidos contra o cardápio e calcula os preços (o servidor é quem manda no valor). Também usado pelo restaurante.
export async function montarLinhas(itensReq, forcar = false) {
  const ids = [...new Set(itensReq.map((i) => idOk(i.item_id)).filter(Boolean))];
  if (ids.length !== new Set(itensReq.map((i) => String(i.item_id))).size) throw new ErroPedido('Item inválido no pedido');
  const { itens, grupos, opcoes } = await cardapioDe(ids);
  const linhas = [];
  let subtotal = 0;
  for (const req of itensReq) {
    const item = itens.find((x) => String(x.id) === String(req.item_id));
    if (!item || !item.active) throw new ErroPedido('Um dos itens não está mais no cardápio');
    if (item.sold_out && !forcar) throw new ErroPedido(`"${item.name}" está esgotado no momento`, 409);
    const qty = inteiro(req.qty ?? 1, 1, 99);
    if (!qty) throw new ErroPedido(`Quantidade inválida em "${item.name}" (de 1 a 99)`);
    const nota = txt(req.note, 200);
    if (nota === null) throw new ErroPedido('Observação do item inválida (até 200 letras)');
    const escolhidas = [...new Set((Array.isArray(req.options) ? req.options : []).map((o) => String(o)))];
    const doItem = grupos.filter((g) => g.item_id === item.id);
    const usadas = [];
    for (const idOpc of escolhidas) {
      const op = opcoes.find((o) => String(o.id) === idOpc && o.active && doItem.some((g) => g.id === o.group_id));
      if (!op) throw new ErroPedido(`Complemento inválido em "${item.name}"`);
      usadas.push(op);
    }
    for (const g of doItem) {
      const n = usadas.filter((o) => o.group_id === g.id).length;
      if (n < g.min_select) throw new ErroPedido(`Em "${item.name}", escolha ${g.min_select > 1 ? `pelo menos ${g.min_select} opções de` : ''} "${g.name}"`);
      if (n > g.max_select) throw new ErroPedido(`Em "${item.name}", "${g.name}" aceita no máximo ${g.max_select} opção(ões)`);
    }
    const unit = r2(Number(item.price) + usadas.reduce((a, o) => a + Number(o.price_delta), 0));
    const total = r2(unit * qty);
    subtotal = r2(subtotal + total);
    linhas.push({ item_id: item.id, name: item.name, qty, unit_price: unit, total, note: nota || null,
      options: usadas.map((o) => ({ group: doItem.find((g) => g.id === o.group_id).name, name: o.name, price: Number(o.price_delta) })) });
  }
  return { linhas, subtotal };
}

// Confere e calcula tudo. `forcar` (pedido feito pela equipe no painel) deixa passar loja fechada e item esgotado.
export async function calcular(b, { forcar = false } = {}) {
  const s = numeros(await configuracao());
  const tipo = b.kind === 'pickup' ? 'pickup' : 'delivery';
  if (!['delivery', 'pickup'].includes(b.kind || 'delivery')) throw new ErroPedido('Tipo de pedido inválido (entrega ou retirada)');
  if (tipo === 'delivery' && !s.delivery_enabled) throw new ErroPedido('No momento não fazemos entregas, apenas retirada');
  if (tipo === 'pickup' && !s.pickup_enabled) throw new ErroPedido('No momento não temos retirada no local, apenas entrega');
  const itensReq = Array.isArray(b.items) ? b.items : [];
  if (!itensReq.length) throw new ErroPedido('O pedido está vazio');
  if (itensReq.length > 60) throw new ErroPedido('Itens demais no pedido (máximo 60 linhas)');

  const loja = await estadoDaLoja(s);
  let agendado = null;
  if (b.scheduled_for) {
    agendado = new Date(b.scheduled_for);
    if (isNaN(agendado) || agendado.getTime() < Date.now() - 60000) throw new ErroPedido('O horário agendado já passou');
    if (agendado.getTime() > Date.now() + 14 * 86400000) throw new ErroPedido('Só aceitamos agendamento para os próximos 14 dias');
    if (!s.accept_scheduled && !forcar) throw new ErroPedido('No momento não aceitamos pedidos agendados');
  } else if (!loja.open_now && !forcar) {
    throw new ErroPedido(s.closed_message || 'Estamos fechados no momento', 409);
  }

  const { linhas, subtotal } = await montarLinhas(itensReq, forcar);

  // endereço, bairro e taxa
  let fee = 0, zona = null, minimo = s.min_order, extraMin = 0;
  const end = { street: null, number: null, complement: null, neighborhood: null, reference: null };
  if (tipo === 'delivery') {
    for (const [k, max] of [['street', 120], ['number', 20], ['complement', 80], ['neighborhood', 80], ['reference', 120]]) {
      const v = txt(b[k], max); if (v === null) throw new ErroPedido(`Campo de endereço inválido (${k})`);
      end[k] = v || null;
    }
    if (!end.street || !end.number) throw new ErroPedido('Informe a rua e o número para a entrega');
    if (s.use_zones) {
      if (!end.neighborhood) throw new ErroPedido('Informe o bairro para a entrega');
      const zonas = (await q('SELECT * FROM dlv_zones WHERE active')).rows;
      zona = zonas.find((z) => semAcento(z.name) === semAcento(end.neighborhood));
      if (!zona) throw new ErroPedido(`Ainda não entregamos no bairro ${end.neighborhood}`, 409);
      fee = Number(zona.fee); extraMin = zona.extra_minutes;
      if (zona.min_order !== null) minimo = Number(zona.min_order);
    } else fee = s.default_fee;
    if (s.free_above !== null && subtotal >= s.free_above) fee = 0;
  }
  if (subtotal < minimo) throw new ErroPedido(`O pedido mínimo${zona ? ` para ${zona.name}` : ''} é ${brl(minimo)}`, 409);

  // cupom
  let desconto = 0, cupom = null;
  const codigo = String(b.coupon || '').trim().toUpperCase();
  if (codigo) {
    cupom = (await q('SELECT *, valid_until::text AS vu FROM dlv_coupons WHERE code=$1', [codigo])).rows[0];
    const hoje = new Date().toLocaleDateString('en-CA', { timeZone: loja.tz });
    if (!cupom || !cupom.active) throw new ErroPedido('Cupom inválido');
    if (cupom.vu && cupom.vu < hoje) throw new ErroPedido('Esse cupom já venceu');
    if (cupom.max_uses !== null && cupom.used >= cupom.max_uses) throw new ErroPedido('Esse cupom já foi usado o máximo de vezes');
    if (subtotal < Number(cupom.min_order)) throw new ErroPedido(`Esse cupom vale para pedidos a partir de ${brl(cupom.min_order)}`);
    desconto = cupom.kind === 'percent' ? r2(subtotal * Number(cupom.value) / 100) : Math.min(subtotal, r2(cupom.value));
  }
  const total = r2(subtotal - desconto + fee);

  // pagamento
  const forma = b.payment_method;
  if (!['pix', 'cash', 'card'].includes(forma)) throw new ErroPedido('Informe a forma de pagamento (pix, dinheiro ou cartão)');
  if (!s[`pay_${forma}`]) throw new ErroPedido('Essa forma de pagamento não está disponível');
  let troco = null;
  if (forma === 'cash' && b.change_for !== undefined && b.change_for !== null && b.change_for !== '') {
    troco = dinheiro(b.change_for);
    if (troco === undefined || troco === null) throw new ErroPedido('Valor do troco inválido');
    if (troco < total) throw new ErroPedido(`O troco precisa ser para um valor maior ou igual ao total (${brl(total)})`);
  }
  const eta = s.prep_minutes + (tipo === 'delivery' ? s.delivery_minutes + extraMin : 0);
  return { s, tipo, linhas, subtotal, fee, desconto, total, cupom, end, zona, forma, troco, agendado, eta,
    resumo: { kind: tipo, items: linhas, subtotal, delivery_fee: fee, discount: desconto, total, payment_method: forma, change_for: troco, eta_minutes: eta, coupon: cupom?.code || null, zone: zona?.name || null, scheduled_for: agendado } };
}

// ---------- leitura de pedidos ----------
const COLS = `o.id::text AS id, o.customer_id::text AS customer_id, o.customer_name, o.phone, o.kind, o.status, o.street, o.number, o.complement,
  o.neighborhood, o.reference, o.subtotal::float AS subtotal, o.fee::float AS fee, o.discount::float AS discount, o.total::float AS total,
  o.coupon_code, o.payment_method, o.change_for::float AS change_for, o.paid, o.note, o.cancel_reason, o.courier_id::text AS courier_id,
  c.name AS courier_name, o.scheduled_for, o.eta_minutes, o.source, o.created_at, o.confirmed_at, o.dispatched_at, o.delivered_at, o.cancelled_at`;
async function pedidosComItens(where, params, { limite = 200 } = {}) {
  const { rows } = await q(`SELECT ${COLS} FROM dlv_orders o LEFT JOIN dlv_couriers c ON c.id=o.courier_id ${where} ORDER BY o.created_at DESC LIMIT ${limite}`, params);
  if (!rows.length) return rows;
  const itens = (await q(`SELECT order_id::text AS order_id, name, qty, unit_price::float AS unit_price, total::float AS total, options, note FROM dlv_order_items
                          WHERE order_id = ANY($1::bigint[]) ORDER BY id`, [rows.map((r) => r.id)])).rows;
  for (const r of rows) r.items = itens.filter((i) => i.order_id === r.id).map(({ order_id, ...i }) => i);
  return rows;
}

async function registrarEvento(t, id, status, nota = null) {
  await t('INSERT INTO dlv_order_events (order_id, status, note) VALUES ($1,$2,$3)', [id, status, nota]);
}

// ---------- rotas ----------
export function registerDeliveryRoutes(r, wrap) {
  const erro = (fn) => wrap(async (req, res) => {
    try { await fn(req, res); }
    catch (e) { if (e instanceof ErroPedido) return res.status(e.status).json({ error: e.message }); throw e; }
  });

  // ----- loja: configuração e status -----
  function lerConfig(b) {
    const o = {};
    const bool = (k) => { if (b[k] !== undefined) o[k] = !!b[k]; };
    ['delivery_enabled', 'pickup_enabled', 'use_zones', 'pay_pix', 'pay_cash', 'pay_card', 'auto_accept', 'accept_scheduled', 'notify'].forEach(bool);
    if (b.open_mode !== undefined) { if (!['auto', 'open', 'closed'].includes(b.open_mode)) return { erro: 'Modo de funcionamento inválido' }; o.open_mode = b.open_mode; }
    for (const k of ['min_order', 'default_fee']) if (b[k] !== undefined) { const v = dinheiro(b[k]); if (v === undefined) return { erro: `Valor inválido (${k})` }; o[k] = v ?? 0; }
    if (b.free_above !== undefined) { const v = dinheiro(b.free_above); if (v === undefined) return { erro: 'Valor inválido (frete grátis acima de)' }; o.free_above = v; }
    for (const k of ['prep_minutes', 'delivery_minutes']) if (b[k] !== undefined) { const v = inteiro(b[k], 0, 600); if (v === null) return { erro: 'Tempo inválido (de 0 a 600 minutos)' }; o[k] = v; }
    if (b.pix_key !== undefined) { const v = txt(b.pix_key, 140); if (v === null) return { erro: 'Chave Pix inválida' }; o.pix_key = v || null; }
    if (b.closed_message !== undefined) { const v = txt(b.closed_message, 300); if (v === null) return { erro: 'Mensagem de loja fechada inválida (até 300 letras)' }; o.closed_message = v || null; }
    if (b.hours !== undefined) {
      const h = {};
      for (let d = 0; d < 7; d++) {
        const x = b.hours?.[d]; if (!x) continue;
        const a = emMin(x.open), f = emMin(x.close);
        if (a === null || f === null || a === f) return { erro: `Horário inválido em ${DIAS[d]} (use HH:MM, abrindo e fechando em horas diferentes)` };
        h[d] = { open: x.open, close: x.close };
      }
      o.hours = JSON.stringify(h);
    }
    if (b.messages !== undefined) {
      const m = {};
      for (const k of MSG_CHAVES) { if (b.messages?.[k] === undefined) continue; const v = txt(b.messages[k], 400); if (v === null) return { erro: 'Mensagem ao cliente inválida (até 400 letras)' }; if (v) m[k] = v; }
      o.messages = JSON.stringify(m);
    }
    return { o };
  }
  r.get('/delivery/settings', wrap(async (req, res) => {
    const s = numeros(await configuracao());
    res.json({ ...s, ...(await estadoDaLoja(s)), default_messages: PADRAO_MSG, notifications_available: lembretesLigados() });
  }));
  r.put('/delivery/settings', wrap(async (req, res) => {
    const { o, erro: e } = lerConfig(req.body || {});
    if (e) return res.status(400).json({ error: e });
    await configuracao();
    const ks = Object.keys(o);
    if (ks.length) await q(`UPDATE dlv_settings SET ${ks.map((k, i) => `${k}=$${i + 1}${k === 'hours' || k === 'messages' ? '::jsonb' : ''}`).join(', ')} WHERE id=1`, ks.map((k) => o[k]));
    const s = numeros(await configuracao());
    res.json({ ...s, ...(await estadoDaLoja(s)) });
  }));
  // Resumo para o atendente: a loja está aberta? o que cobra, que formas aceita, quais bairros atende
  r.get('/delivery/status', wrap(async (req, res) => {
    const s = numeros(await configuracao());
    const loja = await estadoDaLoja(s);
    const zonas = s.use_zones ? (await q('SELECT name, fee::float AS fee, min_order::float AS min_order, extra_minutes FROM dlv_zones WHERE active ORDER BY name')).rows : [];
    res.json({
      open_now: loja.open_now, closed_message: loja.open_now ? null : (s.closed_message || 'Estamos fechados no momento'),
      hours: textoHorarios(s.hours), accepts_scheduled: s.accept_scheduled,
      delivery: s.delivery_enabled, pickup: s.pickup_enabled, min_order: s.min_order, delivery_fee: s.use_zones ? null : s.default_fee,
      free_above: s.free_above, uses_zones: s.use_zones, zones: zonas,
      prep_minutes: s.prep_minutes, delivery_minutes: s.delivery_minutes,
      payment: { pix: s.pay_pix, cash: s.pay_cash, card: s.pay_card, pix_key: s.pay_pix ? s.pix_key : null },
    });
  }));

  // ----- cardápio -----
  r.get('/delivery/menu', wrap(async (req, res) => {
    const tudo = req.query.all === '1' && !(req.baseUrl || '').includes('n8n');
    const cats = (await q(`SELECT id::text AS id, name, position, active FROM dlv_categories ${tudo ? '' : 'WHERE active'} ORDER BY position, id`)).rows;
    const itens = (await q(`SELECT id::text AS id, category_id::text AS category_id, name, description, price::float AS price, active, sold_out, position, station FROM dlv_items ${tudo ? '' : 'WHERE active'} ORDER BY position, name`)).rows;
    const grupos = (await q('SELECT id::text AS id, item_id::text AS item_id, name, min_select, max_select, position FROM dlv_option_groups ORDER BY position, id')).rows;
    const opcoes = (await q(`SELECT id::text AS id, group_id::text AS group_id, name, price_delta::float AS price_delta, active, position FROM dlv_options ${tudo ? '' : 'WHERE active'} ORDER BY position, id`)).rows;
    const monta = (i) => ({ ...i, option_groups: grupos.filter((g) => g.item_id === i.id).map((g) => ({ ...g, options: opcoes.filter((o) => o.group_id === g.id) })) });
    const sem = itens.filter((i) => !i.category_id || !cats.some((c) => c.id === i.category_id));
    res.json({ categories: [...cats.map((c) => ({ ...c, items: itens.filter((i) => i.category_id === c.id).map(monta) })), ...(sem.length ? [{ id: null, name: 'Outros', position: 9999, active: true, items: sem.map(monta) }] : [])] });
  }));

  // Importar o cardápio de uma planilha: Categoria, Item, Descrição, Preço, Local de preparo, Esgotado.
  // Quem já existe (mesma categoria e mesmo nome) é atualizado, sem duplicar. Com dry_run só simula.
  r.post('/delivery/import', wrap(async (req, res) => {
    const linhas = (Array.isArray(req.body?.rows) ? req.body.rows : []).slice(0, 2000);
    const dry = !!req.body?.dry_run;
    const chaveCol = (k) => semAcento(k).replace(/\(.*?\)/g, '').replace(/[^a-z0-9 ]/g, '').trim();
    const pega = (row, ...nomes) => { const m = {}; for (const [k, v] of Object.entries(row || {})) m[chaveCol(k)] = v; for (const n of nomes) if (m[n] !== undefined && String(m[n]).trim() !== '') return String(m[n]).trim(); return ''; };
    const sim = (v) => ['sim', 's', 'x', '1', 'true', 'esgotado'].includes(semAcento(v));
    const nao = (v) => ['nao', 'n', '0', 'false', 'inativo'].includes(semAcento(v));
    const rep = { items: { created: 0, updated: 0 }, categories: { created: 0 }, errors: [], dry_run: dry };
    class Desfazer extends Error {}
    try {
      await tx(currentCompany(), async (t) => {
        const cats = new Map((await t('SELECT id, name FROM dlv_categories')).rows.map((c) => [semAcento(c.name), c.id]));
        for (let i = 0; i < linhas.length; i++) {
          const row = linhas[i];
          const nome = txt(pega(row, 'item', 'nome', 'prato', 'produto'), 100, { vazio: false });
          const linha = `Linha ${i + 2}${nome ? ` (${nome})` : ''}`;
          if (!nome) { rep.errors.push(`${linha}: falta o nome do item`); continue; }
          const preco = dinheiro(pega(row, 'preco', 'valor'));
          if (preco === undefined || preco === null) { rep.errors.push(`${linha}: preço inválido`); continue; }
          const desc = txt(pega(row, 'descricao', 'descr'), 400);
          if (desc === null) { rep.errors.push(`${linha}: descrição longa demais (até 400 letras)`); continue; }
          const est = semAcento(pega(row, 'local de preparo', 'preparo', 'local', 'estacao'));
          const station = !est || est.startsWith('coz') ? 'cozinha' : est.startsWith('bar') ? 'bar' : /direto|sem preparo|nenhum/.test(est) ? 'direto' : null;
          if (!station) { rep.errors.push(`${linha}: local de preparo "${est}" não entendido (use Cozinha, Bar ou Sai direto)`); continue; }
          const nomeCat = txt(pega(row, 'categoria', 'grupo'), 60);
          let catId = null;
          if (nomeCat) {
            catId = cats.get(semAcento(nomeCat)) || null;
            if (!catId) {
              catId = (await t('INSERT INTO dlv_categories (name, position) VALUES ($1,(SELECT COALESCE(max(position),0)+1 FROM dlv_categories)) RETURNING id', [nomeCat])).rows[0].id;
              cats.set(semAcento(nomeCat), catId); rep.categories.created++;
            }
          }
          const esg = pega(row, 'esgotado'), ativo = pega(row, 'ativo');
          const ex = (await t('SELECT id FROM dlv_items WHERE lower(name)=lower($1) AND category_id IS NOT DISTINCT FROM $2', [nome, catId])).rows[0];
          if (ex) {
            await t(`UPDATE dlv_items SET price=$2, description=COALESCE($3,description), station=$4,
                sold_out=CASE WHEN $5::text='' THEN sold_out ELSE $5::text='sim' END, active=CASE WHEN $6::text='' THEN active ELSE $6::text<>'nao' END WHERE id=$1`,
              [ex.id, preco, desc || null, station, esg ? (sim(esg) ? 'sim' : 'nao') : '', ativo ? (nao(ativo) ? 'nao' : 'sim') : '']);
            rep.items.updated++;
          } else {
            await t('INSERT INTO dlv_items (category_id, name, description, price, station, sold_out, active) VALUES ($1,$2,$3,$4,$5,$6,$7)',
              [catId, nome, desc || null, preco, station, sim(esg), !nao(ativo)]);
            rep.items.created++;
          }
        }
        if (dry) throw new Desfazer();
      });
    } catch (e) { if (!(e instanceof Desfazer)) throw e; }
    res.json(rep);
  }));

  const crud = (base, tabela, ler, { depois } = {}) => {
    r.post(base, wrap(async (req, res) => {
      const { o, erro: e } = ler(req.body || {}, false);
      if (e) return res.status(400).json({ error: e });
      const ks = Object.keys(o);
      const id = (await q(`INSERT INTO ${tabela} (${ks.join(',')}) VALUES (${ks.map((_, i) => `$${i + 1}`).join(',')}) RETURNING id`, ks.map((k) => o[k]))).rows[0].id;
      res.status(201).json({ id: String(id) });
    }));
    r.put(`${base}/:id`, wrap(async (req, res) => {
      const id = idOk(req.params.id);
      if (!id || !(await q(`SELECT 1 FROM ${tabela} WHERE id=$1`, [id])).rowCount) return res.status(404).json({ error: 'Não encontrado' });
      const { o, erro: e } = ler(req.body || {}, true);
      if (e) return res.status(400).json({ error: e });
      const ks = Object.keys(o);
      if (ks.length) await q(`UPDATE ${tabela} SET ${ks.map((k, i) => `${k}=$${i + 2}`).join(', ')} WHERE id=$1`, [id, ...ks.map((k) => o[k])]);
      res.json({ ok: true });
    }));
    r.delete(`${base}/:id`, wrap(async (req, res) => {
      const id = idOk(req.params.id);
      const { rowCount } = id ? await q(`DELETE FROM ${tabela} WHERE id=$1`, [id]) : { rowCount: 0 };
      rowCount ? res.json({ ok: true }) : res.status(404).json({ error: 'Não encontrado' });
    }));
  };
  const comum = (b, parcial, o) => {
    if (b.active !== undefined) o.active = !!b.active;
    if (b.position !== undefined) { const p = inteiro(b.position, 0, 9999); if (p === null) return 'Posição inválida'; o.position = p; }
    return null;
  };
  crud('/delivery/categories', 'dlv_categories', (b, p) => {
    const o = {};
    if (!p || b.name !== undefined) { o.name = txt(b.name, 60, { vazio: false }); if (!o.name) return { erro: 'Dê um nome à categoria (até 60 letras)' }; }
    const e = comum(b, p, o); return e ? { erro: e } : { o };
  });
  crud('/delivery/items', 'dlv_items', (b, p) => {
    const o = {};
    if (!p || b.name !== undefined) { o.name = txt(b.name, 100, { vazio: false }); if (!o.name) return { erro: 'Dê um nome ao item (até 100 letras)' }; }
    if (!p || b.price !== undefined) { const v = dinheiro(b.price); if (v === undefined || v === null) return { erro: 'Preço inválido' }; o.price = v; }
    if (b.description !== undefined) { const v = txt(b.description, 400); if (v === null) return { erro: 'Descrição inválida (até 400 letras)' }; o.description = v || null; }
    if (b.category_id !== undefined) { if (b.category_id === null || b.category_id === '') o.category_id = null; else { o.category_id = idOk(b.category_id); if (!o.category_id) return { erro: 'Categoria inválida' }; } }
    if (b.sold_out !== undefined) o.sold_out = !!b.sold_out;
    if (b.station !== undefined) { if (!['cozinha', 'bar', 'direto'].includes(b.station)) return { erro: 'Local de preparo inválido' }; o.station = b.station; }
    const e = comum(b, p, o); return e ? { erro: e } : { o };
  });
  r.post('/delivery/items/:id/groups', wrap(async (req, res) => {
    const id = idOk(req.params.id);
    if (!id || !(await q('SELECT 1 FROM dlv_items WHERE id=$1', [id])).rowCount) return res.status(404).json({ error: 'Item não encontrado' });
    const nome = txt(req.body?.name, 60, { vazio: false });
    const min = inteiro(req.body?.min_select ?? 0, 0, 20), max = inteiro(req.body?.max_select ?? 1, 1, 20);
    if (!nome || min === null || max === null || min > max) return res.status(400).json({ error: 'Grupo inválido (nome, mínimo e máximo de escolhas)' });
    const gid = (await q('INSERT INTO dlv_option_groups (item_id, name, min_select, max_select) VALUES ($1,$2,$3,$4) RETURNING id', [id, nome, min, max])).rows[0].id;
    res.status(201).json({ id: String(gid) });
  }));
  r.put('/delivery/groups/:id', wrap(async (req, res) => {
    const id = idOk(req.params.id);
    const g = id && (await q('SELECT * FROM dlv_option_groups WHERE id=$1', [id])).rows[0];
    if (!g) return res.status(404).json({ error: 'Grupo não encontrado' });
    const nome = req.body?.name !== undefined ? txt(req.body.name, 60, { vazio: false }) : g.name;
    const min = req.body?.min_select !== undefined ? inteiro(req.body.min_select, 0, 20) : g.min_select;
    const max = req.body?.max_select !== undefined ? inteiro(req.body.max_select, 1, 20) : g.max_select;
    if (!nome || min === null || max === null || min > max) return res.status(400).json({ error: 'Grupo inválido (nome, mínimo e máximo de escolhas)' });
    await q('UPDATE dlv_option_groups SET name=$2, min_select=$3, max_select=$4 WHERE id=$1', [id, nome, min, max]);
    res.json({ ok: true });
  }));
  r.delete('/delivery/groups/:id', wrap(async (req, res) => {
    const id = idOk(req.params.id);
    const { rowCount } = id ? await q('DELETE FROM dlv_option_groups WHERE id=$1', [id]) : { rowCount: 0 };
    rowCount ? res.json({ ok: true }) : res.status(404).json({ error: 'Grupo não encontrado' });
  }));
  r.post('/delivery/groups/:id/options', wrap(async (req, res) => {
    const id = idOk(req.params.id);
    if (!id || !(await q('SELECT 1 FROM dlv_option_groups WHERE id=$1', [id])).rowCount) return res.status(404).json({ error: 'Grupo não encontrado' });
    const nome = txt(req.body?.name, 60, { vazio: false });
    const delta = dinheiro(req.body?.price_delta ?? 0, { max: 9999 });
    if (!nome || delta === undefined) return res.status(400).json({ error: 'Complemento inválido (nome e valor a somar)' });
    const oid = (await q('INSERT INTO dlv_options (group_id, name, price_delta) VALUES ($1,$2,$3) RETURNING id', [id, nome, delta ?? 0])).rows[0].id;
    res.status(201).json({ id: String(oid) });
  }));
  r.put('/delivery/options/:id', wrap(async (req, res) => {
    const id = idOk(req.params.id);
    const o = id && (await q('SELECT * FROM dlv_options WHERE id=$1', [id])).rows[0];
    if (!o) return res.status(404).json({ error: 'Complemento não encontrado' });
    const nome = req.body?.name !== undefined ? txt(req.body.name, 60, { vazio: false }) : o.name;
    const delta = req.body?.price_delta !== undefined ? dinheiro(req.body.price_delta, { max: 9999 }) : Number(o.price_delta);
    if (!nome || delta === undefined || delta === null) return res.status(400).json({ error: 'Complemento inválido' });
    await q('UPDATE dlv_options SET name=$2, price_delta=$3, active=$4 WHERE id=$1', [id, nome, delta, req.body?.active !== undefined ? !!req.body.active : o.active]);
    res.json({ ok: true });
  }));
  r.delete('/delivery/options/:id', wrap(async (req, res) => {
    const id = idOk(req.params.id);
    const { rowCount } = id ? await q('DELETE FROM dlv_options WHERE id=$1', [id]) : { rowCount: 0 };
    rowCount ? res.json({ ok: true }) : res.status(404).json({ error: 'Complemento não encontrado' });
  }));

  // ----- bairros, entregadores, cupons -----
  r.get('/delivery/zones', wrap(async (req, res) => res.json((await q('SELECT id::text AS id, name, fee::float AS fee, min_order::float AS min_order, extra_minutes, active FROM dlv_zones ORDER BY name')).rows)));
  crud('/delivery/zones', 'dlv_zones', (b, p) => {
    const o = {};
    if (!p || b.name !== undefined) { o.name = txt(b.name, 80, { vazio: false }); if (!o.name) return { erro: 'Dê um nome ao bairro (até 80 letras)' }; }
    if (!p || b.fee !== undefined) { const v = dinheiro(b.fee ?? 0); if (v === undefined) return { erro: 'Taxa inválida' }; o.fee = v ?? 0; }
    if (b.min_order !== undefined) { const v = dinheiro(b.min_order); if (v === undefined) return { erro: 'Pedido mínimo inválido' }; o.min_order = v; }
    if (b.extra_minutes !== undefined) { const v = inteiro(b.extra_minutes, 0, 300); if (v === null) return { erro: 'Tempo extra inválido' }; o.extra_minutes = v; }
    if (b.active !== undefined) o.active = !!b.active;
    return { o };
  });
  r.get('/delivery/couriers', wrap(async (req, res) => res.json((await q('SELECT id::text AS id, name, phone, active FROM dlv_couriers ORDER BY active DESC, name')).rows)));
  crud('/delivery/couriers', 'dlv_couriers', (b, p) => {
    const o = {};
    if (!p || b.name !== undefined) { o.name = txt(b.name, 80, { vazio: false }); if (!o.name) return { erro: 'Dê um nome ao entregador' }; }
    if (b.phone !== undefined) { const f = b.phone ? normPhone(b.phone) : ''; if (f && (f.length < 10 || f.length > 15)) return { erro: 'Telefone inválido (use DDD + número)' }; o.phone = f || null; }
    if (b.active !== undefined) o.active = !!b.active;
    return { o };
  });
  r.get('/delivery/coupons', wrap(async (req, res) => res.json((await q(`SELECT id::text AS id, code, kind, value::float AS value, min_order::float AS min_order, max_uses, used, valid_until::text AS valid_until, active FROM dlv_coupons ORDER BY active DESC, code`)).rows)));
  crud('/delivery/coupons', 'dlv_coupons', (b, p) => {
    const o = {};
    if (!p || b.code !== undefined) { const c = String(b.code ?? '').trim().toUpperCase(); if (!/^[A-Z0-9_-]{3,20}$/.test(c)) return { erro: 'Código inválido (3 a 20 letras ou números, sem espaços)' }; o.code = c; }
    if (!p || b.kind !== undefined) { if (!['percent', 'fixed'].includes(b.kind)) return { erro: 'Tipo de cupom inválido (porcentagem ou valor fixo)' }; o.kind = b.kind; }
    if (!p || b.value !== undefined) {
      const v = dinheiro(b.value); if (v === undefined || v === null || v <= 0) return { erro: 'Valor do cupom inválido' };
      if ((o.kind || b.kind) === 'percent' && v > 100) return { erro: 'A porcentagem não pode passar de 100' };
      o.value = v;
    }
    if (b.min_order !== undefined) { const v = dinheiro(b.min_order); if (v === undefined) return { erro: 'Pedido mínimo inválido' }; o.min_order = v ?? 0; }
    if (b.max_uses !== undefined) { if (b.max_uses === null || b.max_uses === '') o.max_uses = null; else { const v = inteiro(b.max_uses, 1, 1000000); if (v === null) return { erro: 'Limite de usos inválido' }; o.max_uses = v; } }
    if (b.valid_until !== undefined) { if (!b.valid_until) o.valid_until = null; else { o.valid_until = dataOk(b.valid_until); if (!o.valid_until) return { erro: 'Validade inválida (AAAA-MM-DD)' }; } }
    if (b.active !== undefined) o.active = !!b.active;
    return { o };
  });

  // ----- pedidos -----
  // `force: true` (só no painel) deixa a equipe lançar pedido com a loja fechada ou item esgotado; o atendente nunca força
  const forca = (req) => quem(req) === 'manual' && req.body?.force === true;
  r.post('/delivery/quote', erro(async (req, res) => {
    const c = await calcular(req.body || {}, { forcar: forca(req) });
    res.json(c.resumo);
  }));

  r.post('/delivery/orders', erro(async (req, res) => {
    const b = req.body || {};
    const origem = quem(req);
    const c = await calcular(b, { forcar: forca(req) });
    const phone = b.phone ? normPhone(b.phone) : '';
    if (b.phone && (phone.length < 10 || phone.length > 15)) throw new ErroPedido('Telefone inválido (use DDD + número)');
    const nome = txt(b.name, 100);
    if (nome === null) throw new ErroPedido('Nome inválido');
    if (!phone && !nome) throw new ErroPedido('Informe o nome ou o telefone do cliente');
    const obs = txt(b.note, 400);
    if (obs === null) throw new ErroPedido('Observação inválida (até 400 letras)');
    const nasce = c.s.auto_accept ? 'confirmed' : 'new';
    const pedido = await tx(currentCompany(), async (t) => {
      let cid = null;
      if (phone) {
        cid = (await t(`INSERT INTO customers (name, phone, source, status) VALUES (NULLIF($1,''),$2,$3,'lead')
                        ON CONFLICT (phone) DO UPDATE SET name=COALESCE(customers.name, EXCLUDED.name) RETURNING id`, [nome || '', phone, origem])).rows[0].id;
      }
      if (c.cupom) {
        const uso = await t('UPDATE dlv_coupons SET used=used+1 WHERE id=$1 AND (max_uses IS NULL OR used < max_uses) RETURNING id', [c.cupom.id]);
        if (!uso.rowCount) throw new ErroPedido('Esse cupom já foi usado o máximo de vezes');
      }
      const o = (await t(
        `INSERT INTO dlv_orders (customer_id, customer_name, phone, kind, status, street, number, complement, neighborhood, reference, zone_id,
           subtotal, fee, discount, total, coupon_code, payment_method, change_for, note, scheduled_for, eta_minutes, source, confirmed_at)
         VALUES ($1,NULLIF($2,''),NULLIF($3,''),$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,CASE WHEN $5='confirmed' THEN now() END) RETURNING id`,
        [cid, nome || '', phone, c.tipo, nasce, c.end.street, c.end.number, c.end.complement, c.end.neighborhood, c.end.reference, c.zona?.id ?? null,
         c.subtotal, c.fee, c.desconto, c.total, c.cupom?.code ?? null, c.forma, c.troco, obs || null, c.agendado, c.eta, origem])).rows[0];
      for (const l of c.linhas) {
        await t('INSERT INTO dlv_order_items (order_id, item_id, name, qty, unit_price, options, note, total) VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7,$8)',
          [o.id, l.item_id, l.name, l.qty, l.unit_price, JSON.stringify(l.options), l.note, l.total]);
      }
      await registrarEvento(t, o.id, nasce, origem === 'ia' ? 'Pedido feito pelo atendente' : 'Pedido lançado no painel');
      return o;
    });
    const [novo] = await pedidosComItens('WHERE o.id=$1', [pedido.id]);
    res.status(201).json({ ...novo, order_number: novo.id, pix_key: c.forma === 'pix' ? c.s.pix_key : null });
  }));

  r.get('/delivery/orders', wrap(async (req, res) => {
    const cond = [], params = [];
    if (req.query.status) {
      const lista = String(req.query.status).split(',').filter((x) => ETAPAS.includes(x));
      if (lista.length) { params.push(lista); cond.push(`o.status = ANY($${params.length}::text[])`); }
    }
    if (req.query.active === '1') cond.push("o.status NOT IN ('delivered','cancelled')");
    const tz = await fusoDaEmpresa();
    if (req.query.from) { const d = dataOk(req.query.from); if (!d) return res.status(400).json({ error: 'Data inicial inválida' }); params.push(d, tz); cond.push(`o.created_at >= ($${params.length - 1}::date)::timestamp AT TIME ZONE $${params.length}`); }
    if (req.query.to) { const d = dataOk(req.query.to); if (!d) return res.status(400).json({ error: 'Data final inválida' }); params.push(d, tz); cond.push(`o.created_at < (($${params.length - 1}::date) + 1)::timestamp AT TIME ZONE $${params.length}`); }
    if (req.query.q) { params.push(`%${String(req.query.q).slice(0, 60)}%`); cond.push(`(o.customer_name ILIKE $${params.length} OR o.phone ILIKE $${params.length} OR o.id::text ILIKE $${params.length})`); }
    res.json(await pedidosComItens(cond.length ? 'WHERE ' + cond.join(' AND ') : '', params, { limite: Math.min(Number(req.query.limit) || 200, 500) }));
  }));
  // O atendente pergunta pelo telefone: pedidos em andamento (e o último entregue) para responder "cadê meu pedido?"
  r.get('/delivery/orders/by-phone/:phone', wrap(async (req, res) => {
    const phone = normPhone(req.params.phone);
    if (phone.length < 10) return res.status(400).json({ error: 'Telefone inválido' });
    const lista = await pedidosComItens('WHERE o.phone=$1', [phone], { limite: 10 });
    res.json({ active: lista.filter((o) => !FINAIS.includes(o.status)), recent: lista.filter((o) => FINAIS.includes(o.status)).slice(0, 3), status_names: NOMES_ETAPA });
  }));
  r.get('/delivery/orders/:id', wrap(async (req, res) => {
    const id = idOk(req.params.id);
    const [o] = id ? await pedidosComItens('WHERE o.id=$1', [id]) : [];
    if (!o) return res.status(404).json({ error: 'Pedido não encontrado' });
    o.events = (await q('SELECT status, note, at FROM dlv_order_events WHERE order_id=$1 ORDER BY at, id', [id])).rows;
    res.json(o);
  }));

  r.post('/delivery/orders/:id/status', wrap(async (req, res) => {
    const id = idOk(req.params.id);
    const o = id && (await q('SELECT * FROM dlv_orders WHERE id=$1', [id])).rows[0];
    if (!o) return res.status(404).json({ error: 'Pedido não encontrado' });
    const para = req.body?.status;
    if (!ETAPAS.includes(para)) return res.status(400).json({ error: 'Etapa inválida' });
    if (!podeIr(o.status, para, o.kind)) return res.status(409).json({ error: `Não dá para ir de "${NOMES_ETAPA[o.status]}" para "${NOMES_ETAPA[para]}"${o.kind === 'pickup' && para === 'out_for_delivery' ? ' (pedido para retirada)' : ''}` });
    const motivo = txt(req.body?.reason, 200);
    if (motivo === null) return res.status(400).json({ error: 'Motivo inválido (até 200 letras)' });
    let courier = o.courier_id;
    if (req.body?.courier_id !== undefined) {
      if (req.body.courier_id === null || req.body.courier_id === '') courier = null;
      else {
        const cid = idOk(req.body.courier_id);
        if (!cid || !(await q('SELECT 1 FROM dlv_couriers WHERE id=$1 AND active', [cid])).rowCount) return res.status(400).json({ error: 'Entregador inválido' });
        courier = cid;
      }
    }
    let eta = o.eta_minutes;
    await tx(currentCompany(), async (t) => {
      await t(`UPDATE dlv_orders SET status=$2, courier_id=$3, cancel_reason=CASE WHEN $2='cancelled' THEN $4 ELSE cancel_reason END,
                 confirmed_at = CASE WHEN $2='confirmed' AND confirmed_at IS NULL THEN now() ELSE confirmed_at END,
                 dispatched_at = CASE WHEN $2='out_for_delivery' THEN now() ELSE dispatched_at END,
                 delivered_at = CASE WHEN $2='delivered' THEN now() ELSE delivered_at END,
                 cancelled_at = CASE WHEN $2='cancelled' THEN now() ELSE cancelled_at END,
                 paid = CASE WHEN $2='delivered' AND payment_method IN ('cash','card') THEN true ELSE paid END
               WHERE id=$1`, [id, para, courier, motivo || null]);
      if (para === 'cancelled' && o.coupon_code) await t('UPDATE dlv_coupons SET used=GREATEST(used-1,0) WHERE code=$1', [o.coupon_code]);
      if (para === 'delivered' && o.customer_id) await t(`UPDATE customers SET status='client', client_kinds = CASE WHEN 'buyer' = ANY(client_kinds) THEN client_kinds ELSE array_append(client_kinds, 'buyer') END WHERE id=$1`, [o.customer_id]);
      await registrarEvento(t, id, para, motivo || null);
    });
    const entregador = courier ? (await q('SELECT name FROM dlv_couriers WHERE id=$1', [courier])).rows[0]?.name : null;
    const atual = { ...o, status: para, eta_minutes: eta };
    if (para === 'ready' && o.kind === 'delivery') { /* sem aviso: o cliente espera a saída para entrega */ }
    else await avisarCliente(atual, para, { entregador, motivo });
    res.json({ ok: true, status: para });
  }));

  r.put('/delivery/orders/:id', wrap(async (req, res) => {
    const id = idOk(req.params.id);
    const o = id && (await q('SELECT * FROM dlv_orders WHERE id=$1', [id])).rows[0];
    if (!o) return res.status(404).json({ error: 'Pedido não encontrado' });
    if (FINAIS.includes(o.status)) return res.status(409).json({ error: 'Pedido já encerrado' });
    const b = req.body || {}, set = {};
    if (b.note !== undefined) { const v = txt(b.note, 400); if (v === null) return res.status(400).json({ error: 'Observação inválida' }); set.note = v || null; }
    if (b.paid !== undefined) set.paid = !!b.paid;
    if (b.eta_minutes !== undefined) { const v = inteiro(b.eta_minutes, 0, 600); if (v === null) return res.status(400).json({ error: 'Previsão inválida' }); set.eta_minutes = v; }
    if (b.courier_id !== undefined) {
      if (b.courier_id === null || b.courier_id === '') set.courier_id = null;
      else { const cid = idOk(b.courier_id); if (!cid || !(await q('SELECT 1 FROM dlv_couriers WHERE id=$1 AND active', [cid])).rowCount) return res.status(400).json({ error: 'Entregador inválido' }); set.courier_id = cid; }
    }
    const ks = Object.keys(set);
    if (ks.length) await q(`UPDATE dlv_orders SET ${ks.map((k, i) => `${k}=$${i + 2}`).join(', ')} WHERE id=$1`, [id, ...ks.map((k) => set[k])]);
    res.json({ ok: true });
  }));

  // ----- relatório -----
  r.get('/delivery/report', wrap(async (req, res) => {
    const tz = await fusoDaEmpresa();
    const hoje = new Date().toLocaleDateString('en-CA', { timeZone: tz });
    const ate = dataOk(req.query.to) || hoje;
    const de = dataOk(req.query.from) || new Date(new Date(ate + 'T12:00:00Z').getTime() - 29 * 86400000).toISOString().slice(0, 10);
    const base = `FROM dlv_orders o WHERE o.created_at >= ($1::date)::timestamp AT TIME ZONE $3 AND o.created_at < (($2::date) + 1)::timestamp AT TIME ZONE $3`;
    const P = [de, ate, tz];
    const resumo = (await q(`SELECT count(*)::int AS orders,
        count(*) FILTER (WHERE status='cancelled')::int AS cancelled, count(*) FILTER (WHERE status='delivered')::int AS delivered,
        COALESCE(sum(total) FILTER (WHERE status<>'cancelled'),0)::float AS revenue,
        COALESCE(sum(fee) FILTER (WHERE status<>'cancelled'),0)::float AS fees,
        COALESCE(sum(discount) FILTER (WHERE status<>'cancelled'),0)::float AS discounts,
        COALESCE(avg(total) FILTER (WHERE status<>'cancelled'),0)::float AS avg_ticket,
        COALESCE(avg(EXTRACT(EPOCH FROM (delivered_at - created_at))/60) FILTER (WHERE status='delivered'),0)::float AS avg_minutes ${base}`, P)).rows[0];
    const grupo = async (expr, extra = '') => (await q(`SELECT ${expr} AS key, count(*)::int AS orders, COALESCE(sum(total),0)::float AS revenue ${base} AND o.status<>'cancelled' ${extra} GROUP BY 1 ORDER BY 3 DESC`, P)).rows;
    const porDia = (await q(`SELECT to_char(o.created_at AT TIME ZONE $3,'YYYY-MM-DD') AS key, count(*)::int AS orders, COALESCE(sum(total),0)::float AS revenue ${base} AND o.status<>'cancelled' GROUP BY 1 ORDER BY 1`, P)).rows;
    const porHora = (await q(`SELECT EXTRACT(HOUR FROM o.created_at AT TIME ZONE $3)::int AS key, count(*)::int AS orders ${base} AND o.status<>'cancelled' GROUP BY 1 ORDER BY 1`, P)).rows;
    const topItens = (await q(`SELECT i.name AS key, sum(i.qty)::int AS qty, sum(i.total)::float AS revenue
        FROM dlv_order_items i JOIN dlv_orders o ON o.id=i.order_id
        WHERE o.created_at >= ($1::date)::timestamp AT TIME ZONE $3 AND o.created_at < (($2::date) + 1)::timestamp AT TIME ZONE $3 AND o.status<>'cancelled'
        GROUP BY 1 ORDER BY 2 DESC LIMIT 10`, P)).rows;
    res.json({
      from: de, to: ate, summary: resumo,
      by_payment: await grupo('o.payment_method'), by_kind: await grupo('o.kind'),
      by_neighborhood: (await grupo("COALESCE(NULLIF(o.neighborhood,''),'(retirada)')")).slice(0, 10),
      by_day: porDia, by_hour: porHora, top_items: topItens,
    });
  }));
}
