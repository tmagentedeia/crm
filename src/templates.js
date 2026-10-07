import { schemaOf } from './db.js';

// Modelo de empresa: só a ESTRUTURA (módulos, configurações e o manual do atendente publicado).
// Nunca leva clientes, serviços, categorias, preços, agendamentos, profissionais, atualizações provisórias, logotipo, telefone, nomes nem a chave.

// Tira uma foto da estrutura de uma empresa.
export async function snapshotCompany(companyId, cx) {
  const c = (await cx.query('SELECT modules, menu_custom, inactive_days, timezone, reminder_minutes FROM public.companies WHERE id=$1', [companyId])).rows[0];
  if (!c) return null;
  await cx.query(`SET search_path TO ${schemaOf(companyId)}, public`);
  try {
    const man = (await cx.query('SELECT content FROM agent_manual_versions WHERE published_at IS NOT NULL ORDER BY published_at DESC, id DESC LIMIT 1')).rows[0];
    return {
      modules: c.modules || {},
      menu_custom: c.menu_custom || {},
      settings: { inactive_days: c.inactive_days, timezone: c.timezone, reminder_minutes: c.reminder_minutes },
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
       reminder_minutes = CASE WHEN $4::boolean THEN $5::int ELSE reminder_minutes END,
       menu_custom = COALESCE($6::jsonb, menu_custom) WHERE id=$1`,
    [companyId, s.inactive_days ?? null, s.timezone ?? null, 'reminder_minutes' in s, s.reminder_minutes ?? null,
     data.menu_custom ? JSON.stringify(data.menu_custom) : null]);
  await cx.query(`SET LOCAL search_path TO ${schemaOf(companyId)}, public`);
  // modelos antigos podem ter serviços e categorias guardados: são dados da empresa de origem e não são aplicados
  if (data.manual && data.manual.trim())
    await cx.query('INSERT INTO agent_manual_versions (content, published_at) VALUES ($1, now())', [data.manual]);
  await cx.query('SET LOCAL search_path TO public');
}
