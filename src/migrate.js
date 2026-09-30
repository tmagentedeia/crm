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
    await pool.query('ALTER TABLE barbers ADD COLUMN IF NOT EXISTS google_calendar_id TEXT');
    await pool.query('ALTER TABLE appointments ADD COLUMN IF NOT EXISTS google_event_id TEXT');
    await pool.query('ALTER TABLE appointments ADD COLUMN IF NOT EXISTS reminder_sent_at TIMESTAMPTZ');
    await pool.query(`CREATE TABLE IF NOT EXISTS categories (
      id BIGSERIAL PRIMARY KEY,
      salon_id BIGINT NOT NULL REFERENCES salons(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      UNIQUE (salon_id, name))`);
    await pool.query('ALTER TABLE services ADD COLUMN IF NOT EXISTS category_id BIGINT REFERENCES categories(id) ON DELETE SET NULL');
    // converte a coluna de texto antiga (se existir) para categorias de verdade
    const old = await pool.query("SELECT 1 FROM information_schema.columns WHERE table_name='services' AND column_name='category'");
    if (old.rows[0]) {
      await pool.query(`INSERT INTO categories (salon_id, name)
        SELECT DISTINCT salon_id, category FROM services WHERE category IS NOT NULL AND trim(category) <> ''
        ON CONFLICT DO NOTHING`);
      await pool.query(`UPDATE services s SET category_id = c.id FROM categories c
        WHERE c.salon_id = s.salon_id AND c.name = s.category AND s.category_id IS NULL`);
      await pool.query('ALTER TABLE services DROP COLUMN category');
    }
    await pool.query(`CREATE TABLE IF NOT EXISTS waitlist (
      id BIGSERIAL PRIMARY KEY,
      salon_id BIGINT NOT NULL REFERENCES salons(id) ON DELETE CASCADE,
      customer_id BIGINT NOT NULL REFERENCES customers(id),
      barber_id BIGINT REFERENCES barbers(id) ON DELETE SET NULL,
      desired_at TIMESTAMPTZ NOT NULL,
      status TEXT NOT NULL DEFAULT 'waiting' CHECK (status IN ('waiting','notified','cancelled')),
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      notified_at TIMESTAMPTZ)`);
    await pool.query('CREATE INDEX IF NOT EXISTS idx_waitlist_salon ON waitlist (salon_id, status, desired_at)');
    await pool.query(`CREATE TABLE IF NOT EXISTS barber_categories (
      barber_id BIGINT NOT NULL REFERENCES barbers(id) ON DELETE CASCADE,
      category_id BIGINT NOT NULL REFERENCES categories(id) ON DELETE CASCADE,
      PRIMARY KEY (barber_id, category_id))`);
    // cadastro antigo: deriva as categorias do profissional a partir dos serviços que ele já tinha marcados
    await pool.query(`INSERT INTO barber_categories (barber_id, category_id)
      SELECT DISTINCT bs.barber_id, sv.category_id FROM barber_services bs JOIN services sv ON sv.id=bs.service_id
      WHERE sv.category_id IS NOT NULL
        AND NOT EXISTS (SELECT 1 FROM barber_categories x WHERE x.barber_id=bs.barber_id)
      ON CONFLICT DO NOTHING`);
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
