// Grupos de contatos salvos para campanhas: a pessoa escolhe os contatos uma vez, dá um nome e reaproveita nas próximas campanhas.
import { q } from './db.js';

export const GRUPOS_CAMPANHA_SQL = `
  CREATE TABLE IF NOT EXISTS campaign_groups (
    id           BIGSERIAL PRIMARY KEY,
    name         TEXT NOT NULL,
    customer_ids BIGINT[] NOT NULL DEFAULT '{}',
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
  );
  CREATE UNIQUE INDEX IF NOT EXISTS campaign_groups_name ON campaign_groups (lower(name));
  -- campanha de teste feita só para quem está na lista "Não enviar para"
  ALTER TABLE campaigns ADD COLUMN IF NOT EXISTS allow_excluded BOOLEAN NOT NULL DEFAULT false;
`;

// Faixa de horário escolhida para a campanha rodar (horas cheias, dentro do limite das 7h às 22h); vazio = o limite inteiro
export const JANELA_CAMPANHA_SQL = `
  ALTER TABLE campaigns ADD COLUMN IF NOT EXISTS window_start INT;
  ALTER TABLE campaigns ADD COLUMN IF NOT EXISTS window_end INT;
`;

export function registerGruposCampanha(r, wrap) {
  // grupos com os contatos que ainda existem
  r.get('/campaign-groups', wrap(async (req, res) => {
    const { rows } = await q(`
      SELECT g.id, g.name,
             COALESCE((SELECT array_agg(c.id ORDER BY c.id) FROM customers c WHERE c.id = ANY(g.customer_ids)), '{}') AS ids
      FROM campaign_groups g ORDER BY lower(g.name)`);
    res.json(rows.map((g) => ({ id: g.id, name: g.name, ids: g.ids.map(Number), count: g.ids.length })));
  }));
  r.post('/campaign-groups', wrap(async (req, res) => {
    const name = String(req.body?.name ?? '').trim().slice(0, 80);
    const ids = [...new Set((Array.isArray(req.body?.ids) ? req.body.ids : []).map(Number).filter(Number.isInteger))].slice(0, 20000);
    if (!name) return res.status(400).json({ error: 'Dê um nome ao grupo' });
    if (!ids.length) return res.status(400).json({ error: 'Escolha pelo menos um contato' });
    const { rows } = await q(`INSERT INTO campaign_groups (name, customer_ids) VALUES ($1, $2::bigint[])
      ON CONFLICT (lower(name)) DO UPDATE SET customer_ids = EXCLUDED.customer_ids RETURNING id, name`, [name, ids]);
    res.json({ ...rows[0], count: ids.length });
  }));
  r.delete('/campaign-groups/:id', wrap(async (req, res) => {
    await q('DELETE FROM campaign_groups WHERE id=$1', [req.params.id]);
    res.json({ ok: true });
  }));
}
