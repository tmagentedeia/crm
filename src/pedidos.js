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

const ABERTA = (p) => `(l.closed_at IS NULL AND COALESCE(l.ends_at, ((date_trunc('day', l.starts_at AT TIME ZONE ${p}) + interval '1 day') AT TIME ZONE ${p})) > now())`;
const MES = (col, p) => `to_char(${col} AT TIME ZONE ${p}, 'YYYY-MM')`;

async function fuso() {
  return (await qg('SELECT timezone FROM companies WHERE id=$1', [currentCompany()])).rows[0]?.timezone || 'America/Sao_Paulo';
}
const proximaLive = async (t, tz) =>
  (await t(`SELECT l.* FROM lives l WHERE ${ABERTA('$1')} ORDER BY l.starts_at, l.id LIMIT 1`, [tz])).rows[0] || null;

// franquia do cliente no mês de refTs: { club_status, level_name, franchise, used, remaining, month }
async function saldo(t, tz, customerId, refTs = null) {
  const c = (await t(`SELECT c.club_status, lv.name AS level_name, COALESCE(lv.benefit_qty,0) AS franchise
                      FROM customers c LEFT JOIN loyalty_levels lv ON lv.id=c.club_level_id WHERE c.id=$1`, [customerId])).rows[0];
  const ref = refTs || new Date();
  const mes = (await t(`SELECT ${MES('$1::timestamptz', '$2')} AS m`, [ref, tz])).rows[0].m;
  const used = (await t(`SELECT count(*)::int AS n FROM song_orders o JOIN lives l ON l.id=o.live_id
                         WHERE o.customer_id=$1 AND o.kind='franchise' AND ${MES('l.starts_at', '$2')}=$3`, [customerId, tz, mes])).rows[0].n;
  const member = c?.club_status === 'member';
  const franchise = member ? c.franchise : 0;
  return { club_status: c?.club_status || null, level_name: member ? c.level_name : null, franchise, used, remaining: Math.max(0, franchise - used), month: mes };
}

async function decidirTipo(t, tz, customerId, live) {
  const s = await saldo(t, tz, customerId, live.starts_at);
  if (!(s.franchise > 0)) return 'paid';
  const ja = (await t('SELECT 1 FROM song_orders WHERE customer_id=$1 AND live_id=$2 LIMIT 1', [customerId, live.id])).rowCount;
  if (ja) return 'paid';
  return s.used < s.franchise ? 'franchise' : 'paid';
}

// pedidos da fila entram na próxima live aberta, na ordem de chegada
async function entrarNaLive(t, tz) {
  const live = await proximaLive(t, tz);
  if (!live) return [];
  const fila = (await t('SELECT id, customer_id, amount_paid, kind FROM song_orders WHERE live_id IS NULL ORDER BY created_at, id')).rows;
  const out = [];
  for (const o of fila) {
    const kind = o.kind || await decidirTipo(t, tz, o.customer_id, live);   // modo escolhido na mão vale; senão, automático
    const lv = (await t(`SELECT lv.name FROM customers c LEFT JOIN loyalty_levels lv ON lv.id=c.club_level_id WHERE c.id=$1`, [o.customer_id])).rows[0]?.name || null;
    await t('UPDATE song_orders SET live_id=$2, kind=$3, amount_paid=CASE WHEN $3 IN (\'franchise\',\'courtesy\') THEN 0 ELSE amount_paid END, level_name=$4 WHERE id=$1', [o.id, live.id, kind, lv]);
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
    const song = txt(req.body.song, 200);
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
      let kind = null, level = null;
      if (live) {
        kind = escolha || await decidirTipo(t, tz, cli.id, live);
        level = (await t(`SELECT lv.name FROM customers c LEFT JOIN loyalty_levels lv ON lv.id=c.club_level_id WHERE c.id=$1`, [cli.id])).rows[0]?.name || null;
      }
      const o = (await t(
        `INSERT INTO song_orders (customer_id, live_id, song, dedication, amount_paid, kind, level_name)
         VALUES ($1,$2,$3,NULLIF($4,''),$5,$6,$7) RETURNING *`,
        [cli.id, live?.id || null, song, dedication, kind === 'franchise' || escolha === 'franchise' || escolha === 'courtesy' ? 0 : valor, kind || escolha || null, level])).rows[0];
      // pedido criado já com valor pago: liga ao último recebimento aceito desse cliente com o mesmo valor (se ainda sem pedido)
      if (valor && valor > 0) {
        await t(`UPDATE payments SET order_id=$1 WHERE id = (
                   SELECT id FROM payments WHERE customer_id=$2 AND status='accepted' AND order_id IS NULL AND amount=$3
                     AND created_at > now() - interval '12 hours' ORDER BY id DESC LIMIT 1)`, [o.id, cli.id, valor]);
      }
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
    res.status(201).json({
      id: out.order.id,
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
              count(*) FILTER (WHERE o.kind='franchise')::int AS used,
              count(*) FILTER (WHERE o.kind='paid')::int AS paid_count,
              count(*) FILTER (WHERE o.kind='courtesy')::int AS courtesy_count,
              COALESCE(sum(o.amount_paid) FILTER (WHERE o.kind='paid'),0)::float AS paid_total,
              count(*)::int AS total
       FROM song_orders o JOIN lives l ON l.id=o.live_id JOIN customers c ON c.id=o.customer_id
       LEFT JOIN loyalty_levels lv ON lv.id=c.club_level_id
       WHERE ${MES('l.starts_at', '$1')}=$2
       GROUP BY c.id, lv.name, lv.benefit_qty ORDER BY lower(COALESCE(c.name,'')), c.id`, [tz, mes]);
    res.json({ month: mes, rows: rows.map((x) => ({ ...x, remaining: Math.max(0, x.franchise - x.used) })),
      totals: { orders: rows.reduce((s, x) => s + x.total, 0), franchise: rows.reduce((s, x) => s + x.used, 0), paid: rows.reduce((s, x) => s + x.paid_count, 0), paid_total: Math.round(rows.reduce((s, x) => s + x.paid_total, 0) * 100) / 100 } });
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
  r.put('/orders/:id', wrap(async (req, res) => {
    const b = req.body;
    const song = b.song === undefined ? null : txt(b.song, 200);
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
        const kind = b.kind || cur.kind || await decidirTipo(t, tz, cur.customer_id, lv);
        const level = (await t(`SELECT lv.name FROM customers c LEFT JOIN loyalty_levels lv ON lv.id=c.club_level_id WHERE c.id=$1`, [cur.customer_id])).rows[0]?.name || null;
        await t(`UPDATE song_orders SET live_id=$2, kind=$3, level_name=$4,
                   amount_paid=CASE WHEN $3 IN ('franchise','courtesy') THEN 0 ELSE amount_paid END WHERE id=$1`, [cur.id, lv.id, kind, level]);
        return { kind };
      });
      if (mv.semLive) return res.status(404).json({ error: 'Live não encontrada' });
      if (mv.semPedido) return res.status(404).json({ error: 'Não encontrado' });
      if (!b.kind) b.kind = mv.kind;   // a cobrança definida pela live vale também na gravação abaixo
    }
    const atual = (await q('SELECT live_id FROM song_orders WHERE id=$1', [req.params.id])).rows[0];
    if (!atual) return res.status(404).json({ error: 'Não encontrado' });
    if (b.kind !== undefined && !atual.live_id) return res.status(400).json({ error: 'Pedido na fila ainda não tem cobrança: ela é definida quando a live for marcada' });
    const { rows } = await q(
      `UPDATE song_orders SET song=COALESCE($2,song), dedication=CASE WHEN $3::boolean THEN NULLIF($4,'') ELSE dedication END,
         kind=COALESCE($5::text,kind),
         amount_paid=CASE WHEN $5::text IN ('franchise','courtesy') THEN 0 WHEN $6::boolean THEN $7 ELSE amount_paid END,
         served_at=CASE WHEN $8::boolean THEN (CASE WHEN $9::boolean THEN COALESCE(served_at, now()) ELSE NULL END) ELSE served_at END
       WHERE id=$1 RETURNING *`, [req.params.id, song, b.dedication !== undefined, ded, b.kind ?? null, b.amount_paid !== undefined, valor, b.served !== undefined, b.served === true]);
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
  // troca a lista inteira (uma música por linha) — a cada live o apresentador cola a nova
  r.put('/suggestions', wrap(async (req, res) => {
    const itens = Array.isArray(req.body?.songs) ? req.body.songs : String(req.body?.text ?? '').split('\n');
    const songs = [...new Set(itens.map((x) => txt(String(x ?? ''), 200)).filter(Boolean))].slice(0, 300);
    await run(async (t) => {
      await t('DELETE FROM song_suggestions');
      for (const s of songs) await t('INSERT INTO song_suggestions (song) VALUES ($1)', [s]);
    });
    res.json((await q('SELECT id, song, offered FROM song_suggestions ORDER BY id')).rows);
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
