import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { pool, schemaOf } from './db.js';
import { PEDIDOS_SQL, CORTESIA_SQL, ATENDIDO_SQL, SUGESTOES_SQL, ATENDIDO_FIX_SQL, CORTESIAS_SQL, PADRONIZA_TITULOS_SQL, CORTESIAS_RENOMEIA_SQL } from './pedidos.js';
import { EVENTOS_SQL, EVENTOS_ABERTURA_SQL } from './eventos.js';
import { ASSISTENTE_SQL } from './assistente.js';
import { PRODUTOS_SQL } from './produtos.js';
import { VENDAS_SQL } from './vendas.js';
import { COMISSOES_SQL } from './comissoes.js';
import { SHOWS_LISTA_SQL, SHOWS_LISTA_ENVIO_SQL, SHOWS_LISTA_QR_SQL, SHOWS_LISTA_RETIRADOS_SQL } from './lista_evento.js';
import { CASA_DE_SHOWS_SQL, SHOWS_MEDIA_SQL, SHOWS_PAGAMENTOS_SQL, SHOWS_RENOMEAR_SQL, SHOWS_LOCAIS_SQL, SHOWS_LOCAL_PADRAO_SQL, SHOWS_PIX_EVENTO_SQL, SHOWS_LOTES_SQL, SHOWS_VENDAS_SQL, SHOWS_MESA_RESERVADA_SQL, SHOWS_CLUBE_SQL, SHOWS_FICHA_SETOR_SQL, SHOWS_CANCELAMENTOS_SQL, SHOWS_CORTESIA_SQL } from './casa_de_shows.js';
import { ANIVERSARIO_SQL, ANIVERSARIO_VARIAVEIS_SQL } from './aniversario.js';
import { CONTATOS_SQL } from './contatos.js';
import { ESPELHO_SQL } from './espelho_contatos.js';
import { CAMPOS_EXTRA_SQL } from './planilha_contatos.js';
import { GRUPOS_CAMPANHA_SQL } from './grupos_campanha.js';
import { DOCUMENTOS_SQL, DOC_FILES_VENDA_SQL, DOC_BLOCOS_SQL, DOC_VAGAS_SQL } from './documentos.js';
import { DELIVERY_SQL } from './delivery.js';
import { RESTAURANTE_SQL } from './restaurante.js';
import { CONTRATACOES_SQL } from './contratacoes.js';
import { FINANCEIRO_SQL, FINANCEIRO_ORIGEM_SQL, FINANCEIRO_DEDUP_SQL, PIX_ENVIADAS_SQL, ALERTA_PAGAMENTO_SQL } from './financeiro.js';

const AGENDA_UNICA_SQL = 'ALTER TABLE professionals ADD COLUMN IF NOT EXISTS is_default BOOLEAN NOT NULL DEFAULT false';
// Duas telas abriam ao mesmo tempo e cada uma criava a agenda da empresa: junta as repetidas e passa a permitir só uma.
const AGENDA_UNICA_UMA_SQL = `
DO $$ DECLARE k BIGINT; BEGIN
  SELECT min(id) INTO k FROM professionals WHERE is_default;
  IF k IS NOT NULL THEN
    UPDATE appointments SET professional_id=k WHERE professional_id IN (SELECT id FROM professionals WHERE is_default AND id<>k);
    UPDATE blocked_slots SET professional_id=k WHERE professional_id IN (SELECT id FROM professionals WHERE is_default AND id<>k);
    UPDATE waitlist SET professional_id=k WHERE professional_id IN (SELECT id FROM professionals WHERE is_default AND id<>k);
    DELETE FROM professionals WHERE is_default AND id<>k;
  END IF;
END $$;
CREATE UNIQUE INDEX IF NOT EXISTS professionals_uma_agenda_unica ON professionals (is_default) WHERE is_default;`;
// Lembretes de agendamento: um registro por agendamento (agendado, enviado, não enviado), com o texto que vai/foi para o cliente.
const LEMBRETES_SQL = `
CREATE TABLE IF NOT EXISTS appointment_reminders (
  id BIGSERIAL PRIMARY KEY,
  appointment_id BIGINT UNIQUE REFERENCES appointments(id) ON DELETE SET NULL,
  customer_id BIGINT REFERENCES customers(id) ON DELETE SET NULL,
  customer_name TEXT, phone TEXT, chat_id TEXT, service_name TEXT, professional_name TEXT, professional_default BOOLEAN NOT NULL DEFAULT false,
  starts_at TIMESTAMPTZ NOT NULL,
  send_at TIMESTAMPTZ NOT NULL,
  text TEXT,                       -- texto escrito para este cliente (vazio = mensagem da empresa)
  status TEXT NOT NULL DEFAULT 'scheduled' CHECK (status IN ('scheduled','sending','sent','failed','cancelled','skipped')),
  tries INT NOT NULL DEFAULT 0,
  sent_text TEXT,                  -- o que realmente foi enviado
  sent_at TIMESTAMPTZ,
  claimed_at TIMESTAMPTZ,
  note TEXT,                       -- motivo de não ter sido enviado
  memory_saved BOOLEAN,            -- a mensagem entrou no histórico da conversa do atendente?
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS appointment_reminders_status ON appointment_reminders (status, send_at);`;
// Correções de data/hora de um agendamento: fica registrado quem mudou, quando e de/para
// Assunto duplicado: o texto que ficou guardado como campo personalizado "Assunto" passa para o campo próprio do contato
const ASSUNTO_UNICO_SQL = `
UPDATE customers c SET
  subject = COALESCE(NULLIF(btrim(c.subject), ''), (SELECT NULLIF(btrim(e.v), '') FROM jsonb_each_text(c.extra) e(k, v) WHERE lower(btrim(e.k)) = 'assunto' AND NULLIF(btrim(e.v), '') IS NOT NULL LIMIT 1)),
  subject_at = COALESCE(c.subject_at, now()),
  extra = (SELECT COALESCE(jsonb_object_agg(e.k, e.v), '{}'::jsonb) FROM jsonb_each(c.extra) e(k, v) WHERE lower(btrim(e.k)) <> 'assunto')
WHERE EXISTS (SELECT 1 FROM jsonb_object_keys(c.extra) k WHERE lower(btrim(k)) = 'assunto');
`;
// Recebimento criado pela venda da Casa de Shows: apagar o pagamento da venda (ou a venda) apaga o recebimento que ele gerou
const RECEBIMENTO_DA_VENDA_SQL = `
CREATE OR REPLACE FUNCTION apagar_recebimento_da_venda() RETURNS trigger AS $f$
BEGIN
  IF OLD.payment_id IS NOT NULL THEN DELETE FROM payments WHERE id = OLD.payment_id AND source = 'venda'; END IF;
  RETURN OLD;
END $f$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS shows_sale_payments_recebimento ON shows_sale_payments;
CREATE TRIGGER shows_sale_payments_recebimento AFTER DELETE ON shows_sale_payments FOR EACH ROW EXECUTE FUNCTION apagar_recebimento_da_venda();
`;
const EDICOES_AGENDAMENTO_SQL = `
CREATE TABLE IF NOT EXISTS appointment_edits (
  id BIGSERIAL PRIMARY KEY,
  appointment_id BIGINT NOT NULL REFERENCES appointments(id) ON DELETE CASCADE,
  edited_by TEXT,
  from_starts_at TIMESTAMPTZ NOT NULL,
  to_starts_at TIMESTAMPTZ NOT NULL,
  notified BOOLEAN NOT NULL DEFAULT false,   -- o cliente foi avisado da mudança?
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS appointment_edits_appt ON appointment_edits (appointment_id, created_at);`;
const dir = path.dirname(fileURLToPath(import.meta.url));
const baseline = fs.readFileSync(path.join(dir, '..', 'db', 'tenant.sql'), 'utf8');

// Alterações futuras na estrutura das empresas: cada item roda uma vez em CADA schema (company_<id>),
// em ordem. O número da versão é a posição na lista (a base, tenant.sql, é a versão 1).
// Exemplo: { version: 2, sql: "ALTER TABLE customers ADD COLUMN IF NOT EXISTS algo TEXT" }
const atendenteSql = baseline.slice(baseline.indexOf('-- ========== ATENDENTE'), baseline.indexOf('-- ========== CAMPANHAS'));
const campanhasSql = baseline.slice(baseline.indexOf('-- ========== CAMPANHAS'), baseline.indexOf('-- ========== CAMPANHAS: SAUDA'));
const frasesSql = baseline.slice(baseline.indexOf('-- ========== CAMPANHAS: SAUDA'));
// Ficha do cliente e Clube. Idempotente: roda na criação de empresas novas e como passo 7 nas existentes.
const clubeSql = `
    CREATE TABLE IF NOT EXISTS loyalty_settings (
      id SMALLINT PRIMARY KEY CHECK (id = 1),
      program_name TEXT NOT NULL DEFAULT 'Programa de assinaturas'
    );
    INSERT INTO loyalty_settings (id) VALUES (1) ON CONFLICT DO NOTHING;
    CREATE TABLE IF NOT EXISTS loyalty_levels (
      id          BIGSERIAL PRIMARY KEY,
      name        TEXT NOT NULL,
      benefit_qty INT NOT NULL DEFAULT 0 CHECK (benefit_qty >= 0),   -- benefícios por mês
      position    INT NOT NULL DEFAULT 0,
      created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE UNIQUE INDEX IF NOT EXISTS loyalty_levels_name ON loyalty_levels (lower(name));
    ALTER TABLE customers ADD COLUMN IF NOT EXISTS birth_day SMALLINT CHECK (birth_day BETWEEN 1 AND 31);
    ALTER TABLE customers ADD COLUMN IF NOT EXISTS birth_month SMALLINT CHECK (birth_month BETWEEN 1 AND 12);
    ALTER TABLE customers ADD COLUMN IF NOT EXISTS birth_year SMALLINT CHECK (birth_year BETWEEN 1900 AND 2100);
    ALTER TABLE customers ADD COLUMN IF NOT EXISTS last_name TEXT;          -- sobrenome (name = nome)
    ALTER TABLE customers ADD COLUMN IF NOT EXISTS city TEXT;
    ALTER TABLE customers ADD COLUMN IF NOT EXISTS state TEXT;              -- UF, ex.: MG
    ALTER TABLE customers ADD COLUMN IF NOT EXISTS gender TEXT CHECK (gender IN ('female','male','other'));
    ALTER TABLE customers ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ;  -- última edição da ficha (não conta presença nem pedido)
    UPDATE customers SET updated_at = created_at WHERE updated_at IS NULL;
    ALTER TABLE customers ALTER COLUMN updated_at SET DEFAULT now();
    ALTER TABLE customers ADD COLUMN IF NOT EXISTS club_status TEXT CHECK (club_status IN ('member','former','supporter'));
    ALTER TABLE customers ADD COLUMN IF NOT EXISTS club_level_id BIGINT REFERENCES loyalty_levels(id);
    CREATE INDEX IF NOT EXISTS idx_customers_club ON customers (club_status);`;
// Números que não recebem campanhas (independe de o número estar cadastrado como cliente)
const exclusoesSql = `
    CREATE TABLE IF NOT EXISTS campaign_exclusions (
      id         BIGSERIAL PRIMARY KEY,
      phone      TEXT NOT NULL UNIQUE,
      note       TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );`;
// Qualquer venda que movimenta valor (pagamento aceito ou pedido pago) transforma o lead em cliente, em qualquer fluxo.
// A presença em agendamento já faz isso no baseline. Repetível: pode rodar de novo sem efeito colateral.
const VENDA_SQL = `
    CREATE OR REPLACE FUNCTION trg_venda_vira_cliente() RETURNS trigger AS $$
    DECLARE cid BIGINT;
    BEGIN
      IF TG_TABLE_NAME = 'payments' THEN
        IF NEW.status = 'accepted' AND NEW.amount > 0 THEN
          cid := COALESCE(NEW.customer_id, (SELECT customer_id FROM song_orders WHERE id = NEW.order_id));
        END IF;
      ELSIF COALESCE(NEW.amount_paid, 0) > 0 THEN
        cid := NEW.customer_id;
      END IF;
      IF cid IS NOT NULL THEN
        UPDATE customers SET status = 'client' WHERE id = cid AND status <> 'client';
      END IF;
      RETURN NEW;
    END $$ LANGUAGE plpgsql;
    DROP TRIGGER IF EXISTS venda_vira_cliente ON payments;
    CREATE TRIGGER venda_vira_cliente AFTER INSERT OR UPDATE OF status, amount, customer_id, order_id ON payments
      FOR EACH ROW EXECUTE FUNCTION trg_venda_vira_cliente();
    DROP TRIGGER IF EXISTS venda_vira_cliente ON song_orders;
    CREATE TRIGGER venda_vira_cliente AFTER INSERT OR UPDATE OF amount_paid, customer_id ON song_orders
      FOR EACH ROW EXECUTE FUNCTION trg_venda_vira_cliente();
    UPDATE customers c SET status = 'client'
     WHERE c.status <> 'client' AND (
       EXISTS (SELECT 1 FROM song_orders o WHERE o.customer_id = c.id AND COALESCE(o.amount_paid, 0) > 0)
       OR EXISTS (SELECT 1 FROM payments p WHERE p.status = 'accepted' AND p.amount > 0
                    AND c.id = COALESCE(p.customer_id, (SELECT o.customer_id FROM song_orders o WHERE o.id = p.order_id))));`;

const DOC_VERSOES_SQL = `
CREATE TABLE IF NOT EXISTS doc_template_versions (
  id          BIGSERIAL PRIMARY KEY,
  template_id BIGINT NOT NULL,
  name        TEXT NOT NULL,
  kind        TEXT NOT NULL,
  html        TEXT NOT NULL,
  blocks      JSONB,
  saved_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS doc_template_versions_idx ON doc_template_versions (template_id, id DESC);
`;

export const TENANT_STEPS = [
  // 2: manual e avisos do atendente (empresas criadas antes dele; as novas já nascem com isso na base)
  { version: 2, sql: atendenteSql },
  // 3: status "pending" (aguardando confirmação do responsável); o horário pendente já ocupa a agenda
  { version: 3, sql: `
    DO $$
    DECLARE c record;
    BEGIN
      FOR c IN SELECT conname FROM pg_constraint
               WHERE conrelid = 'appointments'::regclass AND contype IN ('c','x')
                 AND (pg_get_constraintdef(oid) LIKE '%no_show%' OR contype = 'x')
      LOOP
        EXECUTE format('ALTER TABLE appointments DROP CONSTRAINT %I', c.conname);
      END LOOP;
      ALTER TABLE appointments ADD CONSTRAINT appointments_status_check
        CHECK (status IN ('pending','scheduled','attended','no_show','cancelled'));
      ALTER TABLE appointments ADD CONSTRAINT appointments_no_overlap
        EXCLUDE USING gist (professional_id WITH =, tstzrange(starts_at, ends_at) WITH &&)
        WHERE (status IN ('pending','scheduled','attended'));
    END $$;` },
  // 4: campanhas (envio em lote com ritmo controlado)
  { version: 4, sql: campanhasSql },
  // 5: saudações e cumprimentos das campanhas (listas por empresa)
  { version: 5, sql: frasesSql },
  // 6: data do último play da campanha
  { version: 6, sql: 'ALTER TABLE campaigns ADD COLUMN IF NOT EXISTS last_play_at TIMESTAMPTZ' },
  // 7: ficha do cliente (aniversário, cidade) e programa de benefícios ("Clube") com níveis
  { version: 7, sql: clubeSql },
  // 8: lives e pedidos de música (franquia do programa de benefícios)
  { version: 8, sql: PEDIDOS_SQL },
  // 9: eventos (compromissos avulsos, sem profissional nem serviço)
  { version: 9, sql: EVENTOS_SQL },
  // 10: lista de números que não recebem campanhas
  { version: 10, sql: exclusoesSql },
  // 11: financeiro (chaves Pix e recebimentos)
  { version: 11, sql: FINANCEIRO_SQL },
  // 12: cortesia do 1º pedido (tipo novo no pedido e marca na ficha)
  { version: 12, sql: CORTESIA_SQL },
  // 13: cliente pode existir só com o nome (pedido anotado na mão, sem telefone). O telefone continua único quando existe.
  { version: 13, sql: 'ALTER TABLE customers ALTER COLUMN phone DROP NOT NULL' },
  // 14: venda com valor (pagamento aceito ou pedido pago) vira cliente automaticamente
  { version: 14, sql: VENDA_SQL },
  // 15: pedido atendido (marcação de um clique) e lista de músicas sugeridas da live
  { version: 15, sql: ATENDIDO_SQL + SUGESTOES_SQL },
  { version: 16, sql: ATENDIDO_FIX_SQL },
  // 17: pedidos pagos viram lançamentos do Financeiro (um controle só)
  { version: 17, sql: FINANCEIRO_ORIGEM_SQL },
  // 18: sem duplicar comprovante já registrado nos lançamentos de pedido; tipo da entrada
  { version: 18, sql: FINANCEIRO_DEDUP_SQL },
  // 19: manual e atualizações do assistente (opcional por empresa)
  { version: 19, sql: ASSISTENTE_SQL },
  // 20: catálogo de produtos e serviços (tipo do item)
  { version: 20, sql: PRODUTOS_SQL },
  // 21: vendas de produtos (base da comissão sobre produtos)
  { version: 21, sql: VENDAS_SQL },
  // 22: comissões dos profissionais
  { version: 22, sql: COMISSOES_SQL },
  // 23: Casa de Shows (reservas de mesa por setor, controladas por espaço)
  { version: 23, sql: CASA_DE_SHOWS_SQL },
  // 24: campanha automática de aniversariantes
  { version: 24, sql: ANIVERSARIO_SQL },
  // 25: contratações (shows contratados) na ficha do Contratante
  { version: 25, sql: CONTRATACOES_SQL },
  // 26: o programa de assinantes passa a se chamar "Programa de assinaturas" (quem ainda tem o nome de fábrica acompanha; nome escolhido pela empresa fica)
  { version: 26, sql: "UPDATE loyalty_settings SET program_name='Programa de assinaturas' WHERE program_name='Programa de benefícios'" },
  // 27: gerador de documentos em PDF (modelos, documentos gerados, dados fixos)
  { version: 27, sql: DOCUMENTOS_SQL },
  // 28: módulo Delivery (cardápio, pedidos, entregadores, cupons)
  { version: 28, sql: DELIVERY_SQL },
  // 29: módulo Restaurante (mesas, comandas, fila da cozinha, caixa)
  { version: 29, sql: RESTAURANTE_SQL },
  // 30: mapa do espaço e fotos dos setores (Casa de Shows)
  { version: 30, sql: SHOWS_MEDIA_SQL },
  // 31: pagamentos das reservas da Casa de Shows (forma, chave Pix, comprovante)
  { version: 31, sql: SHOWS_PAGAMENTOS_SQL },
  // 32: tabelas da Casa de Shows passam a usar o prefixo shows_
  { version: 32, sql: SHOWS_RENOMEAR_SQL },
  // 33: locais e formatos da Casa de Shows
  { version: 33, sql: SHOWS_LOCAIS_SQL },
  // 34: o local criado na migração passa a se chamar Padrão
  { version: 34, sql: SHOWS_LOCAL_PADRAO_SQL },
  // 35: chaves Pix por evento, com rodízio por valor
  { version: 35, sql: SHOWS_PIX_EVENTO_SQL },
  // 36: lotes de ingresso por evento
  { version: 36, sql: SHOWS_VENDAS_SQL + SHOWS_LOTES_SQL },
  // 37: reserva passa a se chamar venda
  { version: 37, sql: SHOWS_VENDAS_SQL },
  // 38: mesa reservada (convidados ligados a uma venda)
  { version: 38, sql: SHOWS_MESA_RESERVADA_SQL },
  // 39: lista do evento (uma linha por pessoa, entrada e observações)
  { version: 39, sql: SHOWS_LISTA_SQL },
  // 40: desconto do Clube nos ingressos
  { version: 40, sql: SHOWS_CLUBE_SQL },
  // 41: horário de abertura da casa no evento
  { version: 41, sql: EVENTOS_ABERTURA_SQL },
  // 42: envio da lista do evento pelo WhatsApp
  { version: 42, sql: SHOWS_LISTA_ENVIO_SQL },
  // 43: ficha do setor (visão, som, características, grupo ideal)
  { version: 43, sql: SHOWS_FICHA_SETOR_SQL },
  { version: 44, sql: DOC_FILES_VENDA_SQL },
  // 45: modelos de documento por blocos e logotipo da empresa
  { version: 45, sql: DOC_BLOCOS_SQL },
  // 46: vagas de documento (tipos em uso ao mesmo tempo)
  { version: 46, sql: DOC_VAGAS_SQL },
  // 47: versão do QR Code de cada pessoa (ingresso substituído deixa de valer)
  { version: 47, sql: SHOWS_LISTA_QR_SQL },
  // 48: assunto do contato e tipos de cliente da empresa
  { version: 48, sql: CONTATOS_SQL },
  // 49: espelho dos contatos numa planilha (marca de pendente + gatilho)
  { version: 49, sql: ESPELHO_SQL },
  // 50: o espelho também acompanha o aniversário (refaz o gatilho)
  { version: 50, sql: ESPELHO_SQL },
  // 51: o espelho também acompanha o plano do Clube
  { version: 51, sql: ESPELHO_SQL },
  // 52: campos personalizados do contato (colunas extras da planilha importada)
  { version: 52, sql: CAMPOS_EXTRA_SQL },
  // 53: grupos de contatos salvos para campanhas
  { version: 53, sql: GRUPOS_CAMPANHA_SQL },
  // 54: agenda única da empresa (sem profissionais cadastrados, a agenda responde pelo nome da empresa)
  { version: 54, sql: AGENDA_UNICA_SQL },
  // 55: só uma agenda da empresa (corrige duplicada)
  { version: 55, sql: AGENDA_UNICA_UMA_SQL },
  // 56: lembretes de agendamento (lista de agendados e enviados)
  { version: 56, sql: LEMBRETES_SQL },
  // 57: histórico de correções de data/hora do agendamento
  { version: 57, sql: EDICOES_AGENDAMENTO_SQL },
  // 58: assunto do contato em um só campo (o "Assunto" que veio como campo personalizado passa para o campo próprio)
  { version: 58, sql: ASSUNTO_UNICO_SQL },
  // 59: chaves Pix enviadas a cada cliente (a conferência aceita qualquer uma que ele recebeu, mesmo depois do rodízio)
  { version: 59, sql: PIX_ENVIADAS_SQL },
  { version: 60, sql: ALERTA_PAGAMENTO_SQL },
  { version: 61, sql: SHOWS_CANCELAMENTOS_SQL },
  // 62: pessoas tiradas da lista do evento (quem fica mantém a posição e o ingresso)
  { version: 62, sql: SHOWS_LISTA_RETIRADOS_SQL },
  // 63: recebimento gerado pela venda da Casa de Shows some junto com o pagamento da venda
  { version: 63, sql: RECEBIMENTO_DA_VENDA_SQL },
  // 64: versões anteriores dos modelos de documento (para voltar atrás depois de salvar por cima)
  { version: 64, sql: DOC_VERSOES_SQL },
  // 65: serviço e produto que as variáveis {servico} e {produto} da mensagem de aniversário representam
  { version: 65, sql: ANIVERSARIO_VARIAVEIS_SQL },
  // 66: crédito extra de pedidos e trava de música repetida
  { version: 66, sql: CORTESIAS_SQL },
  // 67: marca para padronizar os nomes de música que já existiam
  { version: 67, sql: PADRONIZA_TITULOS_SQL },
  // 68: o saldo vira "cortesias" e vale também para ingressos da Casa de Shows
  { version: 68, sql: CORTESIAS_RENOMEIA_SQL + SHOWS_CORTESIA_SQL },
];
export const TENANT_VERSION = 1 + TENANT_STEPS.length;

// Cria o schema de uma empresa. Deve ser chamado dentro de uma transação aberta em `cx`.
// Ao terminar, o search_path da transação fica em public.
export async function createCompanySchema(cx, companyId) {
  const s = schemaOf(companyId);
  await cx.query(`CREATE SCHEMA ${s}`);
  await cx.query(`SET LOCAL search_path TO ${s}, public`);
  await cx.query(baseline.replaceAll('__COMPANY_ID__', String(Number(companyId))));
  await cx.query(clubeSql);
  await cx.query(PEDIDOS_SQL);
  await cx.query(EVENTOS_SQL);
  await cx.query(exclusoesSql);
  await cx.query(FINANCEIRO_SQL);
  await cx.query(CORTESIA_SQL);
  await cx.query(VENDA_SQL);
  await cx.query(ATENDIDO_SQL);
  await cx.query(SUGESTOES_SQL);
  await cx.query(CORTESIAS_SQL);
  await cx.query(PADRONIZA_TITULOS_SQL);
  await cx.query(FINANCEIRO_ORIGEM_SQL);
  await cx.query(FINANCEIRO_DEDUP_SQL);
  await cx.query(ASSISTENTE_SQL);
  await cx.query(PRODUTOS_SQL);
  await cx.query(VENDAS_SQL);
  await cx.query(COMISSOES_SQL);
  await cx.query(CASA_DE_SHOWS_SQL);
  await cx.query(SHOWS_CORTESIA_SQL);
  await cx.query(ANIVERSARIO_SQL);
  await cx.query(ANIVERSARIO_VARIAVEIS_SQL);
  await cx.query(CONTRATACOES_SQL);
  await cx.query(DOCUMENTOS_SQL);
  await cx.query(DOC_FILES_VENDA_SQL);
  await cx.query(DOC_BLOCOS_SQL);
  await cx.query(DOC_VAGAS_SQL);
  await cx.query(DELIVERY_SQL);
  await cx.query(RESTAURANTE_SQL);
  await cx.query(SHOWS_MEDIA_SQL);
  await cx.query(SHOWS_PAGAMENTOS_SQL);
  await cx.query(SHOWS_LOCAIS_SQL);
  await cx.query(SHOWS_LOCAL_PADRAO_SQL);
  await cx.query(SHOWS_PIX_EVENTO_SQL);
  await cx.query(SHOWS_VENDAS_SQL);
  await cx.query(SHOWS_LOTES_SQL);
  await cx.query(SHOWS_MESA_RESERVADA_SQL);
  await cx.query(SHOWS_LISTA_SQL);
  await cx.query(SHOWS_CLUBE_SQL);
  await cx.query(EVENTOS_ABERTURA_SQL);
  await cx.query(SHOWS_LISTA_ENVIO_SQL);
  await cx.query(SHOWS_FICHA_SETOR_SQL);
  await cx.query(SHOWS_LISTA_QR_SQL);
  await cx.query(CONTATOS_SQL);
  await cx.query(ESPELHO_SQL);
  await cx.query(CAMPOS_EXTRA_SQL);
  await cx.query(GRUPOS_CAMPANHA_SQL);
  await cx.query(AGENDA_UNICA_SQL);
  await cx.query(AGENDA_UNICA_UMA_SQL);
  await cx.query(LEMBRETES_SQL);
  await cx.query(EDICOES_AGENDAMENTO_SQL);
  await cx.query(PIX_ENVIADAS_SQL);
  await cx.query(ALERTA_PAGAMENTO_SQL);
  await cx.query(SHOWS_CANCELAMENTOS_SQL);
  await cx.query(SHOWS_LISTA_RETIRADOS_SQL);
  await cx.query('SET LOCAL search_path TO public');
  await cx.query('INSERT INTO tenant_versions (company_id, version) VALUES ($1, 1)', [companyId]);
}

// Atualiza a estrutura de todas as empresas até a versão atual (usado no deploy).
export async function upgradeAllCompanies() {
  const { rows } = await pool.query(
    `SELECT c.id, COALESCE(v.version, 0) AS version FROM public.companies c
     LEFT JOIN public.tenant_versions v ON v.company_id = c.id ORDER BY c.id`);
  for (const c of rows) {
    const cx = await pool.connect();
    try {
      await cx.query('BEGIN');
      if (c.version === 0) {
        await createCompanySchema(cx, c.id);
        c.version = 1;
      }
      for (const step of TENANT_STEPS) {
        if (step.version <= c.version) continue;
        await cx.query(`SET LOCAL search_path TO ${schemaOf(c.id)}, public`);
        await cx.query(step.sql);
        await cx.query('SET LOCAL search_path TO public');
        await cx.query('UPDATE tenant_versions SET version=$2 WHERE company_id=$1', [c.id, step.version]);
      }
      await cx.query('COMMIT');
    } catch (e) {
      await cx.query('ROLLBACK').catch(() => {});
      throw new Error(`Falha ao atualizar a empresa ${c.id}: ${e.message}`);
    } finally {
      cx.release();
    }
  }
  return rows.length;
}
