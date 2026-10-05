import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { pool, schemaOf } from './db.js';
import { PEDIDOS_SQL, CORTESIA_SQL, ATENDIDO_SQL, SUGESTOES_SQL, ATENDIDO_FIX_SQL } from './pedidos.js';
import { EVENTOS_SQL } from './eventos.js';
import { ASSISTENTE_SQL } from './assistente.js';
import { PRODUTOS_SQL } from './produtos.js';
import { VENDAS_SQL } from './vendas.js';
import { COMISSOES_SQL } from './comissoes.js';
import { SHOWS_LISTA_SQL } from './lista_evento.js';
import { CASA_DE_SHOWS_SQL, SHOWS_MEDIA_SQL, SHOWS_PAGAMENTOS_SQL, SHOWS_RENOMEAR_SQL, SHOWS_LOCAIS_SQL, SHOWS_LOCAL_PADRAO_SQL, SHOWS_PIX_EVENTO_SQL, SHOWS_LOTES_SQL, SHOWS_VENDAS_SQL, SHOWS_MESA_RESERVADA_SQL, SHOWS_CLUBE_SQL } from './casa_de_shows.js';
import { ANIVERSARIO_SQL } from './aniversario.js';
import { DOCUMENTOS_SQL } from './documentos.js';
import { DELIVERY_SQL } from './delivery.js';
import { RESTAURANTE_SQL } from './restaurante.js';
import { CONTRATACOES_SQL } from './contratacoes.js';
import { FINANCEIRO_SQL, FINANCEIRO_ORIGEM_SQL, FINANCEIRO_DEDUP_SQL } from './financeiro.js';

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
  await cx.query(FINANCEIRO_ORIGEM_SQL);
  await cx.query(FINANCEIRO_DEDUP_SQL);
  await cx.query(ASSISTENTE_SQL);
  await cx.query(PRODUTOS_SQL);
  await cx.query(VENDAS_SQL);
  await cx.query(COMISSOES_SQL);
  await cx.query(CASA_DE_SHOWS_SQL);
  await cx.query(ANIVERSARIO_SQL);
  await cx.query(CONTRATACOES_SQL);
  await cx.query(DOCUMENTOS_SQL);
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
