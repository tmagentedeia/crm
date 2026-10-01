-- CRM Salão/Barbearia — schema PostgreSQL puro (sem Supabase)
-- Multi-salão: toda tabela de negócio tem salon_id.

CREATE EXTENSION IF NOT EXISTS btree_gist;
CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- ========== ACESSO ==========
CREATE TABLE salons (
  id              BIGSERIAL PRIMARY KEY,
  name            TEXT NOT NULL,
  slug            TEXT UNIQUE NOT NULL,
  phone           TEXT,
  inactive_days   INT NOT NULL DEFAULT 30,      -- dias p/ considerar cliente inativo
  timezone        TEXT NOT NULL DEFAULT 'America/Sao_Paulo',
  logo            TEXT,                         -- logotipo do salão (data URL, redimensionado no painel)
  max_barbers     INT,                          -- limite de barbeiros ativos (NULL = sem limite)
  adm_name         TEXT,                        -- proprietário/ADM (gera a frase fixa "<nome> aqui")
  agent_name       TEXT,                        -- nome do agente de IA (usado nos comandos de pausa)
  reminder_minutes INT DEFAULT 120,             -- lembrete ao cliente X min antes (NULL = desligado)
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE users (
  id              BIGSERIAL PRIMARY KEY,
  salon_id        BIGINT NOT NULL REFERENCES salons(id) ON DELETE CASCADE,
  name            TEXT NOT NULL,
  email           TEXT UNIQUE NOT NULL,
  password_hash   TEXT NOT NULL,                -- bcrypt gerado no backend
  role            TEXT NOT NULL DEFAULT 'owner' CHECK (role IN ('owner','staff')),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ========== CATEGORIAS ==========
CREATE TABLE categories (
  id              BIGSERIAL PRIMARY KEY,
  salon_id        BIGINT NOT NULL REFERENCES salons(id) ON DELETE CASCADE,
  name            TEXT NOT NULL,
  UNIQUE (salon_id, name)
);

-- ========== SERVIÇOS ==========
CREATE TABLE services (
  id              BIGSERIAL PRIMARY KEY,
  salon_id        BIGINT NOT NULL REFERENCES salons(id) ON DELETE CASCADE,
  name            TEXT NOT NULL,
  price           NUMERIC(10,2) NOT NULL DEFAULT 0,
  duration_min    INT NOT NULL DEFAULT 30,
  category_id     BIGINT REFERENCES categories(id) ON DELETE SET NULL,  -- categoria opcional
  active          BOOLEAN NOT NULL DEFAULT true,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (salon_id, name)
);

-- ========== BARBEIROS ==========
CREATE TABLE barbers (
  id              BIGSERIAL PRIMARY KEY,
  salon_id        BIGINT NOT NULL REFERENCES salons(id) ON DELETE CASCADE,
  name            TEXT NOT NULL,
  color           TEXT NOT NULL DEFAULT '#3B82F6',  -- cor de destaque na agenda
  phone           TEXT,
  active          BOOLEAN NOT NULL DEFAULT true,
  google_calendar_id TEXT,                          -- agenda Google do profissional (espelho opcional)
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Horário de trabalho semanal (0 = domingo ... 6 = sábado)
CREATE TABLE barber_schedules (
  id              BIGSERIAL PRIMARY KEY,
  barber_id       BIGINT NOT NULL REFERENCES barbers(id) ON DELETE CASCADE,
  weekday         SMALLINT NOT NULL CHECK (weekday BETWEEN 0 AND 6),
  start_time      TIME NOT NULL,
  end_time        TIME NOT NULL,
  break_start     TIME,
  break_end       TIME,
  UNIQUE (barber_id, weekday),
  CHECK (end_time > start_time)
);

-- Categorias que cada profissional atende (obrigatório ter ao menos uma; sem linhas = cadastro antigo, atende todas)
CREATE TABLE barber_categories (
  barber_id       BIGINT NOT NULL REFERENCES barbers(id) ON DELETE CASCADE,
  category_id     BIGINT NOT NULL REFERENCES categories(id) ON DELETE CASCADE,
  PRIMARY KEY (barber_id, category_id)
);

-- Ajuste fino: serviços específicos que o profissional faz dentro das categorias (se vazio, faz todos da categoria)
CREATE TABLE barber_services (
  barber_id       BIGINT NOT NULL REFERENCES barbers(id) ON DELETE CASCADE,
  service_id      BIGINT NOT NULL REFERENCES services(id) ON DELETE CASCADE,
  PRIMARY KEY (barber_id, service_id)
);

-- ========== CLIENTES / LEADS ==========
CREATE TABLE customers (
  id              BIGSERIAL PRIMARY KEY,
  salon_id        BIGINT NOT NULL REFERENCES salons(id) ON DELETE CASCADE,
  name            TEXT,
  phone           TEXT NOT NULL,                -- só dígitos, ex: 553291135799
  chat_id         TEXT,                         -- chatid do WhatsApp/UAZAPI, se diferente
  status          TEXT NOT NULL DEFAULT 'lead' CHECK (status IN ('lead','client')),
  source          TEXT NOT NULL DEFAULT 'ia' CHECK (source IN ('ia','manual')),
  notes           TEXT,
  first_contact_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_visit_at   TIMESTAMPTZ,                  -- atualizado por trigger ao marcar presença
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (salon_id, phone)
);
CREATE INDEX idx_customers_salon_status ON customers (salon_id, status);
CREATE INDEX idx_customers_last_visit ON customers (salon_id, last_visit_at);

-- ========== AGENDAMENTOS ==========
CREATE TABLE appointments (
  id              BIGSERIAL PRIMARY KEY,
  salon_id        BIGINT NOT NULL REFERENCES salons(id) ON DELETE CASCADE,
  barber_id       BIGINT NOT NULL REFERENCES barbers(id),
  customer_id     BIGINT NOT NULL REFERENCES customers(id),
  service_id      BIGINT NOT NULL REFERENCES services(id),
  starts_at       TIMESTAMPTZ NOT NULL,
  ends_at         TIMESTAMPTZ NOT NULL,
  price           NUMERIC(10,2) NOT NULL DEFAULT 0,   -- congela o preço na hora do agendamento
  status          TEXT NOT NULL DEFAULT 'scheduled'
                  CHECK (status IN ('scheduled','attended','no_show','cancelled')),
  source          TEXT NOT NULL DEFAULT 'ia' CHECK (source IN ('ia','manual')),
  google_event_id TEXT,                               -- evento espelhado no Google Agenda (opcional)
  reminder_sent_at TIMESTAMPTZ,                       -- lembrete enviado ao cliente (NULL = ainda não)
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (ends_at > starts_at),
  -- impede dois agendamentos ativos sobrepostos para o mesmo barbeiro
  EXCLUDE USING gist (
    barber_id WITH =,
    tstzrange(starts_at, ends_at) WITH &&
  ) WHERE (status IN ('scheduled','attended'))
);
CREATE INDEX idx_appt_salon_start ON appointments (salon_id, starts_at);
CREATE INDEX idx_appt_customer ON appointments (customer_id, starts_at DESC);

-- Bloqueios manuais de horário (folga, almoço extra etc.)
CREATE TABLE blocked_slots (
  id              BIGSERIAL PRIMARY KEY,
  barber_id       BIGINT NOT NULL REFERENCES barbers(id) ON DELETE CASCADE,
  starts_at       TIMESTAMPTZ NOT NULL,
  ends_at         TIMESTAMPTZ NOT NULL,
  reason          TEXT,
  CHECK (ends_at > starts_at),
  EXCLUDE USING gist (barber_id WITH =, tstzrange(starts_at, ends_at) WITH &&)
);

-- Fila de espera: cliente quer um horário que estava ocupado; é avisado se ele abrir
CREATE TABLE waitlist (
  id              BIGSERIAL PRIMARY KEY,
  salon_id        BIGINT NOT NULL REFERENCES salons(id) ON DELETE CASCADE,
  customer_id     BIGINT NOT NULL REFERENCES customers(id),
  barber_id       BIGINT REFERENCES barbers(id) ON DELETE SET NULL,   -- NULL = qualquer profissional
  desired_at      TIMESTAMPTZ NOT NULL,
  status          TEXT NOT NULL DEFAULT 'waiting' CHECK (status IN ('waiting','notified','cancelled')),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  notified_at     TIMESTAMPTZ
);
CREATE INDEX idx_waitlist_salon ON waitlist (salon_id, status, desired_at);

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
-- Clientes inativos (usa salons.inactive_days; o painel pode sobrescrever o valor)
CREATE OR REPLACE VIEW v_inactive_customers AS
SELECT c.*,
       s.inactive_days,
       (now()::date - c.last_visit_at::date) AS days_absent
FROM customers c
JOIN salons s ON s.id = c.salon_id
WHERE c.status = 'client'
  AND c.last_visit_at IS NOT NULL
  AND c.last_visit_at < now() - make_interval(days => s.inactive_days)
  AND NOT EXISTS (
    SELECT 1 FROM appointments a
    WHERE a.customer_id = c.id AND a.status = 'scheduled' AND a.starts_at > now()
  );

-- Histórico do cliente (só compareceu = attended)
CREATE OR REPLACE VIEW v_customer_history AS
SELECT a.customer_id, a.salon_id, a.starts_at, a.status, a.price,
       sv.name AS service, b.name AS barber
FROM appointments a
JOIN services sv ON sv.id = a.service_id
JOIN barbers b   ON b.id = a.barber_id;

-- Base do dashboard: atendimentos concluídos
CREATE OR REPLACE VIEW v_dashboard_base AS
SELECT a.salon_id, a.starts_at, a.status, a.price,
       EXTRACT(DOW FROM a.starts_at AT TIME ZONE 'America/Sao_Paulo')::int AS weekday,
       sv.name AS service, b.name AS barber
FROM appointments a
JOIN services sv ON sv.id = a.service_id
JOIN barbers b   ON b.id = a.barber_id;

-- Comandos do dono para pausar/retomar/ligar/desligar o agente (kind: off | on | pause | resume)
CREATE TABLE agent_commands (
  id         BIGSERIAL PRIMARY KEY,
  salon_id   BIGINT NOT NULL REFERENCES salons(id) ON DELETE CASCADE,
  kind       TEXT NOT NULL CHECK (kind IN ('off','on','pause','resume')),
  phrase     TEXT NOT NULL,
  phrase_norm TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (salon_id, phrase_norm)
);
-- Atendentes que podem pausar: cada nome gera a frase "<nome> aqui"
CREATE TABLE agent_attendants (
  id         BIGSERIAL PRIMARY KEY,
  salon_id   BIGINT NOT NULL REFERENCES salons(id) ON DELETE CASCADE,
  name       TEXT NOT NULL,
  name_norm  TEXT NOT NULL,
  UNIQUE (salon_id, name_norm)
);
