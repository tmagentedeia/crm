// Pedidos de música, lives e franquia mensal do programa de benefícios.
// Regras:
//  - o pedido vai para a próxima live que ainda não encerrou; sem live marcada, fica na fila (live_id nulo)
//  - sai pela franquia quando o cliente é membro com nível que tem benefícios, é o primeiro pedido dele naquela live
//    e ainda sobra franquia no mês da live; senão é pago
//  - o mês é o da data da live (fuso da empresa); a contagem vem dos próprios pedidos, não há contador para zerar
import { q, qg, tx, currentCompany } from './db.js';
import { normPhone } from './phone.js';

export const PEDIDOS_SQL = `
  CREATE TABLE IF NOT EXISTS lives (
    id          BIGSERIAL PRIMARY KEY,
    title       TEXT,
    starts_at   TIMESTAMPTZ NOT NULL,
    ends_at     TIMESTAMPTZ,                 -- vazio = vale até o fim do dia da live
    closed_at   TIMESTAMPTZ,                 -- encerrada à mão
    external_id TEXT UNIQUE,                 -- identificação em outro sistema (ex.: o vídeo da live)
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
  );
  CREATE INDEX IF NOT EXISTS idx_lives_starts ON lives (starts_at);
  CREATE TABLE IF NOT EXISTS song_orders (
    id          BIGSERIAL PRIMARY KEY,
    customer_id BIGINT NOT NULL REFERENCES customers(id),
    live_id     BIGINT REFERENCES lives(id),   -- vazio = na fila, aguardando uma live
    song        TEXT NOT NULL,
    dedication  TEXT,
    amount_paid NUMERIC(10,2),
    kind        TEXT CHECK (kind IN ('franchise','paid','courtesy')),   -- vazio enquanto está na fila
    level_name  TEXT,                          -- nível do cliente na hora do pedido
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    notified_at TIMESTAMPTZ
  );
  CREATE INDEX IF NOT EXISTS idx_song_orders_live ON song_orders (live_id);
  CREATE INDEX IF NOT EXISTS idx_song_orders_customer ON song_orders (customer_id);`;

// Cortesia do 1º pedido: cliente novo (não assinante) que pediu e não mandou comprovante em CORTESIA_MIN minutos.
// Vale uma vez por cliente. A marca fica no pedido (tipo "Cortesia") e na ficha (courtesy_used_at).
// Pedido atendido: o dono marca com um clique quando já tocou; os pendentes ficam no topo e em destaque.
// Ao criar a coluna, o que é de live já encerrada entra como atendido (histórico), para não aparecer como pendente.
// Indica em qual das chaves Pix cadastradas o valor do pedido entrou (todo lançamento financeiro tem chave).
async function gravaChave(t, orderId, keyId) {
  if (!/^\d+$/.test(String(keyId ?? ''))) return;
  await t(`UPDATE payments SET pix_key_id=k.id, key_text=k.key FROM pix_keys k WHERE k.id=$2 AND payments.order_id=$1 AND payments.source='pedido'`, [orderId, keyId]);
}
export const ATENDIDO_SQL = `
    DO $$
    BEGIN
      IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                     WHERE table_schema = current_schema() AND table_name = 'song_orders' AND column_name = 'served_at') THEN
        ALTER TABLE song_orders ADD COLUMN served_at TIMESTAMPTZ;
        UPDATE song_orders o SET served_at = o.created_at
         WHERE o.live_id IS NOT NULL AND EXISTS (SELECT 1 FROM lives l WHERE l.id = o.live_id
               AND COALESCE(l.closed_at, l.ends_at, l.starts_at + interval '1 day') < now() - interval '1 day');
      END IF;
    END $$;`;
// Corrige a carga inicial da versão anterior, que marcou como atendidos também os pedidos de lives recém-encerradas.
export const ATENDIDO_FIX_SQL = `
    UPDATE song_orders o SET served_at = NULL
     WHERE o.served_at = o.created_at AND o.live_id IS NOT NULL
       AND EXISTS (SELECT 1 FROM lives l WHERE l.id = o.live_id
             AND COALESCE(l.closed_at, l.ends_at, l.starts_at + interval '1 day') >= now() - interval '1 day');`;
// Músicas sugeridas para a live do dia: o dono alimenta a lista e a agente oferece uma a uma a quem pedir sugestão.
export const SUGESTOES_SQL = `
    CREATE TABLE IF NOT EXISTS song_suggestions (
      id         BIGSERIAL PRIMARY KEY,
      song       TEXT NOT NULL,
      offered    INT NOT NULL DEFAULT 0,          -- quantas vezes já foi oferecida (a menos oferecida vem primeiro)
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );`;

export const CORTESIA_SQL = `
    ALTER TABLE customers ADD COLUMN IF NOT EXISTS courtesy_used_at TIMESTAMPTZ;
    DO $$
    DECLARE c record;
    BEGIN
      FOR c IN SELECT conname FROM pg_constraint
               WHERE conrelid = 'song_orders'::regclass AND contype = 'c' AND pg_get_constraintdef(oid) LIKE '%franchise%'
      LOOP
        EXECUTE format('ALTER TABLE song_orders DROP CONSTRAINT %I', c.conname);
      END LOOP;
      ALTER TABLE song_orders ADD CONSTRAINT song_orders_kind_check CHECK (kind IN ('franchise','paid','courtesy'));
    END $$;`;
export const CORTESIA_MIN = Math.max(Number(process.env.CORTESIA_MIN ?? 15), 0);
export async function converterCortesias(t) {
  await t(`
    WITH elegiveis AS (
      SELECT o.id, o.customer_id FROM song_orders o JOIN customers c ON c.id=o.customer_id
      WHERE o.kind='paid' AND o.amount_paid IS NULL AND o.created_at <= now() - make_interval(mins => $1::int)
        AND c.courtesy_used_at IS NULL AND c.club_status IS NULL AND c.source='ia'   -- só contato novo (criado pela agente), nunca quem já está no cadastro do programa
        AND o.id = (SELECT min(id) FROM song_orders x WHERE x.customer_id=o.customer_id)
        AND NOT EXISTS (SELECT 1 FROM payments p WHERE p.customer_id=o.customer_id AND p.status='accepted' AND p.order_id IS NULL
                          AND p.created_at >= o.created_at - interval '12 hours')
    ), up AS (
      UPDATE song_orders so SET kind='courtesy', amount_paid=0 FROM elegiveis e WHERE so.id=e.id RETURNING so.customer_id
    )
    UPDATE customers SET courtesy_used_at=now() WHERE id IN (SELECT customer_id FROM up)`, [CORTESIA_MIN]);
}
export function startCortesias() {
  setInterval(async () => {
    try {
      const { rows } = await qg('SELECT id FROM companies ORDER BY id');
      for (const { id } of rows) { try { await tx(id, converterCortesias); } catch { /* empresa sem as tabelas */ } }
    } catch (e) { console.error('cortesias:', e.message); }
  }, 60000).unref();
}

// Cortesias: saldo grátis dado à mão a um cliente (cada concessão é uma linha). Nos pedidos de música vale 1 pedido; nos ingressos, 1 lugar.
// O gasto é contado nas próprias vendas (song_orders.from_courtesy e shows_sales.courtesy_used).
// Trava de música repetida: quando ligada, a música pedida na última live com pedidos não pode ser pedida de novo na seguinte.
export const CORTESIAS_SQL = `
    ALTER TABLE song_orders ADD COLUMN IF NOT EXISTS from_courtesy BOOLEAN NOT NULL DEFAULT false;
    CREATE TABLE IF NOT EXISTS courtesy_credits (
      id          BIGSERIAL PRIMARY KEY,
      customer_id BIGINT NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
      qty         INT NOT NULL CHECK (qty <> 0),
      note        TEXT,
      created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS idx_courtesy_credits_customer ON courtesy_credits (customer_id);
    CREATE TABLE IF NOT EXISTS order_settings (
      id           SMALLINT PRIMARY KEY CHECK (id = 1),
      block_repeat BOOLEAN NOT NULL DEFAULT false
    );
    INSERT INTO order_settings (id) VALUES (1) ON CONFLICT DO NOTHING;`;

// Padrão do nome da música: cada palavra com inicial maiúscula; artigos, preposições e "e/ou" ficam minúsculos no meio do nome.
// A 1ª palavra sempre começa maiúscula. Vale para todo pedido e sugestão (cadastro novo e já existente).
export const PADRONIZA_TITULOS_SQL = `ALTER TABLE order_settings ADD COLUMN IF NOT EXISTS titulos_padronizados BOOLEAN NOT NULL DEFAULT false;`;
const MINUSCULAS = new Set(['a', 'as', 'o', 'os', 'um', 'uma', 'e', 'ou', 'de', 'da', 'do', 'das', 'dos', 'em', 'no', 'na', 'nos', 'nas', 'por', 'pra', 'pro', 'para', 'com', 'ao', 'aos', 'à', 'às']);
export function tituloMusica(texto) {
  let primeira = true;
  return String(texto ?? '').trim().replace(/\s+/g, ' ').split(' ').map((w) => {
    const baixo = w.toLowerCase();
    const letras = baixo.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, '');
    const ficaMinuscula = !primeira && MINUSCULAS.has(letras);
    primeira = false;
    return ficaMinuscula ? baixo : baixo.replace(/\p{L}/u, (c) => c.toUpperCase());
  }).join(' ');
}
// Uma vez por empresa: padroniza os pedidos e as sugestões que já existiam
export async function padronizarTitulosExistentes() {
  const { rows } = await qg('SELECT id FROM companies ORDER BY id');
  for (const { id } of rows) {
    try {
      await tx(id, async (t) => {
        if (!(await t('SELECT 1 FROM order_settings WHERE id=1 AND NOT titulos_padronizados')).rowCount) return;
        for (const tab of ['song_orders', 'song_suggestions']) {
          for (const x of (await t(`SELECT id, song FROM ${tab}`)).rows) {
            const novo = tituloMusica(x.song);
            if (novo && novo !== x.song) await t(`UPDATE ${tab} SET song=$2 WHERE id=$1`, [x.id, novo]);
          }
        }
        await t('UPDATE order_settings SET titulos_padronizados=true WHERE id=1');
      });
    } catch (e) { console.error('padronizar títulos:', id, e.message); }
  }
}

// A tabela e a coluna do saldo nasceram como "crédito extra"; passam a se chamar cortesias (quem já tinha o nome antigo é renomeado)
export const CORTESIAS_RENOMEIA_SQL = `
    DO $$ BEGIN
      IF to_regclass('order_credits') IS NOT NULL THEN
        ALTER TABLE order_credits RENAME TO courtesy_credits;
        ALTER INDEX IF EXISTS idx_order_credits_customer RENAME TO idx_courtesy_credits_customer;
      END IF;
      IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = 'song_orders' AND column_name = 'from_extra') THEN
        ALTER TABLE song_orders RENAME COLUMN from_extra TO from_courtesy;
      END IF;
    END $$;`;

const ABERTA = (p) => `(l.closed_at IS NULL AND COALESCE(l.ends_at, ((date_trunc('day', l.starts_at AT TIME ZONE ${p}) + interval '1 day') AT TIME ZONE ${p})) > now())`;
const MES = (col, p) => `to_char(${col} AT TIME ZONE ${p}, 'YYYY-MM')`;

async function fuso() {
  return (await qg('SELECT timezone FROM companies WHERE id=$1', [currentCompany()])).rows[0]?.timezone || 'America/Sao_Paulo';
}
const proximaLive = async (t, tz) =>
  (await t(`SELECT l.* FROM lives l WHERE ${ABERTA('$1')} ORDER BY l.starts_at, l.id LIMIT 1`, [tz])).rows[0] || null;

// Cortesias gastas por um cliente: pedidos de música pagos com o saldo + lugares de ingresso vendidos como cortesia (vendas não canceladas)
export const CORTESIAS_USADAS = (c) => `(SELECT count(*) FROM song_orders o WHERE o.customer_id=${c}.id AND o.from_courtesy)::int
  + COALESCE((SELECT sum(sv.courtesy_used) FROM shows_sales sv WHERE sv.phone=${c}.phone AND sv.status IN ('confirmed','attended')),0)::int`;
export async function saldoCortesias(t, customerId) {
  const r = (await t(`SELECT COALESCE((SELECT sum(qty) FROM courtesy_credits WHERE customer_id=c.id),0)::int AS granted, ${CORTESIAS_USADAS('c')} AS used
                      FROM customers c WHERE c.id=$1`, [customerId])).rows[0] || { granted: 0, used: 0 };
  return { granted: r.granted, used: r.used, remaining: Math.max(0, r.granted - r.used) };
}

// franquia do cliente no mês de refTs: { club_status, level_name, franchise, used, remaining, month }
async function saldo(t, tz, customerId, refTs = null) {
  const c = (await t(`SELECT c.club_status, lv.name AS level_name, COALESCE(lv.benefit_qty,0) AS franchise
                      FROM customers c LEFT JOIN loyalty_levels lv ON lv.id=c.club_level_id WHERE c.id=$1`, [customerId])).rows[0];
  const ref = refTs || new Date();
  const mes = (await t(`SELECT ${MES('$1::timestamptz', '$2')} AS m`, [ref, tz])).rows[0].m;
  const used = (await t(`SELECT count(*)::int AS n FROM song_orders o JOIN lives l ON l.id=o.live_id
                         WHERE o.customer_id=$1 AND o.kind='franchise' AND NOT o.from_courtesy AND ${MES('l.starts_at', '$2')}=$3`, [customerId, tz, mes])).rows[0].n;
  const ex = await saldoCortesias(t, customerId);
  const member = c?.club_status === 'member';
  const franchise = member ? c.franchise : 0;
  return { club_status: c?.club_status || null, level_name: member ? c.level_name : null, franchise, used, remaining: Math.max(0, franchise - used), month: mes,
    courtesy_remaining: ex.remaining };
}

// { kind, extra }: franquia do mês primeiro; acabando (ou sem franquia), usa o crédito extra; senão é pago
async function decidirTipo(t, tz, customerId, live) {
  const s = await saldo(t, tz, customerId, live.starts_at);
  const ja = (await t('SELECT 1 FROM song_orders WHERE customer_id=$1 AND live_id=$2 LIMIT 1', [customerId, live.id])).rowCount;
  if (s.franchise > 0 && !ja && s.used < s.franchise) return { kind: 'franchise', extra: false };
  if (s.courtesy_remaining > 0) return { kind: 'franchise', extra: true };
  return { kind: 'paid', extra: false };
}

// Trava de música repetida: devolve a live anterior se a música já foi pedida nela (e a trava está ligada)
const NORM = (c) => `translate(lower(btrim(regexp_replace(${c}, '\\s+', ' ', 'g'))), 'áàâãäéèêëíìîïóòôõöúùûüç', 'aaaaaeeeeiiiiooooouuuuc')`;
async function musicaRepetida(t, song, live, ignoraPedido = null) {
  if (!(await t('SELECT block_repeat FROM order_settings WHERE id=1')).rows[0]?.block_repeat) return null;
  const ant = (await t(
    `SELECT l.id, l.title, l.starts_at FROM lives l
      WHERE ($1::bigint IS NULL OR l.starts_at < (SELECT starts_at FROM lives WHERE id=$1))
        AND ($1::bigint IS NULL OR l.id <> $1)
        AND EXISTS (SELECT 1 FROM song_orders o WHERE o.live_id=l.id AND o.id IS DISTINCT FROM $2::bigint)
      ORDER BY l.starts_at DESC, l.id DESC LIMIT 1`, [live?.id || null, ignoraPedido])).rows[0];
  if (!ant) return null;
  const achou = (await t(`SELECT 1 FROM song_orders o WHERE o.live_id=$1 AND o.id IS DISTINCT FROM $3::bigint AND ${NORM('o.song')} = ${NORM('$2::text')} LIMIT 1`, [ant.id, song, ignoraPedido])).rowCount;
  return achou ? ant : null;
}
const MSG_REPETIDA = (song) => `A música "${song}" foi pedida na última live e a regra diz que só pode ser repetida depois de uma live sem ela. Peça outra música, por favor.`;

// pedidos da fila entram na próxima live aberta, na ordem de chegada
async function entrarNaLive(t, tz) {
  const live = await proximaLive(t, tz);
  if (!live) return [];
  const fila = (await t('SELECT id, customer_id, amount_paid, kind FROM song_orders WHERE live_id IS NULL ORDER BY created_at, id')).rows;
  const out = [];
  for (const o of fila) {
    let kind = o.kind, extra = false;
    if (!kind) ({ kind, extra } = await decidirTipo(t, tz, o.customer_id, live));   // modo escolhido na mão vale; senão, automático
    const lv = (await t(`SELECT lv.name FROM customers c LEFT JOIN loyalty_levels lv ON lv.id=c.club_level_id WHERE c.id=$1`, [o.customer_id])).rows[0]?.name || null;
    await t('UPDATE song_orders SET live_id=$2, kind=$3, amount_paid=CASE WHEN $3 IN (\'franchise\',\'courtesy\') THEN 0 ELSE amount_paid END, level_name=$4, from_courtesy=$5 WHERE id=$1', [o.id, live.id, kind, lv, extra]);
    out.push({ id: o.id, kind });
  }
  return out;
}

export async function historicoDoCliente(customerId) {
  const tz = await fuso();
  const orders = (await q(
    `SELECT o.id, o.song, o.dedication, o.kind, o.amount_paid, o.created_at, o.live_id, l.title AS live_title, l.starts_at AS live_starts_at
     FROM song_orders o LEFT JOIN lives l ON l.id=o.live_id WHERE o.customer_id=$1 ORDER BY o.created_at DESC, o.id DESC`, [customerId])).rows;
  const bal = await saldo((s, p) => q(s, p), tz, customerId);
  return { orders, balance: bal };
}

const txt = (v, max) => { const s = String(v ?? '').trim(); return s.length <= max && !/[\u0000-\u0008\u000b-\u001f<>]/.test(s) ? s : null; };
const dataOk = (v) => { const d = new Date(v); return v && !isNaN(d) ? d : null; };
const dinheiro = (v) => { if (v === undefined || v === null || v === '') return null; const n = Number(String(v).replace(',', '.')); return Number.isFinite(n) && n >= 0 && n < 100000 ? Math.round(n * 100) / 100 : NaN; };

export function registerOrderRoutes(r, wrap) {
  const run = async (fn) => { const tz = await fuso(); return tx(currentCompany(), (t) => fn(t, tz)); };

  // ---------- LIVES ----------
  r.get('/lives', wrap(async (req, res) => {
    await tx(currentCompany(), converterCortesias);
    const tz = await fuso();
    const so = req.query.open === '1';
    const { rows } = await q(
      `SELECT l.*, ${ABERTA('$1')} AS open,
              (SELECT count(*)::int FROM song_orders o WHERE o.live_id=l.id) AS orders,
              (SELECT count(*)::int FROM song_orders o WHERE o.live_id=l.id AND o.kind='franchise') AS franchise_count,
              (SELECT count(*)::int FROM song_orders o WHERE o.live_id=l.id AND o.kind='paid') AS paid_count,
              (SELECT count(*)::int FROM song_orders o WHERE o.live_id=l.id AND o.kind='courtesy') AS courtesy_count,
              (SELECT count(*)::int FROM song_orders o WHERE o.live_id=l.id AND o.kind='paid' AND o.amount_paid IS NULL) AS awaiting_count,
              (SELECT COALESCE(sum(o.amount_paid),0)::float FROM song_orders o WHERE o.live_id=l.id AND o.kind='paid') AS received
       FROM lives l WHERE ($2::boolean IS NOT TRUE OR ${ABERTA('$1')}) ORDER BY l.starts_at DESC, l.id DESC LIMIT 200`, [tz, so]);
    res.json(rows);
  }));
  // cria a live (ou atualiza, se vier a mesma identificação externa) e já encaixa quem estava na fila
  r.post('/lives', wrap(async (req, res) => {
    const starts = dataOk(req.body.starts_at);
    const ends = req.body.ends_at ? dataOk(req.body.ends_at) : null;
    const title = txt(req.body.title, 100);
    const ext = req.body.external_id ? txt(req.body.external_id, 100) : null;
    if (!starts) return res.status(400).json({ error: 'Informe a data e a hora da live' });
    if (req.body.ends_at && (!ends || ends <= starts)) return res.status(400).json({ error: 'O fim da live precisa ser depois do começo' });
    if (title === null) return res.status(400).json({ error: 'Título inválido (até 100 letras)' });
    const out = await run(async (t, tz) => {
      let live;
      if (ext) {
        live = (await t(`INSERT INTO lives (title,starts_at,ends_at,external_id) VALUES ($1,$2,$3,$4)
                         ON CONFLICT (external_id) DO UPDATE SET title=EXCLUDED.title, starts_at=EXCLUDED.starts_at, ends_at=EXCLUDED.ends_at
                         RETURNING *, (xmax = 0) AS created`, [title || null, starts, ends, ext])).rows[0];
      } else {
        live = (await t('INSERT INTO lives (title,starts_at,ends_at) VALUES ($1,$2,$3) RETURNING *, true AS created', [title || null, starts, ends])).rows[0];
      }
      return { live, attached: await entrarNaLive(t, tz) };
    });
    res.status(out.live.created ? 201 : 200).json(out);
  }));
  r.put('/lives/:id', wrap(async (req, res) => {
    const b = req.body;
    const starts = b.starts_at === undefined ? null : dataOk(b.starts_at);
    const ends = b.ends_at ? dataOk(b.ends_at) : null;
    const title = b.title === undefined ? null : txt(b.title, 100);
    if (b.starts_at !== undefined && !starts) return res.status(400).json({ error: 'Data e hora inválidas' });
    if (b.ends_at && !ends) return res.status(400).json({ error: 'Fim da live inválido' });
    if (b.title !== undefined && title === null) return res.status(400).json({ error: 'Título inválido (até 100 letras)' });
    const out = await run(async (t, tz) => {
      const live = (await t(`UPDATE lives SET title=CASE WHEN $2::boolean THEN NULLIF($3,'') ELSE title END,
                              starts_at=COALESCE($4,starts_at), ends_at=CASE WHEN $5::boolean THEN $6 ELSE ends_at END
                             WHERE id=$1 RETURNING *`, [req.params.id, b.title !== undefined, title, starts, b.ends_at !== undefined, ends])).rows[0];
      if (!live) return null;
      return { live, attached: await entrarNaLive(t, tz) };
    });
    out ? res.json(out) : res.status(404).json({ error: 'Não encontrado' });
  }));
  r.post('/lives/:id/close', wrap(async (req, res) => {
    const { rows } = await q('UPDATE lives SET closed_at=COALESCE(closed_at, now()) WHERE id=$1 RETURNING *', [req.params.id]);
    rows[0] ? res.json(rows[0]) : res.status(404).json({ error: 'Não encontrado' });
  }));
  r.post('/lives/:id/reopen', wrap(async (req, res) => {
    const out = await run(async (t, tz) => {
      const live = (await t('UPDATE lives SET closed_at=NULL WHERE id=$1 RETURNING *', [req.params.id])).rows[0];
      return live ? { live, attached: await entrarNaLive(t, tz) } : null;
    });
    out ? res.json(out) : res.status(404).json({ error: 'Não encontrado' });
  }));
  r.delete('/lives/:id', wrap(async (req, res) => {
    const l = await q('SELECT id FROM lives WHERE id=$1', [req.params.id]);
    if (!l.rows[0]) return res.status(404).json({ error: 'Não encontrado' });
    const n = (await q('SELECT count(*)::int AS n FROM song_orders WHERE live_id=$1', [req.params.id])).rows[0].n;
    if (n) return res.status(409).json({ error: `Esta live tem ${n} pedido(s). Apague ou mude os pedidos antes.` });
    await q('DELETE FROM lives WHERE id=$1', [req.params.id]);
    res.json({ ok: true });
  }));

  // ---------- PEDIDOS ----------
  // Registra um pedido. O painel decide se é franquia ou pago e se entra numa live ou na fila.
  r.post('/orders', wrap(async (req, res) => {
    const phoneInformado = String(req.body.phone ?? '').trim() !== '';
    const phone = phoneInformado ? normPhone(req.body.phone) : null;
    const song = tituloMusica(txt(req.body.song, 200));
    const dedication = txt(req.body.dedication ?? '', 500);
    const valor = dinheiro(req.body.amount_paid);
    const nome = txt(req.body.name ?? '', 120);
    // modo de pagamento escolhido na anotação manual (vazio = automático: franquia se tiver, senão pago)
    const escolha = String(req.body.kind ?? '');
    if (escolha && !['franchise', 'paid', 'courtesy'].includes(escolha)) return res.status(400).json({ error: 'Modo de pagamento inválido' });
    // telefone é opcional na anotação manual (exceções), mas sem telefone o nome é obrigatório
    if (phoneInformado && phone.length < 12) return res.status(400).json({ error: 'Telefone inválido (use DDD + número)' });
    if (!phoneInformado && !nome) return res.status(400).json({ error: 'Informe o telefone ou, pelo menos, o nome do cliente' });
    if (!song) return res.status(400).json({ error: 'Informe o nome da música' });
    if (dedication === null || nome === null) return res.status(400).json({ error: 'Texto inválido' });
    if (Number.isNaN(valor)) return res.status(400).json({ error: 'Valor inválido' });
    // live escolhida na mão (pode já ter terminado: pedido que ficou sem anotar); vazio = próxima live aberta ou fila
    const liveEscolhida = String(req.body.live_id ?? '').trim();
    if (liveEscolhida && !/^\d+$/.test(liveEscolhida)) return res.status(400).json({ error: 'Live inválida' });
    const out = await run(async (t, tz) => {
      let liveAlvo = null;
      if (liveEscolhida) {
        liveAlvo = (await t('SELECT * FROM lives WHERE id=$1', [liveEscolhida])).rows[0];
        if (!liveAlvo) return { semLive: true };
      }
      // sem telefone: acha o cliente pelo nome (nome ou nome completo, sem diferenciar maiúscula nem espaços sobrando).
      // 1º procura entre os assinantes do clube (é neles que o pedido conta na franquia): um só = usa ele; mais de um = pede o telefone.
      // Sem assinante com esse nome: se o modo for franquia, avisa; senão usa o único cliente com o nome, cria um só com o nome
      // (nenhum) ou pede o telefone (mais de um, sem como saber qual).
      let cli;
      if (phone) {
        cli = (await t(
          `INSERT INTO customers (name,phone,status,source) VALUES (NULLIF($1,''),$2,'lead','ia')
           ON CONFLICT (phone) DO UPDATE SET name=COALESCE(customers.name, NULLIF(EXCLUDED.name,'')) RETURNING id`, [nome || '', phone])).rows[0];
      } else {
        const chave = nome.toLowerCase().replace(/\s+/g, ' ');
        const porNome = (soMembros) => t(
          `SELECT id FROM customers
           WHERE (lower(btrim(regexp_replace(COALESCE(name,''), '\\s+', ' ', 'g'))) = $1
              OR lower(btrim(regexp_replace(concat_ws(' ', name, last_name), '\\s+', ' ', 'g'))) = $1)
             ${soMembros ? "AND club_status='member'" : ''}
           ORDER BY id LIMIT 2`, [chave]).then((x) => x.rows);
        const membros = await porNome(true);
        if (membros.length > 1) return { ambiguo: true };
        if (membros.length === 1) cli = membros[0];
        else {
          if (escolha === 'franchise') return { semMembro: true };
          const todos = await porNome(false);
          if (todos.length > 1) return { ambiguo: true };
          cli = todos[0] || (await t(`INSERT INTO customers (name,phone,status,source) VALUES ($1,NULL,'lead','manual') RETURNING id`, [nome])).rows[0];
        }
      }
      await t('SELECT id FROM customers WHERE id=$1 FOR UPDATE', [cli.id]); // dois pedidos juntos do mesmo cliente não furam a franquia
      const live = liveAlvo || await proximaLive(t, tz);
      let kind = null, level = null, extra = false;
      const rep = await musicaRepetida(t, song, live);
      if (rep) return { repetida: rep };
      if (live) {
        if (escolha) kind = escolha; else ({ kind, extra } = await decidirTipo(t, tz, cli.id, live));
        level = (await t(`SELECT lv.name FROM customers c LEFT JOIN loyalty_levels lv ON lv.id=c.club_level_id WHERE c.id=$1`, [cli.id])).rows[0]?.name || null;
      }
      const o = (await t(
        `INSERT INTO song_orders (customer_id, live_id, song, dedication, amount_paid, kind, level_name, from_courtesy)
         VALUES ($1,$2,$3,NULLIF($4,''),$5,$6,$7,$8) RETURNING *`,
        [cli.id, live?.id || null, song, dedication, kind === 'franchise' || escolha === 'franchise' || escolha === 'courtesy' ? 0 : valor, kind || escolha || null, level, extra])).rows[0];
      // pedido criado já com valor pago: liga ao último recebimento aceito desse cliente com o mesmo valor (se ainda sem pedido)
      if (valor && valor > 0) {
        await t(`UPDATE payments SET order_id=$1 WHERE id = (
                   SELECT id FROM payments WHERE customer_id=$2 AND status='accepted' AND order_id IS NULL AND amount=$3
                     AND created_at > now() - interval '12 hours' ORDER BY id DESC LIMIT 1)`, [o.id, cli.id, valor]);
      }
      await t('SELECT sync_pagamento_pedido($1)', [o.id]);   // pedido pago vira lançamento no Financeiro
      await gravaChave(t, o.id, req.body.pix_key_id);
      await t(`DELETE FROM song_suggestions WHERE lower(btrim(song)) = lower(btrim($1))`, [song]);
      const bal = await saldo(t, tz, cli.id, live?.starts_at || null);
      // 1º pedido sem pagamento de cliente novo: a cortesia sai se o comprovante não chegar no prazo
      const elegivel = !escolha && o.kind !== 'franchise' && !(valor > 0)
        && (await t('SELECT 1 FROM customers WHERE id=$1 AND courtesy_used_at IS NULL AND club_status IS NULL AND source=\'ia\'', [cli.id])).rowCount === 1
        && (await t('SELECT count(*)::int AS n FROM song_orders WHERE customer_id=$1', [cli.id])).rows[0].n === 1;
      return { order: o, live, balance: bal, elegivel };
    });
    if (out.semLive) return res.status(404).json({ error: 'Live não encontrada' });
    if (out.semMembro) return res.status(409).json({ error: 'Não achei assinante do clube com esse nome para usar a franquia. Informe o telefone ou escolha cortesia ou pago.' });
    if (out.ambiguo) return res.status(409).json({ error: 'Há mais de um cliente com esse nome. Informe o telefone para eu saber qual é.' });
    if (out.repetida) return res.status(409).json({ error: MSG_REPETIDA(song), code: 'song_repeated', last_live: { id: out.repetida.id, title: out.repetida.title, starts_at: out.repetida.starts_at } });
    res.status(201).json({
      id: out.order.id,
      from_courtesy: out.order.from_courtesy,      // true = saiu pelo saldo de cortesias do cliente
      status: out.live ? 'confirmed' : 'queued',   // queued = anotado para a próxima live, data a confirmar
      kind: out.order.kind,                        // franchise (sem cobrança) | paid (cobrar) | null (na fila)
      live: out.live ? { id: out.live.id, title: out.live.title, starts_at: out.live.starts_at } : null,
      balance: out.balance,
      courtesy_in_minutes: out.elegivel ? CORTESIA_MIN : null,   // preenchido = 1º pedido: sem comprovante nesse prazo vira cortesia
    });
  }));
  // Saldo de franquia e situação do cliente (a agente usa para responder "quantos pedidos eu ainda tenho?")
  // Assinatura do que a tela de Pedidos mostra: muda quando entra, sai ou é editado um pedido/live.
  // A tela pergunta isso de tempos em tempos e só recarrega as listas quando a assinatura muda.
  r.get('/orders/changes', wrap(async (req, res) => {
    await tx(currentCompany(), converterCortesias);
    const o = (await q(`SELECT count(*)::int AS n, COALESCE(md5(string_agg(concat_ws('|', id, live_id, song, dedication, kind, amount_paid, served_at), ';' ORDER BY id)), '') AS h FROM song_orders`)).rows[0];
    const l = (await q(`SELECT count(*)::int AS n, COALESCE(md5(string_agg(concat_ws('|', id, title, starts_at, ends_at, closed_at), ';' ORDER BY id)), '') AS h FROM lives`)).rows[0];
    res.json({ sig: `${o.n}:${o.h}:${l.n}:${l.h}` });
  }));
  r.get('/orders/balance', wrap(async (req, res) => {
    await tx(currentCompany(), converterCortesias);
    const phone = normPhone(req.query.phone);
    const tz = await fuso();
    const c = (await q('SELECT id, name, last_name FROM customers WHERE phone=$1', [phone])).rows[0];
    const live = await proximaLive((s, p) => q(s, p), tz);
    const out = { found: !!c, name: c?.name || null, last_name: c?.last_name || null, next_live: live ? { id: live.id, title: live.title, starts_at: live.starts_at } : null,
      queued: c ? (await q('SELECT count(*)::int AS n FROM song_orders WHERE customer_id=$1 AND live_id IS NULL', [c.id])).rows[0].n : 0 };
    if (c) Object.assign(out, await saldo((s, p) => q(s, p), tz, c.id, live?.starts_at || null));
    res.json(out);
  }));
  r.get('/orders/summary', wrap(async (req, res) => {
    await tx(currentCompany(), converterCortesias);
    const tz = await fuso();
    const mes = /^\d{4}-(0[1-9]|1[0-2])$/.test(String(req.query.month || '')) ? req.query.month : (await q(`SELECT ${MES('now()', '$1')} AS m`, [tz])).rows[0].m;
    const { rows } = await q(
      `SELECT c.id AS customer_id, c.name, c.last_name, c.phone, c.club_status, lv.name AS level_name,
              CASE WHEN c.club_status='member' THEN COALESCE(lv.benefit_qty,0) ELSE 0 END AS franchise,
              count(*) FILTER (WHERE o.kind='franchise' AND NOT o.from_courtesy)::int AS used,
              count(*) FILTER (WHERE o.from_courtesy)::int AS courtesy_used,
              count(*) FILTER (WHERE o.kind='paid')::int AS paid_count,
              count(*) FILTER (WHERE o.kind='courtesy')::int AS courtesy_count,
              COALESCE(sum(o.amount_paid) FILTER (WHERE o.kind='paid'),0)::float AS paid_total,
              count(*)::int AS total
       FROM song_orders o JOIN lives l ON l.id=o.live_id JOIN customers c ON c.id=o.customer_id
       LEFT JOIN loyalty_levels lv ON lv.id=c.club_level_id
       WHERE ${MES('l.starts_at', '$1')}=$2
       GROUP BY c.id, lv.name, lv.benefit_qty ORDER BY lower(COALESCE(c.name,'')), c.id`, [tz, mes]);
    res.json({ month: mes, rows: rows.map((x) => ({ ...x, remaining: Math.max(0, x.franchise - x.used) })),
      totals: { orders: rows.reduce((s, x) => s + x.total, 0), franchise: rows.reduce((s, x) => s + x.used, 0), courtesy: rows.reduce((s, x) => s + x.courtesy_used, 0), paid: rows.reduce((s, x) => s + x.paid_count, 0), paid_total: Math.round(rows.reduce((s, x) => s + x.paid_total, 0) * 100) / 100 } });
  }));
  r.get('/orders', wrap(async (req, res) => {
    await tx(currentCompany(), converterCortesias);
    // ?phone=: pedidos do cliente na próxima live e na fila (a agente usa para conferir e para trocar música/dedicatória)
    if (req.query.phone) {
      const phone = normPhone(req.query.phone);
      const tz = await fuso();
      const live = await proximaLive((s, p) => q(s, p), tz);
      const { rows } = await q(
        `SELECT o.id, o.song, o.dedication, o.kind, o.amount_paid, o.live_id, o.created_at, (o.live_id IS NULL) AS in_queue
         FROM song_orders o JOIN customers c ON c.id=o.customer_id
         WHERE c.phone=$1 AND (o.live_id IS NULL OR o.live_id=$2::bigint) ORDER BY o.created_at, o.id`, [phone, live?.id || null]);
      return res.json({ next_live: live ? { id: live.id, title: live.title, starts_at: live.starts_at } : null, orders: rows });
    }
    const fila = req.query.queue === '1';
    const live = /^\d+$/.test(String(req.query.live_id || '')) ? req.query.live_id : null;
    const { rows } = await q(
      `SELECT o.*, c.name AS customer_name, c.last_name AS customer_last_name, c.phone AS customer_phone, c.club_status
       FROM song_orders o JOIN customers c ON c.id=o.customer_id
       WHERE (($1::boolean AND o.live_id IS NULL) OR (NOT $1::boolean AND $2::bigint IS NOT NULL AND o.live_id=$2))
       ORDER BY (o.served_at IS NOT NULL), o.created_at, o.id`, [fila, live]);
    res.json(rows);
  }));
  // ---------- AJUSTES DE PEDIDOS ----------
  r.get('/orders/config', wrap(async (req, res) => {
    res.json({ block_repeat: !!(await q('SELECT block_repeat FROM order_settings WHERE id=1')).rows[0]?.block_repeat });
  }));
  r.put('/orders/config', wrap(async (req, res) => {
    if (typeof req.body?.block_repeat !== 'boolean') return res.status(400).json({ error: 'Valor inválido' });
    await q('UPDATE order_settings SET block_repeat=$1 WHERE id=1', [req.body.block_repeat]);
    res.json({ block_repeat: req.body.block_repeat });
  }));

  // ---------- CRÉDITO EXTRA ----------
  // Pedidos grátis dados à mão (além da franquia). Usados depois da franquia do mês; cada pedido gasto é contado nos próprios pedidos.
  const listaCreditos = () => q(
    `SELECT c.id AS customer_id, c.name, c.last_name, c.phone, g.granted,
            ${CORTESIAS_USADAS('c')} AS used
       FROM (SELECT customer_id, sum(qty)::int AS granted FROM courtesy_credits GROUP BY customer_id) g
       JOIN customers c ON c.id=g.customer_id ORDER BY lower(COALESCE(c.name,'')), c.id`).then((x) => x.rows.map((y) => ({ ...y, remaining: Math.max(0, y.granted - y.used) })));
  r.get('/courtesies', wrap(async (req, res) => { res.json(await listaCreditos()); }));
  // soma (ou, com número negativo, tira) crédito de um cliente, achado pelo telefone ou pelo nome
  r.post('/courtesies', wrap(async (req, res) => {
    const qty = Number(req.body?.qty);
    const note = txt(req.body?.note ?? '', 200);
    if (!Number.isInteger(qty) || qty === 0 || Math.abs(qty) > 100) return res.status(400).json({ error: 'Informe a quantidade (de 1 a 100)' });
    if (note === null) return res.status(400).json({ error: 'Texto inválido' });
    let cli;
    if (/^\d+$/.test(String(req.body?.customer_id ?? ''))) cli = (await q('SELECT id FROM customers WHERE id=$1', [req.body.customer_id])).rows[0];
    else if (String(req.body?.phone ?? '').trim()) {
      const phone = normPhone(req.body.phone);
      if (phone.length < 12) return res.status(400).json({ error: 'Telefone inválido (use DDD + número)' });
      cli = (await q('SELECT id FROM customers WHERE phone=$1', [phone])).rows[0];
    } else {
      const nome = txt(req.body?.name ?? '', 120);
      if (!nome) return res.status(400).json({ error: 'Informe o telefone ou o nome do cliente' });
      const achados = (await q(`SELECT id FROM customers WHERE lower(btrim(regexp_replace(concat_ws(' ', name, last_name), '\\s+', ' ', 'g'))) = lower(btrim(regexp_replace($1, '\\s+', ' ', 'g')))
                                   OR lower(btrim(regexp_replace(COALESCE(name,''), '\\s+', ' ', 'g'))) = lower(btrim(regexp_replace($1, '\\s+', ' ', 'g'))) ORDER BY id LIMIT 2`, [nome])).rows;
      if (achados.length > 1) return res.status(409).json({ error: 'Há mais de um cliente com esse nome. Informe o telefone.' });
      cli = achados[0];
    }
    if (!cli) return res.status(404).json({ error: 'Cliente não encontrado' });
    const out = await run(async (t, tz) => {
      await t('SELECT id FROM customers WHERE id=$1 FOR UPDATE', [cli.id]);
      const atual = await saldo(t, tz, cli.id);
      const granted = (await t('SELECT COALESCE(sum(qty),0)::int AS n FROM courtesy_credits WHERE customer_id=$1', [cli.id])).rows[0].n;
      if (granted + qty < 0) return { baixo: true };
      await t('INSERT INTO courtesy_credits (customer_id, qty, note) VALUES ($1,$2,NULLIF($3,\'\'))', [cli.id, qty, note]);
      return { courtesy_remaining: (await saldo(t, tz, cli.id)).courtesy_remaining };
    });
    if (out.baixo) return res.status(409).json({ error: 'O cliente não tem tanto crédito para tirar' });
    res.status(201).json({ ok: true, customer_id: cli.id, ...out });
  }));
  r.delete('/courtesies/:customerId', wrap(async (req, res) => {
    await q('DELETE FROM courtesy_credits WHERE customer_id=$1', [req.params.customerId]);
    res.json({ ok: true });
  }));

  r.put('/orders/:id', wrap(async (req, res) => {
    const b = req.body;
    const song = b.song === undefined ? null : tituloMusica(txt(b.song, 200));
    const ded = b.dedication === undefined ? null : txt(b.dedication, 500);
    const valor = dinheiro(b.amount_paid);
    if (b.song !== undefined && !song) return res.status(400).json({ error: 'Informe o nome da música' });
    if (b.dedication !== undefined && ded === null) return res.status(400).json({ error: 'Texto inválido' });
    if (Number.isNaN(valor)) return res.status(400).json({ error: 'Valor inválido' });
    if (b.kind !== undefined && !['franchise', 'paid', 'courtesy'].includes(b.kind)) return res.status(400).json({ error: 'Cobrança inválida' });
    // atribuir o pedido a uma live (inclusive uma que já terminou): quem estava na fila ganha a cobrança dessa live
    const novaLive = String(b.live_id ?? '').trim();
    if (novaLive) {
      if (!/^\d+$/.test(novaLive)) return res.status(400).json({ error: 'Live inválida' });
      const mv = await run(async (t, tz) => {
        const lv = (await t('SELECT * FROM lives WHERE id=$1', [novaLive])).rows[0];
        if (!lv) return { semLive: true };
        const cur = (await t('SELECT * FROM song_orders WHERE id=$1 FOR UPDATE', [req.params.id])).rows[0];
        if (!cur) return { semPedido: true };
        await t('SELECT id FROM customers WHERE id=$1 FOR UPDATE', [cur.customer_id]);
        const rep = await musicaRepetida(t, song || cur.song, lv, cur.id);
        if (rep) return { repetida: rep };
        let kind = b.kind || cur.kind, extra = !b.kind && !!cur.from_courtesy;
        if (!kind) ({ kind, extra } = await decidirTipo(t, tz, cur.customer_id, lv));
        const level = (await t(`SELECT lv.name FROM customers c LEFT JOIN loyalty_levels lv ON lv.id=c.club_level_id WHERE c.id=$1`, [cur.customer_id])).rows[0]?.name || null;
        await t(`UPDATE song_orders SET live_id=$2, kind=$3, level_name=$4, from_courtesy=$5,
                   amount_paid=CASE WHEN $3 IN ('franchise','courtesy') THEN 0 ELSE amount_paid END WHERE id=$1`, [cur.id, lv.id, kind, level, extra && kind === 'franchise']);
        return { kind };
      });
      if (mv.semLive) return res.status(404).json({ error: 'Live não encontrada' });
      if (mv.semPedido) return res.status(404).json({ error: 'Não encontrado' });
      if (mv.repetida) return res.status(409).json({ error: MSG_REPETIDA(song || 'essa música'), code: 'song_repeated' });
      if (!b.kind) b.kind = mv.kind;   // a cobrança definida pela live vale também na gravação abaixo
    }
    const atual = (await q('SELECT live_id, song FROM song_orders WHERE id=$1', [req.params.id])).rows[0];
    if (!atual) return res.status(404).json({ error: 'Não encontrado' });
    if (song && song !== atual.song) {
      const rep = await run(async (t) => musicaRepetida(t, song, atual.live_id ? (await t('SELECT * FROM lives WHERE id=$1', [atual.live_id])).rows[0] : null, req.params.id));
      if (rep) return res.status(409).json({ error: MSG_REPETIDA(song), code: 'song_repeated' });
    }
    if (b.kind !== undefined && !atual.live_id) return res.status(400).json({ error: 'Pedido na fila ainda não tem cobrança: ela é definida quando a live for marcada' });
    const { rows } = await q(
      `UPDATE song_orders SET song=COALESCE($2,song), dedication=CASE WHEN $3::boolean THEN NULLIF($4,'') ELSE dedication END,
         kind=COALESCE($5::text,kind),
         from_courtesy=CASE WHEN $5::text IS NOT NULL AND $5::text <> 'franchise' THEN false ELSE from_courtesy END,
         amount_paid=CASE WHEN $5::text IN ('franchise','courtesy') THEN 0 WHEN $6::boolean THEN $7 ELSE amount_paid END,
         served_at=CASE WHEN $8::boolean THEN (CASE WHEN $9::boolean THEN COALESCE(served_at, now()) ELSE NULL END) ELSE served_at END
       WHERE id=$1 RETURNING *`, [req.params.id, song, b.dedication !== undefined, ded, b.kind ?? null, b.amount_paid !== undefined, valor, b.served !== undefined, b.served === true]);
    await run(async (t) => { await t('SELECT sync_pagamento_pedido($1)', [req.params.id]); await gravaChave(t, req.params.id, b.pix_key_id); });   // mantém o Financeiro igual ao pedido
    res.json(rows[0]);
  }));
  // marca de uma vez todos os pedidos ainda não atendidos de uma live
  r.post('/orders/serve-all', wrap(async (req, res) => {
    const live = String(req.body?.live_id ?? '');
    if (!/^\d+$/.test(live)) return res.status(400).json({ error: 'Live inválida' });
    const n = (await q('UPDATE song_orders SET served_at=now() WHERE live_id=$1 AND served_at IS NULL', [live])).rowCount;
    res.json({ updated: n });
  }));
  // ---------- SUGESTÕES DA LIVE ----------
  // Lista do dia que o apresentador cadastra; a agente oferece uma a uma. Escolhida vira pedido e sai da lista.
  r.get('/suggestions', wrap(async (req, res) => {
    res.json((await q('SELECT id, song, offered FROM song_suggestions ORDER BY id')).rows);
  }));
  // acrescenta música(s) à lista: uma por vez (song) ou várias coladas (text, uma por linha). Nada é apagado; a música só sai quando é pedida.
  r.post('/suggestions', wrap(async (req, res) => {
    const itens = req.body?.song !== undefined ? [req.body.song] : String(req.body?.text ?? '').split('\n');
    const songs = [...new Set(itens.map((x) => tituloMusica(txt(String(x ?? ''), 200))).filter(Boolean))];
    if (!songs.length) return res.status(400).json({ error: 'Digite o nome da música' });
    let added = 0;
    await run(async (t) => {
      const total = (await t('SELECT count(*)::int AS n FROM song_suggestions')).rows[0].n;
      for (const sg of songs) {
        if (total + added >= 500) break;
        if ((await t('SELECT 1 FROM song_suggestions WHERE lower(btrim(song)) = lower(btrim($1))', [sg])).rowCount) continue;
        await t('INSERT INTO song_suggestions (song) VALUES ($1)', [sg]); added++;
      }
    });
    if (!added) return res.status(409).json({ error: songs.length > 1 ? 'Essas músicas já estão na lista' : 'Esta música já está na lista' });
    res.status(201).json({ added, list: (await q('SELECT id, song, offered FROM song_suggestions ORDER BY id')).rows });
  }));
  r.post('/suggestions/bulk-delete', wrap(async (req, res) => {
    const ids = [...new Set((Array.isArray(req.body?.ids) ? req.body.ids : []).map(Number).filter((n) => Number.isInteger(n) && n > 0))].slice(0, 2000);
    if (!ids.length) return res.status(400).json({ error: 'Nenhum item selecionado' });
    if (req.body.dry_run === true) return res.json({ found: (await q('SELECT count(*)::int AS n FROM song_suggestions WHERE id = ANY($1::bigint[])', [ids])).rows[0].n });
    res.json({ deleted: (await q('DELETE FROM song_suggestions WHERE id = ANY($1::bigint[])', [ids])).rowCount });
  }));
  r.delete('/suggestions/:id', wrap(async (req, res) => {
    const { rowCount } = await q('DELETE FROM song_suggestions WHERE id=$1', [req.params.id]);
    rowCount ? res.json({ ok: true }) : res.status(404).json({ error: 'Não encontrado' });
  }));
  // próxima sugestão a oferecer: a menos oferecida até agora (assim a agente passa por todas, uma a uma)
  r.get('/suggestions/next', wrap(async (req, res) => {
    const { rows } = await q(
      `UPDATE song_suggestions SET offered=offered+1 WHERE id = (SELECT id FROM song_suggestions ORDER BY offered, id LIMIT 1)
       RETURNING id, song`);
    const left = (await q('SELECT count(*)::int AS n FROM song_suggestions')).rows[0].n;
    res.json({ suggestion: rows[0] || null, remaining: left });
  }));
  r.post('/orders/bulk-delete', wrap(async (req, res) => {
    const ids = [...new Set((Array.isArray(req.body?.ids) ? req.body.ids : []).map(Number).filter((n) => Number.isInteger(n) && n > 0))].slice(0, 2000);
    if (!ids.length) return res.status(400).json({ error: 'Nenhum item selecionado' });
    if (req.body.dry_run === true) return res.json({ found: (await q('SELECT count(*)::int AS n FROM song_orders WHERE id = ANY($1::bigint[])', [ids])).rows[0].n });
    res.json({ deleted: (await q('DELETE FROM song_orders WHERE id = ANY($1::bigint[])', [ids])).rowCount });
  }));
  r.post('/lives/bulk-delete', wrap(async (req, res) => {
    const ids = [...new Set((Array.isArray(req.body?.ids) ? req.body.ids : []).map(Number).filter((n) => Number.isInteger(n) && n > 0))].slice(0, 2000);
    if (!ids.length) return res.status(400).json({ error: 'Nenhum item selecionado' });
    const rows = (await q(`SELECT l.id, l.title, (SELECT count(*)::int FROM song_orders o WHERE o.live_id=l.id) AS orders FROM lives l WHERE l.id = ANY($1::bigint[])`, [ids])).rows;
    const livres = rows.filter((x) => x.orders === 0);
    if (req.body.dry_run === true) return res.json({ found: rows.length, com_pedidos: rows.length - livres.length });
    const deleted = livres.length ? (await q('DELETE FROM lives WHERE id = ANY($1::bigint[])', [livres.map((x) => x.id)])).rowCount : 0;
    res.json({ deleted, skipped: rows.filter((x) => x.orders > 0).map((x) => ({ id: x.id, name: x.title, motivo: 'tem pedidos' })) });
  }));
  r.delete('/orders/:id', wrap(async (req, res) => {
    const { rowCount } = await q('DELETE FROM song_orders WHERE id=$1', [req.params.id]);
    rowCount ? res.json({ ok: true }) : res.status(404).json({ error: 'Não encontrado' });
  }));
}
