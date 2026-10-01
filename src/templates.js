import { schemaOf } from './db.js';

// Modelo de empresa: só a ESTRUTURA (módulos, configurações, categorias, serviços e o manual do atendente publicado).
// Nunca leva clientes, agendamentos, profissionais, atualizações provisórias, logotipo, telefone, nomes nem a chave.

// Tira uma foto da estrutura de uma empresa.
export async function snapshotCompany(companyId, cx) {
  const c = (await cx.query('SELECT modules, inactive_days, timezone, reminder_minutes FROM public.companies WHERE id=$1', [companyId])).rows[0];
  if (!c) return null;
  await cx.query(`SET search_path TO ${schemaOf(companyId)}, public`);
  try {
    const categories = (await cx.query('SELECT name FROM categories ORDER BY name')).rows.map((r) => r.name);
    const services = (await cx.query(
      `SELECT sv.name, sv.price::float AS price, sv.duration_min, sv.active, c.name AS category
       FROM services sv LEFT JOIN categories c ON c.id = sv.category_id ORDER BY sv.name`)).rows;
    const man = (await cx.query('SELECT content FROM agent_manual_versions WHERE published_at IS NOT NULL ORDER BY published_at DESC, id DESC LIMIT 1')).rows[0];
    return {
      modules: c.modules || {},
      settings: { inactive_days: c.inactive_days, timezone: c.timezone, reminder_minutes: c.reminder_minutes },
      categories, services,
      manual: man ? man.content : null,
    };
  } finally {
    await cx.query('SET search_path TO public');
  }
}

// Aplica um modelo numa empresa recém-criada (dentro da mesma transação, logo depois de createCompanySchema).
// Os módulos NÃO são aplicados aqui: quem cria a empresa já os escolheu (a tela parte dos módulos do modelo).
export async function applyTemplate(cx, companyId, data) {
  const s = data.settings || {};
  await cx.query('SET LOCAL search_path TO public');
  await cx.query(
    `UPDATE companies SET inactive_days=COALESCE($2,inactive_days), timezone=COALESCE($3,timezone),
       reminder_minutes = CASE WHEN $4::boolean THEN $5::int ELSE reminder_minutes END WHERE id=$1`,
    [companyId, s.inactive_days ?? null, s.timezone ?? null, 'reminder_minutes' in s, s.reminder_minutes ?? null]);
  await cx.query(`SET LOCAL search_path TO ${schemaOf(companyId)}, public`);
  const catId = {};
  for (const name of data.categories || []) {
    catId[name] = (await cx.query('INSERT INTO categories (name) VALUES ($1) ON CONFLICT (name) DO UPDATE SET name=EXCLUDED.name RETURNING id', [name])).rows[0].id;
  }
  for (const sv of data.services || []) {
    if (sv.category && !(sv.category in catId))
      catId[sv.category] = (await cx.query('INSERT INTO categories (name) VALUES ($1) ON CONFLICT (name) DO UPDATE SET name=EXCLUDED.name RETURNING id', [sv.category])).rows[0].id;
    await cx.query('INSERT INTO services (name, price, duration_min, category_id, active) VALUES ($1,$2,$3,$4,$5)',
      [sv.name, sv.price ?? 0, sv.duration_min ?? 30, sv.category ? catId[sv.category] : null, sv.active !== false]);
  }
  if (data.manual && data.manual.trim())
    await cx.query('INSERT INTO agent_manual_versions (content, published_at) VALUES ($1, now())', [data.manual]);
  await cx.query('SET LOCAL search_path TO public');
}
