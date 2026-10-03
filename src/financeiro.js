// Financeiro: chaves Pix que valem para a conferência e o registro/baixa dos comprovantes recebidos.
// O atendente só manda o que leu do comprovante; as regras ficam aqui (não no prompt).
import { q, qg, tx, currentCompany } from './db.js';
import { normPhone } from './phone.js';

export const FINANCEIRO_SQL = `
  CREATE TABLE IF NOT EXISTS pix_keys (
    id          BIGSERIAL PRIMARY KEY,
    key         TEXT NOT NULL,
    key_type    TEXT NOT NULL CHECK (key_type IN ('email','phone','cpf','cnpj','random')),
    key_norm    TEXT NOT NULL UNIQUE,          -- forma comparável (sem pontuação)
    beneficiary TEXT,                          -- quem recebe nessa chave
    note        TEXT,
    active      BOOLEAN NOT NULL DEFAULT true, -- desativar não apaga: dá para reativar
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
  );
  CREATE TABLE IF NOT EXISTS finance_settings (
    id            SMALLINT PRIMARY KEY CHECK (id = 1),
    max_age_hours INT NOT NULL DEFAULT 24,     -- comprovante mais velho que isso é recusado
    min_amount    NUMERIC(10,2)                -- valor mínimo aceito (vazio = qualquer valor)
  );
  INSERT INTO finance_settings (id) VALUES (1) ON CONFLICT DO NOTHING;
  CREATE TABLE IF NOT EXISTS payments (
    id          BIGSERIAL PRIMARY KEY,
    txid        TEXT,                          -- ID da transação do comprovante
    payer_name  TEXT,
    amount      NUMERIC(10,2) NOT NULL,
    key_text    TEXT,                          -- chave que aparece no comprovante
    pix_key_id  BIGINT REFERENCES pix_keys(id) ON DELETE SET NULL,
    paid_at     TIMESTAMPTZ,
    purpose     TEXT,
    customer_id BIGINT REFERENCES customers(id) ON DELETE SET NULL,
    order_id    BIGINT REFERENCES song_orders(id) ON DELETE SET NULL,
    status      TEXT NOT NULL CHECK (status IN ('accepted','duplicate','old','wrong_key','low_amount','review','rejected')),
    reason      TEXT,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
  );
  CREATE INDEX IF NOT EXISTS idx_payments_txid ON payments (txid);
  CREATE INDEX IF NOT EXISTS idx_payments_created ON payments (created_at);`;

// Todo valor recebido passa por aqui: comprovantes Pix e pedidos pagos lançados no painel (coluna "source").
// sync_pagamento_pedido garante UM lançamento por pedido pago, sem contar em dobro quando já existe comprovante aceito ligado ao pedido.
export const FINANCEIRO_FUNCS_SQL = `
  ALTER TABLE payments ADD COLUMN IF NOT EXISTS category TEXT NOT NULL DEFAULT 'contribuicao';
  CREATE OR REPLACE FUNCTION sync_pagamento_pedido(oid BIGINT) RETURNS void AS $f$
  DECLARE o song_orders%ROWTYPE; cand BIGINT;
  BEGIN
    SELECT * INTO o FROM song_orders WHERE id = oid;
    IF NOT FOUND OR o.kind IS DISTINCT FROM 'paid' OR COALESCE(o.amount_paid, 0) <= 0
       OR EXISTS (SELECT 1 FROM payments WHERE order_id = oid AND source <> 'pedido' AND status = 'accepted') THEN
      DELETE FROM payments WHERE order_id = oid AND source = 'pedido';
      RETURN;
    END IF;
    -- já existe um comprovante aceito, ainda sem pedido, do mesmo cliente e valor: ele é o lançamento deste pedido
    SELECT id INTO cand FROM payments
     WHERE source <> 'pedido' AND status = 'accepted' AND order_id IS NULL AND amount = o.amount_paid
       AND (customer_id = o.customer_id
            OR (customer_id IS NULL AND created_at BETWEEN o.created_at - interval '1 day' AND o.created_at + interval '1 day'))
     ORDER BY (customer_id IS NULL), id DESC LIMIT 1;
    IF cand IS NOT NULL THEN
      UPDATE payments SET order_id = oid, category = 'pedido', customer_id = COALESCE(customer_id, o.customer_id) WHERE id = cand;
      DELETE FROM payments WHERE order_id = oid AND source = 'pedido';
      RETURN;
    END IF;
    IF EXISTS (SELECT 1 FROM payments WHERE order_id = oid AND source = 'pedido') THEN
      UPDATE payments SET amount = o.amount_paid, customer_id = o.customer_id, status = 'accepted', reason = NULL
       WHERE order_id = oid AND source = 'pedido';
    ELSE
      -- a chave Pix só entra quando há comprovante conferido (ou quando o responsável a indicar na edição)
      INSERT INTO payments (payer_name, amount, paid_at, purpose, customer_id, order_id, status, source, category, created_at)
      SELECT NULLIF(btrim(concat_ws(' ', c.name, c.last_name)), ''), o.amount_paid, o.created_at, 'Pedido: ' || o.song, o.customer_id, o.id, 'accepted', 'pedido', 'pedido', o.created_at
        FROM customers c WHERE c.id = o.customer_id;
    END IF;
  END $f$ LANGUAGE plpgsql;
  -- comprovante aceito depois do pedido já lançado: vira o lançamento do pedido (sem contar em dobro)
  CREATE OR REPLACE FUNCTION casar_comprovante(pid BIGINT) RETURNS BIGINT AS $f$
  DECLARE p payments%ROWTYPE; oid BIGINT;
  BEGIN
    SELECT * INTO p FROM payments WHERE id = pid;
    IF NOT FOUND OR p.source = 'pedido' OR p.status <> 'accepted' OR p.order_id IS NOT NULL THEN RETURN NULL; END IF;
    SELECT pp.order_id INTO oid FROM payments pp
     WHERE pp.source = 'pedido' AND pp.amount = p.amount
       AND (pp.customer_id = p.customer_id OR (p.customer_id IS NULL AND pp.created_at > now() - interval '2 days'))
     ORDER BY (pp.customer_id IS DISTINCT FROM p.customer_id), pp.id DESC LIMIT 1;
    IF oid IS NULL THEN RETURN NULL; END IF;
    UPDATE payments SET order_id = oid, category = 'pedido', customer_id = COALESCE(customer_id, (SELECT customer_id FROM song_orders WHERE id = oid)) WHERE id = pid;
    DELETE FROM payments WHERE order_id = oid AND source = 'pedido';
    RETURN oid;
  END $f$ LANGUAGE plpgsql;
  CREATE OR REPLACE FUNCTION trg_pedido_apagado() RETURNS trigger AS $f$
  BEGIN
    DELETE FROM payments WHERE order_id = OLD.id AND source = 'pedido';
    RETURN OLD;
  END $f$ LANGUAGE plpgsql;
  DROP TRIGGER IF EXISTS pedido_apagado ON song_orders;
  CREATE TRIGGER pedido_apagado BEFORE DELETE ON song_orders FOR EACH ROW EXECUTE FUNCTION trg_pedido_apagado();`;
export const FINANCEIRO_ORIGEM_SQL = `
  ALTER TABLE payments ADD COLUMN IF NOT EXISTS source TEXT NOT NULL DEFAULT 'comprovante';
  ${FINANCEIRO_FUNCS_SQL}
  SELECT sync_pagamento_pedido(id) FROM song_orders WHERE kind = 'paid' AND COALESCE(amount_paid, 0) > 0;`;
// Corrige a carga anterior: lançamentos de pedido que duplicavam um comprovante já registrado.
export const FINANCEIRO_DEDUP_SQL = `
  ${FINANCEIRO_FUNCS_SQL}
  SELECT sync_pagamento_pedido(order_id) FROM payments WHERE source = 'pedido';
  UPDATE payments SET category = 'pedido' WHERE source = 'pedido' OR order_id IS NOT NULL;`;

export const CATEGORIAS = ['pedido', 'contribuicao', 'outro'];   // para que a entrada serviu
const TIPOS = ['email', 'phone', 'cpf', 'cnpj', 'random'];
const txt = (v, max) => { const s = String(v ?? '').trim(); return s.length <= max && !/[\u0000-\u0008\u000b-\u001f<>]/.test(s) ? s : null; };
const dinheiro = (v) => { if (v === undefined || v === null || v === '') return null; const n = Number(String(v).replace(/[R$\s]/g, '').replace(/\.(?=\d{3}\b)/g, '').replace(',', '.')); return Number.isFinite(n) && n >= 0 && n < 1000000 ? Math.round(n * 100) / 100 : NaN; };

// forma comparável de uma chave, conforme o tipo
export function normKey(type, key) {
  const k = String(key ?? '').trim();
  if (type === 'email' || type === 'random') return k.toLowerCase().replace(/\s+/g, '');
  const d = k.replace(/\D/g, '');
  if (type === 'phone') return d.length > 11 && d.startsWith('55') ? d.slice(2) : d;
  return d;
}
const tipoValido = (type, key) => {
  const n = normKey(type, key);
  if (type === 'email') return /^\S+@\S+\.\S+$/.test(n);
  if (type === 'phone') return n.length >= 10 && n.length <= 11;
  if (type === 'cpf') return n.length === 11;
  if (type === 'cnpj') return n.length === 14;
  return n.length >= 8;
};

export function registerFinanceRoutes(r, wrap) {
  const fuso = async () => (await qg('SELECT timezone FROM companies WHERE id=$1', [currentCompany()])).rows[0]?.timezone || 'America/Sao_Paulo';

  // ---------- chaves Pix ----------
  r.get('/finance/keys', wrap(async (req, res) => {
    res.json((await q(
      `SELECT k.*, COALESCE((SELECT sum(p.amount) FROM payments p WHERE p.pix_key_id=k.id AND p.status='accepted'),0)::float AS received
       FROM pix_keys k ORDER BY k.active DESC, k.id`)).rows);
  }));
  function lerChave(b, parcial) {
    const o = {};
    if (!parcial || b.key_type !== undefined) { if (!TIPOS.includes(b.key_type)) return { erro: 'Escolha o tipo da chave' }; o.key_type = b.key_type; }
    if (!parcial || b.key !== undefined) { o.key = txt(b.key, 120); if (!o.key) return { erro: 'Informe a chave' }; }
    if (b.beneficiary !== undefined) { o.beneficiary = txt(b.beneficiary, 80); if (o.beneficiary === null) return { erro: 'Beneficiário inválido (até 80 letras)' }; }
    if (b.note !== undefined) { o.note = txt(b.note, 200); if (o.note === null) return { erro: 'Anotação inválida (até 200 letras)' }; }
    if (b.active !== undefined) { if (typeof b.active !== 'boolean') return { erro: 'Situação inválida' }; o.active = b.active; }
    return { o };
  }
  r.post('/finance/keys', wrap(async (req, res) => {
    const { o, erro } = lerChave(req.body || {}, false);
    if (erro) return res.status(400).json({ error: erro });
    if (!tipoValido(o.key_type, o.key)) return res.status(400).json({ error: 'A chave não parece estar no formato do tipo escolhido' });
    try {
      const k = (await q(`INSERT INTO pix_keys (key, key_type, key_norm, beneficiary, note, active) VALUES ($1,$2,$3,NULLIF($4,''),NULLIF($5,''),$6) RETURNING *`,
        [o.key, o.key_type, normKey(o.key_type, o.key), o.beneficiary || '', o.note || '', o.active ?? true])).rows[0];
      res.status(201).json(k);
    } catch (e) { if (e.code === '23505') return res.status(409).json({ error: 'Essa chave já está cadastrada' }); throw e; }
  }));
  r.put('/finance/keys/:id', wrap(async (req, res) => {
    const { o, erro } = lerChave(req.body || {}, true);
    if (erro) return res.status(400).json({ error: erro });
    const a = (await q('SELECT * FROM pix_keys WHERE id=$1', [req.params.id])).rows[0];
    if (!a) return res.status(404).json({ error: 'Não encontrada' });
    const n = { ...a, ...o };
    if (!tipoValido(n.key_type, n.key)) return res.status(400).json({ error: 'A chave não parece estar no formato do tipo escolhido' });
    try {
      res.json((await q(`UPDATE pix_keys SET key=$2, key_type=$3, key_norm=$4, beneficiary=NULLIF($5,''), note=NULLIF($6,''), active=$7 WHERE id=$1 RETURNING *`,
        [a.id, n.key, n.key_type, normKey(n.key_type, n.key), n.beneficiary || '', n.note || '', n.active])).rows[0]);
    } catch (e) { if (e.code === '23505') return res.status(409).json({ error: 'Essa chave já está cadastrada' }); throw e; }
  }));
  r.delete('/finance/keys/:id', wrap(async (req, res) => {
    const { rowCount } = await q('DELETE FROM pix_keys WHERE id=$1', [req.params.id]);
    rowCount ? res.json({ ok: true }) : res.status(404).json({ error: 'Não encontrada' });
  }));

  // ---------- ajustes ----------
  r.get('/finance/settings', wrap(async (req, res) => res.json((await q('SELECT max_age_hours, min_amount::float AS min_amount FROM finance_settings WHERE id=1')).rows[0])));
  r.put('/finance/settings', wrap(async (req, res) => {
    const h = req.body?.max_age_hours === undefined ? null : Number(req.body.max_age_hours);
    if (h !== null && (!Number.isInteger(h) || h < 1 || h > 720)) return res.status(400).json({ error: 'Idade máxima do comprovante: de 1 a 720 horas' });
    const mexe = req.body?.min_amount !== undefined;
    const min = mexe ? dinheiro(req.body.min_amount) : null;
    if (mexe && Number.isNaN(min)) return res.status(400).json({ error: 'Valor mínimo inválido' });
    await q('UPDATE finance_settings SET max_age_hours=COALESCE($1,max_age_hours), min_amount=CASE WHEN $2::boolean THEN $3 ELSE min_amount END WHERE id=1', [h, mexe, min]);
    res.json((await q('SELECT max_age_hours, min_amount::float AS min_amount FROM finance_settings WHERE id=1')).rows[0]);
  }));

  // dá baixa no pedido pago que está esperando (um só, ou o indicado) e vincula o recebimento
  async function darBaixa(t, pagamento, orderId) {
    let alvo = null;
    if (orderId) alvo = (await t('SELECT id, customer_id FROM song_orders WHERE id=$1', [orderId])).rows[0];
    else if (pagamento.customer_id) {
      const espera = (await t("SELECT id, customer_id FROM song_orders WHERE customer_id=$1 AND kind='paid' AND amount_paid IS NULL ORDER BY created_at, id", [pagamento.customer_id])).rows;
      if (espera.length === 1) alvo = espera[0];
    }
    if (!alvo) return (await t('SELECT casar_comprovante($1) AS o', [pagamento.id])).rows[0].o;   // pedido já lançado à mão com esse valor
    await t("UPDATE song_orders SET kind=CASE WHEN live_id IS NOT NULL AND kind IS NULL THEN 'paid' ELSE kind END, amount_paid=$2 WHERE id=$1", [alvo.id, pagamento.amount]);
    await t("UPDATE payments SET order_id=$2, category='pedido', customer_id=COALESCE(customer_id,$3) WHERE id=$1", [pagamento.id, alvo.id, alvo.customer_id]);
    await t('SELECT sync_pagamento_pedido($1)', [alvo.id]);   // o comprovante passa a ser o lançamento do pedido
    return alvo.id;
  }

  // ---------- conferir e registrar um comprovante ----------
  r.post('/payments/check', wrap(async (req, res) => {
    const b = req.body || {};
    const amount = dinheiro(b.amount ?? b.valor);
    if (amount === null || Number.isNaN(amount) || amount <= 0) return res.status(400).json({ error: 'Informe o valor pago' });
    const payer = txt(b.payer_name ?? b.nome_pagador, 120) || '';
    const txid = (txt(b.txid ?? b.id_transacao, 120) || '').replace(/\s+/g, '') || null;
    const keyText = txt(b.key ?? b.chave_pix, 120) || '';
    const purpose = txt(b.purpose ?? b.finalidade, 120) || '';
    const phone = normPhone(b.phone) || null;
    const tz = await fuso();
    const out = await tx(currentCompany(), async (t) => {
      const st = (await t('SELECT max_age_hours, min_amount::float AS min_amount FROM finance_settings WHERE id=1')).rows[0];
      // data/hora do pagamento: sem fuso informado vale o fuso da empresa
      let paidAt = null;
      const raw = String(b.paid_at ?? b.data_pagamento ?? '').trim();
      const m = raw.match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?$/);
      if (m) {
        const [, y, mo, d, h, mi] = m.map(Number);
        const ok = mo >= 1 && mo <= 12 && d >= 1 && d <= 31 && h <= 23 && mi <= 59;
        if (ok) paidAt = (await t('SELECT ($1::timestamp AT TIME ZONE $2) AS d', [`${m[1]}-${m[2]}-${m[3]} ${m[4]}:${m[5]}:${m[6] || '00'}`, tz])).rows[0].d;
      } else if (raw) {
        const dt = new Date(raw);
        if (!Number.isNaN(dt.getTime())) paidAt = dt;
      }
      if (txid) await t('SELECT pg_advisory_xact_lock(hashtext($1))', [txid]);
      // cliente novo (ainda sem cadastro) já nasce aqui, para o pagamento ficar ligado a ele e depois ao pedido
      const nomeCli = txt(b.name ?? b.customer_name ?? '', 120) || '';
      const cust = phone ? (await t(
        `INSERT INTO customers (name,phone,status,source) VALUES (NULLIF($1,''),$2,'lead','ia')
         ON CONFLICT (phone) DO UPDATE SET name=COALESCE(customers.name, NULLIF(EXCLUDED.name,'')) RETURNING id`, [nomeCli, phone])).rows[0] : null;
      const chaves = (await t('SELECT * FROM pix_keys')).rows;
      const ativas = chaves.filter((k) => k.active);
      const achada = keyText ? chaves.find((k) => normKey(k.key_type, keyText) === k.key_norm) : null;

      let status = 'accepted', reason = null;
      const dup = txid ? (await t("SELECT 1 FROM payments WHERE txid=$1 AND status IN ('accepted','review')", [txid])).rowCount
        : (payer && paidAt ? (await t("SELECT 1 FROM payments WHERE txid IS NULL AND payer_name=$1 AND amount=$2 AND paid_at=$3 AND status IN ('accepted','review')", [payer, amount, paidAt])).rowCount : 0);
      if (dup) { status = 'duplicate'; reason = 'comprovante já utilizado'; }
      else if (!paidAt) { status = 'review'; reason = 'não consegui ler a data do pagamento'; }
      else if (paidAt.getTime() > Date.now() + 10 * 60000) { status = 'review'; reason = 'a data do pagamento está no futuro'; }
      else if (Date.now() - paidAt.getTime() > st.max_age_hours * 3600000) { status = 'old'; reason = 'comprovante desatualizado'; }
      else if (ativas.length || chaves.length) {
        if (!keyText) { status = 'review'; reason = 'o comprovante não mostra a chave Pix que recebeu'; }
        else if (!achada) { status = 'wrong_key'; reason = 'pagamento para uma chave que não é nossa'; }
        else if (!achada.active) { status = 'wrong_key'; reason = 'pagamento para uma chave que não está em uso agora'; }
      }
      if (status === 'accepted' && st.min_amount != null && amount < st.min_amount) { status = 'low_amount'; reason = 'valor menor que o mínimo'; }
      if (status === 'accepted' && !txid) { status = 'review'; reason = 'o comprovante não mostra o ID da transação'; }

      const p = (await t(
        `INSERT INTO payments (txid, payer_name, amount, key_text, pix_key_id, paid_at, purpose, customer_id, status, reason, category)
         VALUES ($1,NULLIF($2,''),$3,NULLIF($4,''),$5,$6,NULLIF($7,''),$8,$9,$10,$11) RETURNING *`,
        [txid, payer, amount, keyText, achada?.id || null, paidAt, purpose, cust?.id || null, status, reason, CATEGORIAS.includes(b.category) ? b.category : 'contribuicao'])).rows[0];
      let ordem = null;
      if (status === 'accepted') ordem = await darBaixa(t, p, b.order_id ? Number(b.order_id) : null);
      return { p, ordem, key: achada };
    });
    res.status(out.p.status === 'accepted' ? 201 : 200).json({
      accepted: out.p.status === 'accepted', status: out.p.status, motivo: out.p.reason, payment_id: out.p.id,
      order_id: out.ordem, beneficiary: out.key?.beneficiary || null,
    });
  }));

  // ---------- recebimentos ----------
  r.get('/payments', wrap(async (req, res) => {
    const tz = await fuso();
    const mes = /^\d{4}-(0[1-9]|1[0-2])$/.test(String(req.query.month || '')) ? req.query.month : null;
    const status = ['accepted', 'duplicate', 'old', 'wrong_key', 'low_amount', 'review', 'rejected'].includes(req.query.status) ? req.query.status : null;
    const cat = CATEGORIAS.includes(req.query.category) ? req.query.category : null;
    const rows = (await q(
      `SELECT p.*, p.amount::float AS amount, k.beneficiary, k.key AS key_registered, c.name AS customer_name, c.last_name AS customer_last_name, c.phone AS customer_phone,
              o.song AS order_song
       FROM payments p LEFT JOIN pix_keys k ON k.id=p.pix_key_id LEFT JOIN customers c ON c.id=p.customer_id LEFT JOIN song_orders o ON o.id=p.order_id
       WHERE ($2::text IS NULL OR p.status=$2) AND ($3::text IS NULL OR to_char(p.created_at AT TIME ZONE $1,'YYYY-MM')=$3) AND ($4::text IS NULL OR p.category=$4)
       ORDER BY p.created_at DESC, p.id DESC LIMIT 500`, [tz, status, mes, cat])).rows;
    res.json(rows);
  }));
  // Assinatura dos recebimentos (a tela só recarrega a lista quando ela muda)
  r.get('/payments/changes', wrap(async (req, res) => {
    const x = (await q(`SELECT count(*)::int AS n, COALESCE(md5(string_agg(concat_ws('|', id, status, amount, order_id, customer_id, reason, pix_key_id, category), ';' ORDER BY id)), '') AS h FROM payments`)).rows[0];
    res.json({ sig: `${x.n}:${x.h}` });
  }));
  r.get('/payments/summary', wrap(async (req, res) => {
    const tz = await fuso();
    const mes = /^\d{4}-(0[1-9]|1[0-2])$/.test(String(req.query.month || '')) ? req.query.month : (await q("SELECT to_char(now() AT TIME ZONE $1,'YYYY-MM') AS m", [tz])).rows[0].m;
    const porChave = (await q(
      `SELECT k.id, k.key, k.beneficiary, k.active, COALESCE(sum(p.amount),0)::float AS total, count(p.id)::int AS qtd
       FROM pix_keys k LEFT JOIN payments p ON p.pix_key_id=k.id AND p.status='accepted' AND to_char(p.created_at AT TIME ZONE $1,'YYYY-MM')=$2
       GROUP BY k.id ORDER BY k.active DESC, k.id`, [tz, mes])).rows;
    const t = (await q(
      `SELECT COALESCE(sum(amount) FILTER (WHERE status='accepted'),0)::float AS total,
              count(*) FILTER (WHERE status='accepted')::int AS aceitos,
              count(*) FILTER (WHERE status='review')::int AS em_analise,
              count(*) FILTER (WHERE status IN ('duplicate','old','wrong_key','low_amount','rejected'))::int AS recusados,
              count(*) FILTER (WHERE status='accepted' AND order_id IS NULL)::int AS sem_pedido,
              COALESCE(sum(amount) FILTER (WHERE status='accepted' AND source='pedido'),0)::float AS via_pedidos,
              COALESCE(sum(amount) FILTER (WHERE status='accepted' AND source<>'pedido'),0)::float AS via_comprovantes,
              COALESCE(sum(amount) FILTER (WHERE status='accepted' AND category='pedido'),0)::float AS cat_pedido,
              COALESCE(sum(amount) FILTER (WHERE status='accepted' AND category='contribuicao'),0)::float AS cat_contribuicao,
              COALESCE(sum(amount) FILTER (WHERE status='accepted' AND category='outro'),0)::float AS cat_outro,
              count(*) FILTER (WHERE status='accepted' AND pix_key_id IS NULL)::int AS sem_chave
       FROM payments WHERE to_char(created_at AT TIME ZONE $1,'YYYY-MM')=$2`, [tz, mes])).rows[0];
    res.json({ month: mes, keys: porChave, ...t });
  }));
  // aprova (e dá baixa) ou recusa um recebimento que ficou em análise ou foi recusado
  // corrige um recebimento (ex.: a chave Pix foi lida errada no comprovante)
  r.put('/payments/:id', wrap(async (req, res) => {
    const b = req.body || {};
    const out = await tx(currentCompany(), async (t) => {
      const p = (await t('SELECT * FROM payments WHERE id=$1 FOR UPDATE', [req.params.id])).rows[0];
      if (!p) return { code: 404, error: 'Não encontrado' };
      const keyText = b.key === undefined ? (p.key_text ?? '') : txt(b.key, 120);
      const payer = b.payer_name === undefined ? (p.payer_name ?? '') : txt(b.payer_name, 120);
      const purpose = b.purpose === undefined ? (p.purpose ?? '') : txt(b.purpose, 120);
      const category = b.category === undefined ? p.category : String(b.category);
      if (!CATEGORIAS.includes(category)) return { code: 400, error: 'Tipo de entrada inválido' };
      const amount = b.amount === undefined ? Number(p.amount) : dinheiro(b.amount);
      if (keyText === null || payer === null || purpose === null) return { code: 400, error: 'Texto inválido' };
      if (amount === null || Number.isNaN(amount) || amount <= 0) return { code: 400, error: 'Valor inválido' };
      if (p.source === 'pedido' && amount !== Number(p.amount)) return { code: 409, error: 'Este valor vem de um pedido: corrija o valor na tela de Pedidos.' };
      const chaves = (await t('SELECT * FROM pix_keys')).rows;
      const achada = keyText ? chaves.find((k) => normKey(k.key_type, keyText) === k.key_norm) : null;
      let status = p.status, reason = p.reason;
      // chave corrigida para uma das nossas: o recebimento que estava como "chave diferente" passa a valer
      if (p.status === 'wrong_key' && achada && achada.active) {
        if (p.txid && (await t("SELECT 1 FROM payments WHERE txid=$1 AND status='accepted' AND id<>$2", [p.txid, p.id])).rowCount)
          return { code: 409, error: 'Já existe um recebimento aceito com este ID de transação' };
        status = 'accepted'; reason = null;
      }
      const u = (await t(
        `UPDATE payments SET key_text=NULLIF($2,''), pix_key_id=$3, payer_name=NULLIF($4,''), purpose=NULLIF($5,''), amount=$6, status=$7, reason=$8, category=$9 WHERE id=$1 RETURNING *`,
        [p.id, keyText, achada?.id || null, payer, purpose, amount, status, reason, category])).rows[0];
      let ordem = u.order_id;
      if (u.status === 'accepted' && p.status !== 'accepted') ordem = await darBaixa(t, u, null);
      else if (u.status === 'accepted' && u.order_id && Number(p.amount) !== amount) {
        await t('UPDATE song_orders SET amount_paid=$2 WHERE id=$1', [u.order_id, amount]);
        await t('SELECT sync_pagamento_pedido($1)', [u.order_id]);
      }
      return { id: u.id, status: u.status, order_id: ordem };
    });
    out.error ? res.status(out.code).json({ error: out.error }) : res.json(out);
  }));
  r.post('/payments/:id/approve', wrap(async (req, res) => {
    const out = await tx(currentCompany(), async (t) => {
      const p = (await t('SELECT * FROM payments WHERE id=$1 FOR UPDATE', [req.params.id])).rows[0];
      if (!p) return { code: 404, error: 'Não encontrado' };
      if (p.status === 'accepted') return { code: 409, error: 'Este recebimento já foi aceito' };
      if (p.txid && (await t("SELECT 1 FROM payments WHERE txid=$1 AND status='accepted' AND id<>$2", [p.txid, p.id])).rowCount)
        return { code: 409, error: 'Já existe um recebimento aceito com este ID de transação' };
      const u = (await t("UPDATE payments SET status='accepted', reason=NULL WHERE id=$1 RETURNING *", [p.id])).rows[0];
      const ordem = await darBaixa(t, u, req.body?.order_id ? Number(req.body.order_id) : null);
      return { id: u.id, order_id: ordem };
    });
    out.error ? res.status(out.code).json({ error: out.error }) : res.json(out);
  }));
  r.post('/payments/:id/reject', wrap(async (req, res) => {
    const { rowCount } = await q("UPDATE payments SET status='rejected', reason=COALESCE(NULLIF($2,''),'recusado pelo responsável') WHERE id=$1 AND status<>'accepted'", [req.params.id, String(req.body?.reason ?? '').slice(0, 200)]);
    rowCount ? res.json({ ok: true }) : res.status(409).json({ error: 'Não encontrado ou já aceito' });
  }));
  r.delete('/payments/:id', wrap(async (req, res) => {
    const n = await tx(currentCompany(), async (t) => {
      const del = await t('DELETE FROM payments WHERE id=$1 RETURNING order_id', [req.params.id]);
      if (del.rows[0]?.order_id) await t('SELECT sync_pagamento_pedido($1)', [del.rows[0].order_id]);
      return del.rowCount;
    });
    n ? res.json({ ok: true }) : res.status(404).json({ error: 'Não encontrado' });
  }));
  r.post('/payments/bulk-delete', wrap(async (req, res) => {
    const ids = [...new Set((Array.isArray(req.body?.ids) ? req.body.ids : []).map(Number).filter((n) => Number.isInteger(n) && n > 0))].slice(0, 2000);
    if (!ids.length) return res.status(400).json({ error: 'Nenhum item selecionado' });
    if (req.body.dry_run === true) return res.json({ found: (await q('SELECT count(*)::int AS n FROM payments WHERE id = ANY($1::bigint[])', [ids])).rows[0].n });
    res.json({ deleted: await tx(currentCompany(), async (t) => {
      const del = await t('DELETE FROM payments WHERE id = ANY($1::bigint[]) RETURNING order_id', [ids]);
      for (const o of [...new Set(del.rows.map((x) => x.order_id).filter(Boolean))]) await t('SELECT sync_pagamento_pedido($1)', [o]);
      return del.rowCount;
    }) });
  }));
}
