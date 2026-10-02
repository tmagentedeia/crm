-- Tabelas de UMA empresa. Executado dentro do schema company_<id> (search_path já aponta para ele).
-- __COMPANY_ID__ é trocado pelo id da empresa.

-- ========== CATEGORIAS ==========
CREATE TABLE categories (
  id              BIGSERIAL PRIMARY KEY,
  name            TEXT NOT NULL UNIQUE
);

-- ========== SERVIÇOS ==========
CREATE TABLE services (
  id              BIGSERIAL PRIMARY KEY,
  name            TEXT NOT NULL UNIQUE,
  price           NUMERIC(10,2) NOT NULL DEFAULT 0,
  duration_min    INT NOT NULL DEFAULT 30,
  category_id     BIGINT REFERENCES categories(id) ON DELETE SET NULL,  -- categoria opcional
  active          BOOLEAN NOT NULL DEFAULT true,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ========== PROFISSIONAIS (tabela professionals) ==========
CREATE TABLE professionals (
  id              BIGSERIAL PRIMARY KEY,
  name            TEXT NOT NULL,
  color           TEXT NOT NULL DEFAULT '#3B82F6',  -- cor de destaque na agenda
  phone           TEXT,
  active          BOOLEAN NOT NULL DEFAULT true,
  google_calendar_id TEXT,                          -- agenda Google do profissional (espelho opcional)
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Horário de trabalho semanal (0 = domingo ... 6 = sábado)
CREATE TABLE professional_schedules (
  id              BIGSERIAL PRIMARY KEY,
  professional_id       BIGINT NOT NULL REFERENCES professionals(id) ON DELETE CASCADE,
  weekday         SMALLINT NOT NULL CHECK (weekday BETWEEN 0 AND 6),
  start_time      TIME NOT NULL,
  end_time        TIME NOT NULL,
  break_start     TIME,
  break_end       TIME,
  UNIQUE (professional_id, weekday),
  CHECK (end_time > start_time)
);

-- Categorias que cada profissional atende (obrigatório ter ao menos uma; sem linhas = cadastro antigo, atende todas)
CREATE TABLE professional_categories (
  professional_id       BIGINT NOT NULL REFERENCES professionals(id) ON DELETE CASCADE,
  category_id     BIGINT NOT NULL REFERENCES categories(id) ON DELETE CASCADE,
  PRIMARY KEY (professional_id, category_id)
);

-- Ajuste fino: serviços específicos que o profissional faz dentro das categorias (se vazio, faz todos da categoria)
CREATE TABLE professional_services (
  professional_id       BIGINT NOT NULL REFERENCES professionals(id) ON DELETE CASCADE,
  service_id      BIGINT NOT NULL REFERENCES services(id) ON DELETE CASCADE,
  PRIMARY KEY (professional_id, service_id)
);

-- ========== CLIENTES / LEADS ==========
CREATE TABLE customers (
  id              BIGSERIAL PRIMARY KEY,
  name            TEXT,
  phone           TEXT NOT NULL UNIQUE,         -- só dígitos, ex: 553291135799
  chat_id         TEXT,                         -- chatid do WhatsApp/UAZAPI, se diferente
  status          TEXT NOT NULL DEFAULT 'lead' CHECK (status IN ('lead','client')),
  source          TEXT NOT NULL DEFAULT 'ia' CHECK (source IN ('ia','manual')),
  notes           TEXT,
  first_contact_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_visit_at   TIMESTAMPTZ,                  -- atualizado por trigger ao marcar presença
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_customers_status ON customers (status);
CREATE INDEX idx_customers_last_visit ON customers (last_visit_at);

-- ========== AGENDAMENTOS ==========
CREATE TABLE appointments (
  id              BIGSERIAL PRIMARY KEY,
  professional_id       BIGINT NOT NULL REFERENCES professionals(id),
  customer_id     BIGINT NOT NULL REFERENCES customers(id),
  service_id      BIGINT NOT NULL REFERENCES services(id),
  starts_at       TIMESTAMPTZ NOT NULL,
  ends_at         TIMESTAMPTZ NOT NULL,
  price           NUMERIC(10,2) NOT NULL DEFAULT 0,   -- congela o preço na hora do agendamento
  status          TEXT NOT NULL DEFAULT 'scheduled'
                  CHECK (status IN ('pending','scheduled','attended','no_show','cancelled')),
  source          TEXT NOT NULL DEFAULT 'ia' CHECK (source IN ('ia','manual')),
  google_event_id TEXT,                               -- evento espelhado no Google Agenda (opcional)
  reminder_sent_at TIMESTAMPTZ,                       -- lembrete enviado ao cliente (NULL = ainda não)
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (ends_at > starts_at),
  -- impede dois agendamentos ativos sobrepostos para o mesmo profissional
  EXCLUDE USING gist (
    professional_id WITH =,
    tstzrange(starts_at, ends_at) WITH &&
  ) WHERE (status IN ('pending','scheduled','attended'))
);
CREATE INDEX idx_appt_start ON appointments (starts_at);
CREATE INDEX idx_appt_customer ON appointments (customer_id, starts_at DESC);

-- Bloqueios manuais de horário (folga, almoço extra etc.)
CREATE TABLE blocked_slots (
  id              BIGSERIAL PRIMARY KEY,
  professional_id       BIGINT NOT NULL REFERENCES professionals(id) ON DELETE CASCADE,
  starts_at       TIMESTAMPTZ NOT NULL,
  ends_at         TIMESTAMPTZ NOT NULL,
  reason          TEXT,
  CHECK (ends_at > starts_at),
  EXCLUDE USING gist (professional_id WITH =, tstzrange(starts_at, ends_at) WITH &&)
);

-- Fila de espera: cliente quer um horário que estava ocupado; é avisado se ele abrir
CREATE TABLE waitlist (
  id              BIGSERIAL PRIMARY KEY,
  customer_id     BIGINT NOT NULL REFERENCES customers(id),
  professional_id       BIGINT REFERENCES professionals(id) ON DELETE SET NULL,   -- NULL = qualquer profissional
  desired_at      TIMESTAMPTZ NOT NULL,
  status          TEXT NOT NULL DEFAULT 'waiting' CHECK (status IN ('waiting','notified','cancelled')),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  notified_at     TIMESTAMPTZ
);
CREATE INDEX idx_waitlist_status ON waitlist (status, desired_at);

-- ========== AUTOMAÇÕES ==========
-- Ao marcar presença: cliente vira 'client' e last_visit_at é atualizado
CREATE OR REPLACE FUNCTION trg_appointment_attended() RETURNS trigger AS $$
BEGIN
  IF NEW.status = 'attended' AND (TG_OP = 'INSERT' OR OLD.status IS DISTINCT FROM 'attended') THEN
    UPDATE customers
       SET status = 'client',
           last_visit_at = GREATEST(COALESCE(last_visit_at, NEW.starts_at), NEW.starts_at)
     WHERE id = NEW.customer_id;
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;

CREATE TRIGGER appointment_attended
AFTER INSERT OR UPDATE OF status ON appointments
FOR EACH ROW EXECUTE FUNCTION trg_appointment_attended();

-- ========== VIEWS ==========
-- Clientes inativos (usa companies.inactive_days; o painel pode sobrescrever o valor)
CREATE OR REPLACE VIEW v_inactive_customers AS
SELECT c.*,
       s.inactive_days,
       (now()::date - c.last_visit_at::date) AS days_absent
FROM customers c
JOIN public.companies s ON s.id = __COMPANY_ID__
WHERE c.status = 'client'
  AND c.last_visit_at IS NOT NULL
  AND c.last_visit_at < now() - make_interval(days => s.inactive_days)
  AND NOT EXISTS (
    SELECT 1 FROM appointments a
    WHERE a.customer_id = c.id AND a.status = 'scheduled' AND a.starts_at > now()
  );

-- Histórico do cliente (só compareceu = attended)
CREATE OR REPLACE VIEW v_customer_history AS
SELECT a.customer_id, a.starts_at, a.status, a.price,
       sv.name AS service, b.name AS professional
FROM appointments a
JOIN services sv ON sv.id = a.service_id
JOIN professionals b   ON b.id = a.professional_id;

-- Base do dashboard: atendimentos concluídos
CREATE OR REPLACE VIEW v_dashboard_base AS
SELECT a.starts_at, a.status, a.price,
       EXTRACT(DOW FROM a.starts_at AT TIME ZONE 'America/Sao_Paulo')::int AS weekday,
       sv.name AS service, b.name AS professional
FROM appointments a
JOIN services sv ON sv.id = a.service_id
JOIN professionals b   ON b.id = a.professional_id;

-- ========== COMANDOS DO AGENTE ==========
-- Comandos do dono para bloquear/liberar o agente (pause = bloquear 24h, resume = liberar; off/on = legado, migrados para pause/resume)
CREATE TABLE agent_commands (
  id         BIGSERIAL PRIMARY KEY,
  kind       TEXT NOT NULL CHECK (kind IN ('off','on','pause','resume')),
  phrase     TEXT NOT NULL,
  phrase_norm TEXT NOT NULL UNIQUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
-- Atendentes que podem pausar: cada nome gera a frase "<nome> aqui"
CREATE TABLE agent_attendants (
  id         BIGSERIAL PRIMARY KEY,
  name       TEXT NOT NULL,
  name_norm  TEXT NOT NULL UNIQUE
);
-- ========== ATENDENTE: MANUAL E ATUALIZAÇÕES PROVISÓRIAS ==========
-- Manual do atendente em linguagem comum. Uma linha por versão: sem published_at = rascunho (no máximo um),
-- com published_at = já publicada (a mais recente é a que vale).
CREATE TABLE IF NOT EXISTS agent_manual_versions (
  id           BIGSERIAL PRIMARY KEY,
  content      TEXT NOT NULL DEFAULT '',
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  published_at TIMESTAMPTZ
);
CREATE UNIQUE INDEX IF NOT EXISTS agent_manual_one_draft ON agent_manual_versions ((published_at IS NULL)) WHERE published_at IS NULL;
-- Atualizações provisórias (ex.: "amanhã fechamos mais cedo"). Valem de starts_at até ends_at (momento escolhido pela pessoa).
CREATE TABLE IF NOT EXISTS agent_updates (
  id         BIGSERIAL PRIMARY KEY,
  text       TEXT NOT NULL,
  starts_at  TIMESTAMPTZ,
  ends_at    TIMESTAMPTZ,
  active     BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ========== CAMPANHAS ==========
-- Envio em lote com ritmo controlado. Status: draft (rascunho), running, paused, stopped (parada pelo dono), done.
CREATE TABLE IF NOT EXISTS campaigns (
  id            BIGSERIAL PRIMARY KEY,
  name          TEXT NOT NULL,
  status        TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','running','paused','stopped','done')),
  messages      JSONB NOT NULL DEFAULT '[]',          -- 3 versões do texto
  greeting_random BOOLEAN NOT NULL DEFAULT true,
  interval_min  INT NOT NULL DEFAULT 5,               -- minutos entre mensagens (sorteado entre min e max)
  interval_max  INT NOT NULL DEFAULT 10,
  batch_size    INT NOT NULL DEFAULT 20,              -- envios seguidos antes da pausa
  batch_pause_min INT NOT NULL DEFAULT 60,            -- minutos de pausa depois de cada lote
  daily_limit   INT NOT NULL DEFAULT 50,
  accepted_at   TIMESTAMPTZ,                          -- quando o dono confirmou o aviso de risco
  accepted_by   TEXT,
  next_send_at  TIMESTAMPTZ,
  batch_sent    INT NOT NULL DEFAULT 0,
  consecutive_failures INT NOT NULL DEFAULT 0,
  pause_reason  TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  started_at    TIMESTAMPTZ,
  finished_at   TIMESTAMPTZ
);
CREATE TABLE IF NOT EXISTS campaign_recipients (
  id          BIGSERIAL PRIMARY KEY,
  campaign_id BIGINT NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
  customer_id BIGINT REFERENCES customers(id) ON DELETE SET NULL,
  name        TEXT,
  phone       TEXT NOT NULL,
  chat_id     TEXT,
  status      TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','sending','sent','failed','cancelled')),
  sent_text   TEXT,
  sent_at     TIMESTAMPTZ,
  claimed_at  TIMESTAMPTZ,
  error       TEXT,
  UNIQUE (campaign_id, phone)
);
CREATE INDEX IF NOT EXISTS idx_camp_rec_pending ON campaign_recipients (campaign_id, status);

-- ========== CAMPANHAS: SAUDAÇÕES E CUMPRIMENTOS ==========
-- Uma linha só por empresa. NULL = usa a lista padrão. Os "bag" guardam o que ainda não saiu no rodízio.
CREATE TABLE IF NOT EXISTS campaign_settings (
  id          INT PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  greetings   JSONB,
  compliments JSONB,
  greetings_bag   JSONB,
  compliments_bag JSONB
);
INSERT INTO campaign_settings (id) VALUES (1) ON CONFLICT DO NOTHING;
