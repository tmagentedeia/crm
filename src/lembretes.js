// Lembrete de agendamento ao cliente, enviado pelo próprio painel (WhatsApp da empresa, configurado na Administração).
// Regras (iguais às do antigo envio pelo fluxo): um aviso só por agendamento, na antecedência escolhida em Configurações
// (companies.reminder_minutes; vazio = desligado); só agendamentos confirmados; não avisa quem acabou de marcar.
import { qg, tx, runAs } from './db.js';
import { conexaoWhats } from './lista_evento.js';
import { gravarNaConversa } from './campaigns.js';

export const TEXTO_PADRAO = 'Olá, {nome}! Passando para lembrar do seu horário de {servico} {dia} às {hora}{com} na {empresa}. Se não puder comparecer, é só avisar por aqui.';

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

const tentativas = new Map();   // "empresa:agendamento" -> falhas seguidas
// Reserva (de forma atômica) os agendamentos da empresa que estão na janela do lembrete.
async function reservar(companyId, N, limite = 10) {
  const win = N + 5, min = Math.max(N - 30, 15), gap = N + 60;
  return tx(companyId, async (t) => (await t(
    `UPDATE appointments a SET reminder_sent_at = now()
     WHERE a.id IN (
       SELECT a2.id FROM appointments a2
       WHERE a2.status='scheduled' AND a2.reminder_sent_at IS NULL
         AND a2.starts_at > now() + make_interval(mins => $1)
         AND a2.starts_at <= now() + make_interval(mins => $2)
         AND a2.created_at <= a2.starts_at - make_interval(mins => $4)
       ORDER BY a2.starts_at LIMIT $3 FOR UPDATE SKIP LOCKED)
     RETURNING a.id, a.starts_at, a.customer_id, a.service_id, a.professional_id`, [min, win, limite, gap])).rows);
}

export async function enviarLembretes(companyId) {
  const emp = (await qg('SELECT name, timezone, reminder_minutes, reminder_text, modules, scheduling_enabled FROM companies WHERE id=$1', [companyId])).rows[0];
  if (!emp?.reminder_minutes || emp.scheduling_enabled === false || emp.modules?.agenda === false) return 0;
  const con = await conexaoWhats(companyId);
  if (!con) return 0;
  const lista = await reservar(companyId, emp.reminder_minutes);
  let enviados = 0;
  for (const r of lista) {
    const d = await tx(companyId, async (t) => (await t(
      `SELECT c.name AS customer_name, c.phone, c.chat_id, s.name AS service_name, b.name AS professional_name, b.is_default AS professional_default
       FROM customers c LEFT JOIN services s ON s.id=$2 LEFT JOIN professionals b ON b.id=$3 WHERE c.id=$1`, [r.customer_id, r.service_id, r.professional_id])).rows[0]);
    const chave = `${companyId}:${r.id}`;
    const solta = async () => {   // não foi enviado: volta para a fila (até 3 tentativas) em vez de ficar sem aviso
      const n = (tentativas.get(chave) || 0) + 1; tentativas.set(chave, n);
      if (n < 3) await tx(companyId, async (t) => t('UPDATE appointments SET reminder_sent_at=NULL WHERE id=$1', [r.id]));
    };
    if (!d?.phone) continue;   // cliente sem telefone: nada a enviar
    const texto = montarTexto(emp.reminder_text, { ...d, starts_at: r.starts_at }, emp);
    try {
      const resp = await fetch(con.base + '/send/text', {
        method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json', token: con.token },
        body: JSON.stringify({ number: d.phone, text: texto, readchat: true, delay: 3000 }), signal: AbortSignal.timeout(30000),
      });
      if (!resp.ok) { console.error(`lembretes: empresa ${companyId}, WhatsApp respondeu ${resp.status}`); await solta(); continue; }
      const corpo = await resp.json().catch(() => null);
      enviados++; tentativas.delete(chave);
      await gravarNaConversa(companyId, { phone: d.phone, chat_id: d.chat_id, text: texto }, corpo);
    } catch (e) { console.error(`lembretes: empresa ${companyId}:`, e.message); await solta(); }
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
