// Scenarium: reservas de mesa para casas de evento, controladas pelo ESPAÇO de cada setor.
// Ideia: o setor tem um espaço (em pontos) e cada tipo de mesa ocupa uma parte dele. Assim 2 mesas de 10 e 4 mesas de 4
// podem ocupar o mesmo espaço e render lotações diferentes (20 e 16 pessoas), e o sistema calcula o que ainda cabe.
//  - a reserva é de um evento (ou, sem evento, de uma data) e de um setor
//  - o espaço do setor pode ser ajustado só para um evento (ex.: show com a pista reduzida)
//  - a reserva guarda o tipo de mesa e o espaço usado na hora; mudar o cadastro depois não altera reservas antigas
//  - só ocupam espaço reservas "confirmada" e "compareceu"; cancelada e "não veio" liberam
import crypto from 'crypto';
import { q, qg, tx, currentCompany, runAs } from './db.js';
import { normPhone } from './phone.js';
import { parseBirthday } from './ficha.js';

export const SCENARIUM_SQL = `
  ALTER TABLE customers ADD COLUMN IF NOT EXISTS client_kinds TEXT[] NOT NULL DEFAULT '{}';   -- perfis do cliente: buyer (comprador), hirer (contratante)
  CREATE TABLE IF NOT EXISTS scn_sectors (
    id       BIGSERIAL PRIMARY KEY,
    name     TEXT NOT NULL UNIQUE,
    space    NUMERIC(8,2) NOT NULL CHECK (space >= 0),        -- espaço total, em pontos
    notes    TEXT,                                            -- ex.: visão, som, observações do setor
    position INT NOT NULL DEFAULT 0,
    active   BOOLEAN NOT NULL DEFAULT true
  );
  CREATE TABLE IF NOT EXISTS scn_table_types (
    id       BIGSERIAL PRIMARY KEY,
    name     TEXT NOT NULL UNIQUE,
    seats    INT NOT NULL CHECK (seats BETWEEN 1 AND 200),    -- lugares
    space    NUMERIC(8,2) NOT NULL CHECK (space > 0),         -- espaço que uma mesa ocupa, em pontos
    active   BOOLEAN NOT NULL DEFAULT true
  );
  CREATE TABLE IF NOT EXISTS scn_sector_tables (              -- que mesas o setor aceita (sem linhas = aceita todas) e quantas de cada cabem
    sector_id     BIGINT NOT NULL REFERENCES scn_sectors(id) ON DELETE CASCADE,
    table_type_id BIGINT NOT NULL REFERENCES scn_table_types(id) ON DELETE CASCADE,
    max_tables    INT CHECK (max_tables BETWEEN 1 AND 100),                   -- vazio = sem limite de quantidade
    PRIMARY KEY (sector_id, table_type_id)
  );
  CREATE TABLE IF NOT EXISTS scn_event_sectors (              -- espaço do setor ajustado só para um evento
    event_id  BIGINT NOT NULL REFERENCES events(id) ON DELETE CASCADE,
    sector_id BIGINT NOT NULL REFERENCES scn_sectors(id) ON DELETE CASCADE,
    space     NUMERIC(8,2) NOT NULL CHECK (space >= 0),
    PRIMARY KEY (event_id, sector_id)
  );
  CREATE TABLE IF NOT EXISTS scn_event_conditions (           -- preço e instruções do evento
    event_id     BIGINT PRIMARY KEY REFERENCES events(id) ON DELETE CASCADE,
    price        NUMERIC(10,2) CHECK (price >= 0),            -- ingresso por pessoa
    door_price   NUMERIC(10,2) CHECK (door_price >= 0),       -- depois do prazo (ex.: na portaria)
    price_until  TIMESTAMPTZ,                                 -- até quando vale o preço normal
    instructions TEXT                                         -- instrução livre para o atendente (descontos excepcionais etc.)
  );
  CREATE TABLE IF NOT EXISTS scn_event_codes (                -- palavras-chave de desconto do evento
    id          BIGSERIAL PRIMARY KEY,
    event_id    BIGINT NOT NULL REFERENCES events(id) ON DELETE CASCADE,
    word        TEXT NOT NULL,
    word_norm   TEXT NOT NULL,
    kind        TEXT NOT NULL CHECK (kind IN ('percent', 'price')),
    value       NUMERIC(10,2) NOT NULL CHECK (value >= 0),
    max_uses    INT CHECK (max_uses >= 1),
    valid_until TIMESTAMPTZ,
    note        TEXT,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (event_id, word_norm)
  );
  CREATE TABLE IF NOT EXISTS scn_event_interest (             -- quem perguntou sobre o evento (vira lead)
    event_id    BIGINT NOT NULL REFERENCES events(id) ON DELETE CASCADE,
    customer_id BIGINT NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (event_id, customer_id)
  );
  CREATE TABLE IF NOT EXISTS scn_extras (                     -- mesas extras abertas à mão, fora do que o setor comporta, só para um evento/data
    id             BIGSERIAL PRIMARY KEY,
    event_id       BIGINT REFERENCES events(id) ON DELETE CASCADE,
    occasion_date  DATE NOT NULL,
    sector_id      BIGINT NOT NULL REFERENCES scn_sectors(id) ON DELETE CASCADE,
    table_type_id  BIGINT REFERENCES scn_table_types(id) ON DELETE SET NULL,
    table_name     TEXT NOT NULL,
    seats_each     INT NOT NULL CHECK (seats_each > 0),
    space_each     NUMERIC(8,2) NOT NULL CHECK (space_each > 0),
    quantity       INT NOT NULL DEFAULT 1 CHECK (quantity BETWEEN 1 AND 100),
    note           TEXT,
    created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
  );
  CREATE INDEX IF NOT EXISTS idx_scn_extras_event ON scn_extras (event_id);
  CREATE TABLE IF NOT EXISTS scn_reservations (
    id             BIGSERIAL PRIMARY KEY,
    event_id       BIGINT REFERENCES events(id) ON DELETE SET NULL,
    occasion_date  DATE NOT NULL,                             -- dia do evento (ou a data escolhida, sem evento)
    sector_id      BIGINT NOT NULL REFERENCES scn_sectors(id) ON DELETE RESTRICT,
    customer_id    BIGINT REFERENCES customers(id) ON DELETE SET NULL,
    name           TEXT NOT NULL,
    phone          TEXT,
    people         INT NOT NULL CHECK (people BETWEEN 1 AND 1000),
    table_type_id  BIGINT REFERENCES scn_table_types(id) ON DELETE SET NULL,
    table_name     TEXT NOT NULL,                             -- tipo de mesa na hora da reserva
    seats_each     INT NOT NULL CHECK (seats_each > 0),
    space_each     NUMERIC(8,2) NOT NULL CHECK (space_each > 0),
    tables         INT NOT NULL DEFAULT 1 CHECK (tables BETWEEN 1 AND 100),
    status         TEXT NOT NULL DEFAULT 'confirmed' CHECK (status IN ('confirmed', 'attended', 'cancelled', 'no_show')),
    note           TEXT,
    guests         TEXT,                                      -- nomes da lista (um por linha)
    unit_price     NUMERIC(10,2),                             -- valor por pessoa na hora da reserva (vazio = sem preço definido)
    code_id        BIGINT REFERENCES scn_event_codes(id) ON DELETE SET NULL,
    code_word      TEXT,                                      -- palavra usada (guardada para consulta)
    created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at     TIMESTAMPTZ NOT NULL DEFAULT now()
  );
  CREATE INDEX IF NOT EXISTS idx_scn_res_event ON scn_reservations (event_id);
  CREATE INDEX IF NOT EXISTS idx_scn_res_date ON scn_reservations (occasion_date);`;

// Ingressos e reservas do cliente para a ficha: lista, total pago e ticket médio (por compra e por pessoa).
// Só contam reservas confirmadas ou com comparecimento e com valor pago; canceladas e cortesias aparecem na lista, mas ficam fora das contas.
export async function historicoScenarium(customerId) {
  const rows = (await q(
    `SELECT v.id, v.occasion_date::text AS date, e.title AS event_title, s.name AS sector_name, v.people, v.table_name, v.status, v.code_word,
            v.unit_price::float AS unit_price, (v.people * v.unit_price)::float AS total
     FROM scn_reservations v JOIN scn_sectors s ON s.id = v.sector_id LEFT JOIN events e ON e.id = v.event_id
     WHERE v.customer_id = $1 ORDER BY v.occasion_date DESC, v.id DESC LIMIT 200`, [customerId])).rows;
  const contam = rows.filter((x) => ['confirmed', 'attended'].includes(x.status) && x.total > 0);   // cortesia (valor 0) aparece na lista, mas não entra no ticket médio
  const total = r2(contam.reduce((a, x) => a + x.total, 0));
  const pessoas = contam.reduce((a, x) => a + x.people, 0);
  return { tickets: { rows, purchases: contam.length, total, average_ticket: contam.length ? r2(total / contam.length) : null, average_per_person: pessoas ? r2(total / pessoas) : null } };
}

export const KINDS = ['buyer', 'hirer'];
export const STATUS = ['confirmed', 'attended', 'cancelled', 'no_show'];
const OCUPAM = ['confirmed', 'attended'];
const r2 = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;
const txt = (v, max) => { const s = String(v ?? '').trim(); return s.length <= max && !/[\u0000-\u0008\u000b-\u001f<>]/.test(s) ? s : null; };
const idOk = (v) => /^\d+$/.test(String(v ?? '')) ? String(v) : null;
const num = (v) => { const n = Number(String(v ?? '').replace(',', '.')); return v !== '' && v !== null && v !== undefined && Number.isFinite(n) ? n : null; };
const espaco = (v, min) => { const n = num(v); return n !== null && n >= min && n <= 99999 ? r2(n) : null; };
const dinheiro = (v) => { const n = Number(String(v ?? '').replace(/[R$\s]/g, '').replace(',', '.')); return Number.isFinite(n) && n >= 0 && n <= 9999999 ? r2(n) : null; };
const norma = (v) => String(v ?? '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]/g, '');
const inteiro = (v, min, max) => { const n = Number(v); return v !== '' && v !== null && v !== undefined && Number.isInteger(n) && n >= min && n <= max ? n : null; };
const dataOk = (v) => /^\d{4}-\d{2}-\d{2}$/.test(String(v || '')) && !isNaN(new Date(v + 'T00:00:00Z')) ? String(v) : null;

// Jeitos de acomodar `people` pessoas com `livre` de espaço, do que usa menos espaço (e, empatando, menos mesas) para o que usa mais.
// `tipos` = tipos de mesa que o setor aceita; `left` (opcional) = quantas mesas desse tipo ainda cabem no setor.
// Cada jeito usa um tipo só, em quantidade suficiente (ex.: 20 pessoas = 2 mesas de 10). Devolve [{ type, tables, space }].
export function opcoes(tipos, people, livre) {
  const out = [];
  for (const t of tipos) {
    const mesas = Math.ceil(people / t.seats);
    if (mesas > 100) continue;
    if (t.left !== undefined && t.left !== null && mesas > t.left) continue;
    const usa = r2(mesas * t.space);
    if (usa > livre + 1e-9) continue;
    out.push({ type: t, tables: mesas, space: usa });
  }
  return out.sort((a, b) => a.space - b.space || a.tables - b.tables || a.type.seats - b.type.seats);
}
export const melhorOpcao = (tipos, people, livre) => opcoes(tipos, people, livre)[0] || null;


// Mapa do espaço e fotos de cada setor: o atendente envia ao cliente pelo WhatsApp (endereço público e difícil de adivinhar)
export const SCN_MEDIA_SQL = `
  CREATE TABLE IF NOT EXISTS scn_media (
    id         BIGSERIAL PRIMARY KEY,
    sector_id  BIGINT REFERENCES scn_sectors(id) ON DELETE CASCADE,   -- vazio = mapa geral do espaço
    kind       TEXT NOT NULL CHECK (kind IN ('map','photo')),
    caption    TEXT,
    mime       TEXT NOT NULL,
    data       BYTEA NOT NULL,
    token      TEXT NOT NULL UNIQUE,
    position   INT NOT NULL DEFAULT 0,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
  );
  CREATE INDEX IF NOT EXISTS scn_media_sector ON scn_media (sector_id);
`;
const MIDIA_MAX_BYTES = 2.5 * 1024 * 1024, FOTOS_POR_SETOR = 8;
// confere pelo conteúdo (não pelo nome) que é mesmo uma imagem aceita
function tipoDaImagem(buf) {
  if (buf.length > 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
  if (buf.length > 8 && buf.slice(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';
  if (buf.length > 12 && buf.slice(0, 4).toString() === 'RIFF' && buf.slice(8, 12).toString() === 'WEBP') return 'image/webp';
  return null;
}
export function registerMidiaPublica(app) {
  app.get('/m/:token', async (req, res) => {
    const m = String(req.params.token || '').match(/^(\d+)-([0-9a-f]{40})$/);
    if (!m) return res.status(404).end();
    try {
      const f = await runAs(Number(m[1]), async () => (await q('SELECT mime, data FROM scn_media WHERE token=$1', [req.params.token])).rows[0]);
      if (!f) return res.status(404).end();
      res.set({ 'content-type': f.mime, 'cache-control': 'public, max-age=3600', 'x-content-type-options': 'nosniff' }).send(f.data);
    } catch (e) { console.error('scenarium mídia:', e.message); res.status(404).end(); }
  });
}

export function registerScenariumRoutes(r, wrap) {
  const fuso = async () => (await qg('SELECT timezone FROM companies WHERE id=$1', [currentCompany()])).rows[0]?.timezone || 'America/Sao_Paulo';
  const comTratamento = (fn) => wrap(async (req, res) => {
    try { await fn(req, res); } catch (e) { if (e.status) return res.status(e.status).json({ error: e.message }); throw e; }
  });
  const quem = (req) => (req.baseUrl || '').includes('n8n') ? 'ia' : 'manual';

  // ---------- setores ----------
  const SETOR = `SELECT id, name, space::float AS space, notes, position, active,
    COALESCE((SELECT json_agg(json_build_object('table_type_id', st.table_type_id::text, 'max_tables', st.max_tables) ORDER BY st.table_type_id)
              FROM scn_sector_tables st WHERE st.sector_id = scn_sectors.id), '[]'::json) AS tables
    FROM scn_sectors`;

  // ---------- mapa e fotos ----------
  const urlBase = (req) => process.env.PUBLIC_URL || `${req.headers['x-forwarded-proto'] || req.protocol}://${req.headers['x-forwarded-host'] || req.get('host')}`;
  const midiaOut = (req, m) => ({ id: String(m.id), sector_id: m.sector_id ? String(m.sector_id) : null, kind: m.kind, caption: m.caption, url: `${urlBase(req)}/m/${m.token}` });
  // Lista (sem os arquivos): o painel mostra e o atendente usa os endereços para enviar ao cliente
  r.get('/scenarium/media', wrap(async (req, res) => {
    const setorId = req.query.sector_id ? idOk(req.query.sector_id) : null;
    if (req.query.sector_id && !setorId) return res.status(400).json({ error: 'Setor inválido' });
    const rows = (await q(`SELECT m.id, m.sector_id, m.kind, m.caption, m.token, s.name AS sector_name FROM scn_media m LEFT JOIN scn_sectors s ON s.id = m.sector_id
      ${setorId ? 'WHERE m.sector_id = $1 OR m.sector_id IS NULL' : ''} ORDER BY m.kind DESC, m.position, m.id`, setorId ? [setorId] : [])).rows;
    const map = rows.find((m) => m.kind === 'map');
    const setores = (await q('SELECT id, name FROM scn_sectors WHERE active ORDER BY position, id')).rows;
    res.json({
      map: map ? midiaOut(req, map) : null,
      sectors: setores.filter((s) => !setorId || String(s.id) === setorId).map((s) => ({ sector_id: String(s.id), name: s.name, photos: rows.filter((m) => m.kind === 'photo' && String(m.sector_id) === String(s.id)).map((m) => midiaOut(req, m)) })),
    });
  }));
  // Envio: { kind: 'map' | 'photo', sector_id (fotos), caption, data: "data:image/jpeg;base64,..." }
  r.post('/scenarium/media', comTratamento(async (req, res) => {
    if (quem(req) === 'ia') return res.status(403).json({ error: 'Só pelo painel' });
    const b = req.body || {};
    const kind = b.kind === 'map' ? 'map' : b.kind === 'photo' ? 'photo' : null;
    if (!kind) return res.status(400).json({ error: 'Diga se é o mapa ou a foto de um setor' });
    const legenda = txt(b.caption ?? '', 120);
    if (legenda === null) return res.status(400).json({ error: 'Legenda inválida (até 120 letras)' });
    const bruto = String(b.data || '').replace(/^data:[^,]*,/, '');
    const buf = Buffer.from(bruto, 'base64');
    if (!buf.length) return res.status(400).json({ error: 'Escolha uma imagem' });
    if (buf.length > MIDIA_MAX_BYTES) return res.status(400).json({ error: 'A imagem é grande demais (até 2,5 MB)' });
    const mime = tipoDaImagem(buf);
    if (!mime) return res.status(400).json({ error: 'Use uma imagem JPG, PNG ou WebP' });
    let setorId = null;
    if (kind === 'photo') {
      setorId = idOk(b.sector_id);
      if (!setorId || !(await q('SELECT 1 FROM scn_sectors WHERE id=$1', [setorId])).rowCount) return res.status(400).json({ error: 'Escolha o setor da foto' });
      if ((await q("SELECT count(*)::int AS n FROM scn_media WHERE kind='photo' AND sector_id=$1", [setorId])).rows[0].n >= FOTOS_POR_SETOR)
        return res.status(409).json({ error: `Cada setor aceita até ${FOTOS_POR_SETOR} fotos. Apague uma para enviar outra.` });
    }
    const token = `${currentCompany()}-${crypto.randomBytes(20).toString('hex')}`;
    const novo = await tx(currentCompany(), async (t) => {
      if (kind === 'map') await t("DELETE FROM scn_media WHERE kind='map'");   // só existe um mapa: o novo substitui
      return (await t(`INSERT INTO scn_media (sector_id, kind, caption, mime, data, token, position)
        VALUES ($1,$2,$3,$4,$5,$6,(SELECT COALESCE(max(position),0)+1 FROM scn_media)) RETURNING id, sector_id, kind, caption, token`,
        [setorId, kind, legenda || null, mime, buf, token])).rows[0];
    });
    res.status(201).json(midiaOut(req, novo));
  }));
  r.put('/scenarium/media/:id', comTratamento(async (req, res) => {
    if (quem(req) === 'ia') return res.status(403).json({ error: 'Só pelo painel' });
    const id = idOk(req.params.id); const legenda = txt(req.body?.caption ?? '', 120);
    if (!id || legenda === null) return res.status(400).json({ error: 'Legenda inválida (até 120 letras)' });
    const { rowCount } = await q('UPDATE scn_media SET caption=$2 WHERE id=$1', [id, legenda || null]);
    rowCount ? res.json({ ok: true }) : res.status(404).json({ error: 'Imagem não encontrada' });
  }));
  r.delete('/scenarium/media/:id', comTratamento(async (req, res) => {
    if (quem(req) === 'ia') return res.status(403).json({ error: 'Só pelo painel' });
    const id = idOk(req.params.id);
    const { rowCount } = id ? await q('DELETE FROM scn_media WHERE id=$1', [id]) : { rowCount: 0 };
    rowCount ? res.json({ ok: true }) : res.status(404).json({ error: 'Imagem não encontrada' });
  }));

  r.get('/scenarium/sectors', wrap(async (req, res) => res.json((await q(`${SETOR} ORDER BY position, id`)).rows)));
  function lerSetor(b, parcial) {
    const o = {};
    if (!parcial || b.name !== undefined) { o.name = txt(b.name, 60); if (!o.name) return { erro: 'Informe o nome do setor (até 60 letras)' }; }
    if (!parcial || b.space !== undefined) { o.space = espaco(b.space, 0); if (o.space === null) return { erro: 'Informe o espaço do setor (número, 0 ou mais)' }; }
    if (b.notes !== undefined) { o.notes = txt(b.notes, 300); if (o.notes === null) return { erro: 'Observação inválida (até 300 letras)' }; }
    if (b.position !== undefined) { o.position = inteiro(b.position, 0, 9999); if (o.position === null) return { erro: 'Posição inválida' }; }
    if (b.active !== undefined) { if (typeof b.active !== 'boolean') return { erro: 'Ativo inválido' }; o.active = b.active; }
    return { o };
  }
  // Regras do setor: quais mesas aceita e quantas de cada. Lista vazia = aceita todas. undefined = não mexe.
  async function lerRegras(b) {
    if (b.tables === undefined) return { regras: undefined };
    if (!Array.isArray(b.tables)) return { erro: 'Mesas do setor inválidas' };
    const vistos = new Set(), regras = [];
    for (const it of b.tables) {
      const tid = idOk(it?.table_type_id);
      if (!tid || !(await q('SELECT 1 FROM scn_table_types WHERE id=$1', [tid])).rows[0]) return { erro: 'Mesa não encontrada' };
      if (vistos.has(tid)) return { erro: 'Mesa repetida nas regras do setor' };
      vistos.add(tid);
      let mx = null;
      if (it.max_tables !== null && it.max_tables !== undefined && it.max_tables !== '') { mx = inteiro(it.max_tables, 1, 100); if (mx === null) return { erro: 'Quantidade máxima de mesas inválida (1 a 100)' }; }
      regras.push([tid, mx]);
    }
    return { regras };
  }
  const salvarRegras = (sid, regras) => regras === undefined ? null : tx(currentCompany(), async (t) => {
    await t('DELETE FROM scn_sector_tables WHERE sector_id=$1', [sid]);
    for (const [tid, mx] of regras) await t('INSERT INTO scn_sector_tables (sector_id, table_type_id, max_tables) VALUES ($1,$2,$3)', [sid, tid, mx]);
  });
  r.post('/scenarium/sectors', wrap(async (req, res) => {
    const { o, erro } = lerSetor(req.body || {}, false);
    if (erro) return res.status(400).json({ error: erro });
    const rg = await lerRegras(req.body || {});
    if (rg.erro) return res.status(400).json({ error: rg.erro });
    try {
      const pos = o.position ?? (await q('SELECT COALESCE(MAX(position), 0) + 1 AS p FROM scn_sectors')).rows[0].p;
      const id = (await q('INSERT INTO scn_sectors (name, space, notes, position) VALUES ($1,$2,NULLIF($3,\'\'),$4) RETURNING id', [o.name, o.space, o.notes || '', pos])).rows[0].id;
      await salvarRegras(id, rg.regras);
      res.status(201).json((await q(`${SETOR} WHERE id=$1`, [id])).rows[0]);
    } catch (e) {
      if (e.code === '23505') return res.status(409).json({ error: 'Já existe um setor com esse nome' });
      throw e;
    }
  }));
  r.put('/scenarium/sectors/:id', wrap(async (req, res) => {
    const { o, erro } = lerSetor(req.body || {}, true);
    if (erro) return res.status(400).json({ error: erro });
    const rg = await lerRegras(req.body || {});
    if (rg.erro) return res.status(400).json({ error: rg.erro });
    const atual = (await q(`${SETOR} WHERE id=$1`, [req.params.id])).rows[0];
    if (!atual) return res.status(404).json({ error: 'Setor não encontrado' });
    const n = { ...atual, ...o };
    try {
      await q('UPDATE scn_sectors SET name=$2, space=$3, notes=NULLIF($4,\'\'), position=$5, active=$6 WHERE id=$1', [req.params.id, n.name, n.space, n.notes || '', n.position, n.active]);
    } catch (e) {
      if (e.code === '23505') return res.status(409).json({ error: 'Já existe um setor com esse nome' });
      throw e;
    }
    await salvarRegras(req.params.id, rg.regras);
    res.json((await q(`${SETOR} WHERE id=$1`, [req.params.id])).rows[0]);
  }));
  r.delete('/scenarium/sectors/:id', wrap(async (req, res) => {
    try {
      const { rowCount } = await q('DELETE FROM scn_sectors WHERE id=$1', [req.params.id]);
      rowCount ? res.json({ ok: true }) : res.status(404).json({ error: 'Setor não encontrado' });
    } catch (e) {
      if (e.code === '23503') return res.status(409).json({ error: 'Esse setor tem reservas. Desative o setor em vez de apagar.' });
      throw e;
    }
  }));

  // ---------- tipos de mesa ----------
  const TIPO = 'SELECT id, name, seats, space::float AS space, active FROM scn_table_types';
  r.get('/scenarium/table-types', wrap(async (req, res) => res.json((await q(`${TIPO} ORDER BY seats, id`)).rows)));
  function lerTipo(b, parcial) {
    const o = {};
    if (!parcial || b.name !== undefined) { o.name = txt(b.name, 60); if (!o.name) return { erro: 'Informe o nome da mesa (até 60 letras)' }; }
    if (!parcial || b.seats !== undefined) { o.seats = inteiro(b.seats, 1, 200); if (o.seats === null) return { erro: 'Informe quantos lugares tem a mesa (1 a 200)' }; }
    if (!parcial || b.space !== undefined) { o.space = espaco(b.space, 0.01); if (o.space === null) return { erro: 'Informe o espaço que a mesa ocupa (maior que 0)' }; }
    if (b.active !== undefined) { if (typeof b.active !== 'boolean') return { erro: 'Ativo inválido' }; o.active = b.active; }
    return { o };
  }
  r.post('/scenarium/table-types', wrap(async (req, res) => {
    const { o, erro } = lerTipo(req.body || {}, false);
    if (erro) return res.status(400).json({ error: erro });
    try {
      const id = (await q('INSERT INTO scn_table_types (name, seats, space) VALUES ($1,$2,$3) RETURNING id', [o.name, o.seats, o.space])).rows[0].id;
      res.status(201).json((await q(`${TIPO} WHERE id=$1`, [id])).rows[0]);
    } catch (e) {
      if (e.code === '23505') return res.status(409).json({ error: 'Já existe uma mesa com esse nome' });
      throw e;
    }
  }));
  r.put('/scenarium/table-types/:id', wrap(async (req, res) => {
    const { o, erro } = lerTipo(req.body || {}, true);
    if (erro) return res.status(400).json({ error: erro });
    const atual = (await q(`${TIPO} WHERE id=$1`, [req.params.id])).rows[0];
    if (!atual) return res.status(404).json({ error: 'Mesa não encontrada' });
    const n = { ...atual, ...o };
    try {
      await q('UPDATE scn_table_types SET name=$2, seats=$3, space=$4, active=$5 WHERE id=$1', [req.params.id, n.name, n.seats, n.space, n.active]);
    } catch (e) {
      if (e.code === '23505') return res.status(409).json({ error: 'Já existe uma mesa com esse nome' });
      throw e;
    }
    res.json((await q(`${TIPO} WHERE id=$1`, [req.params.id])).rows[0]);
  }));
  r.delete('/scenarium/table-types/:id', wrap(async (req, res) => {
    const { rowCount } = await q('DELETE FROM scn_table_types WHERE id=$1', [req.params.id]);
    rowCount ? res.json({ ok: true }) : res.status(404).json({ error: 'Mesa não encontrada' });
  }));

  // ---------- ocasião (evento ou data) ----------
  // Devolve { event, event_id, date } ou { erro }
  async function ocasiao(src) {
    if (src.event_id === 'next') {   // o próximo evento que ainda vale (mesma regra da tela de Eventos)
      const tz = await fuso();
      const e = (await q(`SELECT id, title, starts_at, to_char(starts_at AT TIME ZONE $1, 'YYYY-MM-DD') AS dia FROM events
                          WHERE COALESCE(ends_at, starts_at + interval '3 hours') > now() ORDER BY starts_at, id LIMIT 1`, [tz])).rows[0];
      if (!e) return { erro: 'Não há evento marcado' };
      return { event: e, event_id: e.id, date: e.dia };
    }
    const ev = src.event_id !== undefined && src.event_id !== null && src.event_id !== '' ? idOk(src.event_id) : null;
    if (src.event_id && !ev) return { erro: 'Evento inválido' };
    if (ev) {
      const tz = await fuso();
      const e = (await q("SELECT id, title, starts_at, to_char(starts_at AT TIME ZONE $2, 'YYYY-MM-DD') AS dia FROM events WHERE id=$1", [ev, tz])).rows[0];
      if (!e) return { erro: 'Evento não encontrado' };
      return { event: e, event_id: e.id, date: e.dia };
    }
    const d = dataOk(src.date);
    if (!d) return { erro: 'Informe o evento ou a data (AAAA-MM-DD)' };
    return { event: null, event_id: null, date: d };
  }
  const filtroOcasiao = (oc, a, alias = '') => {
    if (oc.event_id) { a.push(oc.event_id); return `${alias}event_id = $${a.length}`; }
    a.push(oc.date); return `(${alias}event_id IS NULL AND ${alias}occasion_date = $${a.length}::date)`;
  };

  // Situação dos setores nessa ocasião: espaço, usado, livre e, se pedido, onde cabe `people` pessoas
  async function situacao(oc, { people, sectorId } = {}, run = q) {
    const setores = (await run(`${SETOR} WHERE active ${sectorId ? 'AND id = $1' : ''} ORDER BY position, id`, sectorId ? [sectorId] : [])).rows;
    const tipos = (await run(`${TIPO} WHERE active ORDER BY seats, id`)).rows;
    const over = oc.event_id ? (await run('SELECT sector_id, space::float AS space FROM scn_event_sectors WHERE event_id=$1', [oc.event_id])).rows : [];
    const a = [OCUPAM];
    const f = filtroOcasiao(oc, a);
    const uso = (await run(
      `SELECT sector_id, COUNT(*)::int AS reservations, COALESCE(SUM(people),0)::int AS people, COALESCE(SUM(tables * space_each),0)::float AS used,
              COALESCE(SUM(tables * seats_each),0)::int AS seats
       FROM scn_reservations WHERE status = ANY($1) AND ${f} GROUP BY sector_id`, a)).rows;
    const a2 = [OCUPAM];
    const f2 = filtroOcasiao(oc, a2);
    const usoTipo = (await run(
      `SELECT sector_id, table_type_id, SUM(tables)::int AS tables FROM scn_reservations
       WHERE status = ANY($1) AND table_type_id IS NOT NULL AND ${f2} GROUP BY sector_id, table_type_id`, a2)).rows;
    const a4 = [];
    const f4 = filtroOcasiao(oc, a4);
    const extras = (await run(`SELECT sector_id, table_type_id, COALESCE(SUM(quantity),0)::int AS qtd, COALESCE(SUM(quantity * space_each),0)::float AS space
                               FROM scn_extras WHERE ${f4} GROUP BY sector_id, table_type_id`, a4)).rows;
    return setores.map((s) => {
      const o = over.find((x) => String(x.sector_id) === String(s.id));
      const meusExtras = extras.filter((x) => String(x.sector_id) === String(s.id));
      const espacoExtra = r2(meusExtras.reduce((a, x) => a + x.space, 0));
      const total = r2((o ? o.space : s.space) + espacoExtra);
      const u = uso.find((x) => String(x.sector_id) === String(s.id)) || { reservations: 0, people: 0, used: 0, seats: 0 };
      const usado = r2(u.used);
      const livre = r2(Math.max(0, total - usado));
      // mesas que o setor aceita (sem regras = todas) e, para cada uma, quantas ainda cabem pelo limite do setor
      const regras = s.tables || [];
      const extraDe = (t) => meusExtras.filter((x) => String(x.table_type_id) === String(t.id)).reduce((a, x) => a + x.qtd, 0);
      const permitidos = tipos.filter((t) => !regras.length || regras.some((g) => String(g.table_type_id) === String(t.id)) || extraDe(t) > 0).map((t) => {
        const g = regras.find((x) => String(x.table_type_id) === String(t.id));
        const ex = extraDe(t);
        const jaTem = usoTipo.find((x) => String(x.sector_id) === String(s.id) && String(x.table_type_id) === String(t.id))?.tables || 0;
        const maximo = g && g.max_tables ? g.max_tables + ex : (!g && regras.length ? ex : null);   // mesa fora das regras só existe como extra
        return { ...t, left: maximo === null ? undefined : Math.max(0, maximo - jaTem) };
      });
      const cabe = (t) => { const porEspaco = Math.floor((livre + 1e-9) / t.space); return t.left === undefined ? porEspaco : Math.min(porEspaco, t.left); };
      const out = {
        sector_id: s.id, name: s.name, notes: s.notes, base_space: s.space, space: total, custom_space: !!o, extra_space: espacoExtra, extra_tables: meusExtras.reduce((a, x) => a + x.qtd, 0),
        used: usado, free: livre, reservations: u.reservations, people: u.people, seats_reserved: u.seats,
        max_table_seats: permitidos.reduce((m, t) => Math.max(m, t.seats), 0),
        // quantas mesas de cada tipo ainda cabem se só esse tipo fosse usado (respeitando as regras do setor)
        fits: permitidos.map((t) => ({ table_type_id: t.id, name: t.name, seats: t.seats, tables: cabe(t), seats_total: cabe(t) * t.seats })),
      };
      if (people) {
        const ops = opcoes(permitidos, people, livre);
        out.can_fit = ops.length > 0;
        const fmt = (m) => ({ table_type_id: m.type.id, name: m.type.name, seats: m.type.seats, space_each: m.type.space, tables: m.tables, space: m.space });
        out.option = ops[0] ? fmt(ops[0]) : null;
        out.options = ops.slice(0, 4).map(fmt);
      }
      return out;
    });
  }

  // Vagas por setor. ?event_id= ou ?date= ; ?people=N diz onde cabe esse grupo ; ?sector_id= limita a um setor
  r.get('/scenarium/availability', wrap(async (req, res) => {
    const oc = await ocasiao(req.query);
    if (oc.erro) return res.status(400).json({ error: oc.erro });
    let people = null;
    if (req.query.people !== undefined && req.query.people !== '') {
      people = inteiro(req.query.people, 1, 1000);
      if (people === null) return res.status(400).json({ error: 'Quantidade de pessoas inválida' });
    }
    let sectorId = null;
    if (req.query.sector_id) { sectorId = idOk(req.query.sector_id); if (!sectorId) return res.status(400).json({ error: 'Setor inválido' }); }
    const sectors = await situacao(oc, { people, sectorId });
    res.json({
      event: oc.event ? { id: oc.event.id, title: oc.event.title, starts_at: oc.event.starts_at } : null,
      date: oc.date, people, sectors,
      ...(people ? { sectors_with_room: sectors.filter((s) => s.can_fit).map((s) => s.name) } : {}),
    });
  }));

  // Eventos que ainda valem, cada um com o resumo das vagas. É a lista que o atendente usa para saber "qual evento é qual",
  // sem depender de "show atual" e "show seguinte": cada evento tem nome, data e a própria lista de reservas.
  r.get('/scenarium/events', wrap(async (req, res) => {
    const tz = await fuso();
    const evs = (await q(`SELECT id, title, starts_at, ends_at, place, notes, to_char(starts_at AT TIME ZONE $1, 'YYYY-MM-DD') AS dia FROM events
                          WHERE COALESCE(ends_at, starts_at + interval '3 hours') > now() ORDER BY starts_at, id LIMIT 20`, [tz])).rows;
    const out = [];
    for (const e of evs) {
      const sectors = await situacao({ event_id: e.id, date: e.dia });
      out.push({
        id: e.id, title: e.title, starts_at: e.starts_at, ends_at: e.ends_at, place: e.place, notes: e.notes, date: e.dia,
        reservations: sectors.reduce((a, x) => a + x.reservations, 0), people: sectors.reduce((a, x) => a + x.people, 0),
        interested: (await q('SELECT COUNT(*)::int AS n FROM scn_event_interest WHERE event_id=$1', [e.id])).rows[0].n,
        sectors: sectors.map((x) => ({ sector_id: x.sector_id, name: x.name, free: x.free, space: x.space })),
        sectors_with_room: sectors.filter((x) => x.free > 0).map((x) => x.name),
      });
    }
    res.json(out);
  }));

  // ---------- preço e palavras-chave do evento ----------
  // Preço por pessoa valendo agora, já considerando a palavra-chave (se vier) e, opcionalmente, outro desconto em % já reconhecido
  // (ex.: o do programa de benefícios). Descontos não se somam: vale o que sair mais barato.
  async function precoPara(run, eventId, palavra, outroPct, excluirReserva) {
    const c = (await run('SELECT price::float AS price, door_price::float AS door_price, price_until FROM scn_event_conditions WHERE event_id=$1', [eventId])).rows[0];
    if (!c || c.price === null) return { unit_price: null, base_price: null, code_valid: !palavra, reason: palavra ? 'Este evento não tem preço cadastrado' : undefined };
    const portaria = c.price_until && c.door_price !== null && new Date() > new Date(c.price_until);
    const base = portaria ? c.door_price : c.price;
    const out = { base_price: base, tier: portaria ? 'portaria' : 'normal', unit_price: base, applied: null, code_valid: true };
    if (outroPct) {
      const v = r2(base * (1 - outroPct / 100));
      if (v < out.unit_price) { out.unit_price = v; out.applied = 'other'; }
    }
    if (palavra) {
      const k = (await run('SELECT * FROM scn_event_codes WHERE event_id=$1 AND word_norm=$2', [eventId, norma(palavra)])).rows[0];
      if (!k) return { ...out, code_valid: false, reason: 'Palavra-chave não encontrada neste evento' };
      if (k.valid_until && new Date() > new Date(k.valid_until)) return { ...out, code_valid: false, reason: 'Essa palavra-chave já expirou' };
      if (k.max_uses) {
        const usos = Number((await run(`SELECT COUNT(*) AS n FROM scn_reservations WHERE code_id=$1 AND status = ANY($2)${excluirReserva ? ' AND id <> ' + Number(excluirReserva) : ''}`, [k.id, OCUPAM])).rows[0].n);
        if (usos >= k.max_uses) return { ...out, code_valid: false, reason: 'Essa palavra-chave já atingiu o limite de usos' };
      }
      const v = k.kind === 'percent' ? r2(base * (1 - Number(k.value) / 100)) : r2(Number(k.value));
      if (v <= out.unit_price) { out.unit_price = v; out.applied = 'code'; }
      out.code_id = k.id; out.code_word = k.word; out.code = { kind: k.kind, value: Number(k.value), note: k.note };
    }
    return out;
  }

  async function eventoDe(ref) {
    const oc = await ocasiao({ event_id: ref });
    return oc.erro ? null : oc.event;
  }
  const COND = 'SELECT price::float AS price, door_price::float AS door_price, price_until, instructions FROM scn_event_conditions WHERE event_id=$1';
  r.get('/scenarium/events/:id/conditions', wrap(async (req, res) => {
    const ev = await eventoDe(req.params.id);
    if (!ev) return res.status(404).json({ error: 'Evento não encontrado' });
    const c = (await q(COND, [ev.id])).rows[0] || { price: null, door_price: null, price_until: null, instructions: null };
    res.json({ event_id: ev.id, ...c });
  }));
  r.put('/scenarium/events/:id/conditions', wrap(async (req, res) => {
    const ev = await eventoDe(req.params.id);
    if (!ev) return res.status(404).json({ error: 'Evento não encontrado' });
    const b = req.body || {};
    const atual = (await q(COND, [ev.id])).rows[0] || { price: null, door_price: null, price_until: null, instructions: null };
    const n = { ...atual };
    for (const k of ['price', 'door_price']) {
      if (b[k] === undefined) continue;
      if (b[k] === null || b[k] === '') { n[k] = null; continue; }
      n[k] = dinheiro(b[k]);
      if (n[k] === null) return res.status(400).json({ error: 'Valor inválido' });
    }
    if (b.price_until !== undefined) {
      if (b.price_until === null || b.price_until === '') n.price_until = null;
      else { const d = new Date(b.price_until); if (isNaN(d)) return res.status(400).json({ error: 'Prazo do preço inválido' }); n.price_until = d.toISOString(); }
    }
    if (b.instructions !== undefined) {
      const t = txt(b.instructions, 2000);
      if (t === null) return res.status(400).json({ error: 'Instruções inválidas (até 2000 letras)' });
      n.instructions = t || null;
    }
    if (n.price === null && (n.door_price !== null || n.price_until)) return res.status(400).json({ error: 'Informe o preço do ingresso' });
    await q(`INSERT INTO scn_event_conditions (event_id, price, door_price, price_until, instructions) VALUES ($1,$2,$3,$4,$5)
             ON CONFLICT (event_id) DO UPDATE SET price=EXCLUDED.price, door_price=EXCLUDED.door_price, price_until=EXCLUDED.price_until, instructions=EXCLUDED.instructions`,
      [ev.id, n.price, n.door_price, n.price_until, n.instructions]);
    res.json({ event_id: ev.id, ...(await q(COND, [ev.id])).rows[0] });
  }));

  const CODIGO = `SELECT k.id, k.event_id, k.word, k.kind, k.value::float AS value, k.max_uses, k.valid_until, k.note,
                         (SELECT COUNT(*)::int FROM scn_reservations v WHERE v.code_id = k.id AND v.status IN ('confirmed','attended')) AS uses
                  FROM scn_event_codes k`;
  r.get('/scenarium/events/:id/codes', wrap(async (req, res) => {
    const ev = await eventoDe(req.params.id);
    if (!ev) return res.status(404).json({ error: 'Evento não encontrado' });
    res.json((await q(`${CODIGO} WHERE k.event_id=$1 ORDER BY k.id`, [ev.id])).rows);
  }));
  function lerCodigo(b, parcial, atual) {
    const o = {};
    if (!parcial || b.word !== undefined) {
      o.word = txt(b.word, 40);
      if (!o.word || !norma(o.word)) return { erro: 'Informe a palavra-chave (até 40 letras)' };
      o.word_norm = norma(o.word);
    }
    if (!parcial || b.kind !== undefined) { if (!['percent', 'price'].includes(b.kind)) return { erro: 'Escolha o tipo do desconto (percentual ou preço fixo)' }; o.kind = b.kind; }
    if (!parcial || b.value !== undefined) {
      const v = dinheiro(b.value);
      if (v === null) return { erro: 'Valor inválido' };
      o.value = v;
    }
    const kind = o.kind || atual?.kind, value = o.value ?? atual?.value;
    if (kind === 'percent' && !(value > 0 && value <= 100)) return { erro: 'O percentual precisa ser maior que 0 e no máximo 100' };
    if (b.max_uses !== undefined) {
      if (b.max_uses === null || b.max_uses === '') o.max_uses = null;
      else { o.max_uses = inteiro(b.max_uses, 1, 100000); if (o.max_uses === null) return { erro: 'Limite de usos inválido' }; }
    }
    if (b.valid_until !== undefined) {
      if (b.valid_until === null || b.valid_until === '') o.valid_until = null;
      else { const d = new Date(b.valid_until); if (isNaN(d)) return { erro: 'Validade inválida' }; o.valid_until = d.toISOString(); }
    }
    if (b.note !== undefined) { o.note = txt(b.note, 300); if (o.note === null) return { erro: 'Anotação inválida (até 300 letras)' }; }
    return { o };
  }
  r.post('/scenarium/events/:id/codes', wrap(async (req, res) => {
    const ev = await eventoDe(req.params.id);
    if (!ev) return res.status(404).json({ error: 'Evento não encontrado' });
    const { o, erro } = lerCodigo(req.body || {}, false);
    if (erro) return res.status(400).json({ error: erro });
    try {
      const id = (await q(`INSERT INTO scn_event_codes (event_id, word, word_norm, kind, value, max_uses, valid_until, note) VALUES ($1,$2,$3,$4,$5,$6,$7,NULLIF($8,'')) RETURNING id`,
        [ev.id, o.word, o.word_norm, o.kind, o.value, o.max_uses ?? null, o.valid_until ?? null, o.note || ''])).rows[0].id;
      res.status(201).json((await q(`${CODIGO} WHERE k.id=$1`, [id])).rows[0]);
    } catch (e) {
      if (e.code === '23505') return res.status(409).json({ error: 'Já existe essa palavra-chave neste evento' });
      throw e;
    }
  }));
  r.put('/scenarium/codes/:id', wrap(async (req, res) => {
    const atual = (await q(`${CODIGO} WHERE k.id=$1`, [req.params.id])).rows[0];
    if (!atual) return res.status(404).json({ error: 'Palavra-chave não encontrada' });
    const { o, erro } = lerCodigo(req.body || {}, true, atual);
    if (erro) return res.status(400).json({ error: erro });
    const n = { ...atual, ...o, word_norm: o.word_norm || norma(atual.word) };
    try {
      await q(`UPDATE scn_event_codes SET word=$2, word_norm=$3, kind=$4, value=$5, max_uses=$6, valid_until=$7, note=NULLIF($8,'') WHERE id=$1`,
        [req.params.id, n.word, n.word_norm, n.kind, n.value, n.max_uses ?? null, n.valid_until ?? null, n.note || '']);
    } catch (e) {
      if (e.code === '23505') return res.status(409).json({ error: 'Já existe essa palavra-chave neste evento' });
      throw e;
    }
    res.json((await q(`${CODIGO} WHERE k.id=$1`, [req.params.id])).rows[0]);
  }));
  r.delete('/scenarium/codes/:id', wrap(async (req, res) => {
    const { rowCount } = await q('DELETE FROM scn_event_codes WHERE id=$1', [req.params.id]);
    rowCount ? res.json({ ok: true }) : res.status(404).json({ error: 'Palavra-chave não encontrada' });
  }));

  // Quanto custa o ingresso agora? ?code=palavra (opcional) ; ?people=N (total = N × valor) ; ?other_percent=10 (outro desconto já reconhecido, ex.: programa de benefícios)
  // O atendente usa esta rota: ela nunca devolve a lista de palavras, só diz se a palavra dita vale.
  r.get('/scenarium/events/:id/price', wrap(async (req, res) => {
    const ev = await eventoDe(req.params.id);
    if (!ev) return res.status(404).json({ error: 'Evento não encontrado' });
    const people = req.query.people ? inteiro(req.query.people, 1, 1000) : null;
    if (req.query.people && !people) return res.status(400).json({ error: 'Quantidade de pessoas inválida' });
    const outro = req.query.other_percent ? num(req.query.other_percent) : 0;
    if (outro === null || outro < 0 || outro > 100) return res.status(400).json({ error: 'Percentual inválido' });
    const pr = await precoPara(q, ev.id, String(req.query.code || '').trim(), outro, null);
    const ins = (await q('SELECT instructions FROM scn_event_conditions WHERE event_id=$1', [ev.id])).rows[0]?.instructions || null;
    res.json({ event: { id: ev.id, title: ev.title }, ...pr, code_id: undefined, people, total: people && pr.unit_price !== null ? r2(people * pr.unit_price) : null, instructions: ins });
  }));

  // Duplica um evento (também um já realizado): mesmas condições, palavras-chave e espaço dos setores, com a lista de reservas vazia.
  // As datas de preço e validade acompanham a diferença entre o evento antigo e o novo. Mesas extras e reservas não são copiadas.
  r.post('/scenarium/events/:id/duplicate', wrap(async (req, res) => {
    const ev0 = await eventoDe(req.params.id);
    if (!ev0) return res.status(404).json({ error: 'Evento não encontrado' });
    const b = req.body || {};
    const novoInicio = new Date(b.starts_at);
    if (!b.starts_at || isNaN(novoInicio)) return res.status(400).json({ error: 'Informe a data e a hora do novo evento' });
    const orig = (await q('SELECT * FROM events WHERE id=$1', [ev0.id])).rows[0];
    let titulo = orig.title;
    if (b.title !== undefined) { titulo = txt(b.title, 120); if (!titulo) return res.status(400).json({ error: 'Nome do evento inválido' }); }
    const delta = novoInicio.getTime() - new Date(orig.starts_at).getTime();
    const mover = (d) => (d ? new Date(new Date(d).getTime() + delta).toISOString() : null);
    const fim = orig.ends_at ? mover(orig.ends_at) : null;
    const novo = await tx(currentCompany(), async (t) => {
      const e = (await t('INSERT INTO events (title, starts_at, ends_at, place, notes) VALUES ($1,$2,$3,$4,$5) RETURNING *', [titulo, novoInicio.toISOString(), fim, orig.place, orig.notes])).rows[0];
      await t('INSERT INTO scn_event_sectors (event_id, sector_id, space) SELECT $2, sector_id, space FROM scn_event_sectors WHERE event_id=$1', [orig.id, e.id]);
      const c = (await t('SELECT * FROM scn_event_conditions WHERE event_id=$1', [orig.id])).rows[0];
      if (c) await t('INSERT INTO scn_event_conditions (event_id, price, door_price, price_until, instructions) VALUES ($1,$2,$3,$4,$5)', [e.id, c.price, c.door_price, mover(c.price_until), c.instructions]);
      const ks = (await t('SELECT * FROM scn_event_codes WHERE event_id=$1 ORDER BY id', [orig.id])).rows;
      for (const k of ks) await t('INSERT INTO scn_event_codes (event_id, word, word_norm, kind, value, max_uses, valid_until, note) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)', [e.id, k.word, k.word_norm, k.kind, k.value, k.max_uses, mover(k.valid_until), k.note]);
      return { event: e, codes: ks.length, has_conditions: !!c };
    });
    res.status(201).json(novo);
  }));

  // Quem pergunta sobre o evento vira lead (e fica registrado como interessado nele). Quem já é cliente continua cliente.
  r.post('/scenarium/events/:id/interest', wrap(async (req, res) => {
    const ev = await eventoDe(req.params.id);
    if (!ev) return res.status(404).json({ error: 'Evento não encontrado' });
    const phone = normPhone(req.body?.phone);
    if (!/^\d{8,15}$/.test(phone)) return res.status(400).json({ error: 'Telefone inválido' });
    const nome = req.body?.name === undefined ? null : txt(req.body.name, 120);
    if (nome === null && req.body?.name !== undefined) return res.status(400).json({ error: 'Nome inválido' });
    const cu = (await q(`INSERT INTO customers (name, phone, status, source) VALUES (NULLIF($1,''),$2,'lead',$3)
                         ON CONFLICT (phone) DO UPDATE SET name = COALESCE(customers.name, EXCLUDED.name) RETURNING id, status`, [nome || '', phone, quem(req)])).rows[0];
    const novo = (await q('INSERT INTO scn_event_interest (event_id, customer_id) VALUES ($1,$2) ON CONFLICT DO NOTHING', [ev.id, cu.id])).rowCount === 1;
    res.status(novo ? 201 : 200).json({ customer_id: cu.id, status: cu.status, already: !novo });
  }));

  // ---------- mesas extras ----------
  // Abrir à mão uma mesa fora do que o setor comporta (ex.: tirar um pedaço da pista). Vale só para o evento/data e já aparece nas vagas.
  const EXTRA = `SELECT x.id, x.event_id, x.occasion_date::text AS date, x.sector_id, s.name AS sector_name, x.table_type_id, x.table_name, x.seats_each,
                        x.space_each::float AS space_each, x.quantity, (x.quantity * x.space_each)::float AS space, x.note, x.created_at
                 FROM scn_extras x JOIN scn_sectors s ON s.id = x.sector_id`;
  r.get('/scenarium/extras', wrap(async (req, res) => {
    const oc = await ocasiao(req.query);
    if (oc.erro) return res.status(400).json({ error: oc.erro });
    const a = [];
    const f = filtroOcasiao(oc, a, 'x.');
    res.json((await q(`${EXTRA} WHERE ${f} ORDER BY x.id`, a)).rows);
  }));
  r.post('/scenarium/extras', wrap(async (req, res) => {
    const b = req.body || {};
    const oc = await ocasiao(b);
    if (oc.erro) return res.status(400).json({ error: oc.erro });
    const sid = idOk(b.sector_id);
    if (!sid || !(await q('SELECT 1 FROM scn_sectors WHERE id=$1', [sid])).rows[0]) return res.status(400).json({ error: 'Setor não encontrado' });
    const tid = idOk(b.table_type_id);
    const tipo = tid && (await q(`${TIPO} WHERE id=$1`, [tid])).rows[0];
    if (!tipo) return res.status(400).json({ error: 'Escolha o tipo da mesa extra' });
    const qtd = b.quantity === undefined ? 1 : inteiro(b.quantity, 1, 100);
    if (!qtd) return res.status(400).json({ error: 'Quantidade inválida (1 a 100)' });
    const note = b.note === undefined ? '' : txt(b.note, 300);
    if (note === null) return res.status(400).json({ error: 'Anotação inválida (até 300 letras)' });
    const id = (await q(`INSERT INTO scn_extras (event_id, occasion_date, sector_id, table_type_id, table_name, seats_each, space_each, quantity, note)
                         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,NULLIF($9,'')) RETURNING id`, [oc.event_id, oc.date, sid, tipo.id, tipo.name, tipo.seats, tipo.space, qtd, note])).rows[0].id;
    res.status(201).json((await q(`${EXTRA} WHERE x.id=$1`, [id])).rows[0]);
  }));
  // Fechar a mesa extra só é possível se o setor continua comportando as reservas que já tem
  r.delete('/scenarium/extras/:id', comTratamento(async (req, res) => {
    const x = (await q('SELECT * FROM scn_extras WHERE id=$1', [req.params.id])).rows[0];
    if (!x) return res.status(404).json({ error: 'Mesa extra não encontrada' });
    const oc = { event_id: x.event_id, date: String(x.occasion_date instanceof Date ? x.occasion_date.toISOString().slice(0, 10) : x.occasion_date).slice(0, 10) };
    await tx(currentCompany(), async (t) => {
      await t('SELECT pg_advisory_xact_lock(hashtext($1))', [`scn:${currentCompany()}:${oc.event_id || oc.date}`]);
      await t('DELETE FROM scn_extras WHERE id=$1', [x.id]);
      const [s] = await situacao(oc, { sectorId: x.sector_id }, t);
      let estoura = s && s.used > s.space + 1e-9;
      if (!estoura && x.table_type_id) {
        const g = await regraDoTipo(t, oc, x.sector_id, x.table_type_id);
        if (g.max !== null) {
          const a = [OCUPAM, x.sector_id, x.table_type_id];
          const f = filtroOcasiao(oc, a);
          const ja = Number((await t(`SELECT COALESCE(SUM(tables),0) AS n FROM scn_reservations WHERE status = ANY($1) AND sector_id=$2 AND table_type_id=$3 AND ${f}`, a)).rows[0].n);
          estoura = ja > g.max;
        }
      }
      if (estoura) { const e = new Error('Essa mesa extra já está em uso por uma reserva. Cancele ou mude a reserva primeiro.'); e.status = 409; throw e; }
    });
    res.json({ ok: true });
  }));

  // Ajusta o espaço dos setores só para um evento. Corpo: { sectors: [{ sector_id, space }] } ; space null volta ao padrão do setor.
  r.put('/scenarium/events/:id/sectors', wrap(async (req, res) => {
    const ev = idOk(req.params.id);
    if (!ev || !(await q('SELECT 1 FROM events WHERE id=$1', [ev])).rows[0]) return res.status(404).json({ error: 'Evento não encontrado' });
    const lista = Array.isArray(req.body?.sectors) ? req.body.sectors : null;
    if (!lista) return res.status(400).json({ error: 'Informe os setores' });
    const itens = [];
    for (const it of lista) {
      const sid = idOk(it?.sector_id);
      if (!sid || !(await q('SELECT 1 FROM scn_sectors WHERE id=$1', [sid])).rows[0]) return res.status(400).json({ error: 'Setor não encontrado' });
      if (it.space === null || it.space === '' || it.space === undefined) { itens.push([sid, null]); continue; }
      const v = espaco(it.space, 0);
      if (v === null) return res.status(400).json({ error: 'Espaço inválido' });
      itens.push([sid, v]);
    }
    await tx(currentCompany(), async (t) => {
      for (const [sid, v] of itens) {
        if (v === null) await t('DELETE FROM scn_event_sectors WHERE event_id=$1 AND sector_id=$2', [ev, sid]);
        else await t('INSERT INTO scn_event_sectors (event_id, sector_id, space) VALUES ($1,$2,$3) ON CONFLICT (event_id, sector_id) DO UPDATE SET space=EXCLUDED.space', [ev, sid, v]);
      }
    });
    res.json({ ok: true });
  }));

  // ---------- reservas ----------
  const RESERVA = `SELECT v.id, v.event_id, e.title AS event_title, v.occasion_date::text AS date, v.sector_id, s.name AS sector_name,
                          v.customer_id, v.name, v.phone, v.people, v.table_type_id, v.table_name, v.seats_each, v.space_each::float AS space_each,
                          v.tables, (v.tables * v.space_each)::float AS space, (v.tables * v.seats_each) AS seats, v.status, v.note, v.guests, v.unit_price::float AS unit_price, (v.people * v.unit_price)::float AS total, v.code_word, v.created_at
                   FROM scn_reservations v JOIN scn_sectors s ON s.id = v.sector_id LEFT JOIN events e ON e.id = v.event_id`;

  r.get('/scenarium/reservations', wrap(async (req, res) => {
    const w = [], a = [];
    if (req.query.event_id) { const e = idOk(req.query.event_id); if (!e) return res.status(400).json({ error: 'Evento inválido' }); a.push(e); w.push(`v.event_id = $${a.length}`); }
    if (req.query.date) { const d = dataOk(req.query.date); if (!d) return res.status(400).json({ error: 'Data inválida' }); a.push(d); w.push(`v.occasion_date = $${a.length}::date`); }
    if (req.query.sector_id) { const s = idOk(req.query.sector_id); if (!s) return res.status(400).json({ error: 'Setor inválido' }); a.push(s); w.push(`v.sector_id = $${a.length}`); }
    if (req.query.status) { if (!STATUS.includes(req.query.status)) return res.status(400).json({ error: 'Situação inválida' }); a.push(req.query.status); w.push(`v.status = $${a.length}`); }
    if (req.query.phone) { a.push(normPhone(req.query.phone)); w.push(`v.phone = $${a.length}`); }
    if (req.query.upcoming === 'true') {
      const tz = await fuso();
      a.push(tz); w.push(`v.occasion_date >= (now() AT TIME ZONE $${a.length})::date`);
    }
    res.json((await q(`${RESERVA} ${w.length ? 'WHERE ' + w.join(' AND ') : ''} ORDER BY v.occasion_date, s.position, v.id LIMIT 1000`, a)).rows);
  }));

  // O setor aceita esse tipo de mesa nessa ocasião? E até quantas (null = sem limite)? Mesas extras abertas à mão contam.
  async function regraDoTipo(run, oc, sid, tid) {
    const regras = (await run('SELECT table_type_id::text AS t, max_tables FROM scn_sector_tables WHERE sector_id=$1', [sid])).rows;
    const g = regras.find((x) => x.t === String(tid));
    const a = [sid, tid];
    const f = filtroOcasiao(oc, a);
    const ex = Number((await run(`SELECT COALESCE(SUM(quantity),0) AS n FROM scn_extras WHERE sector_id=$1 AND table_type_id=$2 AND ${f}`, a)).rows[0].n);
    return { aceito: !regras.length || !!g || ex > 0, max: g && g.max_tables ? g.max_tables + ex : (!g && regras.length ? ex : null) };
  }

  // Confere se cabe e grava, tudo dentro de uma transação trancada por ocasião (duas reservas ao mesmo tempo não estouram o setor)
  async function gravar({ id, oc, setor, tipo, tables, people, status, nome, phone, cid, note, guests, confereMesa, preco, aniversario }) {
    return tx(currentCompany(), async (t) => {
      await t('SELECT pg_advisory_xact_lock(hashtext($1))', [`scn:${currentCompany()}:${oc.event_id || oc.date}`]);
      if (OCUPAM.includes(status) && confereMesa && tipo.id) {
        // limite de mesas desse tipo no setor, contando as extras (só a própria reserva em edição não conta)
        const g = await regraDoTipo(t, oc, setor.id, tipo.id);
        if (g.max !== null) {
          const a3 = [OCUPAM, setor.id, tipo.id];
          const f3 = filtroOcasiao(oc, a3);
          const ja = Number((await t(`SELECT COALESCE(SUM(tables),0) AS n FROM scn_reservations WHERE status = ANY($1) AND sector_id=$2 AND table_type_id=$3 AND ${f3}${id ? ` AND id <> ${Number(id)}` : ''}`, a3)).rows[0].n);
          if (ja + tables > g.max) {
            const e = new Error(`O setor ${setor.name} comporta no máximo ${g.max} mesa(s) de ${tipo.name} e já tem ${ja}.`); e.status = 409; throw e;
          }
        }
      }
      if (OCUPAM.includes(status)) {
        const [s] = await situacao(oc, { sectorId: setor.id }, t);
        const jaUsa = id ? Number((await t('SELECT status, tables * space_each AS u, sector_id FROM scn_reservations WHERE id=$1', [id])).rows
          .filter((x) => OCUPAM.includes(x.status) && String(x.sector_id) === String(setor.id)).map((x) => x.u)[0] || 0) : 0;
        // para a edição, o espaço dela mesma conta como livre — mas só se a ocasião não mudou
        const antes = id ? (await t('SELECT event_id, occasion_date::text AS d FROM scn_reservations WHERE id=$1', [id])).rows[0] : null;
        const mesma = antes && String(antes.event_id || '') === String(oc.event_id || '') && (oc.event_id || antes.d === oc.date);
        const livre = s.free + (mesma ? jaUsa : 0);
        const preciso = r2(tables * tipo.space);
        if (preciso > livre + 1e-9) {
          const e = new Error(`Sem espaço no setor ${setor.name}: precisa de ${preciso} e restam ${r2(livre)}.`); e.status = 409; throw e;
        }
      }
      const params = [oc.event_id, oc.date, setor.id, cid, nome, phone, people, tipo.id, tipo.name, tipo.seats, tipo.space, tables, status, note, guests];
      const comprou = async (rid) => {   // reserva com valor pago > 0 transforma o contato em cliente (mesma regra das outras vendas)
        await t(`UPDATE customers SET status = 'client', client_kinds = CASE WHEN 'buyer' = ANY(client_kinds) THEN client_kinds ELSE array_append(client_kinds, 'buyer') END
                 WHERE id = (SELECT customer_id FROM scn_reservations WHERE id=$1 AND status IN ('confirmed','attended') AND unit_price > 0)
                   AND (status <> 'client' OR NOT 'buyer' = ANY(client_kinds))`, [rid]);
        if (aniversario) {   // aniversário informado na venda: grava na ficha só se ainda não houver
          await t(`UPDATE customers SET birth_day=$2, birth_month=$3, birth_year=COALESCE(birth_year, $4)
                   WHERE id = (SELECT customer_id FROM scn_reservations WHERE id=$1) AND birth_day IS NULL AND birth_month IS NULL`, [rid, aniversario.birth_day, aniversario.birth_month, aniversario.birth_year ?? null]);
        }
        return rid;
      };
      if (id) {
        await t(`UPDATE scn_reservations SET event_id=$2, occasion_date=$3, sector_id=$4, customer_id=$5, name=$6, phone=$7, people=$8, table_type_id=$9,
                   table_name=$10, seats_each=$11, space_each=$12, tables=$13, status=$14, note=NULLIF($15,''), guests=NULLIF($16,''),
                   unit_price = CASE WHEN $17::boolean THEN $18::numeric ELSE unit_price END, code_id = CASE WHEN $17::boolean THEN $19::bigint ELSE code_id END,
                   code_word = CASE WHEN $17::boolean THEN $20 ELSE code_word END, updated_at=now() WHERE id=$1`,
          [id, ...params.slice(0, 13), params[13] || '', params[14] || '', preco !== undefined, preco?.unit_price ?? null, preco?.code_id ?? null, preco?.code_word ?? null]);
        return comprou(id);
      }
      return comprou((await t(`INSERT INTO scn_reservations (event_id, occasion_date, sector_id, customer_id, name, phone, people, table_type_id, table_name, seats_each, space_each, tables, status, note, guests, unit_price, code_id, code_word)
                       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,NULLIF($14,''),NULLIF($15,''),$16,$17,$18) RETURNING id`,
        [...params, preco?.unit_price ?? null, preco?.code_id ?? null, preco?.code_word ?? null])).rows[0].id);
    });
  }

  // Monta e valida uma reserva a partir do corpo; `atual` = reserva existente (edição).
  async function preparar(b, atual, quemCriou) {
    const tem = (k) => b[k] !== undefined;
    // ocasião
    let oc;
    if (!atual || tem('event_id') || tem('date')) {
      oc = await ocasiao(atual && !tem('event_id') && !tem('date') ? { event_id: atual.event_id, date: atual.occasion_date } : b);
      if (oc.erro) return { erro: oc.erro };
    } else oc = { event_id: atual.event_id, date: atual.occasion_date };
    // setor
    const sid = tem('sector_id') ? idOk(b.sector_id) : atual?.sector_id;
    if (!sid) return { erro: 'Escolha o setor' };
    const setor = (await q('SELECT id, name, active FROM scn_sectors WHERE id=$1', [sid])).rows[0];
    if (!setor) return { erro: 'Setor não encontrado' };
    if (!setor.active && (!atual || String(atual.sector_id) !== String(setor.id))) return { erro: 'Esse setor está desativado' };
    // nome, telefone
    let nome = atual?.name, phone = atual?.phone ?? null;
    if (tem('name')) { nome = txt(b.name, 120); if (!nome) return { erro: 'Informe o nome de quem reserva' }; }
    if (!nome) return { erro: 'Informe o nome de quem reserva' };
    if (tem('phone')) {
      if (b.phone === null || b.phone === '') phone = null;
      else { phone = normPhone(b.phone); if (!/^\d{8,15}$/.test(phone)) return { erro: 'Telefone inválido' }; }
    }
    // pessoas
    const people = tem('people') ? inteiro(b.people, 1, 1000) : atual?.people;
    if (!people) return { erro: 'Informe quantas pessoas' };
    // situação
    const status = tem('status') ? b.status : (atual?.status || 'confirmed');
    if (!STATUS.includes(status)) return { erro: 'Situação inválida' };
    // anotação
    let note = atual?.note || '';
    if (tem('note')) { note = txt(b.note, 300); if (note === null) return { erro: 'Anotação inválida (até 300 letras)' }; }
    let guests = atual?.guests || '';
    if (tem('guests')) { guests = txt(b.guests, 2000); if (guests === null) return { erro: 'Lista de nomes inválida (até 2000 letras)' }; }
    // mesa: informada, ou escolhida sozinha (a que usa menos espaço) quando não informada
    const mudouMesa = tem('table_type_id') || tem('tables');
    let tipo, tables;
    if (atual && !mudouMesa && !tem('people')) {
      tipo = { id: atual.table_type_id, name: atual.table_name, seats: atual.seats_each, space: Number(atual.space_each) };
      tables = atual.tables;
    } else if (b.table_type_id !== undefined && b.table_type_id !== null && b.table_type_id !== '') {
      const tid = idOk(b.table_type_id);
      const row = tid && (await q(`${TIPO} WHERE id=$1`, [tid])).rows[0];
      if (!row) return { erro: 'Mesa não encontrada' };
      if (!row.active && !(atual && String(atual.table_type_id) === String(row.id))) return { erro: 'Essa mesa está desativada' };
      tipo = row;
      tables = tem('tables') ? inteiro(b.tables, 1, 100) : Math.ceil(people / row.seats);
      if (!tables) return { erro: 'Quantidade de mesas inválida' };
    } else if (atual && !tem('table_type_id') && (tem('tables') || tem('people'))) {
      // mantém o tipo da reserva, ajusta a quantidade
      tipo = { id: atual.table_type_id, name: atual.table_name, seats: atual.seats_each, space: Number(atual.space_each) };
      tables = tem('tables') ? inteiro(b.tables, 1, 100) : Math.ceil(people / tipo.seats);
      if (!tables) return { erro: 'Quantidade de mesas inválida' };
    } else {
      if (!(await q('SELECT 1 FROM scn_table_types WHERE active')).rows[0]) return { erro: 'Cadastre ao menos um tipo de mesa' };
      const [s] = await situacao(oc, { people, sectorId: setor.id });
      const m = s?.option;
      if (!m) { const e = `Sem espaço no setor ${setor.name} para ${people} pessoa(s).`; return { erro: e, status: 409 }; }
      tipo = { id: m.table_type_id, name: m.name, seats: m.seats, space: m.space_each }; tables = m.tables;
    }
    // o setor precisa aceitar essa mesa (confere ao criar ou quando mesa, setor ou grupo mudam)
    const confereMesa = !atual || mudouMesa || tem('sector_id') || tem('people') || (tem('status') && atual.status !== status);
    if (confereMesa && tipo.id) {
      const g = await regraDoTipo(q, oc, setor.id, tipo.id);
      if (!g.aceito) return { erro: `O setor ${setor.name} não aceita ${tipo.name} (${tipo.seats} lugar(es))` };
    }
    if (people > tables * tipo.seats) return { erro: `${tables} mesa(s) de ${tipo.seats} lugar(es) não comportam ${people} pessoas` };
    // cliente: liga ao cadastro pelo telefone (cria como contato se ainda não existir)
    let cid = atual?.customer_id ?? null;
    if (tem('customer_id')) {
      cid = b.customer_id === null || b.customer_id === '' ? null : idOk(b.customer_id);
      if (b.customer_id && !cid) return { erro: 'Cliente inválido' };
      if (cid && !(await q('SELECT 1 FROM customers WHERE id=$1', [cid])).rows[0]) return { erro: 'Cliente não encontrado' };
    } else if (phone && (!atual || tem('phone') || !cid)) {
      cid = (await q(`INSERT INTO customers (name, phone, status, source) VALUES ($1,$2,'lead',$3)
                      ON CONFLICT (phone) DO UPDATE SET name = COALESCE(customers.name, EXCLUDED.name) RETURNING id`, [nome, phone, quemCriou])).rows[0].id;
    }
    // aniversário (dd/mm ou dd/mm/aaaa) de quem reserva: vai para a ficha, sem sobrescrever o que já existe
    let aniversario;
    if (tem('birthday') && b.birthday !== null && String(b.birthday).trim() !== '') {
      aniversario = parseBirthday(b.birthday);
      if (!aniversario) return { erro: 'Data de aniversário inválida (use dd/mm ou dd/mm/aaaa)' };
    }
    // preço por pessoa: automático pelo evento, com palavra-chave de desconto, ou digitado à mão
    let preco;
    if (!atual || tem('code') || tem('unit_price')) {
      const palavra = tem('code') ? String(b.code ?? '').trim() : '';
      if (tem('unit_price') && b.unit_price !== null && b.unit_price !== '') {
        const v = dinheiro(b.unit_price);
        if (v === null) return { erro: 'Valor inválido' };
        preco = { unit_price: v, code_id: null, code_word: null };
      } else if (tem('unit_price')) {
        preco = { unit_price: null, code_id: null, code_word: null };
      } else if (oc.event_id) {
        const pr = await precoPara(q, oc.event_id, palavra, 0, atual?.id);
        if (palavra && !pr.code_valid) return { erro: pr.reason };
        if (pr.unit_price !== null) preco = { unit_price: pr.unit_price, code_id: pr.code_id || null, code_word: pr.code_id ? pr.code_word : null };
        else if (atual) preco = { unit_price: null, code_id: null, code_word: null };
      }
    }
    return { v: { oc, setor, tipo, tables, people, status, nome, phone, cid, note, guests, confereMesa, preco, aniversario } };
  }


  r.post('/scenarium/reservations', comTratamento(async (req, res) => {
    const p = await preparar(req.body || {}, null, quem(req));
    if (p.erro) return res.status(p.status || 400).json({ error: p.erro });
    const id = await gravar({ ...p.v });
    res.status(201).json((await q(`${RESERVA} WHERE v.id=$1`, [id])).rows[0]);
  }));

  r.put('/scenarium/reservations/:id', comTratamento(async (req, res) => {
    const atual = (await q('SELECT *, occasion_date::text AS occasion_date FROM scn_reservations WHERE id=$1', [req.params.id])).rows[0];
    if (!atual) return res.status(404).json({ error: 'Reserva não encontrada' });
    const p = await preparar(req.body || {}, atual, quem(req));
    if (p.erro) return res.status(p.status || 400).json({ error: p.erro });
    await gravar({ ...p.v, id: atual.id });
    res.json((await q(`${RESERVA} WHERE v.id=$1`, [atual.id])).rows[0]);
  }));

  r.delete('/scenarium/reservations/:id', wrap(async (req, res) => {
    const { rowCount } = await q('DELETE FROM scn_reservations WHERE id=$1', [req.params.id]);
    rowCount ? res.json({ ok: true }) : res.status(404).json({ error: 'Reserva não encontrada' });
  }));
}
