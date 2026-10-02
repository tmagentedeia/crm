import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { pool, schemaOf } from './db.js';

const dir = path.dirname(fileURLToPath(import.meta.url));
const baseline = fs.readFileSync(path.join(dir, '..', 'db', 'tenant.sql'), 'utf8');

// Alterações futuras na estrutura das empresas: cada item roda uma vez em CADA schema (company_<id>),
// em ordem. O número da versão é a posição na lista (a base, tenant.sql, é a versão 1).
// Exemplo: { version: 2, sql: "ALTER TABLE customers ADD COLUMN IF NOT EXISTS algo TEXT" }
const atendenteSql = baseline.slice(baseline.indexOf('-- ========== ATENDENTE'), baseline.indexOf('-- ========== CAMPANHAS'));
const campanhasSql = baseline.slice(baseline.indexOf('-- ========== CAMPANHAS'));
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
];
export const TENANT_VERSION = 1 + TENANT_STEPS.length;

// Cria o schema de uma empresa. Deve ser chamado dentro de uma transação aberta em `cx`.
// Ao terminar, o search_path da transação fica em public.
export async function createCompanySchema(cx, companyId) {
  const s = schemaOf(companyId);
  await cx.query(`CREATE SCHEMA ${s}`);
  await cx.query(`SET LOCAL search_path TO ${s}, public`);
  await cx.query(baseline.replaceAll('__COMPANY_ID__', String(Number(companyId))));
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
