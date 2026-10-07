// Lembrete de agendamento ao cliente, enviado pelo próprio painel (WhatsApp da empresa, configurado na Administração).
// Cada lembrete é um registro (appointment_reminders): fica "agendado" até a hora, vira "enviado" (com o texto exato) ou "não enviado".
// Regras: um aviso por agendamento, na antecedência de Configurações (companies.reminder_minutes; vazio = desligado);
// só agendamentos confirmados; não avisa quem acabou de marcar. Toda mensagem enviada entra no histórico da conversa do atendente.
import { qg, q, tx, runAs } from './db.js';
import { conexaoWhats } from './lista_evento.js';
import { gravarNaConversa } from './campaigns.js';
import { podeVerTelefone } from './funcoes.js';

export const TEXTO_PADRAO = 'Olá, {nome}! Passando para lembrar do seu horário de {servico} {dia} às {hora}{com} na {empresa}. Se não puder comparecer, é só avisar por aqui.';
const TEXTO_MAX = 800;
const TOLERANCIA_MIN = 30;      // passou mais que isso da hora de avisar: não envia mais
const MINIMO_ANTES_MIN = 15;    // faltando menos que isso para o horário: não envia mais
const TENTATIVAS = 3;

const diaDe = (inicio, tz) => {
  const f = (d) => new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);
  const hoje = f(new Date()), amanha = f(new Date(Date.now() + 86400000)), dia = f(inicio);
  if (dia === hoje) return 'hoje';
  if (dia === amanha) return 'amanhã';
  return 'dia ' + new Intl.DateTimeFormat('pt-BR', { timeZone: tz, day: '2-digit', month: '2-digit' }).format(inicio);
};
export function montarTexto(modelo, a, empresa) {
  const inicio = new Date(a.starts_at), tz = empresa.timezone || 'America/Sao_Paulo';
  const hora = new Intl.DateTimeFormat('pt-BR', { timeZone: tz, hour: '2-digit', minute: '2-digit' }).format(inicio).replace(':', 'h');
  const primeiro = String(a.customer_name || '').trim().split(/\s+/)[0] || 'tudo bem';
  const valores = {
    nome: primeiro, servico: a.service_name || 'atendimento', dia: diaDe(inicio, tz), hora,
    profissional: a.professional_name || '', com: a.professional_name && !a.professional_default ? ` com ${a.professional_name}` : '',
    empresa: empresa.name,
  };
  return String(modelo || TEXTO_PADRAO).replace(/\{(\w+)\}/g, (m, k) => (k in valores ? valores[k] : m)).replace(/\s+([.,!?])/g, '$1');
}

const empresaDe = async (companyId) => (await qg('SELECT name, timezone, reminder_minutes, reminder_text, modules, scheduling_enabled FROM companies WHERE id=$1', [companyId])).rows[0];
const ativo = (emp) => !!emp?.reminder_minutes && emp.scheduling_enabled !== false && emp.modules?.agenda !== false;

// Mantém a lista em dia com a agenda: cria o lembrete de cada agendamento que se aproxima, cancela os de quem desmarcou.
export async function sincronizar(companyId) {
  const emp = await empresaDe(companyId);
  await tx(companyId, async (t) => {
    // o histórico fica 30 dias depois do horário do agendamento e então é apagado
    await t("DELETE FROM appointment_reminders WHERE status NOT IN ('scheduled','sending') AND starts_at < now() - interval '30 days'");
    if (!ativo(emp)) { await t("DELETE FROM appointment_reminders WHERE status='scheduled'"); return; }
    const N = emp.reminder_minutes;
    await t("UPDATE appointment_reminders SET status='scheduled', claimed_at=NULL WHERE status='sending' AND claimed_at < now() - interval '10 minutes'");
    await t(`INSERT INTO appointment_reminders (appointment_id, customer_id, customer_name, phone, chat_id, service_name, professional_name, professional_default, starts_at, send_at, status, note)
      SELECT a.id, a.customer_id, btrim(concat_ws(' ', c.name, c.last_name)), c.phone, c.chat_id, s.name, b.name, COALESCE(b.is_default,false), a.starts_at,
             a.starts_at - make_interval(mins => $1),
             CASE WHEN a.created_at > a.starts_at - make_interval(mins => $2) THEN 'skipped' ELSE 'scheduled' END,
             CASE WHEN a.created_at > a.starts_at - make_interval(mins => $2) THEN 'Marcado em cima da hora: sem lembrete' END
      FROM appointments a JOIN customers c ON c.id=a.customer_id LEFT JOIN services s ON s.id=a.service_id LEFT JOIN professionals b ON b.id=a.professional_id
      WHERE a.status='scheduled' AND a.reminder_sent_at IS NULL AND a.starts_at > now() AND a.starts_at <= now() + interval '7 days'
        AND NOT EXISTS (SELECT 1 FROM appointment_reminders r WHERE r.appointment_id=a.id)`, [N, N + 60]);
    await t(`UPDATE appointment_reminders r SET send_at = r.starts_at - make_interval(mins => $1) WHERE r.status='scheduled'`, [N]);
    await t(`UPDATE appointment_reminders r SET status='cancelled', note='Agendamento cancelado ou apagado'
             WHERE r.status='scheduled' AND NOT EXISTS (SELECT 1 FROM appointments a WHERE a.id=r.appointment_id AND a.status='scheduled')`);
    await t(`UPDATE appointment_reminders r SET status='skipped', note='O cliente já foi avisado por outro caminho'
             WHERE r.status='scheduled' AND EXISTS (SELECT 1 FROM appointments a WHERE a.id=r.appointment_id AND a.reminder_sent_at IS NOT NULL)`);
    await t(`UPDATE appointment_reminders SET status='skipped', note='Passou da hora de avisar'
             WHERE status='scheduled' AND (send_at < now() - make_interval(mins => $1) OR starts_at <= now() + make_interval(mins => $2))`, [TOLERANCIA_MIN, MINIMO_ANTES_MIN]);
  });
}

// Envia um lembrete (já reservado). Devolve { ok, erro }.
async function enviarUm(companyId, r, emp, con, { forcar = false } = {}) {
  const texto = montarTexto(r.text || emp.reminder_text, r, emp);
  const marcar = async (campos, params = []) => tx(companyId, async (t) => t(`UPDATE appointment_reminders SET ${campos} WHERE id=$${params.length + 1}`, [...params, r.id]));
  if (!r.phone) { await marcar("status='skipped', note='Cliente sem telefone'"); return { ok: false, erro: 'Cliente sem telefone' }; }
  // evita o aviso em dobro com quem ainda use o caminho antigo (reserva pela rota de lembretes)
  if (r.appointment_id && !forcar) {
    const lock = await tx(companyId, async (t) => t('UPDATE appointments SET reminder_sent_at=now() WHERE id=$1 AND reminder_sent_at IS NULL', [r.appointment_id]));
    if (!lock.rowCount) { await marcar("status='skipped', note='O cliente já foi avisado por outro caminho'"); return { ok: false, erro: 'Já avisado' }; }
  }
  const falhou = async (erro) => {
    if (r.appointment_id && !forcar) await tx(companyId, async (t) => t('UPDATE appointments SET reminder_sent_at=NULL WHERE id=$1', [r.appointment_id]));
    const tries = (r.tries || 0) + 1;
    if (tries < TENTATIVAS) await marcar("status='scheduled', claimed_at=NULL, tries=$1, note=$2", [tries, erro]);
    else await marcar("status='failed', tries=$1, note=$2", [tries, erro]);
    return { ok: false, erro };
  };
  try {
    const resp = await fetch(con.base + '/send/text', {
      method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json', token: con.token },
      body: JSON.stringify({ number: r.phone, text: texto, readchat: true, delay: 3000 }), signal: AbortSignal.timeout(30000),
    });
    if (!resp.ok) { console.error(`lembretes: empresa ${companyId}, WhatsApp respondeu ${resp.status}`); return falhou(`O WhatsApp respondeu ${resp.status}`); }
    const corpo = await resp.json().catch(() => null);
    const memoria = await gravarNaConversa(companyId, { phone: r.phone, chat_id: r.chat_id, text: texto }, corpo);
    await marcar("status='sent', sent_text=$1, sent_at=now(), note=NULL, memory_saved=$2, tries=tries+1", [texto, !!memoria]);
    if (r.appointment_id) await tx(companyId, async (t) => t('UPDATE appointments SET reminder_sent_at=COALESCE(reminder_sent_at, now()) WHERE id=$1', [r.appointment_id]));
    return { ok: true };
  } catch (e) {
    console.error(`lembretes: empresa ${companyId}:`, e.message);
    return falhou(e?.name === 'TimeoutError' ? 'O WhatsApp não respondeu a tempo' : 'Não foi possível falar com o WhatsApp');
  }
}

export async function enviarLembretes(companyId) {
  const emp = await empresaDe(companyId);
  if (!ativo(emp)) return 0;
  await sincronizar(companyId);
  const con = await conexaoWhats(companyId);
  if (!con) return 0;
  const lista = await tx(companyId, async (t) => (await t(
    `UPDATE appointment_reminders SET status='sending', claimed_at=now()
     WHERE id IN (SELECT id FROM appointment_reminders WHERE status='scheduled' AND send_at <= now() ORDER BY send_at LIMIT 10 FOR UPDATE SKIP LOCKED)
     RETURNING *`)).rows);
  let enviados = 0;
  for (const r of lista) {
    if ((await enviarUm(companyId, r, emp, con)).ok) enviados++;
    await new Promise((ok) => setTimeout(ok, process.env.LISTA_PAUSA_RAPIDA ? 5 : 4000));   // intervalo entre envios
  }
  return enviados;
}

let rodando = false;
export function startLembretes() {
  const passo = async () => {
    if (rodando) return;
    rodando = true;
    try {
      const { rows } = await qg('SELECT id FROM companies WHERE reminder_minutes IS NOT NULL AND wa_api_url IS NOT NULL AND wa_api_token IS NOT NULL ORDER BY id');
      for (const e of rows) await runAs(e.id, () => enviarLembretes(e.id)).catch((x) => console.error('lembretes:', x.message));
    } catch (x) { console.error('lembretes:', x.message); }
    finally { rodando = false; }
  };
  setInterval(passo, Number(process.env.LEMBRETE_TICK_MS) || 60000).unref();
  console.log('Lembretes de agendamento: painel confere a cada minuto');
}

// ---------- rotas do painel ----------
export function registerLembretesRoutes(r, wrap) {
  const idsDe = (b) => (Array.isArray(b?.ids) ? [...new Set(b.ids.map(String).filter((x) => /^\d+$/.test(x)))].slice(0, 5000) : []);
  r.get('/reminders', wrap(async (req, res) => {
    const id = req.user.companyId;
    const emp = await empresaDe(id);
    if (ativo(emp)) await sincronizar(id);
    const ver = await podeVerTelefone(req.user);
    const dados = (await q(`SELECT id, appointment_id, customer_name, phone, service_name, professional_name, professional_default, starts_at, send_at, text, status, tries, sent_text, sent_at, note, memory_saved
                            FROM appointment_reminders ORDER BY CASE WHEN status IN ('scheduled','sending') THEN send_at END ASC NULLS LAST, COALESCE(sent_at, send_at) DESC LIMIT 600`)).rows;
    const mostra = (x) => ({ ...x, phone: ver ? x.phone : null,
      preview: ['scheduled', 'sending'].includes(x.status) ? montarTexto(x.text || emp.reminder_text, x, emp) : null, custom: !!x.text });
    res.json({
      enabled: ativo(emp), minutes: emp.reminder_minutes || null, connected: !!(await conexaoWhats(id)),
      max: TEXTO_MAX,
      scheduled: dados.filter((x) => ['scheduled', 'sending'].includes(x.status)).map(mostra),
      history: dados.filter((x) => !['scheduled', 'sending'].includes(x.status)).map(mostra),
    });
  }));
  r.put('/reminders/:id', wrap(async (req, res) => {
    const texto = String(req.body?.text ?? '').trim();
    if (texto.length > TEXTO_MAX) return res.status(400).json({ error: `A mensagem é grande demais (até ${TEXTO_MAX} letras)` });
    const { rowCount } = await q("UPDATE appointment_reminders SET text=NULLIF($2,'') WHERE id=$1 AND status='scheduled'", [req.params.id, texto]);
    if (!rowCount) return res.status(409).json({ error: 'Este lembrete já foi enviado ou cancelado' });
    res.json({ ok: true });
  }));
  r.post('/reminders/:id/cancel', wrap(async (req, res) => {
    const { rowCount } = await q("UPDATE appointment_reminders SET status='cancelled', note='Cancelado por você' WHERE id=$1 AND status='scheduled'", [req.params.id]);
    if (!rowCount) return res.status(409).json({ error: 'Este lembrete já foi enviado ou cancelado' });
    res.json({ ok: true });
  }));
  r.post('/reminders/bulk-cancel', wrap(async (req, res) => {
    const ids = idsDe(req.body);
    if (!ids.length) return res.status(400).json({ error: 'Nenhum item selecionado' });
    const { rowCount } = await q("UPDATE appointment_reminders SET status='cancelled', note='Cancelado por você' WHERE id = ANY($1::bigint[]) AND status='scheduled'", [ids]);
    res.json({ cancelled: rowCount });
  }));
  // enviar agora (ou reenviar um que falhou)
  r.post('/reminders/:id/send', wrap(async (req, res) => {
    const id = req.user.companyId;
    const emp = await empresaDe(id);
    const con = await conexaoWhats(id);
    if (!con) return res.status(409).json({ error: 'O WhatsApp para avisos ainda não está ligado. Peça ao suporte para ligar.' });
    const r0 = (await q(`UPDATE appointment_reminders SET status='sending', claimed_at=now(), tries=0
                         WHERE id=$1 AND status IN ('scheduled','failed') RETURNING *`, [req.params.id])).rows[0];
    if (!r0) return res.status(409).json({ error: 'Este lembrete já foi enviado ou cancelado' });
    const out = await enviarUm(id, r0, emp, con, { forcar: true });
    if (!out.ok) return res.status(502).json({ error: out.erro || 'Não foi possível enviar agora' });
    res.json({ ok: true });
  }));
  // limpar o histórico (nunca apaga o que ainda vai ser enviado)
  r.post('/reminders/bulk-delete', wrap(async (req, res) => {
    const ids = idsDe(req.body);
    if (!ids.length) return res.status(400).json({ error: 'Nenhum item selecionado' });
    if (req.body.dry_run === true) return res.json({ found: (await q("SELECT count(*)::int AS n FROM appointment_reminders WHERE id = ANY($1::bigint[]) AND status NOT IN ('scheduled','sending')", [ids])).rows[0].n });
    res.json({ deleted: (await q("DELETE FROM appointment_reminders WHERE id = ANY($1::bigint[]) AND status NOT IN ('scheduled','sending')", [ids])).rowCount });
  }));
}
