import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { pool } from './db.js';
import { upgradeAllCompanies } from './tenant.js';

const dir = path.dirname(fileURLToPath(import.meta.url));
const sql = fs.readFileSync(path.join(dir, '..', 'db', 'schema.sql'), 'utf8');

try {
  const has = async (t) => (await pool.query('SELECT to_regclass($1) AS t', [`public.${t}`])).rows[0].t;
  if (await has('companies')) {
    // já instalado: garante colunas gerais e atualiza o schema de cada empresa
    await pool.query("ALTER TABLE companies ADD COLUMN IF NOT EXISTS modules JSONB NOT NULL DEFAULT '{}'");
    await pool.query("ALTER TABLE companies ADD COLUMN IF NOT EXISTS menu_custom JSONB NOT NULL DEFAULT '{}'");
    await pool.query("ALTER TABLE companies ADD COLUMN IF NOT EXISTS module_labels JSONB NOT NULL DEFAULT '{}'");
    await pool.query('ALTER TABLE companies ADD COLUMN IF NOT EXISTS whatsapp_instance TEXT');
    await pool.query("ALTER TABLE companies ADD COLUMN IF NOT EXISTS redis_prefix TEXT NOT NULL DEFAULT ''");
    await pool.query('ALTER TABLE companies ADD COLUMN IF NOT EXISTS campaign_webhook_url TEXT');
    await pool.query("ALTER TABLE companies ADD COLUMN IF NOT EXISTS booking_mode TEXT NOT NULL DEFAULT 'auto'");
    await pool.query('ALTER TABLE companies ADD COLUMN IF NOT EXISTS api_key_hash TEXT');
    await pool.query('ALTER TABLE companies ADD COLUMN IF NOT EXISTS api_key_hint TEXT');
    await pool.query('ALTER TABLE companies ADD COLUMN IF NOT EXISTS api_key_created_at TIMESTAMPTZ');
    await pool.query(`CREATE TABLE IF NOT EXISTS platform_settings (
      key TEXT PRIMARY KEY, value JSONB NOT NULL, updated_at TIMESTAMPTZ NOT NULL DEFAULT now())`);
    await pool.query(`CREATE TABLE IF NOT EXISTS company_templates (
      id BIGSERIAL PRIMARY KEY, name TEXT NOT NULL UNIQUE, description TEXT, data JSONB NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT now())`);
    await pool.query(`CREATE TABLE IF NOT EXISTS admin_access_log (
      id BIGSERIAL PRIMARY KEY, admin_user_id BIGINT NOT NULL, company_id BIGINT NOT NULL, target_user_id BIGINT, created_at TIMESTAMPTZ NOT NULL DEFAULT now())`);
    const n = await upgradeAllCompanies();
    console.log(`Estrutura em dia (${n} empresa(s)).`);
  } else {
    await pool.query(sql);
    console.log('Estrutura criada com sucesso.');
  }
} catch (e) {
  console.error('Erro na migração:', e.message);
  process.exitCode = 1;
} finally {
  await pool.end();
}
