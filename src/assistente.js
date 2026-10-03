// Assistente (opcional, ligado por empresa pelo administrador): manual e atualizações provisórias próprios,
// separados dos do atendente. Mesma estrutura das tabelas do atendente.
export const ASSISTENTE_SQL = `
CREATE TABLE IF NOT EXISTS assistant_manual_versions (
  id           BIGSERIAL PRIMARY KEY,
  content      TEXT NOT NULL DEFAULT '',
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  published_at TIMESTAMPTZ
);
CREATE UNIQUE INDEX IF NOT EXISTS assistant_manual_one_draft ON assistant_manual_versions ((published_at IS NULL)) WHERE published_at IS NULL;
CREATE TABLE IF NOT EXISTS assistant_updates (
  id         BIGSERIAL PRIMARY KEY,
  text       TEXT NOT NULL,
  starts_at  TIMESTAMPTZ,
  ends_at    TIMESTAMPTZ,
  active     BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);`;
