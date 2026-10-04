// Módulo Restaurante: mesas e comandas lançadas por vários garçons, fila da cozinha/bar, caixa com divisão de conta e
// comissão do garçom. Usa o mesmo cardápio do Delivery (um cadastro só) e as funções da equipe (src/funcoes.js):
// cada tela (salão, cozinha, caixa, gestão) é uma permissão que o administrador dá à função da pessoa.
// Todos os valores são calculados aqui, a partir do cardápio — nunca se confia no preço que vem de fora.
import { q, qg, tx, currentCompany } from './db.js';
import { montarLinhas } from './delivery.js';
import { acessoDe } from './funcoes.js';

export const RESTAURANTE_SQL = `
  ALTER TABLE dlv_items ADD COLUMN IF NOT EXISTS station TEXT NOT NULL DEFAULT 'cozinha';
  CREATE TABLE IF NOT EXISTS rst_settings (
    id                INT PRIMARY KEY CHECK (id = 1),
    service_fee_pct   NUMERIC(5,2) NOT NULL DEFAULT 10 CHECK (service_fee_pct >= 0 AND service_fee_pct <= 30),
    commission_pct    NUMERIC(5,2) NOT NULL DEFAULT 0 CHECK (commission_pct >= 0 AND commission_pct <= 100),
    commission_on_fee BOOLEAN NOT NULL DEFAULT false
  );
  INSERT INTO rst_settings (id) VALUES (1) ON CONFLICT DO NOTHING;
  CREATE TABLE IF NOT EXISTS rst_tables (
    id       BIGSERIAL PRIMARY KEY,
    name     TEXT NOT NULL UNIQUE,
    seats    INT NOT NULL DEFAULT 4 CHECK (seats >= 1 AND seats <= 99),
    position INT NOT NULL DEFAULT 0,
    active   BOOLEAN NOT NULL DEFAULT true
  );
  CREATE TABLE IF NOT EXISTS rst_tabs (
    id            BIGSERIAL PRIMARY KEY,
    table_id      BIGINT REFERENCES rst_tables(id) ON DELETE SET NULL,
    label         TEXT,
    people        INT NOT NULL DEFAULT 1 CHECK (people >= 1 AND people <= 99),
    waiter_id     BIGINT,
    waiter_name   TEXT,
    status        TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','closed','cancelled')),
    fee_pct       NUMERIC(5,2) NOT NULL DEFAULT 0,
    discount      NUMERIC(10,2) NOT NULL DEFAULT 0 CHECK (discount >= 0),
    note          TEXT,
    cancel_reason TEXT,
    opened_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
    closed_at     TIMESTAMPTZ,
    closed_by     TEXT
  );
  CREATE UNIQUE INDEX IF NOT EXISTS rst_tab_open_table ON rst_tabs (table_id) WHERE status = 'open' AND table_id IS NOT NULL;
  CREATE INDEX IF NOT EXISTS rst_tabs_status ON rst_tabs (status, opened_at);
  CREATE TABLE IF NOT EXISTS rst_tab_items (
    id             BIGSERIAL PRIMARY KEY,
    tab_id         BIGINT NOT NULL REFERENCES rst_tabs(id) ON DELETE CASCADE,
    item_id        BIGINT,
    name           TEXT NOT NULL,
    qty            INT NOT NULL CHECK (qty >= 1),
    unit_price     NUMERIC(10,2) NOT NULL,
    total          NUMERIC(10,2) NOT NULL,
    note           TEXT,
    options        JSONB NOT NULL DEFAULT '[]',
    station        TEXT NOT NULL DEFAULT 'cozinha',
    status         TEXT NOT NULL DEFAULT 'sent' CHECK (status IN ('sent','preparing','ready','served','cancelled')),
    cancel_reason  TEXT,
    added_by_name  TEXT,
    added_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
    started_at     TIMESTAMPTZ,
    ready_at       TIMESTAMPTZ,
    served_at      TIMESTAMPTZ
  );
  CREATE INDEX IF NOT EXISTS rst_tab_items_fila ON rst_tab_items (status, added_at);
  CREATE INDEX IF NOT EXISTS rst_tab_items_tab ON rst_tab_items (tab_id);
  CREATE TABLE IF NOT EXISTS rst_payments (
    id         BIGSERIAL PRIMARY KEY,
    tab_id     BIGINT NOT NULL REFERENCES rst_tabs(id) ON DELETE CASCADE,
    method     TEXT NOT NULL CHECK (method IN ('dinheiro','pix','credito','debito','outro')),
    amount     NUMERIC(10,2) NOT NULL CHECK (amount > 0),
    paid_by    TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
  );
  CREATE INDEX IF NOT EXISTS rst_payments_tab ON rst_payments (tab_id);
`;

export const METODOS = ['dinheiro', 'pix', 'credito', 'debito', 'outro'];
export const NOMES_METODO = { dinheiro: 'Dinheiro', pix: 'Pix', credito: 'Cartão de crédito', debito: 'Cartão de débito', outro: 'Outro' };
const ESTACOES = ['cozinha', 'bar', 'direto'];
export const ESTACOES_NOMES = { cozinha: 'Cozinha', bar: 'Bar', direto: 'Sai direto (sem preparo)' };
// Telas do restaurante (permissões da equipe)
export const TELAS_RESTAURANTE = ['rst_salao', 'rst_cozinha', 'rst_caixa', 'rst_gestao'];

const r2 = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;
const idOk = (v) => (/^\d+$/.test(String(v ?? '')) ? String(v) : null);
const txt = (v, max) => { const s = String(v ?? '').trim(); return s.length <= max && !/[\u0000-\u0008\u000b-\u001f<>]/.test(s) ? s : null; };
const dataOk = (v) => /^\d{4}-\d{2}-\d{2}$/.test(String(v || '')) && !isNaN(new Date(v + 'T00:00:00Z')) ? String(v) : null;
const dinheiro = (v) => { const n = Number(String(v ?? '').replace(',', '.')); return Number.isFinite(n) && n >= 0 && n <= 99999 ? r2(n) : null; };

// Totais de uma comanda: soma dos itens (sem os cancelados), taxa de serviço, desconto, pago e o que falta
export function totais(itens, tab, pagamentos) {
  const subtotal = r2(itens.filter((i) => i.status !== 'cancelled').reduce((a, i) => a + Number(i.total), 0));
  const taxa = r2(subtotal * Number(tab.fee_pct) / 100);
  const desconto = Math.min(Number(tab.discount || 0), r2(subtotal + taxa));
  const total = r2(subtotal + taxa - desconto);
  const pago = r2(pagamentos.reduce((a, p) => a + Number(p.amount), 0));
  const pessoas = Math.max(1, Number(tab.people) || 1);
  return { subtotal, fee: taxa, discount: desconto, total, paid: pago, remaining: r2(Math.max(0, total - pago)), per_person: r2(total / pessoas) };
}

// Comissão do garçom sobre o que vendeu (e, se a empresa quiser, sobre a taxa de serviço também)
export const comissao = (vendas, taxa, cfg) => r2((Number(vendas) + (cfg.commission_on_fee ? Number(taxa) : 0)) * Number(cfg.commission_pct) / 100);

// Passos permitidos de cada item e quem pode dar cada um
const PASSOS = { sent: ['preparing', 'ready', 'cancelled'], preparing: ['ready', 'cancelled'], ready: ['served', 'preparing', 'cancelled'], served: ['cancelled'], cancelled: [] };

class Erro extends Error { constructor(msg, status = 400) { super(msg); this.status = status; } }

export function registerRestauranteRoutes(r, wrap) {
  const erro = (fn) => wrap(async (req, res) => {
    try { await fn(req, res); } catch (e) { if (e instanceof Erro || (Number.isInteger(e?.status) && e.status < 500 && e.message)) return res.status(e.status || 400).json({ error: e.message }); throw e; }
  });

  // Quem está pedindo e o que pode: dono (e administrador dentro da empresa) pode tudo; a equipe, só as telas da sua função.
  async function quem(req) {
    if (req.user.role === 'n8n') throw new Erro('Esta área é só do painel', 403);
    const u = (await qg('SELECT id, name, role FROM users WHERE id=$1', [req.user.id])).rows[0];
    if (!u) throw new Erro('Sessão inválida', 401);
    let telas;
    if (u.role === 'owner' || req.user.imp) telas = TELAS_RESTAURANTE;
    else telas = (await acessoDe(u.id))?.telas || [];
    const tem = (...ts) => telas.includes('rst_gestao') || ts.some((t) => telas.includes(t));
    return { id: String(u.id), nome: u.name, telas, tem, vetudo: telas.includes('rst_caixa') || telas.includes('rst_gestao') };
  }
  const precisa = (me, ...ts) => { if (!me.tem(...ts)) throw new Erro('Você não tem acesso a esta área', 403); };

  const config = async () => { const c = (await q('SELECT * FROM rst_settings WHERE id=1')).rows[0]; return { service_fee_pct: Number(c.service_fee_pct), commission_pct: Number(c.commission_pct), commission_on_fee: c.commission_on_fee }; };
  const fusoSql = () => `(SELECT timezone FROM public.companies WHERE id=${Number(currentCompany())})`;

  async function carregarComanda(id, me) {
    const tab = (await q(`SELECT t.*, m.name AS table_name FROM rst_tabs t LEFT JOIN rst_tables m ON m.id=t.table_id WHERE t.id=$1`, [id])).rows[0];
    if (!tab) throw new Erro('Comanda não encontrada', 404);
    if (!me.vetudo && tab.waiter_id !== null && String(tab.waiter_id) !== me.id) throw new Erro('Esta comanda é de outro garçom', 403);
    const itens = (await q(`SELECT id::text AS id, item_id::text AS item_id, name, qty, unit_price::float AS unit_price, total::float AS total, note, options, station, status, cancel_reason,
        added_by_name, added_at, started_at, ready_at, served_at FROM rst_tab_items WHERE tab_id=$1 ORDER BY id`, [id])).rows;
    const pagamentos = (await q(`SELECT id::text AS id, method, amount::float AS amount, paid_by, created_at FROM rst_payments WHERE tab_id=$1 ORDER BY id`, [id])).rows;
    return {
      id: String(tab.id), table_id: tab.table_id ? String(tab.table_id) : null, table_name: tab.table_name, label: tab.label, people: tab.people,
      waiter_id: tab.waiter_id ? String(tab.waiter_id) : null, waiter_name: tab.waiter_name, status: tab.status, fee_pct: Number(tab.fee_pct), discount: Number(tab.discount),
      note: tab.note, cancel_reason: tab.cancel_reason, opened_at: tab.opened_at, closed_at: tab.closed_at, closed_by: tab.closed_by,
      items: itens, payments: pagamentos, totals: totais(itens, tab, pagamentos),
    };
  }

  // ---------- cardápio para lançar (o mesmo do Delivery) ----------
  r.get('/restaurant/menu', erro(async (req, res) => {
    const me = await quem(req); precisa(me, 'rst_salao');
    const cats = (await q('SELECT id::text AS id, name FROM dlv_categories WHERE active ORDER BY position, id')).rows;
    const itens = (await q(`SELECT id::text AS id, category_id::text AS category_id, name, description, price::float AS price, sold_out, station FROM dlv_items WHERE active ORDER BY position, name`)).rows;
    const grupos = (await q('SELECT id::text AS id, item_id::text AS item_id, name, min_select, max_select FROM dlv_option_groups ORDER BY position, id')).rows;
    const opcoes = (await q('SELECT id::text AS id, group_id::text AS group_id, name, price_delta::float AS price_delta FROM dlv_options WHERE active ORDER BY position, id')).rows;
    const monta = (i) => ({ ...i, option_groups: grupos.filter((g) => g.item_id === i.id).map((g) => ({ ...g, options: opcoes.filter((o) => o.group_id === g.id) })) });
    const sem = itens.filter((i) => !cats.some((c) => c.id === i.category_id));
    res.json({ categories: [...cats.map((c) => ({ ...c, items: itens.filter((i) => i.category_id === c.id).map(monta) })), ...(sem.length ? [{ id: null, name: 'Outros', items: sem.map(monta) }] : [])].filter((c) => c.items.length) });
  }));

  // ---------- mesas ----------
  r.get('/restaurant/tables', erro(async (req, res) => {
    const me = await quem(req); precisa(me, 'rst_salao', 'rst_caixa');
    const mesas = (await q('SELECT id::text AS id, name, seats, position FROM rst_tables WHERE active ORDER BY position, id')).rows;
    const abertas = (await q(`SELECT t.id, t.table_id, t.label, t.people, t.waiter_id, t.waiter_name, t.opened_at,
        COALESCE((SELECT sum(total) FROM rst_tab_items i WHERE i.tab_id=t.id AND i.status<>'cancelled'),0)::float AS subtotal,
        (SELECT count(*) FROM rst_tab_items i WHERE i.tab_id=t.id AND i.status='ready')::int AS prontos
      FROM rst_tabs t WHERE t.status='open'`)).rows;
    const mapa = (t) => ({ id: String(t.id), label: t.label, people: t.people, waiter_id: t.waiter_id ? String(t.waiter_id) : null, waiter_name: t.waiter_name, opened_at: t.opened_at, subtotal: t.subtotal, ready: t.prontos, mine: String(t.waiter_id) === me.id });
    res.json({
      tables: mesas.map((m) => ({ ...m, tab: (() => { const t = abertas.find((x) => String(x.table_id) === m.id); return t ? mapa(t) : null; })() })),
      loose: abertas.filter((t) => !t.table_id).map(mapa),
      settings: await config(),
    });
  }));

  r.post('/restaurant/table-defs', erro(async (req, res) => {
    const me = await quem(req); precisa(me, 'rst_gestao');
    const b = req.body || {};
    if (b.from !== undefined || b.to !== undefined) {   // várias de uma vez: "Mesa 1" a "Mesa 20"
      const de = Number(b.from), ate = Number(b.to), pre = txt(b.prefix ?? 'Mesa', 20);
      if (!Number.isInteger(de) || !Number.isInteger(ate) || de < 1 || ate < de || ate - de >= 100 || pre === null) throw new Erro('Informe um intervalo válido (até 100 mesas de uma vez)');
      let n = 0;
      for (let i = de; i <= ate; i++) n += (await q('INSERT INTO rst_tables (name, seats, position) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING', [`${pre} ${i}`.trim(), Number(b.seats) || 4, i])).rowCount;
      return res.status(201).json({ created: n });
    }
    const nome = txt(b.name, 40); if (!nome) throw new Erro('Dê um nome à mesa (até 40 letras)');
    const lug = Number(b.seats ?? 4); if (!Number.isInteger(lug) || lug < 1 || lug > 99) throw new Erro('Lugares inválidos (1 a 99)');
    const rows = (await q('INSERT INTO rst_tables (name, seats, position) VALUES ($1,$2,(SELECT COALESCE(max(position),0)+1 FROM rst_tables)) ON CONFLICT DO NOTHING RETURNING id::text AS id', [nome, lug])).rows;
    if (!rows[0]) throw new Erro('Já existe uma mesa com esse nome', 409);
    res.status(201).json(rows[0]);
  }));
  r.put('/restaurant/table-defs/:id', erro(async (req, res) => {
    const me = await quem(req); precisa(me, 'rst_gestao');
    const id = idOk(req.params.id); const b = req.body || {};
    const sets = [], vals = [id];
    const add = (c, v) => { vals.push(v); sets.push(`${c}=$${vals.length}`); };
    if (b.name !== undefined) { const n = txt(b.name, 40); if (!n) throw new Erro('Nome inválido'); add('name', n); }
    if (b.seats !== undefined) { const n = Number(b.seats); if (!Number.isInteger(n) || n < 1 || n > 99) throw new Erro('Lugares inválidos (1 a 99)'); add('seats', n); }
    if (b.active !== undefined) add('active', !!b.active);
    if (!id || !(await q('SELECT 1 FROM rst_tables WHERE id=$1', [id])).rowCount) throw new Erro('Mesa não encontrada', 404);
    if (sets.length) {
      try { await q(`UPDATE rst_tables SET ${sets.join(', ')} WHERE id=$1`, vals); }
      catch (e) { if (e.code === '23505') throw new Erro('Já existe uma mesa com esse nome', 409); throw e; }
    }
    res.json({ ok: true });
  }));
  r.delete('/restaurant/table-defs/:id', erro(async (req, res) => {
    const me = await quem(req); precisa(me, 'rst_gestao');
    const id = idOk(req.params.id); if (!id) throw new Erro('Mesa não encontrada', 404);
    if ((await q(`SELECT 1 FROM rst_tabs WHERE table_id=$1 AND status='open'`, [id])).rowCount) throw new Erro('A mesa tem uma comanda aberta', 409);
    // com histórico, a mesa só deixa de aparecer; sem histórico, é apagada
    const usada = (await q('SELECT 1 FROM rst_tabs WHERE table_id=$1 LIMIT 1', [id])).rowCount;
    if (usada) await q('UPDATE rst_tables SET active=false WHERE id=$1', [id]); else await q('DELETE FROM rst_tables WHERE id=$1', [id]);
    res.json({ ok: true, archived: !!usada });
  }));
  r.get('/restaurant/table-defs', erro(async (req, res) => {
    const me = await quem(req); precisa(me, 'rst_gestao');
    res.json((await q('SELECT id::text AS id, name, seats, active FROM rst_tables ORDER BY position, id')).rows);
  }));

  // ---------- comandas ----------
  r.post('/restaurant/tabs', erro(async (req, res) => {
    const me = await quem(req); precisa(me, 'rst_salao', 'rst_caixa');
    const b = req.body || {};
    const mesa = b.table_id ? idOk(b.table_id) : null;
    const rotulo = txt(b.label ?? '', 60);
    if (rotulo === null) throw new Erro('Nome da comanda inválido');
    if (!mesa && !rotulo) throw new Erro('Escolha a mesa ou dê um nome à comanda (balcão, viagem...)');
    const pessoas = b.people === undefined ? 1 : Number(b.people);
    if (!Number.isInteger(pessoas) || pessoas < 1 || pessoas > 99) throw new Erro('Número de pessoas inválido');
    if (mesa && !(await q('SELECT 1 FROM rst_tables WHERE id=$1 AND active', [mesa])).rowCount) throw new Erro('Mesa não encontrada', 404);
    const cfg = await config();
    try {
      const id = (await q(`INSERT INTO rst_tabs (table_id, label, people, waiter_id, waiter_name, fee_pct) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
        [mesa, rotulo || null, pessoas, me.id, me.nome, cfg.service_fee_pct])).rows[0].id;
      res.status(201).json(await carregarComanda(id, me));
    } catch (e) {
      if (e.code === '23505') throw new Erro('Essa mesa já tem uma comanda aberta', 409);
      throw e;
    }
  }));

  r.get('/restaurant/tabs', erro(async (req, res) => {
    const me = await quem(req); precisa(me, 'rst_salao', 'rst_caixa');
    const fechadas = req.query.status === 'closed';
    const de = dataOk(req.query.from), ate = dataOk(req.query.to);
    const params = [];
    let where = fechadas ? "t.status='closed'" : "t.status='open'";
    if (!me.vetudo) { params.push(me.id); where += ` AND t.waiter_id=$${params.length}`; }
    if (fechadas && de) { params.push(de); where += ` AND (t.closed_at AT TIME ZONE ${fusoSql()})::date >= $${params.length}::date`; }
    if (fechadas && ate) { params.push(ate); where += ` AND (t.closed_at AT TIME ZONE ${fusoSql()})::date <= $${params.length}::date`; }
    const rows = (await q(`SELECT t.id, t.label, t.people, t.waiter_name, t.status, t.fee_pct, t.discount, t.opened_at, t.closed_at, m.name AS table_name,
        COALESCE((SELECT sum(total) FROM rst_tab_items i WHERE i.tab_id=t.id AND i.status<>'cancelled'),0) AS subtotal,
        COALESCE((SELECT sum(amount) FROM rst_payments p WHERE p.tab_id=t.id),0) AS pago
      FROM rst_tabs t LEFT JOIN rst_tables m ON m.id=t.table_id WHERE ${where} ORDER BY ${fechadas ? 't.closed_at DESC' : 't.opened_at'} LIMIT 300`, params)).rows;
    res.json(rows.map((t) => {
      const itens = [{ total: t.subtotal, status: 'x' }];
      return { id: String(t.id), table_name: t.table_name, label: t.label, people: t.people, waiter_name: t.waiter_name, opened_at: t.opened_at, closed_at: t.closed_at, totals: totais(itens, t, [{ amount: t.pago }]) };
    }));
  }));

  r.get('/restaurant/tabs/:id', erro(async (req, res) => {
    const me = await quem(req); precisa(me, 'rst_salao', 'rst_caixa');
    const id = idOk(req.params.id); if (!id) throw new Erro('Comanda não encontrada', 404);
    res.json(await carregarComanda(id, me));
  }));

  r.put('/restaurant/tabs/:id', erro(async (req, res) => {
    const me = await quem(req); precisa(me, 'rst_salao', 'rst_caixa');
    const id = idOk(req.params.id); if (!id) throw new Erro('Comanda não encontrada', 404);
    const antes = await carregarComanda(id, me);
    if (antes.status !== 'open') throw new Erro('A comanda já foi encerrada', 409);
    const b = req.body || {};
    const sets = [], vals = [id];
    const add = (c, v) => { vals.push(v); sets.push(`${c}=$${vals.length}`); };
    if (b.people !== undefined) { const n = Number(b.people); if (!Number.isInteger(n) || n < 1 || n > 99) throw new Erro('Número de pessoas inválido'); add('people', n); }
    if (b.label !== undefined) { const n = txt(b.label, 60); if (n === null) throw new Erro('Nome inválido'); add('label', n || null); }
    if (b.note !== undefined) { const n = txt(b.note, 200); if (n === null) throw new Erro('Observação inválida'); add('note', n || null); }
    if (b.fee_pct !== undefined || b.discount !== undefined) {
      precisa(me, 'rst_caixa');
      if (b.fee_pct !== undefined) { const n = Number(b.fee_pct); if (!Number.isFinite(n) || n < 0 || n > 30) throw new Erro('Taxa de serviço inválida (0 a 30%)'); add('fee_pct', r2(n)); }
      if (b.discount !== undefined) { const n = dinheiro(b.discount); if (n === null) throw new Erro('Desconto inválido'); add('discount', n); }
    }
    if (b.waiter_id !== undefined) {
      precisa(me, 'rst_caixa');
      const w = (await qg('SELECT id, name FROM users WHERE id=$1 AND company_id=$2 AND active', [idOk(b.waiter_id) || 0, currentCompany()])).rows[0];
      if (!w) throw new Erro('Garçom não encontrado');
      add('waiter_id', w.id); add('waiter_name', w.name);
    }
    if (b.table_id !== undefined) {
      const mesa = b.table_id ? idOk(b.table_id) : null;
      if (mesa && !(await q('SELECT 1 FROM rst_tables WHERE id=$1 AND active', [mesa])).rowCount) throw new Erro('Mesa não encontrada', 404);
      add('table_id', mesa);
    }
    if (sets.length) {
      try { await q(`UPDATE rst_tabs SET ${sets.join(', ')} WHERE id=$1`, vals); }
      catch (e) { if (e.code === '23505') throw new Erro('Essa mesa já tem uma comanda aberta', 409); throw e; }
    }
    res.json(await carregarComanda(id, me));
  }));

  // Lança itens na comanda (vários de uma vez). Cada item vai para a fila da cozinha ou do bar, conforme o cadastro do cardápio.
  r.post('/restaurant/tabs/:id/items', erro(async (req, res) => {
    const me = await quem(req); precisa(me, 'rst_salao', 'rst_caixa');
    const id = idOk(req.params.id); if (!id) throw new Erro('Comanda não encontrada', 404);
    const tab = await carregarComanda(id, me);
    if (tab.status !== 'open') throw new Erro('A comanda já foi encerrada', 409);
    if (!me.vetudo && tab.waiter_id !== me.id) throw new Erro('Esta comanda é de outro garçom', 403);
    const pedido = Array.isArray(req.body?.items) ? req.body.items : [];
    if (!pedido.length) throw new Erro('Escolha pelo menos um item');
    if (pedido.length > 40) throw new Erro('Itens demais de uma vez (máximo 40)');
    const { linhas } = await montarLinhas(pedido.map((i) => ({ item_id: i.item_id, qty: i.qty, note: i.note, options: i.options })), false);
    const est = (await q('SELECT id::text AS id, station FROM dlv_items WHERE id = ANY($1::bigint[])', [linhas.map((l) => l.item_id)])).rows;
    await tx(currentCompany(), async (t) => {
      for (const l of linhas) {
        const estacao = est.find((e) => e.id === String(l.item_id))?.station || 'cozinha';
        const direto = estacao === 'direto';
        await t(`INSERT INTO rst_tab_items (tab_id, item_id, name, qty, unit_price, total, note, options, station, status, added_by_name, ready_at)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9,$10,$11,${direto ? 'now()' : 'NULL'})`,
          [id, l.item_id, l.name, l.qty, l.unit_price, l.total, l.note, JSON.stringify(l.options), estacao, direto ? 'ready' : 'sent', me.nome]);
      }
    });
    res.status(201).json(await carregarComanda(id, me));
  }));

  // Muda o andamento de um item: cozinha/bar (preparando, pronto), garçom (entregue na mesa) ou cancelamento
  r.post('/restaurant/items/:id/status', erro(async (req, res) => {
    const me = await quem(req);
    const id = idOk(req.params.id); const para = String(req.body?.status || '');
    if (!id || !PASSOS.sent.concat(['served']).includes(para)) throw new Erro('Andamento inválido');
    const it = (await q(`SELECT i.*, t.waiter_id, t.status AS tab_status FROM rst_tab_items i JOIN rst_tabs t ON t.id=i.tab_id WHERE i.id=$1`, [id])).rows[0];
    if (!it) throw new Erro('Item não encontrado', 404);
    if (!PASSOS[it.status].includes(para)) throw new Erro('Esse item não pode ir para este andamento agora', 409);
    if (it.tab_status !== 'open') throw new Erro('A comanda já foi encerrada', 409);
    const minha = String(it.waiter_id) === me.id;
    if (para === 'preparing' || para === 'ready') precisa(me, 'rst_cozinha');
    else if (para === 'served') { precisa(me, 'rst_salao', 'rst_caixa'); if (!me.vetudo && !minha) throw new Erro('Este item é de outro garçom', 403); }
    else if (para === 'cancelled') {
      // o garçom desfaz o que acabou de lançar (ainda não começou a ser feito); depois disso, só caixa ou gestão
      const livre = it.status === 'sent' && me.tem('rst_salao') && minha;
      if (!livre) precisa(me, 'rst_caixa');
    }
    const motivo = para === 'cancelled' ? txt(req.body?.reason ?? '', 200) : null;
    if (para === 'cancelled' && (motivo === null || (it.status !== 'sent' && !motivo))) throw new Erro('Diga o motivo do cancelamento');
    const col = { preparing: 'started_at', ready: 'ready_at', served: 'served_at' }[para];
    await q(`UPDATE rst_tab_items SET status=$2, cancel_reason=$3${col ? `, ${col}=now()` : ''}${para === 'preparing' && it.status === 'ready' ? ', ready_at=NULL' : ''} WHERE id=$1`, [id, para, motivo || null]);
    res.json({ ok: true });
  }));

  // ---------- cozinha e bar ----------
  r.get('/restaurant/kitchen', erro(async (req, res) => {
    const me = await quem(req); precisa(me, 'rst_cozinha');
    const est = ESTACOES.includes(req.query.station) && req.query.station !== 'direto' ? req.query.station : null;
    const rows = (await q(`SELECT i.id, i.name, i.qty, i.note, i.options, i.station, i.status, i.added_at, i.started_at, i.ready_at, t.id AS tab_id, t.label, t.waiter_name, m.name AS table_name
      FROM rst_tab_items i JOIN rst_tabs t ON t.id=i.tab_id LEFT JOIN rst_tables m ON m.id=t.table_id
      WHERE t.status='open' AND i.station <> 'direto' AND ${est ? 'i.station=$1 AND' : ''}
        (i.status IN ('sent','preparing') OR (i.status='ready' AND i.ready_at > now() - interval '20 minutes'))
      ORDER BY i.added_at, i.id`, est ? [est] : [])).rows;
    res.json(rows.map((i) => ({ id: String(i.id), name: i.name, qty: i.qty, note: i.note, options: i.options, station: i.station, status: i.status, added_at: i.added_at,
      started_at: i.started_at, ready_at: i.ready_at, tab_id: String(i.tab_id), where: i.table_name || i.label || 'Comanda', waiter_name: i.waiter_name })));
  }));

  // Itens prontos esperando o garçom levar
  r.get('/restaurant/ready', erro(async (req, res) => {
    const me = await quem(req); precisa(me, 'rst_salao', 'rst_caixa');
    const rows = (await q(`SELECT i.id, i.name, i.qty, i.note, i.ready_at, t.id AS tab_id, t.label, t.waiter_id, t.waiter_name, m.name AS table_name
      FROM rst_tab_items i JOIN rst_tabs t ON t.id=i.tab_id LEFT JOIN rst_tables m ON m.id=t.table_id
      WHERE t.status='open' AND i.status='ready' ${me.vetudo ? '' : 'AND t.waiter_id=$1'} ORDER BY i.ready_at, i.id`, me.vetudo ? [] : [me.id])).rows;
    res.json(rows.map((i) => ({ id: String(i.id), name: i.name, qty: i.qty, note: i.note, ready_at: i.ready_at, tab_id: String(i.tab_id), where: i.table_name || i.label || 'Comanda', waiter_name: i.waiter_name })));
  }));

  // ---------- caixa ----------
  r.post('/restaurant/tabs/:id/payments', erro(async (req, res) => {
    const me = await quem(req); precisa(me, 'rst_caixa');
    const id = idOk(req.params.id); if (!id) throw new Erro('Comanda não encontrada', 404);
    const tab = await carregarComanda(id, me);
    if (tab.status !== 'open') throw new Erro('A comanda já foi encerrada', 409);
    const metodo = String(req.body?.method || '');
    if (!METODOS.includes(metodo)) throw new Erro('Forma de pagamento inválida');
    const valor = dinheiro(req.body?.amount);
    if (valor === null || valor <= 0) throw new Erro('Valor inválido');
    if (valor > tab.totals.remaining + 0.004) throw new Erro(`O valor passa do que falta pagar (${tab.totals.remaining.toFixed(2).replace('.', ',')})`);
    await q('INSERT INTO rst_payments (tab_id, method, amount, paid_by) VALUES ($1,$2,$3,$4)', [id, metodo, valor, me.nome]);
    res.status(201).json(await carregarComanda(id, me));
  }));
  r.delete('/restaurant/payments/:id', erro(async (req, res) => {
    const me = await quem(req); precisa(me, 'rst_caixa');
    const id = idOk(req.params.id);
    const p = id ? (await q('SELECT p.tab_id, t.status FROM rst_payments p JOIN rst_tabs t ON t.id=p.tab_id WHERE p.id=$1', [id])).rows[0] : null;
    if (!p) throw new Erro('Pagamento não encontrado', 404);
    if (p.status !== 'open') throw new Erro('A comanda já foi encerrada', 409);
    await q('DELETE FROM rst_payments WHERE id=$1', [id]);
    res.json(await carregarComanda(p.tab_id, me));
  }));

  r.post('/restaurant/tabs/:id/close', erro(async (req, res) => {
    const me = await quem(req); precisa(me, 'rst_caixa');
    const id = idOk(req.params.id); if (!id) throw new Erro('Comanda não encontrada', 404);
    const tab = await carregarComanda(id, me);
    if (tab.status !== 'open') throw new Erro('A comanda já foi encerrada', 409);
    if (tab.totals.remaining > 0.004) throw new Erro(`Ainda falta pagar ${tab.totals.remaining.toFixed(2).replace('.', ',')}`, 409);
    if (tab.items.some((i) => ['sent', 'preparing'].includes(i.status)) && !req.body?.force)
      throw new Erro('Ainda há itens na cozinha ou no bar. Confirme para encerrar mesmo assim.', 409);
    await tx(currentCompany(), async (t) => {
      // o que ficou sem preparar não entra na conta nem fica na fila
      await t(`UPDATE rst_tab_items SET status='cancelled', cancel_reason='Encerrado sem preparo' WHERE tab_id=$1 AND status IN ('sent','preparing')`, [id]);
      await t(`UPDATE rst_tabs SET status='closed', closed_at=now(), closed_by=$2 WHERE id=$1`, [id, me.nome]);
    });
    res.json(await carregarComanda(id, me));
  }));

  r.post('/restaurant/tabs/:id/cancel', erro(async (req, res) => {
    const me = await quem(req); precisa(me, 'rst_caixa');
    const id = idOk(req.params.id); if (!id) throw new Erro('Comanda não encontrada', 404);
    const tab = await carregarComanda(id, me);
    if (tab.status !== 'open') throw new Erro('A comanda já foi encerrada', 409);
    if (tab.payments.length) throw new Erro('A comanda já tem pagamento. Remova os pagamentos antes de cancelar.', 409);
    const motivo = txt(req.body?.reason ?? '', 200);
    if (!motivo) throw new Erro('Diga o motivo do cancelamento');
    await tx(currentCompany(), async (t) => {
      await t(`UPDATE rst_tab_items SET status='cancelled', cancel_reason='Comanda cancelada' WHERE tab_id=$1 AND status <> 'cancelled'`, [id]);
      await t(`UPDATE rst_tabs SET status='cancelled', closed_at=now(), closed_by=$2, cancel_reason=$3 WHERE id=$1`, [id, me.nome, motivo]);
    });
    res.json({ ok: true });
  }));

  // ---------- configuração, equipe e relatório ----------
  r.get('/restaurant/settings', erro(async (req, res) => {
    const me = await quem(req); precisa(me, 'rst_gestao');
    res.json(await config());
  }));
  r.put('/restaurant/settings', erro(async (req, res) => {
    const me = await quem(req); precisa(me, 'rst_gestao');
    const b = req.body || {}; const cur = await config();
    const taxa = b.service_fee_pct === undefined ? cur.service_fee_pct : Number(b.service_fee_pct);
    const com = b.commission_pct === undefined ? cur.commission_pct : Number(b.commission_pct);
    if (!Number.isFinite(taxa) || taxa < 0 || taxa > 30) throw new Erro('Taxa de serviço inválida (0 a 30%)');
    if (!Number.isFinite(com) || com < 0 || com > 100) throw new Erro('Comissão inválida (0 a 100%)');
    await q('UPDATE rst_settings SET service_fee_pct=$1, commission_pct=$2, commission_on_fee=$3 WHERE id=1', [r2(taxa), r2(com), b.commission_on_fee === undefined ? cur.commission_on_fee : !!b.commission_on_fee]);
    res.json(await config());
  }));
  r.get('/restaurant/waiters', erro(async (req, res) => {
    const me = await quem(req); precisa(me, 'rst_caixa');
    res.json((await qg('SELECT id::text AS id, name FROM users WHERE company_id=$1 AND active ORDER BY lower(name)', [currentCompany()])).rows);
  }));

  r.get('/restaurant/report', erro(async (req, res) => {
    const me = await quem(req); precisa(me, 'rst_caixa');
    const de = dataOk(req.query.from), ate = dataOk(req.query.to);
    if (!de || !ate || de > ate) throw new Erro('Informe o período (data inicial e final)');
    const cfg = await config();
    const base = `FROM rst_tabs t WHERE t.status='closed' AND (t.closed_at AT TIME ZONE ${fusoSql()})::date BETWEEN $1::date AND $2::date`;
    const P = [de, ate];
    const comandas = (await q(`SELECT t.id, t.waiter_id, t.waiter_name, t.fee_pct, t.discount, t.people, (t.closed_at AT TIME ZONE ${fusoSql()})::date::text AS dia,
        COALESCE((SELECT sum(total) FROM rst_tab_items i WHERE i.tab_id=t.id AND i.status<>'cancelled'),0)::float AS subtotal ${base} ORDER BY t.id`, P)).rows;
    const pagamentos = (await q(`SELECT p.method, sum(p.amount)::float AS total ${base.replace('FROM rst_tabs t', 'FROM rst_tabs t JOIN rst_payments p ON p.tab_id=t.id')} GROUP BY p.method`, P)).rows;
    const itens = (await q(`SELECT i.name, sum(i.qty)::int AS qty, sum(i.total)::float AS total ${base.replace('FROM rst_tabs t', 'FROM rst_tabs t JOIN rst_tab_items i ON i.tab_id=t.id')} AND i.status<>'cancelled' GROUP BY i.name ORDER BY sum(i.total) DESC LIMIT 15`, P)).rows;
    const por = new Map(), dias = new Map();
    let vendas = 0, taxas = 0, descontos = 0, total = 0, pessoas = 0;
    for (const c of comandas) {
      const t = totais([{ total: c.subtotal, status: 'x' }], c, []);
      vendas = r2(vendas + t.subtotal); taxas = r2(taxas + t.fee); descontos = r2(descontos + t.discount); total = r2(total + t.total); pessoas += c.people;
      const chave = String(c.waiter_id ?? '');
      const w = por.get(chave) || { waiter_id: chave || null, name: c.waiter_name || 'Sem garçom', tabs: 0, sales: 0, fee: 0 };
      w.tabs++; w.sales = r2(w.sales + t.subtotal); w.fee = r2(w.fee + t.fee); por.set(chave, w);
      const d = dias.get(c.dia) || { day: c.dia, tabs: 0, total: 0 }; d.tabs++; d.total = r2(d.total + t.total); dias.set(c.dia, d);
    }
    const garcons = [...por.values()].map((w) => ({ ...w, commission: comissao(w.sales, w.fee, cfg) })).sort((a, b) => b.sales - a.sales);
    res.json({
      from: de, to: ate, tabs: comandas.length, people: pessoas, sales: vendas, fee: taxas, discounts: descontos, total,
      average_ticket: comandas.length ? r2(total / comandas.length) : 0,
      commission_total: r2(garcons.reduce((a, w) => a + w.commission, 0)),
      settings: cfg, by_waiter: garcons, by_method: pagamentos.map((p) => ({ method: p.method, name: NOMES_METODO[p.method], total: r2(p.total) })),
      top_items: itens, by_day: [...dias.values()].sort((a, b) => a.day.localeCompare(b.day)),
    });
  }));
}
