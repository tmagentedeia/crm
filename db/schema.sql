-- CRM — tabelas GERAIS (schema public): empresas e usuários.
-- Cada empresa tem ainda o seu próprio schema (company_<id>), criado a partir de db/tenant.sql.

CREATE EXTENSION IF NOT EXISTS btree_gist;
CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE companies (
  id              BIGSERIAL PRIMARY KEY,
  name            TEXT NOT NULL,
  slug            TEXT UNIQUE NOT NULL,
  phone           TEXT,
  inactive_days   INT NOT NULL DEFAULT 30,      -- dias p/ considerar cliente inativo
  timezone        TEXT NOT NULL DEFAULT 'America/Sao_Paulo',
  logo            TEXT,                         -- logotipo da empresa (data URL, redimensionado no painel)
  max_professionals     INT,                          -- limite de profissionais ativos (NULL = sem limite)
  adm_name        TEXT,                         -- proprietário/ADM (gera a frase fixa "<nome> aqui")
  agent_name      TEXT,                         -- nome do agente de IA (usado nos comandos de pausa)
  reminder_minutes INT DEFAULT 120,             -- lembrete ao cliente X min antes (NULL = desligado)
  menu_custom     JSONB NOT NULL DEFAULT '{}',  -- nomes e ícones do menu escolhidos pela empresa (só aparência)
  modules         JSONB NOT NULL DEFAULT '{}',  -- módulos liberados para a empresa (só o administrador altera)
  api_key_hash    TEXT,                         -- hash (SHA-256) da chave de integração da empresa; a chave em si nunca é guardada
  api_key_hint    TEXT,                         -- últimos 4 caracteres da chave, só para identificá-la na tela de administração
  api_key_created_at TIMESTAMPTZ,               -- quando a chave atual foi gerada
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE users (
  id              BIGSERIAL PRIMARY KEY,
  company_id      BIGINT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  name            TEXT NOT NULL,
  email           TEXT UNIQUE NOT NULL,
  password_hash   TEXT NOT NULL,                -- bcrypt gerado no backend
  role            TEXT NOT NULL DEFAULT 'owner' CHECK (role IN ('owner','staff')),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Quais versões do schema de cada empresa já foram aplicadas (ver src/tenant.js)
CREATE TABLE tenant_versions (
  company_id      BIGINT PRIMARY KEY REFERENCES companies(id) ON DELETE CASCADE,
  version         INT NOT NULL
);

-- Modelos de empresa (só a estrutura: módulos, configurações, categorias, serviços e manual do atendente; nunca dados de clientes)
-- Registro dos acessos do administrador ao painel de uma empresa ("abrir painel")
CREATE TABLE admin_access_log (
  id                BIGSERIAL PRIMARY KEY,
  admin_user_id     BIGINT NOT NULL,
  company_id        BIGINT NOT NULL,
  target_user_id    BIGINT,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE company_templates (
  id                BIGSERIAL PRIMARY KEY,
  name              TEXT NOT NULL UNIQUE,
  description       TEXT,
  data              JSONB NOT NULL,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);
