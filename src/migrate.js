import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { pool } from './db.js';

const dir = path.dirname(fileURLToPath(import.meta.url));
const sql = fs.readFileSync(path.join(dir, '..', 'db', 'schema.sql'), 'utf8');

try {
  const { rows } = await pool.query("SELECT to_regclass('public.salons') AS t");
  if (rows[0].t) {
    await pool.query('ALTER TABLE salons ADD COLUMN IF NOT EXISTS logo TEXT');
    await pool.query('ALTER TABLE salons ADD COLUMN IF NOT EXISTS max_barbers INT');
    console.log('Schema já existe, colunas atualizadas.');
  } else {
    await pool.query(sql);
    console.log('Schema criado com sucesso.');
  }
} catch (e) {
  console.error('Erro na migração:', e.message);
  process.exitCode = 1;
} finally {
  await pool.end();
}
