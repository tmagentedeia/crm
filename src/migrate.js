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
    await pool.query('ALTER TABLE companies ADD COLUMN IF NOT EXISTS api_key_hash TEXT');
    await pool.query('ALTER TABLE companies ADD COLUMN IF NOT EXISTS api_key_hint TEXT');
    await pool.query('ALTER TABLE companies ADD COLUMN IF NOT EXISTS api_key_created_at TIMESTAMPTZ');
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
