// Eventos: compromissos avulsos da empresa (uma live, uma reunião, um show), sem profissional nem serviço.
// Ficam separados da Agenda de atendimentos, que continua só de profissional + serviço.
import { q } from './db.js';

export const EVENTOS_SQL = `
  CREATE TABLE IF NOT EXISTS events (
    id          BIGSERIAL PRIMARY KEY,
    title       TEXT NOT NULL,
    starts_at   TIMESTAMPTZ NOT NULL,
    ends_at     TIMESTAMPTZ,                 -- vazio = sem horário de fim
    place       TEXT,                        -- local ou link
    notes       TEXT,
    external_id TEXT UNIQUE,                 -- identificação em outro sistema (ex.: o vídeo no YouTube)
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
  );
  CREATE INDEX IF NOT EXISTS idx_events_starts ON events (starts_at);`;

const txt = (v, max) => { const s = String(v ?? '').trim(); return s.length <= max && !/[\u0000-\u0008\u000b-\u001f<>]/.test(s) ? s : null; };
const dataOk = (v) => { const d = new Date(v); return v && !isNaN(d) ? d : null; };
// "em andamento ou futuro": sem fim, vale até 3 horas depois do começo
const AINDA_VALE = `COALESCE(ends_at, starts_at + interval '3 hours') > now()`;

export function registerEventRoutes(r, wrap) {
  // ?quando=proximos (padrão) | passados | todos ; ?de=&ate= (datas) filtram o período
  r.get('/events', wrap(async (req, res) => {
    const quando = req.query.quando || 'proximos';
    const w = [], a = [];
    if (quando === 'proximos') w.push(AINDA_VALE);
    else if (quando === 'passados') w.push(`NOT (${AINDA_VALE})`);
    if (req.query.de && dataOk(req.query.de)) { a.push(dataOk(req.query.de)); w.push(`COALESCE(ends_at, starts_at) >= $${a.length}`); }
    if (req.query.ate && dataOk(req.query.ate)) { a.push(dataOk(req.query.ate)); w.push(`starts_at <= $${a.length}`); }
    const ordem = quando === 'passados' ? 'DESC' : 'ASC';
    res.json((await q(`SELECT * FROM events ${w.length ? 'WHERE ' + w.join(' AND ') : ''} ORDER BY starts_at ${ordem}, id LIMIT 500`, a)).rows);
  }));
  // o próximo evento que ainda vale (para o atendente responder "quando é a próxima?")
  r.get('/events/next', wrap(async (req, res) => {
    const e = (await q(`SELECT * FROM events WHERE ${AINDA_VALE} ORDER BY starts_at, id LIMIT 1`)).rows[0];
    res.json(e ? { found: true, event: e } : { found: false, event: null });
  }));
  function ler(b, parcial) {
    const o = {};
    if (!parcial || b.title !== undefined) { o.title = txt(b.title, 120); if (!o.title) return { erro: 'Informe o nome do evento (até 120 letras)' }; }
    if (!parcial || b.starts_at !== undefined) { o.starts_at = dataOk(b.starts_at); if (!o.starts_at) return { erro: 'Informe a data e a hora de início' }; }
    if (b.ends_at !== undefined) { o.ends_at = b.ends_at ? dataOk(b.ends_at) : null; if (b.ends_at && !o.ends_at) return { erro: 'Fim inválido' }; }
    if (b.place !== undefined) { o.place = txt(b.place, 200); if (o.place === null) return { erro: 'Local inválido (até 200 letras)' }; }
    if (b.notes !== undefined) { o.notes = txt(b.notes, 2000); if (o.notes === null) return { erro: 'Observações inválidas (até 2000 letras)' }; }
    if (b.external_id !== undefined) o.external_id = b.external_id ? txt(b.external_id, 100) : null;
    return { o };
  }
  r.post('/events', wrap(async (req, res) => {
    const { o, erro } = ler(req.body || {}, false);
    if (erro) return res.status(400).json({ error: erro });
    if (o.ends_at && o.ends_at <= o.starts_at) return res.status(400).json({ error: 'O fim precisa ser depois do início' });
    try {
      const e = (await q(`INSERT INTO events (title, starts_at, ends_at, place, notes, external_id) VALUES ($1,$2,$3,NULLIF($4,''),NULLIF($5,''),$6) RETURNING *`,
        [o.title, o.starts_at, o.ends_at || null, o.place || '', o.notes || '', o.external_id || null])).rows[0];
      res.status(201).json(e);
    } catch (e) {
      if (e.code === '23505') return res.status(409).json({ error: 'Já existe um evento com essa identificação' });
      throw e;
    }
  }));
  r.put('/events/:id', wrap(async (req, res) => {
    const { o, erro } = ler(req.body || {}, true);
    if (erro) return res.status(400).json({ error: erro });
    const atual = (await q('SELECT * FROM events WHERE id=$1', [req.params.id])).rows[0];
    if (!atual) return res.status(404).json({ error: 'Não encontrado' });
    const n = { ...atual, ...o };
    if (n.ends_at && new Date(n.ends_at) <= new Date(n.starts_at)) return res.status(400).json({ error: 'O fim precisa ser depois do início' });
    try {
      res.json((await q(`UPDATE events SET title=$2, starts_at=$3, ends_at=$4, place=NULLIF($5,''), notes=NULLIF($6,''), external_id=$7, updated_at=now() WHERE id=$1 RETURNING *`,
        [req.params.id, n.title, n.starts_at, n.ends_at || null, n.place || '', n.notes || '', n.external_id || null])).rows[0]);
    } catch (e) {
      if (e.code === '23505') return res.status(409).json({ error: 'Já existe um evento com essa identificação' });
      throw e;
    }
  }));
  r.delete('/events/:id', wrap(async (req, res) => {
    const { rowCount } = await q('DELETE FROM events WHERE id=$1', [req.params.id]);
    rowCount ? res.json({ ok: true }) : res.status(404).json({ error: 'Não encontrado' });
  }));
  r.post('/events/bulk-delete', wrap(async (req, res) => {
    const ids = [...new Set((Array.isArray(req.body?.ids) ? req.body.ids : []).map(Number).filter((n) => Number.isInteger(n) && n > 0))].slice(0, 2000);
    if (!ids.length) return res.status(400).json({ error: 'Nenhum item selecionado' });
    if (req.body.dry_run === true) return res.json({ found: (await q('SELECT count(*)::int AS n FROM events WHERE id = ANY($1::bigint[])', [ids])).rows[0].n });
    res.json({ deleted: (await q('DELETE FROM events WHERE id = ANY($1::bigint[])', [ids])).rowCount });
  }));
}
