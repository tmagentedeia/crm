// Programa de benefícios por indicação (Parceiro M2): cada empresa que indica um cliente que fecha contrato ganha 10% de
// desconto na mensalidade, até 2 indicações por mês (20%); o que passar disso vai para os meses seguintes, em fila.
// Quem controla é o administrador (tabelas gerais, fora do schema de cada empresa). A empresa só enxerga o seu próprio saldo.
// Os lembretes para o administrador aplicar o desconto saem pela tabela de mensagens agendadas do WhatsApp (a mesma que a
// Maria usa), na véspera do vencimento — o painel só grava as linhas, sem precisar de nenhum fluxo novo.
import pg from 'pg';
import { qg, currentCompany } from './db.js';
import { normPhone } from './phone.js';

export const PCT_POR_INDICACAO = 10;
export const MAX_POR_MES = 2;
const TZ = 'America/Sao_Paulo';
const HORIZONTE_DIAS = 35;       // só agenda o lembrete quando faltam até 35 dias para ele (o resto o relógio do painel cuida)
const HORA_LEMBRETE = '09:00:00';

export const INDICACOES_SQL = `
  ALTER TABLE companies ADD COLUMN IF NOT EXISTS billing_due_day SMALLINT CHECK (billing_due_day BETWEEN 1 AND 31);
  ALTER TABLE companies ADD COLUMN IF NOT EXISTS billing_exempt BOOLEAN NOT NULL DEFAULT false;
  CREATE TABLE IF NOT EXISTS partner_referrals (
    id            BIGSERIAL PRIMARY KEY,
    company_id    BIGINT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
    referred_name TEXT NOT NULL,
    closed_on     DATE NOT NULL,
    note          TEXT,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
  );
  CREATE INDEX IF NOT EXISTS idx_partner_referrals_company ON partner_referrals (company_id, closed_on);
  CREATE TABLE IF NOT EXISTS partner_reminders (
    id           BIGSERIAL PRIMARY KEY,
    company_id   BIGINT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
    month        DATE NOT NULL,
    discount_pct INT NOT NULL,
    due_on       DATE NOT NULL,
    message_id   BIGINT,
    told_pct     INT,                       -- percentual que o administrador já recebeu por mensagem entregue (NULL = nada entregue ainda)
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (company_id, month)
  );
  ALTER TABLE partner_reminders ADD COLUMN IF NOT EXISTS told_pct INT;`;

// ---------- datas (sempre texto AAAA-MM-DD, sem fuso) ----------
const hojeSP = () => new Date().toLocaleDateString('en-CA', { timeZone: TZ });
const pad = (n) => String(n).padStart(2, '0');
const ultimoDia = (y, m) => new Date(Date.UTC(y, m, 0)).getUTCDate();       // m = 1..12
const vencimento = (y, m, dia) => `${y}-${pad(m)}-${pad(Math.min(dia, ultimoDia(y, m)))}`;
const mesSeguinte = ({ y, m }) => (m === 12 ? { y: y + 1, m: 1 } : { y, m: m + 1 });
const chaveMes = ({ y, m }) => `${y}-${pad(m)}-01`;
const somaDias = (iso, n) => { const d = new Date(iso + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
const br = (iso) => iso.split('-').reverse().slice(0, 2).join('/');

// Agenda de descontos: cada indicação vale PCT_POR_INDICACAO a partir da primeira mensalidade que vence DEPOIS do dia em que foi
// marcada; cada mês aceita no máximo MAX_POR_MES indicações, e as que não cabem vão para o mês seguinte.
export function agendaDescontos(referrals, dueDay) {
  if (!dueDay) return [];
  const meses = new Map();
  const ordem = [...referrals].sort((a, b) => String(a.closed_on).localeCompare(String(b.closed_on)) || Number(a.id) - Number(b.id));
  for (const r of ordem) {
    const [y, m] = String(r.closed_on).slice(0, 10).split('-').map(Number);
    let mes = { y, m };
    while (vencimento(mes.y, mes.m, dueDay) <= String(r.closed_on).slice(0, 10)) mes = mesSeguinte(mes);
    while ((meses.get(chaveMes(mes))?.names.length || 0) >= MAX_POR_MES) mes = mesSeguinte(mes);
    const k = chaveMes(mes);
    if (!meses.has(k)) meses.set(k, { month: k, due_on: vencimento(mes.y, mes.m, dueDay), names: [] });
    meses.get(k).names.push(r.referred_name);
  }
  return [...meses.values()].sort((a, b) => a.month.localeCompare(b.month))
    .map((x) => ({ month: x.month, due_on: x.due_on, pct: x.names.length * PCT_POR_INDICACAO, referrals: x.names }));
}

// ---------- ligação com a tabela de mensagens agendadas ----------
let poolMsg = null;
const msgPool = () => {
  if (!process.env.N8N_DATABASE_URL) return null;
  return (poolMsg ||= new pg.Pool({ connectionString: process.env.N8N_DATABASE_URL, max: 2 }));
};
export const lembretesLigados = () => !!process.env.N8N_DATABASE_URL;

async function configAvisos() {
  const v = (await qg("SELECT value FROM platform_settings WHERE key='benefit_notices'")).rows[0]?.value || {};
  return { phone: v.phone || '', instance: v.instance || '' };
}

// Os avisos para o administrador nunca saem juntos: entre um e outro há pelo menos INTERVALO_MIN minutos
const INTERVALO_MIN = 10;
async function agendarMsg(cfg, nome, texto, quando) {
  let t = new Date(quando);
  for (let i = 0; i < 500; i++) {
    const { rows: [x] } = await msgPool().query(
      `SELECT max(data_hora_envio) AS ultimo FROM agendamentos_mensagens
       WHERE origem='indicacao_m2' AND data_hora_envio > $1::timestamptz - make_interval(mins => $2) AND data_hora_envio < $1::timestamptz + make_interval(mins => $2)`,
      [t, INTERVALO_MIN]);
    if (!x.ultimo) break;
    t = new Date(new Date(x.ultimo).getTime() + INTERVALO_MIN * 60000);
  }
  quando = t;
  const { rows } = await msgPool().query(
    `INSERT INTO agendamentos_mensagens (telefone, mensagem, data_hora_envio, instancia, nome, origem)
     VALUES ($1,$2,$3,$4,$5,'indicacao_m2') RETURNING id`, [cfg.phone, texto, quando, cfg.instance, nome]);
  return rows[0].id;
}
const apagarPendente = async (id) =>
  (await msgPool().query("DELETE FROM agendamentos_mensagens WHERE id=$1 AND status='pendente' RETURNING id", [id])).rowCount > 0;

const quandoLembrar = (dueOn) => {
  const alvo = new Date(`${somaDias(dueOn, -1)}T${HORA_LEMBRETE}-03:00`);
  const minimo = new Date(Date.now() + 2 * 60000);
  return alvo > minimo ? alvo : minimo;
};
const textoLembrete = (empresa, e) =>
  `Lembrete de desconto: aplicar ${e.pct}% na mensalidade de ${empresa}, que vence em ${br(e.due_on)}.` +
  (e.referrals?.length ? ` Indicações: ${e.referrals.join(', ')}.` : '');

// Põe os lembretes em dia para uma empresa: cria os que faltam, troca os que mudaram e avisa se algum já enviado mudou.
export async function sincronizarLembretes(companyId) {
  if (!lembretesLigados()) return { skipped: 'desligado' };
  const cfg = await configAvisos();
  const c = (await qg('SELECT id, name, billing_due_day, billing_exempt FROM companies WHERE id=$1', [companyId])).rows[0];
  if (!c) return { skipped: 'sem empresa' };
  if (!cfg.phone || !cfg.instance) return { skipped: 'sem destino' };
  const hoje = hojeSP();
  const limite = somaDias(hoje, HORIZONTE_DIAS + 1);
  const refs = (await qg("SELECT id, referred_name, closed_on::text AS closed_on FROM partner_referrals WHERE company_id=$1", [companyId])).rows;
  const agenda = c.billing_exempt ? [] : agendaDescontos(refs, c.billing_due_day);
  const desejado = new Map(agenda.filter((e) => e.due_on > hoje && somaDias(e.due_on, -1) <= limite).map((e) => [e.month, e]));
  const linhas = (await qg("SELECT id, month::text AS month, discount_pct, due_on::text AS due_on, message_id, told_pct FROM partner_reminders WHERE company_id=$1 AND due_on > $2", [companyId, hoje])).rows;
  const porMes = new Map(linhas.map((l) => [l.month, l]));
  let feitos = 0;
  for (const mes of new Set([...desejado.keys(), ...porMes.keys()])) {
    const want = desejado.get(mes);
    const pct = want?.pct ?? 0;
    const row = porMes.get(mes);
    if (!row && !want) continue;
    if (row && row.discount_pct === pct) continue;
    if (!row) {
      const id = await agendarMsg(cfg, c.name, textoLembrete(c.name, want), quandoLembrar(want.due_on));
      await qg('INSERT INTO partner_reminders (company_id, month, discount_pct, due_on, message_id) VALUES ($1,$2,$3,$4,$5)', [companyId, mes, pct, want.due_on, id]);
      feitos++; continue;
    }
    // o que o administrador já recebeu: se a mensagem pendente ainda não saiu, vale o que já tinha sido entregue antes dela
    const pendente = row.message_id ? await apagarPendente(row.message_id) : false;
    const told = pendente ? row.told_pct : row.discount_pct;
    const dueOn = want?.due_on || row.due_on;
    if (told === null || told === undefined) {
      // nada foi entregue ainda: é só trocar o lembrete (ou tirar, se não vale mais)
      if (!want) { await qg('DELETE FROM partner_reminders WHERE id=$1', [row.id]); feitos++; continue; }
      const id = await agendarMsg(cfg, c.name, textoLembrete(c.name, want), quandoLembrar(want.due_on));
      await qg('UPDATE partner_reminders SET discount_pct=$2, due_on=$3, message_id=$4, told_pct=NULL WHERE id=$1', [row.id, pct, want.due_on, id]);
    } else if (told === pct) {
      await qg('UPDATE partner_reminders SET discount_pct=$2, due_on=$3, message_id=NULL, told_pct=$4 WHERE id=$1', [row.id, pct, dueOn, told]);
    } else {
      const texto = want
        ? `Atualização: o desconto de ${c.name} para o vencimento de ${br(dueOn)} agora é ${pct}% (antes ${told}%).`
        : `Atualização: não aplicar desconto na mensalidade de ${c.name} (vencimento ${br(dueOn)}); a indicação foi removida.`;
      const id = await agendarMsg(cfg, c.name, texto, new Date(Date.now() + 2 * 60000));
      await qg('UPDATE partner_reminders SET discount_pct=$2, due_on=$3, message_id=$4, told_pct=$5 WHERE id=$1', [row.id, pct, dueOn, id, told]);
    }
    feitos++;
  }
  return { feitos };
}

export async function sincronizarTodas() {
  if (!lembretesLigados()) return;
  const { rows } = await qg('SELECT DISTINCT company_id FROM partner_referrals');
  for (const { company_id } of rows) {
    try { await sincronizarLembretes(company_id); } catch (e) { console.error('indicações:', e.message); }
  }
}

// ---------- visão de uma empresa ----------
async function visao(companyId) {
  const c = (await qg('SELECT id, name, billing_due_day, billing_exempt FROM companies WHERE id=$1', [companyId])).rows[0];
  if (!c) return null;
  const referrals = (await qg('SELECT id::text AS id, referred_name, closed_on::text AS closed_on, note FROM partner_referrals WHERE company_id=$1 ORDER BY closed_on DESC, id DESC', [companyId])).rows;
  const hoje = hojeSP();
  const agenda = c.billing_exempt ? [] : agendaDescontos(referrals, c.billing_due_day);
  const futuros = agenda.filter((e) => e.due_on > hoje);
  const mesAtual = hoje.slice(0, 7) + '-01';
  return {
    company: { id: String(c.id), name: c.name, billing_due_day: c.billing_due_day, billing_exempt: c.billing_exempt },
    referrals, schedule: agenda.filter((e) => e.month >= mesAtual),
    next: futuros[0] || null, total: referrals.length, reminders: lembretesLigados(),
    rules: { pct_each: PCT_POR_INDICACAO, max_per_month: MAX_POR_MES },
  };
}

const nomeOk = (v) => { const s = String(v ?? '').trim(); return s && s.length <= 120 && !/[\u0000-\u001f<>]/.test(s) ? s : null; };
const dataOk = (v) => /^\d{4}-\d{2}-\d{2}$/.test(String(v || '')) && !isNaN(new Date(v + 'T00:00:00Z')) ? String(v) : null;
const idOk = (v) => (/^\d+$/.test(String(v ?? '')) ? String(v) : null);

// Rotas do administrador (Administração)
export function registerIndicacoesAdmin(app, requireUser, requireAdmin) {
  const A = [requireUser, requireAdmin];
  const seguro = (fn) => async (req, res) => { try { await fn(req, res); } catch (e) { console.error('indicações:', e.message); res.status(500).json({ error: 'Erro interno' }); } };

  app.get('/api/admin/benefits', ...A, seguro(async (req, res) => {
    const cfg = await configAvisos();
    res.json({ notice_phone: cfg.phone, notice_instance: cfg.instance, reminders: lembretesLigados() });
  }));
  app.put('/api/admin/benefits', ...A, seguro(async (req, res) => {
    const phone = req.body.notice_phone ? normPhone(req.body.notice_phone) : '';
    if (req.body.notice_phone && (!phone || phone.length < 12)) return res.status(400).json({ error: 'Telefone inválido (use DDD + número)' });
    const inst = String(req.body.notice_instance ?? '').trim();
    if (inst.length > 60 || /[\u0000-\u001f<>]/.test(inst)) return res.status(400).json({ error: 'Nome da instância inválido' });
    await qg(`INSERT INTO platform_settings (key, value) VALUES ('benefit_notices', $1::jsonb)
              ON CONFLICT (key) DO UPDATE SET value=EXCLUDED.value, updated_at=now()`, [JSON.stringify({ phone, instance: inst })]);
    await sincronizarTodas();
    res.json({ notice_phone: phone, notice_instance: inst, reminders: lembretesLigados() });
  }));

  app.put('/api/admin/companies/:id/billing', ...A, seguro(async (req, res) => {
    const id = idOk(req.params.id);
    if (!id) return res.status(404).json({ error: 'Empresa não encontrada' });
    const b = req.body || {};
    let dia = b.billing_due_day === '' || b.billing_due_day === null || b.billing_due_day === undefined ? null : Number(b.billing_due_day);
    if (dia !== null && (!Number.isInteger(dia) || dia < 1 || dia > 31)) return res.status(400).json({ error: 'O dia do vencimento vai de 1 a 31' });
    const isento = b.billing_exempt === true;
    const { rowCount } = await qg('UPDATE companies SET billing_due_day=$2, billing_exempt=$3 WHERE id=$1', [id, isento ? null : dia, isento]);
    if (!rowCount) return res.status(404).json({ error: 'Empresa não encontrada' });
    await sincronizarLembretes(id);
    res.json(await visao(id));
  }));

  app.get('/api/admin/companies/:id/referrals', ...A, seguro(async (req, res) => {
    const v = idOk(req.params.id) && await visao(req.params.id);
    v ? res.json(v) : res.status(404).json({ error: 'Empresa não encontrada' });
  }));
  app.post('/api/admin/companies/:id/referrals', ...A, seguro(async (req, res) => {
    const id = idOk(req.params.id);
    if (!id || !(await qg('SELECT 1 FROM companies WHERE id=$1', [id])).rowCount) return res.status(404).json({ error: 'Empresa não encontrada' });
    const nome = nomeOk(req.body.referred_name);
    if (!nome) return res.status(400).json({ error: 'Informe o nome de quem foi indicado' });
    const dia = req.body.closed_on ? dataOk(req.body.closed_on) : hojeSP();
    if (!dia) return res.status(400).json({ error: 'Data inválida (use AAAA-MM-DD)' });
    await qg('INSERT INTO partner_referrals (company_id, referred_name, closed_on, note) VALUES ($1,$2,$3,$4)', [id, nome, dia, String(req.body.note ?? '').trim().slice(0, 300) || null]);
    await sincronizarLembretes(id);
    res.status(201).json(await visao(id));
  }));
  app.delete('/api/admin/referrals/:id', ...A, seguro(async (req, res) => {
    const rid = idOk(req.params.id);
    const row = rid && (await qg('DELETE FROM partner_referrals WHERE id=$1 RETURNING company_id', [rid])).rows[0];
    if (!row) return res.status(404).json({ error: 'Indicação não encontrada' });
    await sincronizarLembretes(row.company_id);
    res.json(await visao(row.company_id));
  }));
}

// Rota da empresa: só enxerga o próprio saldo (somente leitura)
export function registerBeneficiosCliente(r, wrap) {
  r.get('/benefits', wrap(async (req, res) => {
    const v = await visao(currentCompany());
    if (!v) return res.status(404).json({ error: 'Empresa não encontrada' });
    const { reminders, ...resto } = v;
    res.json(resto);
  }));
}
