import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { pool, schemaOf } from './db.js';
import { createCompanySchema, upgradeAllCompanies } from './tenant.js';

const dir = path.dirname(fileURLToPath(import.meta.url));
const sql = fs.readFileSync(path.join(dir, '..', 'db', 'schema.sql'), 'utf8');

// Tabelas que existiam todas juntas em public, com salon_id (modelo antigo) → agora uma cópia por empresa.
const LEGACY_TABLES = ['categories', 'services', 'barbers', 'barber_schedules', 'barber_categories', 'barber_services',
  'customers', 'appointments', 'blocked_slots', 'waitlist', 'agent_commands', 'agent_attendants'];

// Garante que o modelo antigo esteja completo antes de converter (instalações mais velhas).
async function prepareLegacy(cx) {
  await cx.query('ALTER TABLE salons ADD COLUMN IF NOT EXISTS logo TEXT');
  await cx.query('ALTER TABLE salons ADD COLUMN IF NOT EXISTS max_barbers INT');
  await cx.query('ALTER TABLE salons ADD COLUMN IF NOT EXISTS reminder_minutes INT DEFAULT 120');
  await cx.query('ALTER TABLE salons ADD COLUMN IF NOT EXISTS agent_name TEXT');
  await cx.query('ALTER TABLE salons ADD COLUMN IF NOT EXISTS adm_name TEXT');
  await cx.query(`CREATE TABLE IF NOT EXISTS agent_commands (
    id BIGSERIAL PRIMARY KEY,
    salon_id BIGINT NOT NULL REFERENCES salons(id) ON DELETE CASCADE,
    kind TEXT NOT NULL CHECK (kind IN ('off','on','pause','resume')),
    phrase TEXT NOT NULL, phrase_norm TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (salon_id, phrase_norm))`);
  // /off e /on são fixos (sem cadastro); frases cadastradas só existem como bloquear (pause) e liberar (resume)
  await cx.query("UPDATE agent_commands SET kind='pause' WHERE kind='off'");
  await cx.query("UPDATE agent_commands SET kind='resume' WHERE kind='on'");
  await cx.query(`CREATE TABLE IF NOT EXISTS agent_attendants (
    id BIGSERIAL PRIMARY KEY,
    salon_id BIGINT NOT NULL REFERENCES salons(id) ON DELETE CASCADE,
    name TEXT NOT NULL, name_norm TEXT NOT NULL,
    UNIQUE (salon_id, name_norm))`);
  await cx.query('ALTER TABLE barbers ADD COLUMN IF NOT EXISTS google_calendar_id TEXT');
  await cx.query('ALTER TABLE appointments ADD COLUMN IF NOT EXISTS google_event_id TEXT');
  await cx.query('ALTER TABLE appointments ADD COLUMN IF NOT EXISTS reminder_sent_at TIMESTAMPTZ');
  await cx.query(`CREATE TABLE IF NOT EXISTS categories (
    id BIGSERIAL PRIMARY KEY,
    salon_id BIGINT NOT NULL REFERENCES salons(id) ON DELETE CASCADE,
    name TEXT NOT NULL, UNIQUE (salon_id, name))`);
  await cx.query('ALTER TABLE services ADD COLUMN IF NOT EXISTS category_id BIGINT REFERENCES categories(id) ON DELETE SET NULL');
  const old = await cx.query("SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='services' AND column_name='category'");
  if (old.rows[0]) {
    await cx.query(`INSERT INTO categories (salon_id, name)
      SELECT DISTINCT salon_id, category FROM services WHERE category IS NOT NULL AND trim(category) <> ''
      ON CONFLICT DO NOTHING`);
    await cx.query(`UPDATE services s SET category_id = c.id FROM categories c
      WHERE c.salon_id = s.salon_id AND c.name = s.category AND s.category_id IS NULL`);
    await cx.query('ALTER TABLE services DROP COLUMN category');
  }
  await cx.query(`CREATE TABLE IF NOT EXISTS waitlist (
    id BIGSERIAL PRIMARY KEY,
    salon_id BIGINT NOT NULL REFERENCES salons(id) ON DELETE CASCADE,
    customer_id BIGINT NOT NULL REFERENCES customers(id),
    barber_id BIGINT REFERENCES barbers(id) ON DELETE SET NULL,
    desired_at TIMESTAMPTZ NOT NULL,
    status TEXT NOT NULL DEFAULT 'waiting' CHECK (status IN ('waiting','notified','cancelled')),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(), notified_at TIMESTAMPTZ)`);
  await cx.query(`CREATE TABLE IF NOT EXISTS barber_categories (
    barber_id BIGINT NOT NULL REFERENCES barbers(id) ON DELETE CASCADE,
    category_id BIGINT NOT NULL REFERENCES categories(id) ON DELETE CASCADE,
    PRIMARY KEY (barber_id, category_id))`);
  await cx.query(`INSERT INTO barber_categories (barber_id, category_id)
    SELECT DISTINCT bs.barber_id, sv.category_id FROM barber_services bs JOIN services sv ON sv.id=bs.service_id
    WHERE sv.category_id IS NOT NULL
      AND NOT EXISTS (SELECT 1 FROM barber_categories x WHERE x.barber_id=bs.barber_id)
    ON CONFLICT DO NOTHING`);
}

// Modelo antigo (tudo em public, com salon_id) → empresas + um schema por empresa.
// Tudo numa transação: se algo falhar, o banco continua como estava.
// As tabelas antigas NÃO são apagadas: ficam como legacy_<nome> até você conferir e remover.
async function convertLegacy() {
  const cx = await pool.connect();
  try {
    await cx.query('BEGIN');
    await cx.query('SET LOCAL search_path TO public');
    await prepareLegacy(cx);

    for (const v of ['v_inactive_customers', 'v_customer_history', 'v_dashboard_base'])
      await cx.query(`DROP VIEW IF EXISTS public.${v}`);

    await cx.query('ALTER TABLE salons RENAME TO companies');
    await cx.query('ALTER TABLE companies RENAME COLUMN max_barbers TO max_professionals');
    await cx.query('ALTER TABLE users RENAME COLUMN salon_id TO company_id');
    await cx.query("ALTER TABLE companies ADD COLUMN IF NOT EXISTS modules JSONB NOT NULL DEFAULT '{}'");
    await cx.query(`CREATE TABLE IF NOT EXISTS tenant_versions (
      company_id BIGINT PRIMARY KEY REFERENCES companies(id) ON DELETE CASCADE, version INT NOT NULL)`);

    const companies = (await cx.query('SELECT id FROM companies ORDER BY id')).rows;
    for (const { id } of companies) {
      const S = schemaOf(id);
      await createCompanySchema(cx, id);
      const L = (t) => `public.${t}`;
      // t: tabela nova; old: tabela antiga; colunas com nome antigo (barber_id) viram professional_id
      const copy = (t, cols, from, where) => {
        const src = cols.split(',').map((c) => c.trim());
        const dst = src.map((c) => c.replace(/^barber_id$/, 'professional_id'));
        return cx.query(`INSERT INTO ${S}.${t} (${dst.join(', ')}) SELECT ${src.map((c) => `x.${c}`).join(', ')} FROM ${from} x ${where} `, [id]);
      };
      await copy('categories', 'id, name', L('categories'), 'WHERE x.salon_id=$1');
      await copy('services', 'id, name, price, duration_min, category_id, active, created_at', L('services'), 'WHERE x.salon_id=$1');
      await copy('professionals', 'id, name, color, phone, active, google_calendar_id, created_at', L('barbers'), 'WHERE x.salon_id=$1');
      await cx.query(`INSERT INTO ${S}.professional_schedules (id, professional_id, weekday, start_time, end_time, break_start, break_end)
        SELECT x.id, x.barber_id, x.weekday, x.start_time, x.end_time, x.break_start, x.break_end
        FROM public.barber_schedules x JOIN public.barbers b ON b.id=x.barber_id WHERE b.salon_id=$1`, [id]);
      await cx.query(`INSERT INTO ${S}.professional_categories (professional_id, category_id)
        SELECT x.barber_id, x.category_id FROM public.barber_categories x JOIN public.barbers b ON b.id=x.barber_id WHERE b.salon_id=$1`, [id]);
      await cx.query(`INSERT INTO ${S}.professional_services (professional_id, service_id)
        SELECT x.barber_id, x.service_id FROM public.barber_services x JOIN public.barbers b ON b.id=x.barber_id WHERE b.salon_id=$1`, [id]);
      await copy('customers', 'id, name, phone, chat_id, status, source, notes, first_contact_at, last_visit_at, created_at', L('customers'), 'WHERE x.salon_id=$1');
      // o gatilho de presença recalcularia o cliente; os dados já estão consistentes, então fica fora durante a cópia
      await cx.query(`ALTER TABLE ${S}.appointments DISABLE TRIGGER appointment_attended`);
      await copy('appointments', 'id, barber_id, customer_id, service_id, starts_at, ends_at, price, status, source, google_event_id, reminder_sent_at, created_at', L('appointments'), 'WHERE x.salon_id=$1');
      await cx.query(`ALTER TABLE ${S}.appointments ENABLE TRIGGER appointment_attended`);
      await cx.query(`INSERT INTO ${S}.blocked_slots (id, professional_id, starts_at, ends_at, reason)
        SELECT x.id, x.barber_id, x.starts_at, x.ends_at, x.reason
        FROM public.blocked_slots x JOIN public.barbers b ON b.id=x.barber_id WHERE b.salon_id=$1`, [id]);
      await copy('waitlist', 'id, customer_id, barber_id, desired_at, status, created_at, notified_at', L('waitlist'), 'WHERE x.salon_id=$1');
      await copy('agent_commands', 'id, kind, phrase, phrase_norm, created_at', L('agent_commands'), 'WHERE x.salon_id=$1');
      await copy('agent_attendants', 'id, name, name_norm', L('agent_attendants'), 'WHERE x.salon_id=$1');
      for (const t of ['categories', 'services', 'professionals', 'professional_schedules', 'customers', 'appointments',
        'blocked_slots', 'waitlist', 'agent_commands', 'agent_attendants']) {
        await cx.query(`SELECT setval(pg_get_serial_sequence('${S}.${t}', 'id'),
          GREATEST((SELECT COALESCE(MAX(id), 1) FROM ${S}.${t}), 1),
          (SELECT MAX(id) IS NOT NULL FROM ${S}.${t}))`);
      }
    }
    for (const t of LEGACY_TABLES) await cx.query(`ALTER TABLE public.${t} RENAME TO legacy_${t}`);
    await cx.query('COMMIT');
    console.log(`Convertido para schema por empresa: ${companies.length} empresa(s). Tabelas antigas guardadas como legacy_*.`);
  } catch (e) {
    await cx.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    cx.release();
  }
}

try {
  const has = async (t) => (await pool.query('SELECT to_regclass($1) AS t', [`public.${t}`])).rows[0].t;
  if (await has('companies')) {
    // já no modelo novo: só garante colunas gerais e atualiza o schema de cada empresa
    await pool.query("ALTER TABLE companies ADD COLUMN IF NOT EXISTS modules JSONB NOT NULL DEFAULT '{}'");
    const n = await upgradeAllCompanies();
    console.log(`Estrutura em dia (${n} empresa(s)).`);
  } else if (await has('salons')) {
    await convertLegacy();
    await upgradeAllCompanies();
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
