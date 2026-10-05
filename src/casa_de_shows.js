// Casa de Shows: venda de mesas e ingressos para casas de evento, controladas pelo ESPAÇO de cada setor.
// Ideia: o setor tem um espaço (em pontos) e cada tipo de mesa ocupa uma parte dele. Assim 2 mesas de 10 e 4 mesas de 4
// podem ocupar o mesmo espaço e render lotações diferentes (20 e 16 pessoas), e o sistema calcula o que ainda cabe.
//  - a venda é de um evento (ou, sem evento, de uma data) e de um setor
//  - o espaço do setor pode ser ajustado só para um evento (ex.: show com a pista reduzida)
//  - a venda guarda o tipo de mesa e o espaço usado na hora; mudar o cadastro depois não altera vendas antigas
//  - só ocupam espaço vendas "confirmada" e "compareceu"; cancelada e "não veio" liberam
import crypto from 'crypto';
import { q, qg, tx, currentCompany, runAs } from './db.js';
import { normPhone } from './phone.js';
import { parseBirthday } from './ficha.js';
import { beneficiosDeParceiros } from './parcerias.js';

export const CASA_DE_SHOWS_SQL = `
  ALTER TABLE customers ADD COLUMN IF NOT EXISTS client_kinds TEXT[] NOT NULL DEFAULT '{}';   -- perfis do cliente: buyer (comprador), hirer (contratante)
  CREATE TABLE IF NOT EXISTS shows_sectors (
    id       BIGSERIAL PRIMARY KEY,
    name     TEXT NOT NULL UNIQUE,
    space    NUMERIC(8,2) NOT NULL CHECK (space >= 0),        -- espaço total, em pontos
    notes    TEXT,                                            -- ex.: visão, som, observações do setor
    position INT NOT NULL DEFAULT 0,
    active   BOOLEAN NOT NULL DEFAULT true
  );
  CREATE TABLE IF NOT EXISTS shows_table_types (
    id       BIGSERIAL PRIMARY KEY,
    name     TEXT NOT NULL UNIQUE,
    seats    INT NOT NULL CHECK (seats BETWEEN 1 AND 200),    -- lugares
    space    NUMERIC(8,2) NOT NULL CHECK (space > 0),         -- espaço que uma mesa ocupa, em pontos
    active   BOOLEAN NOT NULL DEFAULT true
  );
  CREATE TABLE IF NOT EXISTS shows_sector_tables (              -- que mesas o setor aceita (sem linhas = aceita todas) e quantas de cada cabem
    sector_id     BIGINT NOT NULL REFERENCES shows_sectors(id) ON DELETE CASCADE,
    table_type_id BIGINT NOT NULL REFERENCES shows_table_types(id) ON DELETE CASCADE,
    max_tables    INT CHECK (max_tables BETWEEN 1 AND 100),                   -- vazio = sem limite de quantidade
    PRIMARY KEY (sector_id, table_type_id)
  );
  CREATE TABLE IF NOT EXISTS shows_event_sectors (              -- espaço do setor ajustado só para um evento
    event_id  BIGINT NOT NULL REFERENCES events(id) ON DELETE CASCADE,
    sector_id BIGINT NOT NULL REFERENCES shows_sectors(id) ON DELETE CASCADE,
    space     NUMERIC(8,2) NOT NULL CHECK (space >= 0),
    PRIMARY KEY (event_id, sector_id)
  );
  CREATE TABLE IF NOT EXISTS shows_event_conditions (           -- preço e instruções do evento
    event_id     BIGINT PRIMARY KEY REFERENCES events(id) ON DELETE CASCADE,
    price        NUMERIC(10,2) CHECK (price >= 0),            -- ingresso por pessoa
    door_price   NUMERIC(10,2) CHECK (door_price >= 0),       -- depois do prazo (ex.: na portaria)
    price_until  TIMESTAMPTZ,                                 -- até quando vale o preço normal
    instructions TEXT                                         -- instrução livre para o atendente (descontos excepcionais etc.)
  );
  CREATE TABLE IF NOT EXISTS shows_event_codes (                -- palavras-chave de desconto do evento
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
  CREATE TABLE IF NOT EXISTS shows_event_interest (             -- quem perguntou sobre o evento (vira lead)
    event_id    BIGINT NOT NULL REFERENCES events(id) ON DELETE CASCADE,
    customer_id BIGINT NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (event_id, customer_id)
  );
  CREATE TABLE IF NOT EXISTS shows_extras (                     -- mesas extras abertas à mão, fora do que o setor comporta, só para um evento/data
    id             BIGSERIAL PRIMARY KEY,
    event_id       BIGINT REFERENCES events(id) ON DELETE CASCADE,
    occasion_date  DATE NOT NULL,
    sector_id      BIGINT NOT NULL REFERENCES shows_sectors(id) ON DELETE CASCADE,
    table_type_id  BIGINT REFERENCES shows_table_types(id) ON DELETE SET NULL,
    table_name     TEXT NOT NULL,
    seats_each     INT NOT NULL CHECK (seats_each > 0),
    space_each     NUMERIC(8,2) NOT NULL CHECK (space_each > 0),
    quantity       INT NOT NULL DEFAULT 1 CHECK (quantity BETWEEN 1 AND 100),
    note           TEXT,
    created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
  );
  CREATE INDEX IF NOT EXISTS idx_shows_extras_event ON shows_extras (event_id);
  CREATE TABLE IF NOT EXISTS shows_sales (
    id             BIGSERIAL PRIMARY KEY,
    event_id       BIGINT REFERENCES events(id) ON DELETE SET NULL,
    occasion_date  DATE NOT NULL,                             -- dia do evento (ou a data escolhida, sem evento)
    sector_id      BIGINT NOT NULL REFERENCES shows_sectors(id) ON DELETE RESTRICT,
    customer_id    BIGINT REFERENCES customers(id) ON DELETE SET NULL,
    name           TEXT NOT NULL,
    phone          TEXT,
    people         INT NOT NULL CHECK (people BETWEEN 1 AND 1000),
    table_type_id  BIGINT REFERENCES shows_table_types(id) ON DELETE SET NULL,
    table_name     TEXT NOT NULL,                             -- tipo de mesa na hora da venda
    seats_each     INT NOT NULL CHECK (seats_each > 0),
    space_each     NUMERIC(8,2) NOT NULL CHECK (space_each > 0),
    tables         INT NOT NULL DEFAULT 1 CHECK (tables BETWEEN 1 AND 100),
    status         TEXT NOT NULL DEFAULT 'confirmed' CHECK (status IN ('confirmed', 'attended', 'cancelled', 'no_show')),
    note           TEXT,
    guests         TEXT,                                      -- nomes da lista (um por linha)
    unit_price     NUMERIC(10,2),                             -- valor por pessoa na hora da venda (vazio = sem preço definido)
    code_id        BIGINT REFERENCES shows_event_codes(id) ON DELETE SET NULL,
    code_word      TEXT,                                      -- palavra usada (guardada para consulta)
    created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at     TIMESTAMPTZ NOT NULL DEFAULT now()
  );
  CREATE INDEX IF NOT EXISTS idx_shows_sales_event ON shows_sales (event_id);
  CREATE INDEX IF NOT EXISTS idx_shows_sales_date ON shows_sales (occasion_date);`;

// Ingressos e vendas do cliente para a ficha: lista, total pago e ticket médio (por compra e por pessoa).
// Só contam vendas confirmadas ou com comparecimento e com valor pago; canceladas e cortesias aparecem na lista, mas ficam fora das contas.
export async function historicoCasaDeShows(customerId) {
  const rows = (await q(
    `SELECT v.id, v.occasion_date::text AS date, e.title AS event_title, s.name AS sector_name, v.people, v.table_name, v.status, v.code_word,
            v.unit_price::float AS unit_price, (v.people * v.unit_price - v.club_discount)::float AS total
     FROM shows_sales v JOIN shows_sectors s ON s.id = v.sector_id LEFT JOIN events e ON e.id = v.event_id
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
export const SHOWS_MEDIA_SQL = `
  CREATE TABLE IF NOT EXISTS shows_media (
    id         BIGSERIAL PRIMARY KEY,
    sector_id  BIGINT REFERENCES shows_sectors(id) ON DELETE CASCADE,   -- vazio = mapa geral do espaço
    kind       TEXT NOT NULL CHECK (kind IN ('map','photo')),
    caption    TEXT,
    mime       TEXT NOT NULL,
    data       BYTEA NOT NULL,
    token      TEXT NOT NULL UNIQUE,
    position   INT NOT NULL DEFAULT 0,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
  );
  CREATE INDEX IF NOT EXISTS shows_media_sector ON shows_media (sector_id);
`;
// Pagamentos de cada venda: forma (Pix, dinheiro, cartão, parceiro, cortesia...), chave Pix que recebeu e, se houver, o comprovante já validado em Recebimentos
export const SHOWS_PAGAMENTOS_SQL = `
  CREATE TABLE IF NOT EXISTS shows_sale_payments (
    id             BIGSERIAL PRIMARY KEY,
    sale_id BIGINT NOT NULL REFERENCES shows_sales(id) ON DELETE CASCADE,
    method         TEXT NOT NULL CHECK (method IN ('pix','dinheiro','cartao','parceiro','cortesia','outro')),
    amount         NUMERIC(10,2) NOT NULL DEFAULT 0 CHECK (amount >= 0),
    pix_key_id     BIGINT REFERENCES pix_keys(id) ON DELETE SET NULL,
    payment_id     BIGINT REFERENCES payments(id) ON DELETE SET NULL,   -- comprovante de Recebimentos
    note           TEXT,
    created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
  );
  CREATE INDEX IF NOT EXISTS shows_sale_pay_sale ON shows_sale_payments (sale_id);
  CREATE UNIQUE INDEX IF NOT EXISTS shows_sale_pay_comprovante ON shows_sale_payments (payment_id) WHERE payment_id IS NOT NULL;
`;
// Locais e formatos: cada empresa pode ter vários locais (ambientes), cada local tem seus setores e vários formatos de uso.
// Um formato diz quais setores valem, o espaço de cada um e, se quiser, quais mesas cada setor aceita. Cada evento escolhe local e formato.
// Evento sem escolha usa o primeiro local e o formato padrão dele, como era antes.
export const SHOWS_LOCAIS_SQL = `
  CREATE TABLE IF NOT EXISTS shows_venues (
    id         BIGSERIAL PRIMARY KEY,
    name       TEXT NOT NULL UNIQUE,
    address    TEXT,
    notes      TEXT,
    position   INT NOT NULL DEFAULT 0,
    active     BOOLEAN NOT NULL DEFAULT true,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
  );
  INSERT INTO shows_venues (name) SELECT 'Padrão' WHERE NOT EXISTS (SELECT 1 FROM shows_venues);
  ALTER TABLE shows_sectors ADD COLUMN IF NOT EXISTS venue_id BIGINT REFERENCES shows_venues(id) ON DELETE RESTRICT;
  UPDATE shows_sectors SET venue_id = (SELECT id FROM shows_venues ORDER BY id LIMIT 1) WHERE venue_id IS NULL;
  ALTER TABLE shows_sectors ALTER COLUMN venue_id SET NOT NULL;
  DO $u$
  DECLARE c TEXT;
  BEGIN
    FOR c IN SELECT conname FROM pg_constraint WHERE conrelid = 'shows_sectors'::regclass AND contype = 'u' LOOP
      EXECUTE format('ALTER TABLE shows_sectors DROP CONSTRAINT %I', c);   -- o nome do setor passa a ser único só dentro do local
    END LOOP;
  END $u$;
  CREATE UNIQUE INDEX IF NOT EXISTS shows_sectors_venue_name ON shows_sectors (venue_id, name);
  ALTER TABLE shows_media ADD COLUMN IF NOT EXISTS venue_id BIGINT REFERENCES shows_venues(id) ON DELETE CASCADE;   -- mapa de cada local
  UPDATE shows_media SET venue_id = (SELECT id FROM shows_venues ORDER BY id LIMIT 1) WHERE kind = 'map' AND venue_id IS NULL;
  CREATE TABLE IF NOT EXISTS shows_layouts (
    id         BIGSERIAL PRIMARY KEY,
    venue_id   BIGINT NOT NULL REFERENCES shows_venues(id) ON DELETE CASCADE,
    name       TEXT NOT NULL,
    is_default BOOLEAN NOT NULL DEFAULT false,
    position   INT NOT NULL DEFAULT 0,
    active     BOOLEAN NOT NULL DEFAULT true,
    UNIQUE (venue_id, name)
  );
  CREATE UNIQUE INDEX IF NOT EXISTS shows_layouts_default ON shows_layouts (venue_id) WHERE is_default;
  INSERT INTO shows_layouts (venue_id, name, is_default) SELECT v.id, 'Padrão', true FROM shows_venues v
    WHERE NOT EXISTS (SELECT 1 FROM shows_layouts l WHERE l.venue_id = v.id);
  CREATE TABLE IF NOT EXISTS shows_layout_sectors (            -- sem linhas = o formato usa todos os setores do local, no espaço de cada um
    layout_id  BIGINT NOT NULL REFERENCES shows_layouts(id) ON DELETE CASCADE,
    sector_id  BIGINT NOT NULL REFERENCES shows_sectors(id) ON DELETE CASCADE,
    space      NUMERIC(8,2) CHECK (space >= 0),                 -- vazio = espaço do setor
    own_rules  BOOLEAN NOT NULL DEFAULT false,                  -- true = as mesas deste setor neste formato são as de shows_layout_tables
    PRIMARY KEY (layout_id, sector_id)
  );
  CREATE TABLE IF NOT EXISTS shows_layout_tables (
    layout_id     BIGINT NOT NULL,
    sector_id     BIGINT NOT NULL,
    table_type_id BIGINT NOT NULL REFERENCES shows_table_types(id) ON DELETE CASCADE,
    max_tables    INT CHECK (max_tables BETWEEN 1 AND 100),
    PRIMARY KEY (layout_id, sector_id, table_type_id),
    FOREIGN KEY (layout_id, sector_id) REFERENCES shows_layout_sectors(layout_id, sector_id) ON DELETE CASCADE
  );
  CREATE TABLE IF NOT EXISTS shows_event_setup (               -- local e formato escolhidos para o evento
    event_id  BIGINT PRIMARY KEY REFERENCES events(id) ON DELETE CASCADE,
    venue_id  BIGINT NOT NULL REFERENCES shows_venues(id) ON DELETE RESTRICT,
    layout_id BIGINT NOT NULL REFERENCES shows_layouts(id) ON DELETE RESTRICT
  );
  DO $n$
  DECLARE x RECORD;
  BEGIN
    FOR x IN SELECT c.relname, c.relkind FROM pg_class c WHERE c.relnamespace = current_schema()::regnamespace AND c.relname LIKE 'scn\\_%' AND c.relkind IN ('S','i') LOOP
      IF to_regclass(replace(x.relname, 'scn_', 'shows_')) IS NULL THEN
        EXECUTE format(CASE x.relkind WHEN 'S' THEN 'ALTER SEQUENCE %I RENAME TO %I' ELSE 'ALTER INDEX %I RENAME TO %I' END, x.relname, replace(x.relname, 'scn_', 'shows_'));
      END IF;
    END LOOP;
    FOR x IN SELECT conname, conrelid::regclass::text AS tabela FROM pg_constraint WHERE connamespace = current_schema()::regnamespace AND conname LIKE 'scn\\_%' LOOP
      EXECUTE format('ALTER TABLE %s RENAME CONSTRAINT %I TO %I', x.tabela, x.conname, replace(x.conname, 'scn_', 'shows_'));
    END LOOP;
  END $n$;
`;
const FORMAS = ['pix', 'dinheiro', 'cartao', 'parceiro', 'cortesia', 'outro'];
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
      const f = await runAs(Number(m[1]), async () => (await q('SELECT mime, data FROM shows_media WHERE token=$1', [req.params.token])).rows[0]);
      if (!f) return res.status(404).end();
      res.set({ 'content-type': f.mime, 'cache-control': 'public, max-age=3600', 'x-content-type-options': 'nosniff' }).send(f.data);
    } catch (e) { console.error('casa de shows mídia:', e.message); res.status(404).end(); }
  });
}

export function registerCasaDeShowsRoutes(r, wrap) {
  const fuso = async () => (await qg('SELECT timezone FROM companies WHERE id=$1', [currentCompany()])).rows[0]?.timezone || 'America/Sao_Paulo';
  const comTratamento = (fn) => wrap(async (req, res) => {
    try { await fn(req, res); } catch (e) { if (e.status) return res.status(e.status).json({ error: e.message }); throw e; }
  });
  const quem = (req) => (req.baseUrl || '').includes('n8n') ? 'ia' : 'manual';

  // ---------- setores ----------
  const SETOR = `SELECT id, venue_id, (SELECT v.name FROM shows_venues v WHERE v.id = shows_sectors.venue_id) AS venue_name, name, space::float AS space, notes, position, active,
    COALESCE((SELECT json_agg(json_build_object('table_type_id', st.table_type_id::text, 'max_tables', st.max_tables) ORDER BY st.table_type_id)
              FROM shows_sector_tables st WHERE st.sector_id = shows_sectors.id), '[]'::json) AS tables
    FROM shows_sectors`;

  // ---------- mapa e fotos ----------
  const urlBase = (req) => process.env.PUBLIC_URL || `${req.headers['x-forwarded-proto'] || req.protocol}://${req.headers['x-forwarded-host'] || req.get('host')}`;
  const midiaOut = (req, m) => ({ id: String(m.id), sector_id: m.sector_id ? String(m.sector_id) : null, kind: m.kind, caption: m.caption, url: `${urlBase(req)}/m/${m.token}` });
  // Lista (sem os arquivos): o painel mostra e o atendente usa os endereços para enviar ao cliente
  // Mapa e fotos são do local: ?venue_id= ou ?event_id= (o local do evento); sem nada, vale o primeiro local
  r.get('/casa-de-shows/media', wrap(async (req, res) => {
    const setorId = req.query.sector_id ? idOk(req.query.sector_id) : null;
    if (req.query.sector_id && !setorId) return res.status(400).json({ error: 'Setor inválido' });
    let origem = req.query;
    if (setorId && !origem.venue_id && !origem.event_id) {   // só o setor: vale o local dele
      const dono = (await q('SELECT venue_id FROM shows_sectors WHERE id=$1', [setorId])).rows[0];
      if (dono) origem = { venue_id: dono.venue_id };
    }
    const lv = await venueDe(origem);
    if (lv.erro) return res.status(400).json({ error: lv.erro });
    const rows = (await q(`SELECT m.id, m.sector_id, m.kind, m.caption, m.token, s.name AS sector_name FROM shows_media m LEFT JOIN shows_sectors s ON s.id = m.sector_id
      WHERE (m.kind = 'map' AND m.venue_id = $1) OR (m.kind = 'photo' AND s.venue_id = $1)${setorId ? ' AND (m.sector_id = $2 OR m.kind = \'map\')' : ''} ORDER BY m.kind DESC, m.position, m.id`, setorId ? [lv.venue_id, setorId] : [lv.venue_id])).rows;
    const map = rows.find((m) => m.kind === 'map');
    const setores = (await q('SELECT id, name FROM shows_sectors WHERE active AND venue_id=$1 ORDER BY position, id', [lv.venue_id])).rows;
    res.json({
      map: map ? midiaOut(req, map) : null,
      sectors: setores.filter((s) => !setorId || String(s.id) === setorId).map((s) => ({ sector_id: String(s.id), name: s.name, photos: rows.filter((m) => m.kind === 'photo' && String(m.sector_id) === String(s.id)).map((m) => midiaOut(req, m)) })),
    });
  }));
  // Envio: { kind: 'map' | 'photo', sector_id (fotos), caption, data: "data:image/jpeg;base64,..." }
  r.post('/casa-de-shows/media', comTratamento(async (req, res) => {
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
    let setorId = null, localId = null;
    if (kind === 'map') {
      const lv = await venueDe(b);
      if (lv.erro) return res.status(400).json({ error: lv.erro });
      localId = lv.venue_id;
    }
    if (kind === 'photo') {
      setorId = idOk(b.sector_id);
      if (!setorId || !(await q('SELECT 1 FROM shows_sectors WHERE id=$1', [setorId])).rowCount) return res.status(400).json({ error: 'Escolha o setor da foto' });
      if ((await q("SELECT count(*)::int AS n FROM shows_media WHERE kind='photo' AND sector_id=$1", [setorId])).rows[0].n >= FOTOS_POR_SETOR)
        return res.status(409).json({ error: `Cada setor aceita até ${FOTOS_POR_SETOR} fotos. Apague uma para enviar outra.` });
    }
    const token = `${currentCompany()}-${crypto.randomBytes(20).toString('hex')}`;
    const novo = await tx(currentCompany(), async (t) => {
      if (kind === 'map') await t("DELETE FROM shows_media WHERE kind='map' AND venue_id=$1", [localId]);   // cada local tem um mapa só: o novo substitui
      return (await t(`INSERT INTO shows_media (sector_id, venue_id, kind, caption, mime, data, token, position)
        VALUES ($1,$7,$2,$3,$4,$5,$6,(SELECT COALESCE(max(position),0)+1 FROM shows_media)) RETURNING id, sector_id, kind, caption, token`,
        [setorId, kind, legenda || null, mime, buf, token, localId])).rows[0];
    });
    res.status(201).json(midiaOut(req, novo));
  }));
  r.put('/casa-de-shows/media/:id', comTratamento(async (req, res) => {
    if (quem(req) === 'ia') return res.status(403).json({ error: 'Só pelo painel' });
    const id = idOk(req.params.id); const legenda = txt(req.body?.caption ?? '', 120);
    if (!id || legenda === null) return res.status(400).json({ error: 'Legenda inválida (até 120 letras)' });
    const { rowCount } = await q('UPDATE shows_media SET caption=$2 WHERE id=$1', [id, legenda || null]);
    rowCount ? res.json({ ok: true }) : res.status(404).json({ error: 'Imagem não encontrada' });
  }));
  r.delete('/casa-de-shows/media/:id', comTratamento(async (req, res) => {
    if (quem(req) === 'ia') return res.status(403).json({ error: 'Só pelo painel' });
    const id = idOk(req.params.id);
    const { rowCount } = id ? await q('DELETE FROM shows_media WHERE id=$1', [id]) : { rowCount: 0 };
    rowCount ? res.json({ ok: true }) : res.status(404).json({ error: 'Imagem não encontrada' });
  }));

  r.get('/casa-de-shows/sectors', wrap(async (req, res) => {
    if (req.query.venue_id !== undefined && req.query.venue_id !== '') {
      const v = idOk(req.query.venue_id);
      if (!v) return res.status(400).json({ error: 'Local inválido' });
      return res.json((await q(`${SETOR} WHERE venue_id=$1 ORDER BY position, id`, [v])).rows);
    }
    res.json((await q(`${SETOR} ORDER BY venue_id, position, id`)).rows);
  }));
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
      if (!tid || !(await q('SELECT 1 FROM shows_table_types WHERE id=$1', [tid])).rows[0]) return { erro: 'Mesa não encontrada' };
      if (vistos.has(tid)) return { erro: 'Mesa repetida nas regras do setor' };
      vistos.add(tid);
      let mx = null;
      if (it.max_tables !== null && it.max_tables !== undefined && it.max_tables !== '') { mx = inteiro(it.max_tables, 1, 100); if (mx === null) return { erro: 'Quantidade máxima de mesas inválida (1 a 100)' }; }
      regras.push([tid, mx]);
    }
    return { regras };
  }
  const salvarRegras = (sid, regras) => regras === undefined ? null : tx(currentCompany(), async (t) => {
    await t('DELETE FROM shows_sector_tables WHERE sector_id=$1', [sid]);
    for (const [tid, mx] of regras) await t('INSERT INTO shows_sector_tables (sector_id, table_type_id, max_tables) VALUES ($1,$2,$3)', [sid, tid, mx]);
  });
  r.post('/casa-de-shows/sectors', wrap(async (req, res) => {
    const { o, erro } = lerSetor(req.body || {}, false);
    if (erro) return res.status(400).json({ error: erro });
    const rg = await lerRegras(req.body || {});
    if (rg.erro) return res.status(400).json({ error: rg.erro });
    const lv = await venueDe(req.body || {});
    if (lv.erro) return res.status(400).json({ error: lv.erro });
    try {
      const pos = o.position ?? (await q('SELECT COALESCE(MAX(position), 0) + 1 AS p FROM shows_sectors WHERE venue_id=$1', [lv.venue_id])).rows[0].p;
      const id = (await q('INSERT INTO shows_sectors (venue_id, name, space, notes, position) VALUES ($5,$1,$2,NULLIF($3,\'\'),$4) RETURNING id', [o.name, o.space, o.notes || '', pos, lv.venue_id])).rows[0].id;
      await salvarRegras(id, rg.regras);
      res.status(201).json((await q(`${SETOR} WHERE id=$1`, [id])).rows[0]);
    } catch (e) {
      if (e.code === '23505') return res.status(409).json({ error: 'Já existe um setor com esse nome neste local' });
      throw e;
    }
  }));
  r.put('/casa-de-shows/sectors/:id', wrap(async (req, res) => {
    const { o, erro } = lerSetor(req.body || {}, true);
    if (erro) return res.status(400).json({ error: erro });
    const rg = await lerRegras(req.body || {});
    if (rg.erro) return res.status(400).json({ error: rg.erro });
    const atual = (await q(`${SETOR} WHERE id=$1`, [req.params.id])).rows[0];
    if (!atual) return res.status(404).json({ error: 'Setor não encontrado' });
    const n = { ...atual, ...o };
    try {
      await q('UPDATE shows_sectors SET name=$2, space=$3, notes=NULLIF($4,\'\'), position=$5, active=$6 WHERE id=$1', [req.params.id, n.name, n.space, n.notes || '', n.position, n.active]);
    } catch (e) {
      if (e.code === '23505') return res.status(409).json({ error: 'Já existe um setor com esse nome neste local' });
      throw e;
    }
    await salvarRegras(req.params.id, rg.regras);
    res.json((await q(`${SETOR} WHERE id=$1`, [req.params.id])).rows[0]);
  }));
  r.delete('/casa-de-shows/sectors/:id', wrap(async (req, res) => {
    try {
      const { rowCount } = await q('DELETE FROM shows_sectors WHERE id=$1', [req.params.id]);
      rowCount ? res.json({ ok: true }) : res.status(404).json({ error: 'Setor não encontrado' });
    } catch (e) {
      if (e.code === '23503') return res.status(409).json({ error: 'Esse setor tem vendas. Desative o setor em vez de apagar.' });
      throw e;
    }
  }));

  // ---------- tipos de mesa ----------
  const TIPO = 'SELECT id, name, seats, space::float AS space, active FROM shows_table_types';
  r.get('/casa-de-shows/table-types', wrap(async (req, res) => res.json((await q(`${TIPO} ORDER BY seats, id`)).rows)));
  function lerTipo(b, parcial) {
    const o = {};
    if (!parcial || b.name !== undefined) { o.name = txt(b.name, 60); if (!o.name) return { erro: 'Informe o nome da mesa (até 60 letras)' }; }
    if (!parcial || b.seats !== undefined) { o.seats = inteiro(b.seats, 1, 200); if (o.seats === null) return { erro: 'Informe quantos lugares tem a mesa (1 a 200)' }; }
    if (!parcial && b.space === undefined && o.seats) b = { ...b, space: o.seats };   // sem espaço informado, a mesa ocupa um ponto por lugar
    if (!parcial || b.space !== undefined) { o.space = espaco(b.space, 0.01); if (o.space === null) return { erro: 'Informe o espaço que a mesa ocupa (maior que 0)' }; }
    if (b.active !== undefined) { if (typeof b.active !== 'boolean') return { erro: 'Ativo inválido' }; o.active = b.active; }
    return { o };
  }
  r.post('/casa-de-shows/table-types', wrap(async (req, res) => {
    const { o, erro } = lerTipo(req.body || {}, false);
    if (erro) return res.status(400).json({ error: erro });
    try {
      const id = (await q('INSERT INTO shows_table_types (name, seats, space) VALUES ($1,$2,$3) RETURNING id', [o.name, o.seats, o.space])).rows[0].id;
      res.status(201).json((await q(`${TIPO} WHERE id=$1`, [id])).rows[0]);
    } catch (e) {
      if (e.code === '23505') return res.status(409).json({ error: 'Já existe uma mesa com esse nome' });
      throw e;
    }
  }));
  r.put('/casa-de-shows/table-types/:id', wrap(async (req, res) => {
    const { o, erro } = lerTipo(req.body || {}, true);
    if (erro) return res.status(400).json({ error: erro });
    const atual = (await q(`${TIPO} WHERE id=$1`, [req.params.id])).rows[0];
    if (!atual) return res.status(404).json({ error: 'Mesa não encontrada' });
    const n = { ...atual, ...o };
    try {
      await q('UPDATE shows_table_types SET name=$2, seats=$3, space=$4, active=$5 WHERE id=$1', [req.params.id, n.name, n.seats, n.space, n.active]);
    } catch (e) {
      if (e.code === '23505') return res.status(409).json({ error: 'Já existe uma mesa com esse nome' });
      throw e;
    }
    res.json((await q(`${TIPO} WHERE id=$1`, [req.params.id])).rows[0]);
  }));
  r.delete('/casa-de-shows/table-types/:id', wrap(async (req, res) => {
    const { rowCount } = await q('DELETE FROM shows_table_types WHERE id=$1', [req.params.id]);
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


  // ---------- local e formato da ocasião ----------
  async function primeiroLocal(run = q) {
    return (await run('SELECT id FROM shows_venues WHERE active ORDER BY position, id LIMIT 1')).rows[0] || (await run('SELECT id FROM shows_venues ORDER BY id LIMIT 1')).rows[0];
  }
  // Local pedido por venue_id, pelo evento (event_id) ou, sem nada, o primeiro local
  async function venueDe(src, run = q) {
    if (src.venue_id !== undefined && src.venue_id !== null && src.venue_id !== '') {
      const v = idOk(src.venue_id);
      if (!v || !(await run('SELECT 1 FROM shows_venues WHERE id=$1', [v])).rowCount) return { erro: 'Local não encontrado' };
      return { venue_id: v };
    }
    if (src.event_id) {
      const oc = await ocasiao(src);
      if (oc.erro) return { erro: oc.erro };
      return { venue_id: String((await configuracao(run, oc)).venue_id) };
    }
    return { venue_id: String((await primeiroLocal(run)).id) };
  }
  // Local e formato que valem para a ocasião, e o que o formato muda nos setores (quais valem, espaço, mesas aceitas)
  async function configuracao(run, oc) {
    const es = oc.event_id ? (await run('SELECT venue_id, layout_id FROM shows_event_setup WHERE event_id=$1', [oc.event_id])).rows[0] : null;
    let venueId, layoutId;
    if (es) { venueId = es.venue_id; layoutId = es.layout_id; }
    else {
      venueId = (await primeiroLocal(run)).id;
      layoutId = (await run('SELECT id FROM shows_layouts WHERE venue_id=$1 AND is_default', [venueId])).rows[0]?.id;
    }
    const info = (await run(`SELECT v.name AS venue_name, l.name AS layout_name FROM shows_venues v LEFT JOIN shows_layouts l ON l.id = $2 WHERE v.id = $1`, [venueId, layoutId || null])).rows[0] || {};
    const ls = layoutId ? (await run('SELECT sector_id, space::float AS space, own_rules FROM shows_layout_sectors WHERE layout_id=$1', [layoutId])).rows : [];
    const lt = layoutId ? (await run('SELECT sector_id, table_type_id::text AS t, max_tables FROM shows_layout_tables WHERE layout_id=$1', [layoutId])).rows : [];
    const st = (await run('SELECT sector_id, table_type_id::text AS t, max_tables FROM shows_sector_tables')).rows;
    const linha = (sid) => ls.find((x) => String(x.sector_id) === String(sid));
    return {
      venue_id: venueId, layout_id: layoutId || null, venue_name: info.venue_name || null, layout_name: info.layout_name || null,
      custom: !!es,
      entra: (sid) => !ls.length || !!linha(sid),
      espaco: (sid, base) => { const x = linha(sid); return x && x.space !== null ? x.space : base; },
      regras: (sid) => {
        const x = linha(sid);
        const fonte = x && x.own_rules ? lt : st;
        return fonte.filter((m) => String(m.sector_id) === String(sid)).map((m) => ({ table_type_id: m.t, max_tables: m.max_tables }));
      },
    };
  }

  // Situação dos setores nessa ocasião: espaço, usado, livre e, se pedido, onde cabe `people` pessoas
  async function situacao(oc, { people, sectorId } = {}, run = q) {
    const cfg = await configuracao(run, oc);
    const setores = (await run(`${SETOR} WHERE active AND venue_id = $1 ${sectorId ? 'AND id = $2' : ''} ORDER BY position, id`, sectorId ? [cfg.venue_id, sectorId] : [cfg.venue_id])).rows.filter((x) => cfg.entra(x.id));
    const tipos = (await run(`${TIPO} WHERE active ORDER BY seats, id`)).rows;
    const over = oc.event_id ? (await run('SELECT sector_id, space::float AS space FROM shows_event_sectors WHERE event_id=$1', [oc.event_id])).rows : [];
    const a = [OCUPAM];
    const f = filtroOcasiao(oc, a);
    const uso = (await run(
      `SELECT sector_id, COUNT(*)::int AS sales, COALESCE(SUM(people),0)::int AS people, COALESCE(SUM(tables * space_each),0)::float AS used,
              COALESCE(SUM(tables * seats_each),0)::int AS seats
       FROM shows_sales WHERE status = ANY($1) AND ${f} GROUP BY sector_id`, a)).rows;
    const a2 = [OCUPAM];
    const f2 = filtroOcasiao(oc, a2);
    const usoTipo = (await run(
      `SELECT sector_id, table_type_id, SUM(tables)::int AS tables FROM shows_sales
       WHERE status = ANY($1) AND table_type_id IS NOT NULL AND ${f2} GROUP BY sector_id, table_type_id`, a2)).rows;
    const a4 = [];
    const f4 = filtroOcasiao(oc, a4);
    const extras = (await run(`SELECT sector_id, table_type_id, COALESCE(SUM(quantity),0)::int AS qtd, COALESCE(SUM(quantity * space_each),0)::float AS space
                               FROM shows_extras WHERE ${f4} GROUP BY sector_id, table_type_id`, a4)).rows;
    return setores.map((s) => {
      const o = over.find((x) => String(x.sector_id) === String(s.id));
      const meusExtras = extras.filter((x) => String(x.sector_id) === String(s.id));
      const espacoExtra = r2(meusExtras.reduce((a, x) => a + x.space, 0));
      const baseDoFormato = cfg.espaco(s.id, s.space);
      const total = r2((o ? o.space : baseDoFormato) + espacoExtra);
      const u = uso.find((x) => String(x.sector_id) === String(s.id)) || { sales: 0, people: 0, used: 0, seats: 0 };
      const usado = r2(u.used);
      const livre = r2(Math.max(0, total - usado));
      // mesas que o setor aceita (sem regras = todas) e, para cada uma, quantas ainda cabem pelo limite do setor
      const regras = cfg.regras(s.id);
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
        sector_id: s.id, name: s.name, notes: s.notes, base_space: baseDoFormato, space: total, custom_space: !!o, extra_space: espacoExtra, extra_tables: meusExtras.reduce((a, x) => a + x.qtd, 0),
        used: usado, free: livre, sales: u.sales, people: u.people, seats_reserved: u.seats,
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
  r.get('/casa-de-shows/availability', wrap(async (req, res) => {
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
    const cfg = setupOut(await configuracao(q, oc));
    res.json({
      event: oc.event ? { id: oc.event.id, title: oc.event.title, starts_at: oc.event.starts_at } : null,
      date: oc.date, venue: cfg.venue, layout: cfg.layout, people, sectors,
      ...(people ? { sectors_with_room: sectors.filter((s) => s.can_fit).map((s) => s.name) } : {}),
    });
  }));

  // Eventos que ainda valem, cada um com o resumo das vagas. É a lista que o atendente usa para saber "qual evento é qual",
  // sem depender de "show atual" e "show seguinte": cada evento tem nome, data e a própria lista de vendas.
  r.get('/casa-de-shows/events', wrap(async (req, res) => {
    const tz = await fuso();
    const evs = (await q(`SELECT id, title, starts_at, ends_at, place, notes, to_char(starts_at AT TIME ZONE $1, 'YYYY-MM-DD') AS dia FROM events
                          WHERE COALESCE(ends_at, starts_at + interval '3 hours') > now() ORDER BY starts_at, id LIMIT 20`, [tz])).rows;
    const out = [];
    for (const e of evs) {
      const sectors = await situacao({ event_id: e.id, date: e.dia });
      const cfg = setupOut(await configuracao(q, { event_id: e.id }));
      out.push({
        venue: cfg.venue, layout: cfg.layout,
        id: e.id, title: e.title, starts_at: e.starts_at, ends_at: e.ends_at, place: e.place, notes: e.notes, date: e.dia,
        sales: sectors.reduce((a, x) => a + x.sales, 0), people: sectors.reduce((a, x) => a + x.people, 0),
        interested: (await q('SELECT COUNT(*)::int AS n FROM shows_event_interest WHERE event_id=$1', [e.id])).rows[0].n,
        sectors: sectors.map((x) => ({ sector_id: x.sector_id, name: x.name, free: x.free, space: x.space })),
        sectors_with_room: sectors.filter((x) => x.free > 0).map((x) => x.name),
      });
    }
    res.json(out);
  }));


  // ---------- locais ----------
  const LOCAL = `SELECT v.id, v.name, v.address, v.notes, v.position, v.active,
      (SELECT COUNT(*)::int FROM shows_sectors s WHERE s.venue_id = v.id) AS sectors,
      COALESCE((SELECT json_agg(json_build_object('id', l.id, 'name', l.name, 'is_default', l.is_default) ORDER BY l.is_default DESC, l.position, l.id) FROM shows_layouts l WHERE l.venue_id = v.id), '[]'::json) AS layouts
    FROM shows_venues v`;
  function lerLocal(b, parcial) {
    const o = {};
    if (!parcial || b.name !== undefined) { o.name = txt(b.name, 80); if (!o.name) return { erro: 'Informe o nome do local (até 80 letras)' }; }
    if (b.address !== undefined) { o.address = txt(b.address, 200); if (o.address === null) return { erro: 'Endereço inválido (até 200 letras)' }; }
    if (b.notes !== undefined) { o.notes = txt(b.notes, 300); if (o.notes === null) return { erro: 'Observação inválida (até 300 letras)' }; }
    if (b.position !== undefined) { o.position = inteiro(b.position, 0, 9999); if (o.position === null) return { erro: 'Posição inválida' }; }
    if (b.active !== undefined) { if (typeof b.active !== 'boolean') return { erro: 'Ativo inválido' }; o.active = b.active; }
    return { o };
  }
  r.get('/casa-de-shows/venues', wrap(async (req, res) => res.json((await q(`${LOCAL} ORDER BY v.position, v.id`)).rows)));
  r.post('/casa-de-shows/venues', wrap(async (req, res) => {
    const { o, erro } = lerLocal(req.body || {}, false);
    if (erro) return res.status(400).json({ error: erro });
    try {
      const id = await tx(currentCompany(), async (t) => {
        const pos = o.position ?? (await t('SELECT COALESCE(MAX(position), 0) + 1 AS p FROM shows_venues')).rows[0].p;
        const novo = (await t(`INSERT INTO shows_venues (name, address, notes, position) VALUES ($1,NULLIF($2,''),NULLIF($3,''),$4) RETURNING id`, [o.name, o.address || '', o.notes || '', pos])).rows[0].id;
        await t(`INSERT INTO shows_layouts (venue_id, name, is_default) VALUES ($1,'Padrão',true)`, [novo]);
        return novo;
      });
      res.status(201).json((await q(`${LOCAL} WHERE v.id=$1`, [id])).rows[0]);
    } catch (e) {
      if (e.code === '23505') return res.status(409).json({ error: 'Já existe um local com esse nome' });
      throw e;
    }
  }));
  r.put('/casa-de-shows/venues/:id', wrap(async (req, res) => {
    const { o, erro } = lerLocal(req.body || {}, true);
    if (erro) return res.status(400).json({ error: erro });
    const atual = (await q(`${LOCAL} WHERE v.id=$1`, [idOk(req.params.id) || 0])).rows[0];
    if (!atual) return res.status(404).json({ error: 'Local não encontrado' });
    const n = { ...atual, ...o };
    try {
      await q(`UPDATE shows_venues SET name=$2, address=NULLIF($3,''), notes=NULLIF($4,''), position=$5, active=$6 WHERE id=$1`, [atual.id, n.name, n.address || '', n.notes || '', n.position, n.active]);
    } catch (e) {
      if (e.code === '23505') return res.status(409).json({ error: 'Já existe um local com esse nome' });
      throw e;
    }
    res.json((await q(`${LOCAL} WHERE v.id=$1`, [atual.id])).rows[0]);
  }));
  r.delete('/casa-de-shows/venues/:id', wrap(async (req, res) => {
    const id = idOk(req.params.id);
    const v = id && (await q(`${LOCAL} WHERE v.id=$1`, [id])).rows[0];
    if (!v) return res.status(404).json({ error: 'Local não encontrado' });
    if ((await q('SELECT COUNT(*)::int AS n FROM shows_venues')).rows[0].n <= 1) return res.status(409).json({ error: 'Mantenha ao menos um local' });
    if (v.sectors > 0) return res.status(409).json({ error: 'Esse local ainda tem setores. Apague os setores primeiro.' });
    try { await q('DELETE FROM shows_venues WHERE id=$1', [id]); } catch (e) {
      if (e.code === '23503') return res.status(409).json({ error: 'Há eventos usando esse local. Troque o local desses eventos primeiro.' });
      throw e;
    }
    res.json({ ok: true });
  }));

  // ---------- formatos do local ----------
  // Um formato diz quais setores do local valem, o espaço de cada um e, se quiser, as mesas aceitas. Sem setores listados = todos, como são.
  async function formatoOut(l) {
    const linhas = (await q(`SELECT ls.sector_id, ls.space::float AS space, ls.own_rules FROM shows_layout_sectors ls JOIN shows_sectors s ON s.id = ls.sector_id WHERE ls.layout_id=$1 ORDER BY s.position, s.id`, [l.id])).rows;
    const mesas = (await q('SELECT sector_id, table_type_id::text AS table_type_id, max_tables FROM shows_layout_tables WHERE layout_id=$1 ORDER BY table_type_id', [l.id])).rows;
    const setores = (await q('SELECT id, name, space::float AS space FROM shows_sectors WHERE venue_id=$1 ORDER BY position, id', [l.venue_id])).rows;
    const todos = !linhas.length;
    const lista = todos ? setores.map((s) => ({ sector_id: s.id, space: null, own_rules: false })) : linhas;
    return {
      id: l.id, venue_id: l.venue_id, name: l.name, is_default: l.is_default, active: l.active, all_sectors: todos,
      sectors: lista.map((x) => {
        const s = setores.find((y) => String(y.id) === String(x.sector_id));
        return {
          sector_id: x.sector_id, name: s?.name, base_space: s?.space, space: x.space, effective_space: x.space !== null ? x.space : s?.space,
          tables: x.own_rules ? mesas.filter((m) => String(m.sector_id) === String(x.sector_id)).map((m) => ({ table_type_id: m.table_type_id, max_tables: m.max_tables })) : null,
        };
      }),
    };
  }
  const FORMATO = 'SELECT id, venue_id, name, is_default, active, position FROM shows_layouts';
  r.get('/casa-de-shows/layouts', wrap(async (req, res) => {
    let w = '', a = [];
    if (req.query.venue_id !== undefined && req.query.venue_id !== '') {
      const v = idOk(req.query.venue_id);
      if (!v) return res.status(400).json({ error: 'Local inválido' });
      w = 'WHERE venue_id=$1'; a = [v];
    }
    const rows = (await q(`${FORMATO} ${w} ORDER BY venue_id, is_default DESC, position, id`, a)).rows;
    res.json(await Promise.all(rows.map(formatoOut)));
  }));
  // Lê a lista de setores do formato: [{ sector_id, space|null, tables: null (as do setor) | [{ table_type_id, max_tables }] }]
  async function lerSetoresDoFormato(venueId, lista) {
    if (lista === undefined) return { itens: undefined };
    if (lista === null || (Array.isArray(lista) && !lista.length)) return { itens: [] };
    if (!Array.isArray(lista)) return { erro: 'Setores do formato inválidos' };
    const vistos = new Set(), itens = [];
    for (const it of lista) {
      const sid = idOk(it?.sector_id);
      const setor = sid && (await q('SELECT venue_id FROM shows_sectors WHERE id=$1', [sid])).rows[0];
      if (!setor) return { erro: 'Setor não encontrado' };
      if (String(setor.venue_id) !== String(venueId)) return { erro: 'Esse setor é de outro local' };
      if (vistos.has(sid)) return { erro: 'Setor repetido no formato' };
      vistos.add(sid);
      let sp = null;
      if (it.space !== null && it.space !== undefined && it.space !== '') { sp = espaco(it.space, 0); if (sp === null) return { erro: 'Espaço inválido' }; }
      let mesas = null;
      if (it.tables !== null && it.tables !== undefined) {
        const rg = await lerRegras({ tables: it.tables });
        if (rg.erro) return { erro: rg.erro };
        mesas = rg.regras;
      }
      itens.push({ sid, sp, mesas });
    }
    return { itens };
  }
  // O que muda no espaço não pode deixar um evento com mais vendas do que cabe
  async function conferirEventos(t, ids) {
    for (const id of ids) {
      const ss = await situacao({ event_id: id, date: '' }, {}, t);
      const estoura = ss.find((x) => x.used > x.space + 1e-9);
      if (estoura) { const e = new Error(`No setor ${estoura.name} já há vendas que ocupam ${estoura.used} e o novo espaço é ${estoura.space}.`); e.status = 409; throw e; }
    }
  }
  async function eventosDoFormato(t, layoutId, venueId) {
    const doEvento = (await t('SELECT event_id FROM shows_event_setup WHERE layout_id=$1', [layoutId])).rows.map((x) => x.event_id);
    const principal = await primeiroLocal(t);
    const padrao = (await t('SELECT 1 FROM shows_layouts WHERE id=$1 AND is_default', [layoutId])).rowCount && String(principal.id) === String(venueId);
    const semEscolha = padrao ? (await t('SELECT DISTINCT v.event_id FROM shows_sales v WHERE v.event_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM shows_event_setup es WHERE es.event_id = v.event_id)')).rows.map((x) => x.event_id) : [];
    return [...new Set([...doEvento, ...semEscolha].map(String))];
  }
  async function salvarFormato(t, id, venueId, itens) {
    if (itens === undefined) return;
    await t('DELETE FROM shows_layout_sectors WHERE layout_id=$1', [id]);
    for (const it of itens) {
      await t('INSERT INTO shows_layout_sectors (layout_id, sector_id, space, own_rules) VALUES ($1,$2,$3,$4)', [id, it.sid, it.sp, it.mesas !== null]);
      for (const [tid, mx] of it.mesas || []) await t('INSERT INTO shows_layout_tables (layout_id, sector_id, table_type_id, max_tables) VALUES ($1,$2,$3,$4)', [id, it.sid, tid, mx]);
    }
  }
  r.post('/casa-de-shows/layouts', comTratamento(async (req, res) => {
    const b = req.body || {};
    const lv = await venueDe(b);
    if (lv.erro) return res.status(400).json({ error: lv.erro });
    const nome = txt(b.name, 60);
    if (!nome) return res.status(400).json({ error: 'Informe o nome do formato (até 60 letras)' });
    const ls = await lerSetoresDoFormato(lv.venue_id, b.sectors);
    if (ls.erro) return res.status(400).json({ error: ls.erro });
    try {
      const id = await tx(currentCompany(), async (t) => {
        const pos = (await t('SELECT COALESCE(MAX(position), 0) + 1 AS p FROM shows_layouts WHERE venue_id=$1', [lv.venue_id])).rows[0].p;
        const novo = (await t('INSERT INTO shows_layouts (venue_id, name, position) VALUES ($1,$2,$3) RETURNING id', [lv.venue_id, nome, pos])).rows[0].id;
        await salvarFormato(t, novo, lv.venue_id, ls.itens);
        if (b.is_default === true) { await t('UPDATE shows_layouts SET is_default = (id = $2) WHERE venue_id=$1', [lv.venue_id, novo]); }
        return novo;
      });
      res.status(201).json(await formatoOut((await q(`${FORMATO} WHERE id=$1`, [id])).rows[0]));
    } catch (e) {
      if (e.code === '23505') return res.status(409).json({ error: 'Já existe um formato com esse nome neste local' });
      throw e;
    }
  }));
  r.put('/casa-de-shows/layouts/:id', comTratamento(async (req, res) => {
    const b = req.body || {};
    const atual = (await q(`${FORMATO} WHERE id=$1`, [idOk(req.params.id) || 0])).rows[0];
    if (!atual) return res.status(404).json({ error: 'Formato não encontrado' });
    let nome = atual.name;
    if (b.name !== undefined) { nome = txt(b.name, 60); if (!nome) return res.status(400).json({ error: 'Informe o nome do formato (até 60 letras)' }); }
    if (b.active !== undefined && typeof b.active !== 'boolean') return res.status(400).json({ error: 'Ativo inválido' });
    if (b.is_default === false && atual.is_default) return res.status(400).json({ error: 'Escolha outro formato como padrão para trocar' });
    const ls = await lerSetoresDoFormato(atual.venue_id, b.sectors);
    if (ls.erro) return res.status(400).json({ error: ls.erro });
    try {
      await tx(currentCompany(), async (t) => {
        await t('UPDATE shows_layouts SET name=$2, active=$3 WHERE id=$1', [atual.id, nome, b.active ?? atual.active]);
        await salvarFormato(t, atual.id, atual.venue_id, ls.itens);
        if (b.is_default === true) await t('UPDATE shows_layouts SET is_default = (id = $2) WHERE venue_id=$1', [atual.venue_id, atual.id]);
        if (ls.itens !== undefined) await conferirEventos(t, await eventosDoFormato(t, atual.id, atual.venue_id));
      });
    } catch (e) {
      if (e.code === '23505') return res.status(409).json({ error: 'Já existe um formato com esse nome neste local' });
      throw e;
    }
    res.json(await formatoOut((await q(`${FORMATO} WHERE id=$1`, [atual.id])).rows[0]));
  }));
  r.delete('/casa-de-shows/layouts/:id', wrap(async (req, res) => {
    const l = (await q(`${FORMATO} WHERE id=$1`, [idOk(req.params.id) || 0])).rows[0];
    if (!l) return res.status(404).json({ error: 'Formato não encontrado' });
    if (l.is_default) return res.status(409).json({ error: 'O formato padrão não pode ser apagado. Escolha outro como padrão antes.' });
    try { await q('DELETE FROM shows_layouts WHERE id=$1', [l.id]); } catch (e) {
      if (e.code === '23503') return res.status(409).json({ error: 'Há eventos usando esse formato. Troque o formato desses eventos primeiro.' });
      throw e;
    }
    res.json({ ok: true });
  }));

  // Local e formato de um evento
  const setupOut = (cfg) => ({ venue: { id: cfg.venue_id, name: cfg.venue_name }, layout: cfg.layout_id ? { id: cfg.layout_id, name: cfg.layout_name } : null, chosen: cfg.custom });
  r.get('/casa-de-shows/events/:id/setup', wrap(async (req, res) => {
    const ev = await eventoDe(req.params.id);
    if (!ev) return res.status(404).json({ error: 'Evento não encontrado' });
    res.json(setupOut(await configuracao(q, { event_id: ev.id })));
  }));
  // Corpo: { venue_id, layout_id? } (sem formato, vale o padrão do local) ; { venue_id: null } volta ao primeiro local e ao formato padrão
  r.put('/casa-de-shows/events/:id/setup', comTratamento(async (req, res) => {
    const ev = await eventoDe(req.params.id);
    if (!ev) return res.status(404).json({ error: 'Evento não encontrado' });
    const b = req.body || {};
    let venueId = null, layoutId = null;
    if (b.venue_id !== null && b.venue_id !== undefined && b.venue_id !== '') {
      const lv = await venueDe({ venue_id: b.venue_id });
      if (lv.erro) return res.status(400).json({ error: lv.erro });
      venueId = lv.venue_id;
      if (b.layout_id !== undefined && b.layout_id !== null && b.layout_id !== '') {
        layoutId = idOk(b.layout_id);
        const l = layoutId && (await q('SELECT venue_id FROM shows_layouts WHERE id=$1', [layoutId])).rows[0];
        if (!l || String(l.venue_id) !== String(venueId)) return res.status(400).json({ error: 'Esse formato não é deste local' });
      } else layoutId = (await q('SELECT id FROM shows_layouts WHERE venue_id=$1 AND is_default', [venueId])).rows[0]?.id;
    } else if (b.venue_id === undefined) return res.status(400).json({ error: 'Informe o local' });
    await tx(currentCompany(), async (t) => {
      await t('SELECT pg_advisory_xact_lock(hashtext($1))', [`shows:${currentCompany()}:${ev.id}`]);
      if (venueId) await t(`INSERT INTO shows_event_setup (event_id, venue_id, layout_id) VALUES ($1,$2,$3) ON CONFLICT (event_id) DO UPDATE SET venue_id=EXCLUDED.venue_id, layout_id=EXCLUDED.layout_id`, [ev.id, venueId, layoutId]);
      else await t('DELETE FROM shows_event_setup WHERE event_id=$1', [ev.id]);
      const cfg = await configuracao(t, { event_id: ev.id });
      const usados = (await t(`SELECT DISTINCT s.id, s.name FROM shows_sales v JOIN shows_sectors s ON s.id = v.sector_id WHERE v.event_id=$1 AND v.status = ANY($2)`, [ev.id, OCUPAM])).rows;
      const naoCabem = [];
      for (const x of usados) {
        const dono = (await t('SELECT venue_id FROM shows_sectors WHERE id=$1', [x.id])).rows[0].venue_id;
        if (String(dono) !== String(cfg.venue_id) || !cfg.entra(x.id)) naoCabem.push(x.name);
      }
      if (naoCabem.length) { const e = new Error(`Há vendas em setores que não existem nesse local e formato: ${naoCabem.join(', ')}.`); e.status = 409; throw e; }
      await conferirEventos(t, [ev.id]);
    });
    res.json(setupOut(await configuracao(q, { event_id: ev.id })));
  }));

  // ---------- preço e palavras-chave do evento ----------
  // Preço por pessoa valendo agora, já considerando a palavra-chave (se vier) e, opcionalmente, outro desconto em % já reconhecido
  // (ex.: o do programa de benefícios). Descontos não se somam: vale o que sair mais barato.
  // Lugares que ainda dá para vender numa mesa reservada: lugares da mesa - pessoas do dono - convidados confirmados
  async function lugaresLivres(run, hostId) {
    const h = (await run('SELECT seats_each, tables, people, status FROM shows_sales WHERE id=$1', [hostId])).rows[0];
    if (!h || !OCUPAM.includes(h.status)) return 0;
    const vend = Number((await run('SELECT COALESCE(SUM(people),0) AS n FROM shows_sales WHERE host_sale_id=$1 AND status = ANY($2)', [hostId, OCUPAM])).rows[0].n);
    return Math.max(0, h.seats_each * h.tables - h.people - vend);
  }
  // ---------- desconto do Clube ----------
  // Membro do clube (conferido no cadastro de clientes pelo telefone) paga menos nele e em N acompanhantes. Vale o que sair mais barato:
  // não soma com palavra-chave nem com outro desconto, e nunca encarece.
  async function clubeCfg(run) {
    const c = (await run('SELECT percent::float AS percent, companions FROM shows_club_discount WHERE id')).rows[0];
    return c && c.percent > 0 ? c : { percent: null, companions: 1 };
  }
  async function ehMembro(run, phone, cid) {
    if (!phone && !cid) return false;
    return !!(await run(`SELECT 1 FROM customers WHERE club_status = 'member' AND (id = $1::bigint OR phone = $2) LIMIT 1`, [cid || null, phone || null])).rows[0];
  }
  // Melhor desconto de clube para este telefone: o do próprio programa da empresa (se for membro) ou o de um programa parceiro com desconto em %
  async function beneficioClube(run, phone, cid) {
    const cfg = await clubeCfg(run);
    const opcoes = [];
    if (cfg.percent && await ehMembro(run, phone, cid)) opcoes.push({ percent: cfg.percent, companions: cfg.companions, source: 'own', label: null });
    if (phone) for (const b of await beneficiosDeParceiros(phone)) if (b.discount_percent) opcoes.push({ percent: b.discount_percent, companions: b.companions, source: 'partner', label: `${b.program} (${b.partner})` });
    opcoes.sort((a, b) => b.percent - a.percent || b.companions - a.companions);
    return opcoes[0] || null;
  }
  // Quanto abate da venda: para o membro e os acompanhantes (os primeiros da venda), o preço do clube se for menor que o preço já valendo
  function descontoClube(unit, base, people, cfg) {
    if (!cfg.percent || unit === null || unit === undefined || base === null || base === undefined) return 0;
    const n = Math.min(people, 1 + cfg.companions);
    const noClube = r2(base * (1 - cfg.percent / 100));
    return noClube < unit ? r2(n * (unit - noClube)) : 0;
  }
  async function precoPara(run, eventId, palavra, outroPct, excluirVenda) {
    const c = (await run('SELECT price::float AS price, door_price::float AS door_price, price_until FROM shows_event_conditions WHERE event_id=$1', [eventId])).rows[0];
    const lotes = (await run('SELECT id, name, price::float AS price, valid_until, max_qty FROM shows_event_lots WHERE event_id=$1 ORDER BY position', [eventId])).rows;
    if (!lotes.length && (!c || c.price === null)) return { unit_price: null, base_price: null, code_valid: !palavra, reason: palavra ? 'Este evento não tem preço cadastrado' : undefined };
    let base, tier = 'normal', lote = null, proximo = null, ate = null, loteId = null, restam = null, qtd = null;
    if (lotes.length) {
      const agora = new Date();
      // lote sem prazo vale até o começo do evento, quando entra o preço da portaria (se houver)
      if (c?.door_price != null) { const ini = (await run('SELECT starts_at FROM events WHERE id=$1', [eventId])).rows[0]?.starts_at; for (const l of lotes) if (!l.valid_until && !l.max_qty) l.valid_until = ini; }
      const vendidos = {};
      for (const x of (await run(`SELECT lot_id, COALESCE(SUM(people),0)::int AS n FROM shows_sales WHERE event_id=$1 AND lot_id IS NOT NULL AND status = ANY($2)${excluirVenda ? ' AND id <> ' + Number(excluirVenda) : ''} GROUP BY lot_id`, [eventId, OCUPAM])).rows) vendidos[x.lot_id] = x.n;
      for (const l of lotes) l.restam = l.max_qty ? Math.max(0, l.max_qty - (vendidos[l.id] || 0)) : null;
      const aberto = (l) => (!l.valid_until || agora <= new Date(l.valid_until)) && (l.restam === null || l.restam > 0);
      const i = lotes.findIndex(aberto);
      const mostra = (l) => ({ lote: l.name, ate: l.valid_until, loteId: l.id, restam: l.restam, qtd: l.max_qty });
      if (i >= 0) {
        ({ lote, ate, loteId, restam, qtd } = mostra(lotes[i])); base = lotes[i].price; tier = 'lote';
        const n = lotes.slice(i + 1).find(aberto) || lotes[i + 1];
        if (n) proximo = { name: n.name, price: n.price, valid_until: n.valid_until };
        else if (c?.door_price != null && (ate || restam !== null)) proximo = { name: 'Portaria', price: c.door_price, valid_until: null };
      } else if (c?.door_price != null) { base = c.door_price; tier = 'portaria'; }
      else { const u = lotes[lotes.length - 1]; base = u.price; ({ lote, ate, loteId, restam, qtd } = mostra(u)); tier = 'lote'; }
    } else {
      const portaria = c.price_until && c.door_price !== null && new Date() > new Date(c.price_until);
      base = portaria ? c.door_price : c.price;
      tier = portaria ? 'portaria' : 'normal';
    }
    const out = { base_price: base, tier, unit_price: base, applied: null, code_valid: true };
    if (lote) { out.lot = lote; out.lot_until = ate; out.lot_id = loteId; out.lot_qty = qtd; out.lot_remaining = restam; out.next_lot = proximo; }
    if (outroPct) {
      const v = r2(base * (1 - outroPct / 100));
      if (v < out.unit_price) { out.unit_price = v; out.applied = 'other'; }
    }
    if (palavra) {
      const k = (await run('SELECT * FROM shows_event_codes WHERE event_id=$1 AND word_norm=$2', [eventId, norma(palavra)])).rows[0];
      if (!k) return { ...out, code_valid: false, reason: 'Palavra-chave não encontrada neste evento' };
      if (k.valid_until && new Date() > new Date(k.valid_until)) return { ...out, code_valid: false, reason: 'Essa palavra-chave já expirou' };
      if (k.max_uses) {
        const usos = Number((await run(`SELECT COUNT(*) AS n FROM shows_sales WHERE code_id=$1 AND status = ANY($2)${excluirVenda ? ' AND id <> ' + Number(excluirVenda) : ''}`, [k.id, OCUPAM])).rows[0].n);
        if (usos >= k.max_uses) return { ...out, code_valid: false, reason: 'Essa palavra-chave já atingiu o limite de usos' };
      }
      if (k.host_sale_id) {   // palavra de mesa reservada: só vale se ainda há lugar
        const livres = await lugaresLivres(run, k.host_sale_id);
        out.held = { sale_id: k.host_sale_id, free_seats: livres };
        if (livres < 1) return { ...out, code_valid: false, reason: 'Os lugares dessa mesa já foram todos vendidos' };
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
  const COND = 'SELECT price::float AS price, door_price::float AS door_price, price_until, instructions FROM shows_event_conditions WHERE event_id=$1';
  r.get('/casa-de-shows/events/:id/conditions', wrap(async (req, res) => {
    const ev = await eventoDe(req.params.id);
    if (!ev) return res.status(404).json({ error: 'Evento não encontrado' });
    const c = (await q(COND, [ev.id])).rows[0] || { price: null, door_price: null, price_until: null, instructions: null };
    res.json({ event_id: ev.id, ...c });
  }));
  r.put('/casa-de-shows/events/:id/conditions', wrap(async (req, res) => {
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
    const temLotes = Number((await q('SELECT COUNT(*) AS n FROM shows_event_lots WHERE event_id=$1', [ev.id])).rows[0].n) > 0;
    if (n.price === null && !temLotes && (n.door_price !== null || n.price_until)) return res.status(400).json({ error: 'Informe o preço do ingresso' });
    await q(`INSERT INTO shows_event_conditions (event_id, price, door_price, price_until, instructions) VALUES ($1,$2,$3,$4,$5)
             ON CONFLICT (event_id) DO UPDATE SET price=EXCLUDED.price, door_price=EXCLUDED.door_price, price_until=EXCLUDED.price_until, instructions=EXCLUDED.instructions`,
      [ev.id, n.price, n.door_price, n.price_until, n.instructions]);
    res.json({ event_id: ev.id, ...(await q(COND, [ev.id])).rows[0] });
  }));

  const CODIGO = `SELECT k.id, k.event_id, k.word, k.kind, k.value::float AS value, k.max_uses, k.valid_until, k.note,
                         (SELECT COUNT(*)::int FROM shows_sales v WHERE v.code_id = k.id AND v.status IN ('confirmed','attended')) AS uses
                  FROM shows_event_codes k`;
  r.get('/casa-de-shows/events/:id/codes', wrap(async (req, res) => {
    const ev = await eventoDe(req.params.id);
    if (!ev) return res.status(404).json({ error: 'Evento não encontrado' });
    res.json((await q(`${CODIGO} WHERE k.event_id=$1 AND k.host_sale_id IS NULL ORDER BY k.id`, [ev.id])).rows);
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
  r.post('/casa-de-shows/events/:id/codes', wrap(async (req, res) => {
    const ev = await eventoDe(req.params.id);
    if (!ev) return res.status(404).json({ error: 'Evento não encontrado' });
    const { o, erro } = lerCodigo(req.body || {}, false);
    if (erro) return res.status(400).json({ error: erro });
    try {
      const id = (await q(`INSERT INTO shows_event_codes (event_id, word, word_norm, kind, value, max_uses, valid_until, note) VALUES ($1,$2,$3,$4,$5,$6,$7,NULLIF($8,'')) RETURNING id`,
        [ev.id, o.word, o.word_norm, o.kind, o.value, o.max_uses ?? null, o.valid_until ?? null, o.note || ''])).rows[0].id;
      res.status(201).json((await q(`${CODIGO} WHERE k.id=$1`, [id])).rows[0]);
    } catch (e) {
      if (e.code === '23505') return res.status(409).json({ error: 'Já existe essa palavra-chave neste evento' });
      throw e;
    }
  }));
  r.put('/casa-de-shows/codes/:id', wrap(async (req, res) => {
    const atual = (await q(`${CODIGO} WHERE k.id=$1`, [req.params.id])).rows[0];
    if (!atual) return res.status(404).json({ error: 'Palavra-chave não encontrada' });
    if ((await q('SELECT host_sale_id FROM shows_event_codes WHERE id=$1', [atual.id])).rows[0].host_sale_id) return res.status(409).json({ error: 'Essa palavra é de uma mesa reservada. Altere pela própria mesa.' });
    const { o, erro } = lerCodigo(req.body || {}, true, atual);
    if (erro) return res.status(400).json({ error: erro });
    const n = { ...atual, ...o, word_norm: o.word_norm || norma(atual.word) };
    try {
      await q(`UPDATE shows_event_codes SET word=$2, word_norm=$3, kind=$4, value=$5, max_uses=$6, valid_until=$7, note=NULLIF($8,'') WHERE id=$1`,
        [req.params.id, n.word, n.word_norm, n.kind, n.value, n.max_uses ?? null, n.valid_until ?? null, n.note || '']);
    } catch (e) {
      if (e.code === '23505') return res.status(409).json({ error: 'Já existe essa palavra-chave neste evento' });
      throw e;
    }
    res.json((await q(`${CODIGO} WHERE k.id=$1`, [req.params.id])).rows[0]);
  }));
  r.delete('/casa-de-shows/codes/:id', wrap(async (req, res) => {
    const k = (await q('SELECT host_sale_id FROM shows_event_codes WHERE id=$1', [req.params.id])).rows[0];
    if (k?.host_sale_id) return res.status(409).json({ error: 'Essa palavra é de uma mesa reservada. Desative a mesa reservada na própria venda.' });
    const { rowCount } = await q('DELETE FROM shows_event_codes WHERE id=$1', [req.params.id]);
    rowCount ? res.json({ ok: true }) : res.status(404).json({ error: 'Palavra-chave não encontrada' });
  }));

  // Quanto custa o ingresso agora? ?code=palavra (opcional) ; ?people=N (total = N × valor) ; ?other_percent=10 (outro desconto já reconhecido, ex.: programa de benefícios)
  // O atendente usa esta rota: ela nunca devolve a lista de palavras, só diz se a palavra dita vale.
  r.get('/casa-de-shows/events/:id/price', wrap(async (req, res) => {
    const ev = await eventoDe(req.params.id);
    if (!ev) return res.status(404).json({ error: 'Evento não encontrado' });
    const people = req.query.people ? inteiro(req.query.people, 1, 1000) : null;
    if (req.query.people && !people) return res.status(400).json({ error: 'Quantidade de pessoas inválida' });
    const outro = req.query.other_percent ? num(req.query.other_percent) : 0;
    if (outro === null || outro < 0 || outro > 100) return res.status(400).json({ error: 'Percentual inválido' });
    const pr = await precoPara(q, ev.id, String(req.query.code || '').trim(), outro, null);
    const ins = (await q('SELECT instructions FROM shows_event_conditions WHERE event_id=$1', [ev.id])).rows[0]?.instructions || null;
    const pix = await chavesDoEvento(q, ev.id);
    // Clube: com ?phone= o preço confere se a pessoa é membro (do programa da empresa ou de um parceiro); devolve quanto abate para ele e os acompanhantes
    const cfgClube = await clubeCfg(q);
    let clube = null, cfgUsado = cfgClube;
    const fone = req.query.phone ? normPhone(req.query.phone) : null;
    const bene = fone ? await beneficioClube(q, fone, null) : null;
    if (bene) cfgUsado = { percent: bene.percent, companions: bene.companions };
    if (cfgClube.percent || bene) {
      const p0 = bene ? bene.percent : cfgClube.percent;
      clube = { percent: p0, companions: cfgUsado.companions, member: fone ? !!bene : null, via: bene?.label || null };
      if (bene && pr.unit_price !== null) {
        clube.discount = descontoClube(pr.unit_price, pr.base_price, people || 1 + cfgUsado.companions, cfgUsado);
        clube.price = r2(Math.min(pr.unit_price, pr.base_price * (1 - bene.percent / 100)));
      }
    }
    const abate = bene && people && pr.unit_price !== null ? descontoClube(pr.unit_price, pr.base_price, people, cfgUsado) : 0;
    res.json({ event: { id: ev.id, title: ev.title }, ...pr, code_id: undefined, club: clube, club_discount: abate, people, total: people && pr.unit_price !== null ? r2(people * pr.unit_price - abate) : null, instructions: ins, pix_key: chaveOut(pix.current), pix_all_full: pix.all_full });
  }));

  // ---------- lotes de ingresso ----------
  const LOTES = `SELECT l.id, l.position, l.name, l.price::float AS price, l.valid_until, l.max_qty,
                        (SELECT COALESCE(SUM(v.people),0)::int FROM shows_sales v WHERE v.lot_id = l.id AND v.status = ANY($2)) AS sold
                 FROM shows_event_lots l WHERE l.event_id=$1 ORDER BY l.position`;
  const lotesOut = async (ev) => {
    const pr = await precoPara(q, ev.id, '', 0, null);
    return { event_id: ev.id, lots: (await q(LOTES, [ev.id, OCUPAM])).rows, current: pr.lot ? { name: pr.lot, price: pr.base_price, remaining: pr.lot_remaining } : null, tier: pr.tier || null };
  };
  // ---------- desconto do Clube ----------
  r.get('/casa-de-shows/club-discount', wrap(async (req, res) => {
    const c = await clubeCfg(q);
    res.json({ percent: c.percent, companions: c.companions });
  }));
  // Corpo: { percent: 10 | null (desliga), companions: 1 }
  r.put('/casa-de-shows/club-discount', wrap(async (req, res) => {
    if ((req.baseUrl || '').includes('n8n')) return res.status(403).json({ error: 'Só pelo painel' });
    const b = req.body || {};
    const pct = b.percent === null || b.percent === '' || b.percent === undefined ? null : num(b.percent);
    if (pct !== null && (pct <= 0 || pct > 100)) return res.status(400).json({ error: 'O desconto precisa ficar entre 0 e 100%' });
    const comp = b.companions === undefined || b.companions === '' ? 1 : inteiro(b.companions, 0, 20);
    if (comp === null || comp === undefined) return res.status(400).json({ error: 'Número de acompanhantes inválido' });
    await q(`INSERT INTO shows_club_discount (id, percent, companions) VALUES (true, $1, $2) ON CONFLICT (id) DO UPDATE SET percent=$1, companions=$2`, [pct, comp]);
    const c = await clubeCfg(q);
    res.json({ percent: c.percent, companions: c.companions });
  }));

  r.get('/casa-de-shows/events/:id/lots', wrap(async (req, res) => {
    const ev = await eventoDe(req.params.id);
    if (!ev) return res.status(404).json({ error: 'Evento não encontrado' });
    res.json(await lotesOut(ev));
  }));
  // Corpo: { lots: [{ id?, name, price, valid_until?, max_qty? }, ...] } na ordem dos lotes ; { lots: [] } apaga todos (volta ao preço único)
  // O lote fecha pelo prazo OU ao esgotar a quantidade (o que vier primeiro). Mandar o id mantém o histórico de vendas do lote.
  r.put('/casa-de-shows/events/:id/lots', wrap(async (req, res) => {
    if ((req.baseUrl || '').includes('n8n')) return res.status(403).json({ error: 'Só pelo painel' });
    const ev = await eventoDe(req.params.id);
    if (!ev) return res.status(404).json({ error: 'Evento não encontrado' });
    const ls = req.body?.lots;
    if (!Array.isArray(ls) || ls.length > 12) return res.status(400).json({ error: 'Informe a lista de lotes (até 12)' });
    const existentes = new Set((await q('SELECT id FROM shows_event_lots WHERE event_id=$1', [ev.id])).rows.map((x) => String(x.id)));
    const novos = [];
    let anterior = null;
    for (const [i, l] of ls.entries()) {
      const nome = txt(l?.name || String(i + 1), 60);
      if (!nome) return res.status(400).json({ error: 'Nome do lote inválido' });
      const preco = dinheiro(l?.price);
      if (l?.price === undefined || l?.price === null || l?.price === '' || preco === null) return res.status(400).json({ error: `Informe o valor do ${nome}` });
      let ate = null;
      if (l.valid_until) { const d = new Date(l.valid_until); if (isNaN(d)) return res.status(400).json({ error: `Prazo do ${nome} inválido` }); ate = d.toISOString(); }
      let qtd = null;
      if (l.max_qty !== undefined && l.max_qty !== null && l.max_qty !== '') { qtd = inteiro(l.max_qty, 1, 100000); if (!qtd) return res.status(400).json({ error: `Quantidade do ${nome} inválida` }); }
      if (!ate && !qtd && i < ls.length - 1) return res.status(400).json({ error: `Informe até quando vale ou quantos ingressos tem o ${nome}` });
      if (ate && anterior && new Date(ate) <= new Date(anterior)) return res.status(400).json({ error: `O prazo do ${nome} precisa ser depois do lote anterior` });
      if (ate) anterior = ate;
      const id = idOk(l.id);
      if (id && !existentes.has(id)) return res.status(400).json({ error: `O ${nome} não pertence a este evento` });
      novos.push({ id, pos: i + 1, nome, preco, ate, qtd });
    }
    await tx(currentCompany(), async (t) => {
      const manter = novos.filter((n) => n.id).map((n) => n.id);
      await t('DELETE FROM shows_event_lots WHERE event_id=$1 AND NOT (id = ANY($2::bigint[]))', [ev.id, manter]);
      await t('UPDATE shows_event_lots SET position = position + 1000 WHERE event_id=$1', [ev.id]);
      for (const n of novos) {
        if (n.id) await t('UPDATE shows_event_lots SET position=$2, name=$3, price=$4, valid_until=$5, max_qty=$6 WHERE id=$1', [n.id, n.pos, n.nome, n.preco, n.ate, n.qtd]);
        else await t('INSERT INTO shows_event_lots (event_id, position, name, price, valid_until, max_qty) VALUES ($1,$2,$3,$4,$5,$6)', [ev.id, n.pos, n.nome, n.preco, n.ate, n.qtd]);
      }
    });
    res.json(await lotesOut(ev));
  }));

  // ---------- chaves Pix do evento (com rodízio por valor) ----------
  // Lista as chaves do evento em ordem, com quanto cada uma já recebeu NESTE evento (Pix lançado nas vendas, sem as canceladas).
  // A chave da vez é a primeira ativa que ainda não chegou ao limite; se todas chegaram, fica a última e vem all_full = true.
  // Evento sem chaves próprias usa a primeira chave ativa da empresa.
  async function chavesDoEvento(run, eventId) {
    const lista = (await run(`SELECT e.key_id, e.position, e.limit_amount::float AS limit_amount, k.key, k.key_type, k.beneficiary, k.active,
                                     COALESCE((SELECT SUM(p.amount) FROM shows_sale_payments p JOIN shows_sales v ON v.id = p.sale_id
                                               WHERE p.method = 'pix' AND p.pix_key_id = e.key_id AND v.event_id = e.event_id AND v.status <> 'cancelled'), 0)::float AS received
                              FROM shows_event_pix e JOIN pix_keys k ON k.id = e.key_id WHERE e.event_id = $1 ORDER BY e.position`, [eventId])).rows;
    const out = { configured: lista.length > 0, keys: lista, current: null, all_full: false };
    if (lista.length) {
      const ativas = lista.filter((k) => k.active);
      const vez = ativas.find((k) => k.limit_amount === null || k.received < k.limit_amount);
      out.current = vez || ativas[ativas.length - 1] || null;
      out.all_full = !!ativas.length && !vez;
    } else {
      const k = (await run('SELECT id AS key_id, key, key_type, beneficiary, active FROM pix_keys WHERE active ORDER BY id LIMIT 1')).rows[0];
      out.current = k ? { ...k, position: 0, limit_amount: null, received: 0 } : null;
    }
    return out;
  }
  const chaveOut = (c) => (c ? { key_id: c.key_id, key: c.key, key_type: c.key_type, beneficiary: c.beneficiary } : null);
  r.get('/casa-de-shows/events/:id/pix', wrap(async (req, res) => {
    const ev = await eventoDe(req.params.id);
    if (!ev) return res.status(404).json({ error: 'Evento não encontrado' });
    const c = await chavesDoEvento(q, ev.id);
    res.json({ event_id: ev.id, configured: c.configured, keys: c.keys, current: chaveOut(c.current), all_full: c.all_full });
  }));
  // Corpo: { keys: [{ key_id, limit_amount? }, ...] } na ordem do rodízio ; { keys: [] } volta a usar a chave da empresa
  r.put('/casa-de-shows/events/:id/pix', wrap(async (req, res) => {
    if ((req.baseUrl || '').includes('n8n')) return res.status(403).json({ error: 'Só pelo painel' });
    const ev = await eventoDe(req.params.id);
    if (!ev) return res.status(404).json({ error: 'Evento não encontrado' });
    const ks = req.body?.keys;
    if (!Array.isArray(ks) || ks.length > 20) return res.status(400).json({ error: 'Informe a lista de chaves (até 20)' });
    const vistos = new Set(), novas = [];
    for (const [i, k] of ks.entries()) {
      const id = idOk(k?.key_id);
      if (!id) return res.status(400).json({ error: 'Chave inválida' });
      if (vistos.has(id)) return res.status(400).json({ error: 'A mesma chave foi escolhida duas vezes' });
      vistos.add(id);
      if (!(await q('SELECT 1 FROM pix_keys WHERE id=$1', [id])).rows.length) return res.status(400).json({ error: 'Chave Pix não encontrada' });
      let lim = null;
      if (k.limit_amount !== undefined && k.limit_amount !== null && k.limit_amount !== '') {
        lim = dinheiro(k.limit_amount);
        if (lim === null || lim <= 0) return res.status(400).json({ error: 'Limite inválido' });
      }
      novas.push([id, i + 1, lim]);
    }
    await tx(currentCompany(), async (t) => {
      await t('DELETE FROM shows_event_pix WHERE event_id=$1', [ev.id]);
      for (const [id, pos, lim] of novas) await t('INSERT INTO shows_event_pix (event_id, key_id, position, limit_amount) VALUES ($1,$2,$3,$4)', [ev.id, id, pos, lim]);
    });
    const c = await chavesDoEvento(q, ev.id);
    res.json({ event_id: ev.id, configured: c.configured, keys: c.keys, current: chaveOut(c.current), all_full: c.all_full });
  }));

  // Duplica um evento (também um já realizado): mesmas condições, palavras-chave e espaço dos setores, com a lista de vendas vazia.
  // As datas de preço e validade acompanham a diferença entre o evento antigo e o novo. Mesas extras e vendas não são copiadas.
  r.post('/casa-de-shows/events/:id/duplicate', wrap(async (req, res) => {
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
      await t('INSERT INTO shows_event_sectors (event_id, sector_id, space) SELECT $2, sector_id, space FROM shows_event_sectors WHERE event_id=$1', [orig.id, e.id]);
      await t('INSERT INTO shows_event_setup (event_id, venue_id, layout_id) SELECT $2, venue_id, layout_id FROM shows_event_setup WHERE event_id=$1', [orig.id, e.id]);
      await t('INSERT INTO shows_event_pix (event_id, key_id, position, limit_amount) SELECT $2, key_id, position, limit_amount FROM shows_event_pix WHERE event_id=$1', [orig.id, e.id]);
      for (const l of (await t('SELECT * FROM shows_event_lots WHERE event_id=$1 ORDER BY position', [orig.id])).rows) await t('INSERT INTO shows_event_lots (event_id, position, name, price, valid_until, max_qty) VALUES ($1,$2,$3,$4,$5,$6)', [e.id, l.position, l.name, l.price, mover(l.valid_until), l.max_qty]);
      const c = (await t('SELECT * FROM shows_event_conditions WHERE event_id=$1', [orig.id])).rows[0];
      if (c) await t('INSERT INTO shows_event_conditions (event_id, price, door_price, price_until, instructions) VALUES ($1,$2,$3,$4,$5)', [e.id, c.price, c.door_price, mover(c.price_until), c.instructions]);
      const ks = (await t('SELECT * FROM shows_event_codes WHERE event_id=$1 AND host_sale_id IS NULL ORDER BY id', [orig.id])).rows;
      for (const k of ks) await t('INSERT INTO shows_event_codes (event_id, word, word_norm, kind, value, max_uses, valid_until, note) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)', [e.id, k.word, k.word_norm, k.kind, k.value, k.max_uses, mover(k.valid_until), k.note]);
      return { event: e, codes: ks.length, has_conditions: !!c };
    });
    res.status(201).json(novo);
  }));

  // Quem pergunta sobre o evento vira lead (e fica registrado como interessado nele). Quem já é cliente continua cliente.
  r.post('/casa-de-shows/events/:id/interest', wrap(async (req, res) => {
    const ev = await eventoDe(req.params.id);
    if (!ev) return res.status(404).json({ error: 'Evento não encontrado' });
    const phone = normPhone(req.body?.phone);
    if (!/^\d{8,15}$/.test(phone)) return res.status(400).json({ error: 'Telefone inválido' });
    const nome = req.body?.name === undefined ? null : txt(req.body.name, 120);
    if (nome === null && req.body?.name !== undefined) return res.status(400).json({ error: 'Nome inválido' });
    const cu = (await q(`INSERT INTO customers (name, phone, status, source) VALUES (NULLIF($1,''),$2,'lead',$3)
                         ON CONFLICT (phone) DO UPDATE SET name = COALESCE(customers.name, EXCLUDED.name) RETURNING id, status`, [nome || '', phone, quem(req)])).rows[0];
    const novo = (await q('INSERT INTO shows_event_interest (event_id, customer_id) VALUES ($1,$2) ON CONFLICT DO NOTHING', [ev.id, cu.id])).rowCount === 1;
    res.status(novo ? 201 : 200).json({ customer_id: cu.id, status: cu.status, already: !novo });
  }));

  // ---------- mesas extras ----------
  // Abrir à mão uma mesa fora do que o setor comporta (ex.: tirar um pedaço da pista). Vale só para o evento/data e já aparece nas vagas.
  const EXTRA = `SELECT x.id, x.event_id, x.occasion_date::text AS date, x.sector_id, s.name AS sector_name, x.table_type_id, x.table_name, x.seats_each,
                        x.space_each::float AS space_each, x.quantity, (x.quantity * x.space_each)::float AS space, x.note, x.created_at
                 FROM shows_extras x JOIN shows_sectors s ON s.id = x.sector_id`;
  r.get('/casa-de-shows/extras', wrap(async (req, res) => {
    const oc = await ocasiao(req.query);
    if (oc.erro) return res.status(400).json({ error: oc.erro });
    const a = [];
    const f = filtroOcasiao(oc, a, 'x.');
    res.json((await q(`${EXTRA} WHERE ${f} ORDER BY x.id`, a)).rows);
  }));
  r.post('/casa-de-shows/extras', wrap(async (req, res) => {
    const b = req.body || {};
    const oc = await ocasiao(b);
    if (oc.erro) return res.status(400).json({ error: oc.erro });
    const sid = idOk(b.sector_id);
    if (!sid || !(await q('SELECT 1 FROM shows_sectors WHERE id=$1', [sid])).rows[0]) return res.status(400).json({ error: 'Setor não encontrado' });
    const tid = idOk(b.table_type_id);
    const tipo = tid && (await q(`${TIPO} WHERE id=$1`, [tid])).rows[0];
    if (!tipo) return res.status(400).json({ error: 'Escolha o tipo da mesa extra' });
    const qtd = b.quantity === undefined ? 1 : inteiro(b.quantity, 1, 100);
    if (!qtd) return res.status(400).json({ error: 'Quantidade inválida (1 a 100)' });
    const note = b.note === undefined ? '' : txt(b.note, 300);
    if (note === null) return res.status(400).json({ error: 'Anotação inválida (até 300 letras)' });
    const id = (await q(`INSERT INTO shows_extras (event_id, occasion_date, sector_id, table_type_id, table_name, seats_each, space_each, quantity, note)
                         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,NULLIF($9,'')) RETURNING id`, [oc.event_id, oc.date, sid, tipo.id, tipo.name, tipo.seats, tipo.space, qtd, note])).rows[0].id;
    res.status(201).json((await q(`${EXTRA} WHERE x.id=$1`, [id])).rows[0]);
  }));
  // Fechar a mesa extra só é possível se o setor continua comportando as vendas que já tem
  r.delete('/casa-de-shows/extras/:id', comTratamento(async (req, res) => {
    const x = (await q('SELECT * FROM shows_extras WHERE id=$1', [req.params.id])).rows[0];
    if (!x) return res.status(404).json({ error: 'Mesa extra não encontrada' });
    const oc = { event_id: x.event_id, date: String(x.occasion_date instanceof Date ? x.occasion_date.toISOString().slice(0, 10) : x.occasion_date).slice(0, 10) };
    await tx(currentCompany(), async (t) => {
      await t('SELECT pg_advisory_xact_lock(hashtext($1))', [`shows:${currentCompany()}:${oc.event_id || oc.date}`]);
      await t('DELETE FROM shows_extras WHERE id=$1', [x.id]);
      const [s] = await situacao(oc, { sectorId: x.sector_id }, t);
      let estoura = s && s.used > s.space + 1e-9;
      if (!estoura && x.table_type_id) {
        const g = await regraDoTipo(t, oc, x.sector_id, x.table_type_id);
        if (g.max !== null) {
          const a = [OCUPAM, x.sector_id, x.table_type_id];
          const f = filtroOcasiao(oc, a);
          const ja = Number((await t(`SELECT COALESCE(SUM(tables),0) AS n FROM shows_sales WHERE status = ANY($1) AND sector_id=$2 AND table_type_id=$3 AND ${f}`, a)).rows[0].n);
          estoura = ja > g.max;
        }
      }
      if (estoura) { const e = new Error('Essa mesa extra já está em uso por uma venda. Cancele ou mude a venda primeiro.'); e.status = 409; throw e; }
    });
    res.json({ ok: true });
  }));

  // Ajusta o espaço dos setores só para um evento. Corpo: { sectors: [{ sector_id, space }] } ; space null volta ao padrão do setor.
  r.put('/casa-de-shows/events/:id/sectors', wrap(async (req, res) => {
    const ev = idOk(req.params.id);
    if (!ev || !(await q('SELECT 1 FROM events WHERE id=$1', [ev])).rows[0]) return res.status(404).json({ error: 'Evento não encontrado' });
    const lista = Array.isArray(req.body?.sectors) ? req.body.sectors : null;
    if (!lista) return res.status(400).json({ error: 'Informe os setores' });
    const itens = [];
    for (const it of lista) {
      const sid = idOk(it?.sector_id);
      if (!sid || !(await q('SELECT 1 FROM shows_sectors WHERE id=$1', [sid])).rows[0]) return res.status(400).json({ error: 'Setor não encontrado' });
      if (it.space === null || it.space === '' || it.space === undefined) { itens.push([sid, null]); continue; }
      const v = espaco(it.space, 0);
      if (v === null) return res.status(400).json({ error: 'Espaço inválido' });
      itens.push([sid, v]);
    }
    await tx(currentCompany(), async (t) => {
      for (const [sid, v] of itens) {
        if (v === null) await t('DELETE FROM shows_event_sectors WHERE event_id=$1 AND sector_id=$2', [ev, sid]);
        else await t('INSERT INTO shows_event_sectors (event_id, sector_id, space) VALUES ($1,$2,$3) ON CONFLICT (event_id, sector_id) DO UPDATE SET space=EXCLUDED.space', [ev, sid, v]);
      }
    });
    res.json({ ok: true });
  }));

  // ---------- vendas ----------
  const VENDA = `SELECT v.id, v.event_id, e.title AS event_title, v.occasion_date::text AS date, v.sector_id, s.name AS sector_name,
                          v.customer_id, v.name, v.phone, v.people, v.table_type_id, v.table_name, v.seats_each, v.space_each::float AS space_each,
                          v.tables, (v.tables * v.space_each)::float AS space, (v.tables * v.seats_each) AS seats, v.status, v.note, v.guests, v.unit_price::float AS unit_price, v.club_discount::float AS club_discount, (v.people * v.unit_price - v.club_discount)::float AS total, v.code_word, v.created_at, v.held, v.host_sale_id,
                          (SELECT h.name FROM shows_sales h WHERE h.id = v.host_sale_id) AS host_name,
                          CASE WHEN v.held THEN GREATEST(0, v.seats_each * v.tables - v.people) END AS held_seats,
                          CASE WHEN v.held THEN COALESCE((SELECT SUM(g.people) FROM shows_sales g WHERE g.host_sale_id = v.id AND g.status IN ('confirmed','attended')), 0)::int END AS held_sold,
                          COALESCE((SELECT SUM(p.amount) FROM shows_sale_payments p WHERE p.sale_id = v.id AND p.method <> 'cortesia'), 0)::float AS paid,
                          EXISTS (SELECT 1 FROM shows_sale_payments p WHERE p.sale_id = v.id AND p.method = 'cortesia') AS courtesy
                   FROM shows_sales v JOIN shows_sectors s ON s.id = v.sector_id LEFT JOIN events e ON e.id = v.event_id`;

  r.get('/casa-de-shows/sales', wrap(async (req, res) => {
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
    res.json((await q(`${VENDA} ${w.length ? 'WHERE ' + w.join(' AND ') : ''} ORDER BY v.occasion_date, s.position, COALESCE(v.host_sale_id, v.id), (v.host_sale_id IS NOT NULL), v.id LIMIT 1000`, a)).rows);
  }));

  // O setor aceita esse tipo de mesa nessa ocasião? E até quantas (null = sem limite)? Mesas extras abertas à mão contam.
  async function regraDoTipo(run, oc, sid, tid) {
    const cfg = await configuracao(run, oc);
    const regras = cfg.regras(sid).map((x) => ({ t: x.table_type_id, max_tables: x.max_tables }));
    const g = regras.find((x) => x.t === String(tid));
    const a = [sid, tid];
    const f = filtroOcasiao(oc, a);
    const ex = Number((await run(`SELECT COALESCE(SUM(quantity),0) AS n FROM shows_extras WHERE sector_id=$1 AND table_type_id=$2 AND ${f}`, a)).rows[0].n);
    return { aceito: !regras.length || !!g || ex > 0, max: g && g.max_tables ? g.max_tables + ex : (!g && regras.length ? ex : null) };
  }

  // Confere se cabe e grava, tudo dentro de uma transação trancada por ocasião (duas vendas ao mesmo tempo não estouram o setor)
  async function gravar({ id, oc, setor, tipo, tables, people, status, nome, phone, cid, note, guests, confereMesa, preco, clube, aniversario }) {
    return tx(currentCompany(), async (t) => {
      await t('SELECT pg_advisory_xact_lock(hashtext($1))', [`shows:${currentCompany()}:${oc.event_id || oc.date}`]);
      if (OCUPAM.includes(status) && confereMesa && tipo.id) {
        // limite de mesas desse tipo no setor, contando as extras (só a própria venda em edição não conta)
        const g = await regraDoTipo(t, oc, setor.id, tipo.id);
        if (g.max !== null) {
          const a3 = [OCUPAM, setor.id, tipo.id];
          const f3 = filtroOcasiao(oc, a3);
          const ja = Number((await t(`SELECT COALESCE(SUM(tables),0) AS n FROM shows_sales WHERE status = ANY($1) AND sector_id=$2 AND table_type_id=$3 AND ${f3}${id ? ` AND id <> ${Number(id)}` : ''}`, a3)).rows[0].n);
          if (ja + tables > g.max) {
            const e = new Error(`O setor ${setor.name} comporta no máximo ${g.max} mesa(s) de ${tipo.name} e já tem ${ja}.`); e.status = 409; throw e;
          }
        }
      }
      if (OCUPAM.includes(status)) {
        const [s] = await situacao(oc, { sectorId: setor.id }, t);
        if (!s) { const e = new Error(`O setor ${setor.name} não faz parte do local e formato deste evento.`); e.status = 409; throw e; }
        const jaUsa = id ? Number((await t('SELECT status, tables * space_each AS u, sector_id FROM shows_sales WHERE id=$1', [id])).rows
          .filter((x) => OCUPAM.includes(x.status) && String(x.sector_id) === String(setor.id)).map((x) => x.u)[0] || 0) : 0;
        // para a edição, o espaço dela mesma conta como livre — mas só se a ocasião não mudou
        const antes = id ? (await t('SELECT event_id, occasion_date::text AS d FROM shows_sales WHERE id=$1', [id])).rows[0] : null;
        const mesma = antes && String(antes.event_id || '') === String(oc.event_id || '') && (oc.event_id || antes.d === oc.date);
        const livre = s.free + (mesma ? jaUsa : 0);
        const preciso = r2(tables * tipo.space);
        if (preciso > livre + 1e-9) {
          const e = new Error(`Sem espaço no setor ${setor.name}: precisa de ${preciso} e restam ${r2(livre)}.`); e.status = 409; throw e;
        }
      }
      const params = [oc.event_id, oc.date, setor.id, cid, nome, phone, people, tipo.id, tipo.name, tipo.seats, tipo.space, tables, status, note, guests];
      const comprou = async (rid) => {   // venda com valor pago > 0 transforma o contato em cliente (mesma regra das outras vendas)
        await t(`UPDATE customers SET status = 'client', client_kinds = CASE WHEN 'buyer' = ANY(client_kinds) THEN client_kinds ELSE array_append(client_kinds, 'buyer') END
                 WHERE id = (SELECT customer_id FROM shows_sales WHERE id=$1 AND status IN ('confirmed','attended') AND unit_price > 0)
                   AND (status <> 'client' OR NOT 'buyer' = ANY(client_kinds))`, [rid]);
        if (aniversario) {   // aniversário informado na venda: grava na ficha só se ainda não houver
          await t(`UPDATE customers SET birth_day=$2, birth_month=$3, birth_year=COALESCE(birth_year, $4)
                   WHERE id = (SELECT customer_id FROM shows_sales WHERE id=$1) AND birth_day IS NULL AND birth_month IS NULL`, [rid, aniversario.birth_day, aniversario.birth_month, aniversario.birth_year ?? null]);
        }
        return rid;
      };
      if (id) {
        await t(`UPDATE shows_sales SET event_id=$2, occasion_date=$3, sector_id=$4, customer_id=$5, name=$6, phone=$7, people=$8, table_type_id=$9,
                   table_name=$10, seats_each=$11, space_each=$12, tables=$13, status=$14, note=NULLIF($15,''), guests=NULLIF($16,''),
                   unit_price = CASE WHEN $17::boolean THEN $18::numeric ELSE unit_price END, code_id = CASE WHEN $17::boolean THEN $19::bigint ELSE code_id END,
                   code_word = CASE WHEN $17::boolean THEN $20 ELSE code_word END, lot_id = CASE WHEN $17::boolean THEN $21::bigint ELSE lot_id END,
                   club_discount = CASE WHEN $22::boolean THEN $23::numeric ELSE club_discount END, updated_at=now() WHERE id=$1`,
          [id, ...params.slice(0, 13), params[13] || '', params[14] || '', preco !== undefined, preco?.unit_price ?? null, preco?.code_id ?? null, preco?.code_word ?? null, preco?.lot_id ?? null, clube !== undefined, clube ?? 0]);
        return comprou(id);
      }
      return comprou((await t(`INSERT INTO shows_sales (event_id, occasion_date, sector_id, customer_id, name, phone, people, table_type_id, table_name, seats_each, space_each, tables, status, note, guests, unit_price, code_id, code_word, lot_id, club_discount)
                       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,NULLIF($14,''),NULLIF($15,''),$16,$17,$18,$19,$20) RETURNING id`,
        [...params, preco?.unit_price ?? null, preco?.code_id ?? null, preco?.code_word ?? null, preco?.lot_id ?? null, clube ?? 0])).rows[0].id);
    });
  }

  // Monta e valida uma venda a partir do corpo; `atual` = venda existente (edição).
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
    const setor = (await q('SELECT id, name, active FROM shows_sectors WHERE id=$1', [sid])).rows[0];
    if (!setor) return { erro: 'Setor não encontrado' };
    if (!setor.active && (!atual || String(atual.sector_id) !== String(setor.id))) return { erro: 'Esse setor está desativado' };
    if (!atual || tem('sector_id') || tem('event_id') || tem('date')) {
      const cfg = await configuracao(q, oc);
      const dele = (await q('SELECT venue_id FROM shows_sectors WHERE id=$1', [setor.id])).rows[0];
      if (String(dele.venue_id) !== String(cfg.venue_id) || !cfg.entra(setor.id))
        return { erro: `O setor ${setor.name} não faz parte do local e formato deste evento`, status: 409 };
    }
    // nome, telefone
    let nome = atual?.name, phone = atual?.phone ?? null;
    if (tem('name')) { nome = txt(b.name, 120); if (!nome) return { erro: 'Informe o nome de quem compra' }; }
    if (!nome) return { erro: 'Informe o nome de quem compra' };
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
      // mantém o tipo da venda, ajusta a quantidade
      tipo = { id: atual.table_type_id, name: atual.table_name, seats: atual.seats_each, space: Number(atual.space_each) };
      tables = tem('tables') ? inteiro(b.tables, 1, 100) : Math.ceil(people / tipo.seats);
      if (!tables) return { erro: 'Quantidade de mesas inválida' };
    } else {
      if (!(await q('SELECT 1 FROM shows_table_types WHERE active')).rows[0]) return { erro: 'Cadastre ao menos um tipo de mesa' };
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
    // aniversário (dd/mm ou dd/mm/aaaa) de quem compra: vai para a ficha, sem sobrescrever o que já existe
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
        preco = { unit_price: v, code_id: null, code_word: null, lot_id: null };
      } else if (tem('unit_price')) {
        preco = { unit_price: null, code_id: null, code_word: null, lot_id: null };
      } else if (oc.event_id) {
        const pr = await precoPara(q, oc.event_id, palavra, 0, atual?.id);
        if (palavra && !pr.code_valid) return { erro: pr.reason };
        if (pr.unit_price !== null) preco = { unit_price: pr.unit_price, code_id: pr.code_id || null, code_word: pr.code_id ? pr.code_word : null, lot_id: pr.tier === 'lote' ? pr.lot_id || null : null };
        else if (atual) preco = { unit_price: null, code_id: null, code_word: null, lot_id: null };
      }
    }
    // desconto do Clube: confere o telefone no cadastro; valor digitado à mão não leva desconto
    let clube;
    if (!atual || preco !== undefined || tem('people') || tem('phone') || tem('customer_id')) {
      clube = 0;
      const unit = preco !== undefined ? preco.unit_price : (atual?.unit_price == null ? null : Number(atual.unit_price));
      const manual = tem('unit_price') && b.unit_price !== null && b.unit_price !== '';
      if (oc.event_id && unit !== null && !manual && !atual?.host_sale_id) {
        const bene = await beneficioClube(q, phone, cid);
        if (bene) {
          const pr = await precoPara(q, oc.event_id, '', 0, atual?.id);
          clube = descontoClube(unit, pr.base_price, people, bene);
        }
      }
    }
    return { v: { oc, setor, tipo, tables, people, status, nome, phone, cid, note, guests, confereMesa, preco, clube, aniversario } };
  }


  // ---------- mesa reservada e convidados ----------
  // O dono compra a mesa; os lugares que sobram são vendidos a convidados, que ficam ligados à mesa:
  // cada convidado ocupa lugares dela (não espaço novo do setor) e paga o valor vigente com o desconto da mesa (percentual ou valor fixo).
  const erroHttp = (status, msg) => { const e = new Error(msg); e.status = status; return e; };
  const mesaDe = async (run, id) => (await run('SELECT *, occasion_date::text AS occasion_date FROM shows_sales WHERE id=$1', [id])).rows[0];
  const mesaOut = async (h) => {
    const cod = (await q(`${CODIGO} WHERE k.host_sale_id=$1`, [h.id])).rows[0] || null;
    const total = h.seats_each * h.tables;
    const livres = h.held ? await lugaresLivres(q, h.id) : 0;
    const convidados = (await q(`${VENDA} WHERE v.host_sale_id=$1 ORDER BY v.id`, [h.id])).rows;
    const vendidos = convidados.filter((c) => OCUPAM.includes(c.status)).reduce((a, c) => a + c.people, 0);
    return {
      sale_id: h.id, held: h.held, seats_total: total, owner_people: h.people, sold: vendidos, free: livres,
      code: cod && { id: cod.id, word: cod.word, kind: cod.kind, value: cod.value, valid_until: cod.valid_until, closed: !!cod.valid_until && new Date(cod.valid_until) < new Date() },
      guests: convidados,
    };
  };
  r.get('/casa-de-shows/sales/:id/held', wrap(async (req, res) => {
    const h = await mesaDe(q, idOk(req.params.id) || 0);
    if (!h) return res.status(404).json({ error: 'Venda não encontrada' });
    if (h.host_sale_id) return res.status(409).json({ error: 'Essa venda é de um convidado' });
    res.json(await mesaOut(h));
  }));
  // Corpo: { enabled: true, word, kind: 'percent'|'price', value } liga/ajusta ; { enabled: false } desliga (sem convidados) ; { closed: true|false } encerra/reabre a venda pela palavra
  r.put('/casa-de-shows/sales/:id/held', comTratamento(async (req, res) => {
    if ((req.baseUrl || '').includes('n8n')) return res.status(403).json({ error: 'Só pelo painel' });
    const h = await mesaDe(q, idOk(req.params.id) || 0);
    if (!h) return res.status(404).json({ error: 'Venda não encontrada' });
    if (h.host_sale_id) throw erroHttp(409, 'Essa venda é de um convidado');
    const b = req.body || {};
    const cod = (await q('SELECT id FROM shows_event_codes WHERE host_sale_id=$1', [h.id])).rows[0];
    if (b.enabled === false) {
      const ativos = Number((await q('SELECT COUNT(*) AS n FROM shows_sales WHERE host_sale_id=$1 AND status = ANY($2)', [h.id, OCUPAM])).rows[0].n);
      if (ativos) throw erroHttp(409, 'Essa mesa já tem convidados. Cancele ou apague os convidados antes.');
      await tx(currentCompany(), async (t) => { await t('DELETE FROM shows_event_codes WHERE host_sale_id=$1', [h.id]); await t('UPDATE shows_sales SET held=false WHERE id=$1', [h.id]); });
      return res.json(await mesaOut(await mesaDe(q, h.id)));
    }
    if (b.closed !== undefined && b.enabled === undefined) {
      if (!cod) throw erroHttp(409, 'Essa venda ainda não é uma mesa reservada');
      await q('UPDATE shows_event_codes SET valid_until = $2 WHERE id=$1', [cod.id, b.closed ? new Date().toISOString() : null]);
      return res.json(await mesaOut(await mesaDe(q, h.id)));
    }
    if (b.enabled !== true) return res.status(400).json({ error: 'Informe se a mesa reservada fica ligada' });
    if (!h.event_id) throw erroHttp(409, 'A mesa reservada precisa estar numa venda de um evento');
    if (!OCUPAM.includes(h.status)) throw erroHttp(409, 'Essa venda está cancelada');
    if (h.seats_each * h.tables - h.people < 1) throw erroHttp(409, 'Não sobram lugares nessa mesa para vender a convidados');
    const { o, erro } = lerCodigo({ word: b.word, kind: b.kind, value: b.value, valid_until: b.valid_until, note: b.note }, !!cod, cod && (await q(`${CODIGO} WHERE k.id=$1`, [cod.id])).rows[0]);
    if (erro) throw erroHttp(400, erro);
    try {
      await tx(currentCompany(), async (t) => {
        if (cod) {
          const a = (await t(`${CODIGO} WHERE k.id=$1`, [cod.id])).rows[0];
          const n = { ...a, ...o, word_norm: o.word_norm || norma(a.word) };
          await t('UPDATE shows_event_codes SET word=$2, word_norm=$3, kind=$4, value=$5, valid_until=$6, note=NULLIF($7,\'\') WHERE id=$1', [cod.id, n.word, n.word_norm, n.kind, n.value, n.valid_until ?? null, n.note || '']);
        } else {
          await t('INSERT INTO shows_event_codes (event_id, word, word_norm, kind, value, max_uses, valid_until, note, host_sale_id) VALUES ($1,$2,$3,$4,$5,NULL,$6,NULLIF($7,\'\'),$8)', [h.event_id, o.word, o.word_norm, o.kind, o.value, o.valid_until ?? null, o.note || '', h.id]);
        }
        await t('UPDATE shows_sales SET held=true WHERE id=$1', [h.id]);
      });
    } catch (e) {
      if (e.code === '23505') throw erroHttp(409, 'Já existe essa palavra-chave neste evento');
      throw e;
    }
    res.json(await mesaOut(await mesaDe(q, h.id)));
  }));

  // Grava um convidado na mesa. modo: 'mesa' (valor vigente com o desconto da mesa) | 'normal' (valor vigente, sem desconto) | 'manual' (valor informado)
  // via = 'palavra' quando vem do atendente (respeita o encerramento da venda pela palavra); 'painel' quando a equipe adiciona à mão.
  async function criarConvidado(hostId, b, { modo, via, quemCriou }) {
    const nome = txt(b.name, 120);
    if (!nome) throw erroHttp(400, 'Informe o nome de quem compra');
    let phone = null;
    if (b.phone !== undefined && b.phone !== null && b.phone !== '') { phone = normPhone(b.phone); if (!/^\d{8,15}$/.test(phone)) throw erroHttp(400, 'Telefone inválido'); }
    const people = b.people === undefined ? 1 : inteiro(b.people, 1, 1000);
    if (!people) throw erroHttp(400, 'Informe quantas pessoas');
    const note = b.note ? txt(b.note, 300) : '';
    if (note === null) throw erroHttp(400, 'Anotação inválida (até 300 letras)');
    let manual = null;
    if (modo === 'manual') { manual = b.unit_price === undefined || b.unit_price === null || b.unit_price === '' ? null : dinheiro(b.unit_price); if (manual === null) throw erroHttp(400, 'Informe o valor por pessoa'); }
    return tx(currentCompany(), async (t) => {
      await t('SELECT pg_advisory_xact_lock(hashtext($1))', [`shows:${currentCompany()}:mesa:${hostId}`]);
      const h = await mesaDe(t, hostId);
      if (!h || !h.held) throw erroHttp(404, 'Mesa reservada não encontrada');
      if (!OCUPAM.includes(h.status)) throw erroHttp(409, 'Essa mesa está cancelada');
      const livres = await lugaresLivres(t, h.id);
      if (people > livres) throw erroHttp(409, livres ? `Essa mesa tem só ${livres} lugar(es) livre(s)` : 'Os lugares dessa mesa já foram todos vendidos');
      const k = (await t('SELECT * FROM shows_event_codes WHERE host_sale_id=$1', [h.id])).rows[0];
      let preco = null, codeId = null, codeWord = null, lotId = null;
      if (modo === 'manual') preco = manual;
      else if (modo === 'mesa' && via === 'palavra') {
        const pr = await precoPara(t, h.event_id, k.word, 0, null);
        if (!pr.code_valid) throw erroHttp(409, pr.reason || 'Essa palavra não vale mais');
        preco = pr.unit_price; codeId = pr.code_id || null; codeWord = pr.code_id ? pr.code_word : null; lotId = pr.tier === 'lote' ? pr.lot_id || null : null;
      } else {
        const pr = await precoPara(t, h.event_id, '', 0, null);
        preco = pr.unit_price; lotId = pr.tier === 'lote' ? pr.lot_id || null : null;
        if (modo === 'mesa' && preco !== null && k) {
          const v = k.kind === 'percent' ? r2(preco * (1 - Number(k.value) / 100)) : r2(Number(k.value));
          if (v <= preco) { preco = v; codeId = k.id; codeWord = k.word; }
        }
      }
      let cid = null;
      if (phone) cid = (await t(`INSERT INTO customers (name, phone, status, source) VALUES ($1,$2,'lead',$3) ON CONFLICT (phone) DO UPDATE SET name = COALESCE(customers.name, EXCLUDED.name) RETURNING id`, [nome, phone, quemCriou])).rows[0].id;
      const id = (await t(`INSERT INTO shows_sales (event_id, occasion_date, sector_id, customer_id, name, phone, people, table_type_id, table_name, seats_each, space_each, tables, status, note, unit_price, code_id, code_word, lot_id, host_sale_id)
                           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,0,0,'confirmed',NULLIF($11,''),$12,$13,$14,$15,$16) RETURNING id`,
        [h.event_id, h.occasion_date, h.sector_id, cid, nome, phone, people, h.table_type_id, h.table_name, h.seats_each, note || '', preco, codeId, codeWord, lotId, h.id])).rows[0].id;
      await t(`UPDATE customers SET status = 'client', client_kinds = CASE WHEN 'buyer' = ANY(client_kinds) THEN client_kinds ELSE array_append(client_kinds, 'buyer') END
               WHERE id = (SELECT customer_id FROM shows_sales WHERE id=$1 AND unit_price > 0) AND (status <> 'client' OR NOT 'buyer' = ANY(client_kinds))`, [id]);
      return id;
    });
  }
  // Corpo: { name, phone?, people?, note?, price_mode?: 'mesa'(padrão) | 'normal' | 'manual', unit_price? (com 'manual') }
  r.post('/casa-de-shows/sales/:id/guests', comTratamento(async (req, res) => {
    const b = req.body || {};
    const modo = ['mesa', 'normal', 'manual'].includes(b.price_mode) ? b.price_mode : 'mesa';
    const id = await criarConvidado(idOk(req.params.id) || 0, b, { modo, via: (req.baseUrl || '').includes('n8n') ? 'palavra' : 'painel', quemCriou: quem(req) });
    res.status(201).json((await q(`${VENDA} WHERE v.id=$1`, [id])).rows[0]);
  }));
  // Edita um convidado: nome, telefone, pessoas (dentro dos lugares livres), situação, anotação e valor por pessoa
  async function editarConvidado(g, b, res) {
    const n = { name: g.name, phone: g.phone, people: g.people, status: g.status, note: g.note, unit_price: g.unit_price };
    if (b.name !== undefined) { n.name = txt(b.name, 120); if (!n.name) throw erroHttp(400, 'Informe o nome de quem compra'); }
    if (b.phone !== undefined) { if (b.phone === null || b.phone === '') n.phone = null; else { n.phone = normPhone(b.phone); if (!/^\d{8,15}$/.test(n.phone)) throw erroHttp(400, 'Telefone inválido'); } }
    if (b.people !== undefined) { n.people = inteiro(b.people, 1, 1000); if (!n.people) throw erroHttp(400, 'Informe quantas pessoas'); }
    if (b.status !== undefined) { if (!STATUS.includes(b.status)) throw erroHttp(400, 'Situação inválida'); n.status = b.status; }
    if (b.note !== undefined) { n.note = b.note ? txt(b.note, 300) : null; if (n.note === null && b.note) throw erroHttp(400, 'Anotação inválida (até 300 letras)'); }
    if (b.unit_price !== undefined) { if (b.unit_price === null || b.unit_price === '') n.unit_price = null; else { n.unit_price = dinheiro(b.unit_price); if (n.unit_price === null) throw erroHttp(400, 'Valor inválido'); } }
    await tx(currentCompany(), async (t) => {
      await t('SELECT pg_advisory_xact_lock(hashtext($1))', [`shows:${currentCompany()}:mesa:${g.host_sale_id}`]);
      if (OCUPAM.includes(n.status)) {
        const livres = await lugaresLivres(t, g.host_sale_id);
        const eraContado = OCUPAM.includes(g.status) ? g.people : 0;
        if (n.people - eraContado > livres) throw erroHttp(409, livres + eraContado ? `Essa mesa tem só ${livres + eraContado} lugar(es) para este convidado` : 'Os lugares dessa mesa já foram todos vendidos');
      }
      await t('UPDATE shows_sales SET name=$2, phone=$3, people=$4, status=$5, note=$6, unit_price=$7, updated_at=now() WHERE id=$1', [g.id, n.name, n.phone, n.people, n.status, n.note, n.unit_price]);
    });
    res.json((await q(`${VENDA} WHERE v.id=$1`, [g.id])).rows[0]);
  }

  r.post('/casa-de-shows/sales', comTratamento(async (req, res) => {
    const b0 = req.body || {};
    if (b0.code && idOk(b0.event_id)) {   // a palavra de uma mesa reservada coloca a pessoa na mesa e tira um lugar dela
      const k = (await q('SELECT host_sale_id FROM shows_event_codes WHERE event_id=$1 AND word_norm=$2 AND host_sale_id IS NOT NULL', [idOk(b0.event_id), norma(b0.code)])).rows[0];
      if (k) {
        const id = await criarConvidado(k.host_sale_id, b0, { modo: 'mesa', via: 'palavra', quemCriou: quem(req) });
        return res.status(201).json((await q(`${VENDA} WHERE v.id=$1`, [id])).rows[0]);
      }
    }
    const p = await preparar(req.body || {}, null, quem(req));
    if (p.erro) return res.status(p.status || 400).json({ error: p.erro });
    const id = await gravar({ ...p.v });
    res.status(201).json((await q(`${VENDA} WHERE v.id=$1`, [id])).rows[0]);
  }));

  r.put('/casa-de-shows/sales/:id', comTratamento(async (req, res) => {
    const atual = (await q('SELECT *, occasion_date::text AS occasion_date FROM shows_sales WHERE id=$1', [req.params.id])).rows[0];
    if (!atual) return res.status(404).json({ error: 'Venda não encontrada' });
    if (atual.host_sale_id) return editarConvidado(atual, req.body || {}, res);
    const p = await preparar(req.body || {}, atual, quem(req));
    if (p.erro) return res.status(p.status || 400).json({ error: p.erro });
    if (atual.held) {   // mesa reservada: não pode perder lugares já vendidos nem ser cancelada com convidados
      const vend = Number((await q('SELECT COALESCE(SUM(people),0) AS n FROM shows_sales WHERE host_sale_id=$1 AND status = ANY($2)', [atual.id, OCUPAM])).rows[0].n);
      if (!OCUPAM.includes(p.v.status) && vend) return res.status(409).json({ error: 'Essa mesa tem convidados. Cancele ou apague os convidados antes.' });
      if (OCUPAM.includes(p.v.status) && p.v.tipo.seats * p.v.tables - p.v.people < vend) return res.status(409).json({ error: `Já foram vendidos ${vend} lugar(es) para convidados; a mesa precisa ter lugar para eles.` });
    }
    await gravar({ ...p.v, id: atual.id });
    res.json((await q(`${VENDA} WHERE v.id=$1`, [atual.id])).rows[0]);
  }));

  // ---------- pagamentos da venda ----------
  const PAGTO = `SELECT p.id, p.sale_id, p.method, p.amount::float AS amount, p.pix_key_id, k.beneficiary, k.key AS pix_key,
                        p.payment_id, p.note, p.created_at
                 FROM shows_sale_payments p LEFT JOIN pix_keys k ON k.id = p.pix_key_id`;

  r.get('/casa-de-shows/sales/:id/payments', wrap(async (req, res) => {
    const id = idOk(req.params.id);
    if (!id) return res.status(400).json({ error: 'Venda inválida' });
    const v = (await q(`${VENDA} WHERE v.id=$1`, [id])).rows[0];
    if (!v) return res.status(404).json({ error: 'Venda não encontrada' });
    res.json({ total: v.total, paid: v.paid, courtesy: v.courtesy, payments: (await q(`${PAGTO} WHERE p.sale_id=$1 ORDER BY p.id`, [id])).rows });
  }));

  r.post('/casa-de-shows/sales/:id/payments', comTratamento(async (req, res) => {
    const id = idOk(req.params.id);
    if (!id) return res.status(400).json({ error: 'Venda inválida' });
    if (!(await q('SELECT 1 FROM shows_sales WHERE id=$1', [id])).rows.length) return res.status(404).json({ error: 'Venda não encontrada' });
    const b = req.body || {};
    const method = String(b.method || '').toLowerCase();
    if (!FORMAS.includes(method)) return res.status(400).json({ error: 'Forma de pagamento inválida' });
    let amount = b.amount === undefined || b.amount === null || b.amount === '' ? null : dinheiro(b.amount);
    if (b.amount !== undefined && b.amount !== null && b.amount !== '' && amount === null) return res.status(400).json({ error: 'Valor inválido' });
    let keyId = null, payId = null;
    if (b.pix_key_id) {
      keyId = idOk(b.pix_key_id);
      if (!keyId || !(await q('SELECT 1 FROM pix_keys WHERE id=$1', [keyId])).rows.length) return res.status(400).json({ error: 'Chave Pix não encontrada' });
      if (method !== 'pix') return res.status(400).json({ error: 'Chave Pix só vale para pagamento em Pix' });
    }
    if (b.payment_id) {
      payId = idOk(b.payment_id);
      const c = payId ? (await q('SELECT amount::float AS amount, status, pix_key_id FROM payments WHERE id=$1', [payId])).rows[0] : null;
      if (!c) return res.status(400).json({ error: 'Comprovante não encontrado em Recebimentos' });
      if (method !== 'pix') return res.status(400).json({ error: 'Comprovante só vale para pagamento em Pix' });
      if (c.status !== 'accepted') return res.status(400).json({ error: 'Esse comprovante não foi aceito' });
      if ((await q('SELECT 1 FROM shows_sale_payments WHERE payment_id=$1', [payId])).rows.length) return res.status(409).json({ error: 'Esse comprovante já está ligado a uma venda' });
      if (amount === null) amount = c.amount;
      if (!keyId && c.pix_key_id) keyId = String(c.pix_key_id);
    }
    if (method === 'cortesia') amount = 0;
    else if (amount === null || amount <= 0) return res.status(400).json({ error: 'Informe o valor pago' });
    const note = b.note ? String(b.note).slice(0, 300) : null;
    const novo = (await q('INSERT INTO shows_sale_payments (sale_id, method, amount, pix_key_id, payment_id, note) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id',
      [id, method, amount, keyId, payId, note])).rows[0].id;
    res.status(201).json((await q(`${PAGTO} WHERE p.id=$1`, [novo])).rows[0]);
  }));

  r.delete('/casa-de-shows/payments/:id', wrap(async (req, res) => {
    if ((req.baseUrl || '').includes('n8n')) return res.status(403).json({ error: 'Só pelo painel' });
    const { rowCount } = await q('DELETE FROM shows_sale_payments WHERE id=$1', [req.params.id]);
    rowCount ? res.json({ ok: true }) : res.status(404).json({ error: 'Pagamento não encontrado' });
  }));

  // Totais por evento ou data: previsto x recebido, por forma de pagamento e por chave Pix/beneficiário. Vendas canceladas ficam de fora.
  r.get('/casa-de-shows/payments/summary', wrap(async (req, res) => {
    const w = ["v.status = ANY($1)"], a = [OCUPAM];
    if (req.query.event_id) { const e = idOk(req.query.event_id); if (!e) return res.status(400).json({ error: 'Evento inválido' }); a.push(e); w.push(`v.event_id = $${a.length}`); }
    if (req.query.date) { const d = dataOk(req.query.date); if (!d) return res.status(400).json({ error: 'Data inválida' }); a.push(d); w.push(`v.occasion_date = $${a.length}::date`); }
    const onde = w.join(' AND ');
    const base = (await q(`SELECT COUNT(*)::int AS sales, COALESCE(SUM(v.people),0)::int AS people,
                             COALESCE(SUM(v.people * v.unit_price - v.club_discount),0)::float AS expected
                           FROM shows_sales v WHERE ${onde}`, a)).rows[0];
    const formas = (await q(`SELECT p.method, COUNT(*)::int AS n, COALESCE(SUM(p.amount),0)::float AS total
                             FROM shows_sale_payments p JOIN shows_sales v ON v.id = p.sale_id WHERE ${onde} GROUP BY p.method ORDER BY p.method`, a)).rows;
    const chaves = (await q(`SELECT p.pix_key_id, k.beneficiary, k.key AS pix_key, COUNT(*)::int AS n, COALESCE(SUM(p.amount),0)::float AS total
                             FROM shows_sale_payments p JOIN shows_sales v ON v.id = p.sale_id LEFT JOIN pix_keys k ON k.id = p.pix_key_id
                             WHERE ${onde} AND p.method = 'pix' GROUP BY p.pix_key_id, k.beneficiary, k.key ORDER BY total DESC`, a)).rows;
    const estado = (await q(`SELECT
        COUNT(*) FILTER (WHERE x.courtesy)::int AS courtesy,
        COUNT(*) FILTER (WHERE NOT x.courtesy AND x.paid >= x.total AND x.total > 0)::int AS paid,
        COUNT(*) FILTER (WHERE NOT x.courtesy AND x.paid > 0 AND x.paid < x.total)::int AS partial,
        COUNT(*) FILTER (WHERE NOT x.courtesy AND x.paid = 0 AND COALESCE(x.total,0) > 0)::int AS pending,
        COALESCE(SUM(GREATEST(x.total - x.paid, 0)) FILTER (WHERE NOT x.courtesy),0)::float AS open_amount
      FROM (SELECT v.id, COALESCE(v.people * v.unit_price - v.club_discount, 0) AS total,
                   COALESCE((SELECT SUM(p.amount) FROM shows_sale_payments p WHERE p.sale_id = v.id AND p.method <> 'cortesia'),0) AS paid,
                   EXISTS (SELECT 1 FROM shows_sale_payments p WHERE p.sale_id = v.id AND p.method = 'cortesia') AS courtesy
            FROM shows_sales v WHERE ${onde}) x`, a)).rows[0];
    const recebido = r2(formas.filter((f) => f.method !== 'cortesia').reduce((s, f) => s + f.total, 0));
    res.json({ ...base, received: recebido, by_method: formas, by_pix_key: chaves, ...estado });
  }));

  r.delete('/casa-de-shows/sales/:id', wrap(async (req, res) => {
    let rowCount;
    try { ({ rowCount } = await q('DELETE FROM shows_sales WHERE id=$1', [req.params.id])); } catch (e) {
      if (e.code === '23503') return res.status(409).json({ error: 'Essa mesa tem convidados. Apague os convidados antes.' });
      throw e;
    }
    rowCount ? res.json({ ok: true }) : res.status(404).json({ error: 'Venda não encontrada' });
  }));
}

// Passo 32: ajusta o prefixo das tabelas das empresas que ainda usam o nome antigo; as que já estão no nome novo não mudam.
export const SHOWS_RENOMEAR_SQL = `
  DO $r$
  DECLARE n TEXT;
  BEGIN
    FOREACH n IN ARRAY ARRAY['sectors','table_types','sector_tables','extras','event_sectors','event_interest','event_conditions','event_codes','reservations','media','res_payments','hirings'] LOOP
      IF to_regclass('scn_' || n) IS NOT NULL AND to_regclass('shows_' || n) IS NULL THEN
        EXECUTE format('ALTER TABLE %I RENAME TO %I', 'scn_' || n, 'shows_' || n);
      END IF;
    END LOOP;
    FOREACH n IN ARRAY ARRAY['idx_scn_res_event','idx_scn_res_date','idx_scn_hirings_customer','idx_scn_extras_event','scn_media_sector','scn_res_pay_res','scn_res_pay_comprovante'] LOOP
      IF to_regclass(n) IS NOT NULL AND to_regclass(replace(n, 'scn_', 'shows_')) IS NULL THEN
        EXECUTE format('ALTER INDEX %I RENAME TO %I', n, replace(n, 'scn_', 'shows_'));
      END IF;
    END LOOP;
  END $r$;
`;

// Passo 37: a venda deixa de se chamar "reserva" (tabelas, índices e colunas); empresas que já estão no nome novo não mudam.
// Também roda no começo do passo 36, para quem ainda estava no nome antigo quando o passo dos lotes foi aplicado.
export const SHOWS_VENDAS_SQL = `
  DO $v$
  DECLARE x RECORD;
  BEGIN
    IF to_regclass('shows_reservations') IS NOT NULL AND to_regclass('shows_sales') IS NULL THEN
      ALTER TABLE shows_reservations RENAME TO shows_sales;
    END IF;
    IF to_regclass('shows_res_payments') IS NOT NULL AND to_regclass('shows_sale_payments') IS NULL THEN
      ALTER TABLE shows_res_payments RENAME TO shows_sale_payments;
    END IF;
    IF to_regclass('shows_sale_payments') IS NOT NULL AND EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = 'shows_sale_payments' AND column_name = 'reservation_id') THEN
      ALTER TABLE shows_sale_payments RENAME COLUMN reservation_id TO sale_id;
    END IF;
    FOR x IN SELECT * FROM (VALUES
      ('shows_reservations_id_seq','shows_sales_id_seq'), ('shows_res_payments_id_seq','shows_sale_payments_id_seq')) AS t(a, b) LOOP
      IF to_regclass(x.a) IS NOT NULL AND to_regclass(x.b) IS NULL THEN EXECUTE format('ALTER SEQUENCE %I RENAME TO %I', x.a, x.b); END IF;
    END LOOP;
    FOR x IN SELECT * FROM (VALUES
      ('idx_shows_res_event','idx_shows_sales_event'), ('idx_shows_res_date','idx_shows_sales_date'),
      ('shows_res_pay_res','shows_sale_pay_sale'), ('shows_res_pay_comprovante','shows_sale_pay_comprovante')) AS t(a, b) LOOP
      IF to_regclass(x.a) IS NOT NULL AND to_regclass(x.b) IS NULL THEN EXECUTE format('ALTER INDEX %I RENAME TO %I', x.a, x.b); END IF;
    END LOOP;
    FOR x IN SELECT c.conname, c.conrelid::regclass AS tbl FROM pg_constraint c
             WHERE c.connamespace = to_regnamespace(current_schema()) AND (c.conname LIKE 'shows_reservations\_%' OR c.conname LIKE 'shows_res_payments\_%') LOOP
      EXECUTE format('ALTER TABLE %s RENAME CONSTRAINT %I TO %I', x.tbl, x.conname,
                     replace(replace(x.conname, 'shows_reservations_', 'shows_sales_'), 'shows_res_payments_', 'shows_sale_payments_'));
    END LOOP;
  END $v$;
`;

// Mesa reservada: uma venda cujo dono compra a mesa e os lugares que sobram são vendidos a convidados (com uma palavra e um desconto próprios).
// O convidado é uma venda ligada à mesa (host_sale_id): ocupa um lugar dela e nenhum espaço novo do setor (tables = 0, space_each = 0).
export const SHOWS_MESA_RESERVADA_SQL = `
  ALTER TABLE shows_sales DROP CONSTRAINT IF EXISTS shows_sales_tables_check;
  ALTER TABLE shows_sales ADD CONSTRAINT shows_sales_tables_check CHECK (tables BETWEEN 0 AND 100);
  ALTER TABLE shows_sales DROP CONSTRAINT IF EXISTS shows_sales_space_each_check;
  ALTER TABLE shows_sales ADD CONSTRAINT shows_sales_space_each_check CHECK (space_each >= 0);
  ALTER TABLE shows_sales ADD COLUMN IF NOT EXISTS held BOOLEAN NOT NULL DEFAULT false;              -- esta venda é uma mesa reservada
  ALTER TABLE shows_sales ADD COLUMN IF NOT EXISTS host_sale_id BIGINT REFERENCES shows_sales(id) ON DELETE RESTRICT;   -- convidado: mesa reservada a que pertence
  ALTER TABLE shows_event_codes ADD COLUMN IF NOT EXISTS host_sale_id BIGINT REFERENCES shows_sales(id) ON DELETE CASCADE;   -- palavra da mesa reservada
  CREATE INDEX IF NOT EXISTS idx_shows_sales_host ON shows_sales (host_sale_id) WHERE host_sale_id IS NOT NULL;
  CREATE UNIQUE INDEX IF NOT EXISTS idx_shows_codes_host ON shows_event_codes (host_sale_id) WHERE host_sale_id IS NOT NULL;
`;

// Passo 34: o local criado na migração se chama "Padrão" (não existe necessariamente um local principal)
// Chaves Pix de cada evento, em ordem de rodízio: cada chave recebe até o limite e depois passa a vez à próxima
export const SHOWS_PIX_EVENTO_SQL = `
  CREATE TABLE IF NOT EXISTS shows_event_pix (
    event_id     BIGINT NOT NULL REFERENCES events(id) ON DELETE CASCADE,
    key_id       BIGINT NOT NULL REFERENCES pix_keys(id) ON DELETE CASCADE,
    position     INT NOT NULL,
    limit_amount NUMERIC(12,2) CHECK (limit_amount > 0),        -- vazio = sem limite
    PRIMARY KEY (event_id, key_id)
  );
`;

// Lotes de ingresso do evento: cada lote tem nome, preço e até quando vale; depois do último vale o preço da portaria
export const SHOWS_LOTES_SQL = `
  CREATE TABLE IF NOT EXISTS shows_event_lots (
    id          BIGSERIAL PRIMARY KEY,
    event_id    BIGINT NOT NULL REFERENCES events(id) ON DELETE CASCADE,
    position    INT NOT NULL,
    name        TEXT NOT NULL,
    price       NUMERIC(10,2) NOT NULL CHECK (price >= 0),
    valid_until TIMESTAMPTZ,                                   -- vazio = sem prazo (normalmente só o último)
    UNIQUE (event_id, position)
  );
  ALTER TABLE shows_event_lots ADD COLUMN IF NOT EXISTS max_qty INT CHECK (max_qty > 0);   -- ingressos (pessoas) do lote; vazio = só vale o prazo
  ALTER TABLE shows_sales ADD COLUMN IF NOT EXISTS lot_id BIGINT REFERENCES shows_event_lots(id) ON DELETE SET NULL;   -- lote em que a venda foi vendida
`;

export const SHOWS_LOCAL_PADRAO_SQL = `
  UPDATE shows_venues SET name = 'Padrão' WHERE name = 'Local principal' AND NOT EXISTS (SELECT 1 FROM shows_venues WHERE name = 'Padrão');
`;

// Desconto do Clube: percentual e número de acompanhantes, iguais para todos os eventos; a venda guarda quanto abateu
export const SHOWS_CLUBE_SQL = `
  CREATE TABLE IF NOT EXISTS shows_club_discount (
    id         BOOLEAN PRIMARY KEY DEFAULT true CHECK (id),
    percent    NUMERIC(5,2) CHECK (percent IS NULL OR (percent > 0 AND percent <= 100)),
    companions INT NOT NULL DEFAULT 1 CHECK (companions BETWEEN 0 AND 20)
  );
  ALTER TABLE shows_sales ADD COLUMN IF NOT EXISTS club_discount NUMERIC(10,2) NOT NULL DEFAULT 0;`;
