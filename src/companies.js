import bcrypt from 'bcryptjs';
import { pool } from './db.js';
import { createCompanySchema } from './tenant.js';
import { newApiKey } from './apikeys.js';
import { applyTemplate } from './templates.js';

const slugOf = (name) => String(name).toLowerCase().normalize('NFD').replace(/[^\w]+/g, '-').replace(/^-|-$/g, '')
  + '-' + Math.random().toString(36).slice(2, 6);

// Cria a empresa, o schema dela, o usuário dono e a chave de integração, tudo numa transação.
// Devolve também apiKey: a chave em texto, que não fica guardada em lugar nenhum (só o hash) — mostre-a uma única vez.
// Lança um erro com code '23505' se o e-mail já existir.
export async function createCompany({ name, ownerName, email, password, modules = {}, template = null }) {
  const hash = await bcrypt.hash(password, 10);
  const k = newApiKey();
  const cx = await pool.connect();
  try {
    await cx.query('BEGIN');
    await cx.query('SET LOCAL search_path TO public');
    const c = (await cx.query(
      `INSERT INTO companies (name, slug, modules, api_key_hash, api_key_hint, api_key_created_at)
       VALUES ($1,$2,$3,$4,$5,now()) RETURNING *`,
      [name, slugOf(name), JSON.stringify(modules), k.hash, k.hint])).rows[0];
    const u = (await cx.query(
      "INSERT INTO users (company_id,name,email,password_hash,role) VALUES ($1,$2,$3,$4,'owner') RETURNING *",
      [c.id, ownerName, email, hash])).rows[0];
    await createCompanySchema(cx, c.id);
    if (template) await applyTemplate(cx, c.id, template);
    else {
      // sem modelo: a empresa nasce com o menu padrão definido pelo administrador (se houver)
      const padrao = (await cx.query("SELECT value FROM public.platform_settings WHERE key='default_menu'")).rows[0]?.value?.menu_custom;
      if (padrao && Object.keys(padrao).length) {
        await cx.query('UPDATE public.companies SET menu_custom=$2::jsonb WHERE id=$1', [c.id, JSON.stringify(padrao)]);
        c.menu_custom = padrao;
      }
    }
    await cx.query('COMMIT');
    // nada da chave sai junto com os dados da empresa
    delete c.api_key_hash; delete c.api_key_hint; delete c.api_key_created_at;
    return { company: c, user: u, apiKey: k.key };
  } catch (e) {
    await cx.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    cx.release();
  }
}
