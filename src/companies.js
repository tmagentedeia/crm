import bcrypt from 'bcryptjs';
import { pool } from './db.js';
import { createCompanySchema } from './tenant.js';

const slugOf = (name) => String(name).toLowerCase().normalize('NFD').replace(/[^\w]+/g, '-').replace(/^-|-$/g, '')
  + '-' + Math.random().toString(36).slice(2, 6);

// Cria a empresa, o schema dela e o usuário dono, tudo numa transação.
// Lança um erro com code '23505' se o e-mail já existir.
export async function createCompany({ name, ownerName, email, password, modules = {} }) {
  const hash = await bcrypt.hash(password, 10);
  const cx = await pool.connect();
  try {
    await cx.query('BEGIN');
    await cx.query('SET LOCAL search_path TO public');
    const c = (await cx.query('INSERT INTO companies (name, slug, modules) VALUES ($1,$2,$3) RETURNING *',
      [name, slugOf(name), JSON.stringify(modules)])).rows[0];
    const u = (await cx.query(
      "INSERT INTO users (company_id,name,email,password_hash,role) VALUES ($1,$2,$3,$4,'owner') RETURNING *",
      [c.id, ownerName, email, hash])).rows[0];
    await createCompanySchema(cx, c.id);
    await cx.query('COMMIT');
    return { company: c, user: u };
  } catch (e) {
    await cx.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    cx.release();
  }
}
