// Campanhas: envio em lote com ritmo controlado. Todas as regras de segurança valem aqui no servidor,
// independentemente do que a tela mostrar.
import { conexaoWhats } from './lista_evento.js';
import { poolDaEmpresa, nomeTabelaValido } from './conversas.js';
import { decifrar } from './segredo.js';
import { testarRedis } from './blocks.js';
import { q, qg, tx, currentCompany } from './db.js';
import { normPhone } from './phone.js';

export const LIMITS = {
  INTERVAL_MIN: 10,       // menor intervalo permitido entre mensagens (minutos)
  INTERVAL_MAX_MIN: 10,   // o máximo escolhido nunca pode ser menor que isto
  BATCH_MAX: 30,          // envios seguidos antes de parar
  BATCH_PAUSE_MIN: 60,    // pausa mínima depois de cada lote (minutos)
  DAILY_MAX: 100,
  START_HOUR: 7,          // janela de envio: das 7h às 22h (horário da empresa)
  END_HOUR: 22,
  FAIL_PAUSE: 3,          // falhas seguidas que pausam a campanha
  VARIANTS: 3,
  GREETINGS_MIN: 3,       // saudações (Oi, Ei, Olá...) no mínimo
  COMPLIMENTS_MIN: 20,    // cumprimentos (Como vai?...) no mínimo
  SAVED_MAX: 10,          // campanhas guardadas por empresa
};

// O administrador da plataforma pode ajustar, por empresa, o limite diário e o intervalo mínimo (null = padrão acima).
export const TETO_ADMIN = { DAILY_MAX: 1000, INTERVAL_MIN: 120 };
// Liberação progressiva: empresas que ligaram o módulo Campanhas começam apertado e soltam a cada 2 campanhas manuais concluídas.
export const DEGRAUS = [
  { INTERVAL_MIN: 15, DAILY_MAX: 50 }, { INTERVAL_MIN: 14, DAILY_MAX: 60 }, { INTERVAL_MIN: 13, DAILY_MAX: 70 },
  { INTERVAL_MIN: 12, DAILY_MAX: 80 }, { INTERVAL_MIN: 11, DAILY_MAX: 90 }, { INTERVAL_MIN: 10, DAILY_MAX: 100 },
];
export const CAMPANHAS_POR_DEGRAU = 2;
export async function progressoDaEmpresa(companyId, desde) {
  if (!desde) return null;
  const concluidas = (await tx(companyId, (t) => t(
    "SELECT COUNT(*)::int AS n FROM campaigns WHERE kind='manual' AND status='done' AND finished_at >= $1", [desde]))).rows[0].n;
  const degrau = Math.min(DEGRAUS.length - 1, Math.floor(concluidas / CAMPANHAS_POR_DEGRAU));
  const ultimo = degrau === DEGRAUS.length - 1;
  return { concluidas, degrau: degrau + 1, degraus: DEGRAUS.length, atual: DEGRAUS[degrau], proximo: ultimo ? null : DEGRAUS[degrau + 1],
           faltam: ultimo ? 0 : CAMPANHAS_POR_DEGRAU - (concluidas % CAMPANHAS_POR_DEGRAU) };
}
export async function limitesDaEmpresa(companyId) {
  const c = (await qg('SELECT campaign_daily_max, campaign_interval_min, campaign_prog_desde FROM companies WHERE id=$1', [companyId])).rows[0] || {};
  const manual = c.campaign_daily_max != null || c.campaign_interval_min != null;
  // valor definido pelo administrador manda; sem ele, vale o degrau da liberação progressiva (se a empresa tem)
  const prog = manual ? null : await progressoDaEmpresa(companyId, c.campaign_prog_desde);
  const INTERVAL_MIN = c.campaign_interval_min ?? prog?.atual.INTERVAL_MIN ?? LIMITS.INTERVAL_MIN;
  const DAILY_MAX = c.campaign_daily_max ?? prog?.atual.DAILY_MAX ?? LIMITS.DAILY_MAX;
  return { ...LIMITS, DAILY_MAX, INTERVAL_MIN, INTERVAL_MAX_MIN: Math.max(LIMITS.INTERVAL_MAX_MIN, INTERVAL_MIN), personalizado: manual, progressivo: !!prog };
}

// A frase de saída precisa existir e a mensagem termina com "tá?", "ok?" ou "tudo bem?"
// (pergunta, para a atendente responder se o contato voltar a escrever).
const OPT_OUT_END = /(t[áa]|ok|tudo bem)\s*\?\s*$/i;
const LINK = /(https?:\/\/|www\.|\b[a-z0-9-]+\.(com|net|org|io|me|app)(\.br)?\b)/i;
export const DEFAULT_GREETINGS = ['Oi', 'Ei', 'Olá'];
export const DEFAULT_COMPLIMENTS = [
  'Como vai?', 'Como vai você?', 'Como vai seu dia?', 'Como vai por aí?', 'Que bom falar com você!',
  'Prazer falar com você!', 'Tudo certo por aí?', 'Beleza?', 'Tudo bom?', 'Tudo bom com você?',
  'Tudo bom por aí?', 'Como vai, tudo bem?', 'Tudo certo?', 'Tudo certinho?', 'Bom falar com você!',
  'Como você está?', 'Como você anda?', 'Como vão as coisas?', 'Como vão as coisas por aí?',
  'Como está por aí?', 'Como andam as coisas?', 'Espero que esteja bem!', 'Tudo beleza?',
  'Como estão as coisas por aí?', 'Tudo tranquilo por aí?', 'Como vai a vida?',
  'Espero que esteja tendo um ótimo dia!', 'Tudo bem com você?', 'Como você está hoje?',
  'Como estão as coisas?', 'Tudo em ordem por aí?', 'Como estão indo as coisas?',
  'Espero encontrar você bem!', 'Espero que esteja tudo ótimo!', 'Que bom falar com você hoje!',
];

// Valida e limpa uma lista de frases. Devolve { list } ou { error }.
export function cleanPhrases(input, min, rotulo) {
  if (!Array.isArray(input)) return { error: `Lista de ${rotulo} inválida` };
  const seen = new Set(), list = [];
  for (const raw of input) {
    const t = String(raw ?? '').trim().replace(/\s+/g, ' ');
    if (!t) continue;
    if (t.length > 120 || /[\u0000-\u001f<>]/.test(t)) return { error: `Há uma frase inválida nos ${rotulo}` };
    if (seen.has(t.toLowerCase())) continue;
    seen.add(t.toLowerCase()); list.push(t);
  }
  if (list.length < min) return { error: `Mantenha pelo menos ${min} ${rotulo}` };
  return { list };
}

// Rodízio sem repetir: sorteia do "saco" e só o reabastece quando acaba. Devolve { item, bag }.
export function takeFromBag(bag, list) {
  let b = Array.isArray(bag) ? bag.filter((x) => list.includes(x)) : [];
  if (!b.length) b = [...list];
  const i = Math.floor(Math.random() * b.length);
  const item = b[i];
  b.splice(i, 1);
  return { item, bag: b };
}

export const hasLink = (messages) => (messages || []).some((m) => LINK.test(String(m || '')));

// Devolve texto de erro (em português simples) ou null se estiver tudo certo.
export function validateConfig(c, L = LIMITS) {
  const n = (v) => Number.isInteger(v);
  if (!c.name || !String(c.name).trim()) return 'Dê um nome para a campanha';
  if (!Array.isArray(c.messages) || c.messages.length !== LIMITS.VARIANTS
      || c.messages.some((m) => !String(m || '').trim()))
    return `Escreva a mensagem e mais ${LIMITS.VARIANTS - 1} variações`;
  if (c.messages.some((m) => !OPT_OUT_END.test(String(m).trim())))
    return 'Cada versão da mensagem deve terminar com a frase de saída em forma de pergunta (por exemplo: "Se não quiser mais receber, é só avisar, tá?")';
  if (!n(c.interval_min) || c.interval_min < L.INTERVAL_MIN)
    return `O intervalo mínimo entre mensagens é de ${L.INTERVAL_MIN} minutos`;
  if (!n(c.interval_max) || c.interval_max < L.INTERVAL_MAX_MIN)
    return `O intervalo máximo precisa ser de pelo menos ${L.INTERVAL_MAX_MIN} minutos`;
  if (c.interval_max < c.interval_min) return 'O intervalo máximo não pode ser menor que o mínimo';
  if (!n(c.batch_size) || c.batch_size < 1 || c.batch_size > LIMITS.BATCH_MAX)
    return `Cada lote pode ter de 1 a ${LIMITS.BATCH_MAX} envios seguidos`;
  if (!n(c.batch_pause_min) || c.batch_pause_min < LIMITS.BATCH_PAUSE_MIN)
    return `A pausa entre lotes é de pelo menos ${LIMITS.BATCH_PAUSE_MIN} minutos`;
  if (!n(c.daily_limit) || c.daily_limit < 1 || c.daily_limit > L.DAILY_MAX)
    return `O limite por dia vai de 1 a ${L.DAILY_MAX} envios`;
  return null;
}

// Previsão de ritmo (usa a média dos intervalos). Devolve envios por dia e dias necessários.
export function simulate(c, total) {
  const avg = (c.interval_min + c.interval_max) / 2;
  const window = (LIMITS.END_HOUR - LIMITS.START_HOUR) * 60;
  let t = 0, sent = 0, inBatch = 0;
  while (sent < c.daily_limit) {
    t += avg;
    if (t > window) break;
    sent++; inBatch++;
    if (inBatch >= c.batch_size) { inBatch = 0; t += c.batch_pause_min; }
  }
  const perDay = Math.max(sent, 0);
  const t0 = Number(total) || 0;
  return { per_day: perDay, days: perDay ? Math.ceil(t0 / perDay) : null,
           per_hour: Math.round((60 / avg) * 10) / 10 };
}

const rand = (a, b) => a + Math.random() * (b - a);
const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];
const firstName = (s) => String(s || '').trim().split(/\s+/)[0] || '';

// Saudação + nome (se houver) + cumprimento + texto da campanha (que já traz a frase de saída).
export function buildText(campaign, name, greeting, compliment, variantIndex = 0) {
  const body = campaign.messages[variantIndex % campaign.messages.length]
    .replaceAll('{nome}', firstName(name)).replace(/\s+([,!?.])/g, '$1').trim();
  const nome = firstName(name);
  return `${greeting}${nome ? ' ' + nome : ''}! ${compliment} ${body}`;
}
const fmtCache = new Map();
const hourOf = (tz, d = new Date()) => {
  if (!fmtCache.has(tz)) fmtCache.set(tz, new Intl.DateTimeFormat('en-GB', { hour: '2-digit', hour12: false, timeZone: tz }));
  return Number(fmtCache.get(tz).format(d)) % 24;
};
const dayOf = (tz, d) => d.toLocaleDateString('en-CA', { timeZone: tz });
export const inWindow = (tz, d) => { const h = hourOf(tz, d); return h >= LIMITS.START_HOUR && h < LIMITS.END_HOUR; };

const toCampaign = (c) => ({ ...c, messages: c.messages || [] });

// Quando sai o próximo envio de uma campanha em andamento, já considerando a janela de envio e o limite do dia.
// motivo: 'sorteado' (horário já definido), 'fora_do_horario', 'limite_do_dia' ou null (é só esperar a próxima rodada).
export function proximoEnvio({ nextSendAt, sentToday, dailyLimit, tz, now = new Date(), semJanela = false }) {
  let t = nextSendAt && new Date(nextSendAt) > now ? new Date(nextSendAt) : now;
  const sorteado = t > now;
  let motivo = sorteado ? 'sorteado' : null;
  const andar = (cond) => { // avança de 5 em 5 minutos até a condição deixar de valer (no máximo 2 dias)
    t = new Date(Math.ceil(t.getTime() / 300000) * 300000);
    for (let i = 0; i < 576 && cond(); i++) t = new Date(t.getTime() + 300000);
  };
  if (sentToday >= dailyLimit) {
    const hoje = dayOf(tz, now);
    andar(() => dayOf(tz, t) === hoje);
    motivo = 'limite_do_dia';
  }
  if (!semJanela && !inWindow(tz, t)) { andar(() => !inWindow(tz, t)); motivo = motivo === 'limite_do_dia' ? motivo : 'fora_do_horario'; }
  return { at: motivo ? t.toISOString() : (sorteado ? t.toISOString() : null), motivo };
}

const companyCfg = async (id) => (await qg('SELECT timezone, whatsapp_instance, campaign_daily_max, campaign_interval_min FROM companies WHERE id=$1', [id])).rows[0] || {};

// Reserva o próximo envio permitido da empresa (ou devolve null). Quem decide o quê e quando é o painel.
export async function claimNext(companyId) {
  const cfg = await companyCfg(companyId);
  const tz = cfg.timezone || 'America/Sao_Paulo';
  const foraDaJanela = !inWindow(tz); // a campanha de teste é a única que envia fora do horário
  const intervaloMin = (await limitesDaEmpresa(companyId)).INTERVAL_MIN;
  const teto = Math.max(LIMITS.DAILY_MAX, cfg.campaign_daily_max ?? 0);   // campanha criada com um limite maior não é cortada
  const out = await tx(companyId, async (t) => {
    // quem ficou "enviando" sem resposta por mais de 30 min é dado como falho (nunca reenvia)
    await t(`UPDATE campaign_recipients SET status='failed', error='Sem retorno do envio'
             WHERE status='sending' AND claimed_at < now() - interval '30 minutes'`);
    const cs = (await t(
      `SELECT * FROM campaigns WHERE status='running' AND (next_send_at IS NULL OR next_send_at <= now())
       ORDER BY id FOR UPDATE SKIP LOCKED`)).rows;
    for (const c of cs) {
      if (foraDaJanela && !c.allow_excluded) continue;
      const sentToday = (await t(
        `SELECT COUNT(*)::int AS n FROM campaign_recipients WHERE sent_at IS NOT NULL
           AND (sent_at AT TIME ZONE $1)::date = (now() AT TIME ZONE $1)::date`, [tz])).rows[0].n;
      // o limite diário vale para todas as campanhas da empresa juntas
      if (sentToday >= Math.min(c.daily_limit, teto)) continue;
      // duas campanhas ativas ao mesmo tempo (a de aniversariantes roda junto com as outras) nunca enviam coladas
      const colada = (await t(`SELECT 1 FROM campaign_recipients r JOIN campaigns o ON o.id=r.campaign_id
         WHERE r.campaign_id<>$1 AND o.status='running' AND r.claimed_at > now() - make_interval(mins => $2) LIMIT 1`,
        [c.id, Math.max(LIMITS.INTERVAL_MIN, intervaloMin)])).rowCount;
      if (colada) continue;
      // quem entrou na lista de exceções depois de a campanha ser montada não recebe
      if (!c.allow_excluded) await t(`UPDATE campaign_recipients SET status='cancelled', error='Na lista de exceções'
               WHERE campaign_id=$1 AND status='pending' AND phone IN (SELECT phone FROM campaign_exclusions)`, [c.id]);
      // a ordem de envio é sorteada (não segue a ordem do cadastro)
      const rec = (await t(
        `SELECT * FROM campaign_recipients WHERE campaign_id=$1 AND status='pending'
         ORDER BY random() LIMIT 1 FOR UPDATE SKIP LOCKED`, [c.id])).rows[0];
      if (!rec) {
        const open = (await t("SELECT 1 FROM campaign_recipients WHERE campaign_id=$1 AND status='sending'", [c.id])).rowCount;
        if (!open && c.kind !== 'birthday') await t("UPDATE campaigns SET status='done', finished_at=now() WHERE id=$1", [c.id]);
        continue;
      }
      const st = (await t('SELECT * FROM campaign_settings WHERE id=1 FOR UPDATE')).rows[0] || {};
      const greetings = st.greetings || DEFAULT_GREETINGS, compliments = st.compliments || DEFAULT_COMPLIMENTS;
      const g = takeFromBag(st.greetings_bag, greetings), k = takeFromBag(st.compliments_bag, compliments);
      await t('UPDATE campaign_settings SET greetings_bag=$1, compliments_bag=$2 WHERE id=1', [JSON.stringify(g.bag), JSON.stringify(k.bag)]);
      const done = (await t("SELECT COUNT(*)::int AS n FROM campaign_recipients WHERE campaign_id=$1 AND status IN ('sent','sending','failed')", [c.id])).rows[0].n;
      const text = buildText(toCampaign(c), rec.name, g.item, k.item, done);
      await t("UPDATE campaign_recipients SET status='sending', claimed_at=now(), sent_text=$2 WHERE id=$1", [rec.id, text]);
      let gap = rand(c.interval_min, c.interval_max);
      let batch = c.batch_sent + 1;
      if (batch >= c.batch_size) { gap = Math.max(gap, c.batch_pause_min); batch = 0; }
      await t("UPDATE campaigns SET next_send_at = now() + make_interval(secs => $2), batch_sent=$3 WHERE id=$1",
        [c.id, Math.round(gap * 60), batch]);
      return { campaign_id: c.id, recipient_id: rec.id, phone: rec.phone, chat_id: rec.chat_id, name: rec.name, text, instance: cfg.whatsapp_instance || null };
    }
    return null;
  });
  return out;
}

// Registra o resultado de um envio. Falhou = marcado como falho e nunca reenviado; 3 falhas seguidas pausam a campanha.
export async function reportResult(companyId, recipientId, ok, errorText) {
  const error = ok ? null : String(errorText || 'Falha no envio').slice(0, 300);
  return tx(companyId, async (t) => {
    const rec = (await t(
      `UPDATE campaign_recipients SET status=$2, sent_at=CASE WHEN $2='sent' THEN now() ELSE sent_at END, error=$3
       WHERE id=$1 AND status='sending' RETURNING campaign_id`, [recipientId, ok ? 'sent' : 'failed', error])).rows[0];
    if (!rec) return null;
    if (ok) {
      await t('UPDATE campaigns SET consecutive_failures=0 WHERE id=$1', [rec.campaign_id]);
    } else {
      await t(`UPDATE campaigns SET consecutive_failures=consecutive_failures+1,
               status=CASE WHEN consecutive_failures+1 >= $2 AND status='running' THEN 'paused' ELSE status END,
               pause_reason=CASE WHEN consecutive_failures+1 >= $2 AND status='running'
                 THEN 'Pausada automaticamente: ' || $2 || ' envios seguidos falharam' ELSE pause_reason END
               WHERE id=$1`, [rec.campaign_id, LIMITS.FAIL_PAUSE]);
    }
    return { ok: true };
  });
}

// Envio direto: o painel manda pela conexão de WhatsApp da própria empresa (sem fluxo no N8N) e registra o resultado sozinho.
async function enviarDireto(companyId, con, job) {
  let resp = null;
  try {
    const r = await fetch(con.base + '/send/text', {
      method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json', token: con.token },
      body: JSON.stringify({ number: job.phone, text: job.text, readchat: true, delay: 3000 }), signal: AbortSignal.timeout(30000),
    });
    if (!r.ok) { await reportResult(companyId, job.recipient_id, false, `O WhatsApp respondeu ${r.status}`); return; }
    resp = await r.json().catch(() => null);
  } catch (e) {
    await reportResult(companyId, job.recipient_id, false, e?.name === 'TimeoutError' ? 'O WhatsApp não respondeu a tempo' : 'Não foi possível falar com o WhatsApp');
    return;
  }
  await reportResult(companyId, job.recipient_id, true);
  // Campanha é mensagem do responsável (só sai pelo painel para facilitar): entra na memória com a mesma marca da mensagem que ele digita.
  await gravarNaConversa(companyId, job, resp, { comoResponsavel: true });
}
// Mesma frase que o fluxo do atendimento põe nas mensagens digitadas pelo responsável e que as Diretrizes do atendente citam.
export const MARCA_RESPONSAVEL = '[MENSAGEM PRIORITÁRIA digitada pelo ADM]';
// A mensagem enviada entra no histórico da conversa do agente (mesma tabela e formato que o agente usa), para ele saber o que foi dito.
// Entra como mensagem DO AGENTE (ele é quem escreveu); o motivo de qualquer falha fica no registro do servidor.
export async function gravarNaConversa(companyId, job, resp, { comoResponsavel = false } = {}) {
  try {
    const c = (await qg('SELECT chat_table, whatsapp_instance, conv_db_url FROM companies WHERE id=$1', [companyId])).rows[0];
    const pool = poolDaEmpresa(c);
    const falta = !pool ? 'sem ligação com o histórico do atendimento (banco próprio da empresa ou N8N_DATABASE_URL do servidor)' : !c?.chat_table ? 'empresa sem tabela de conversas' : !nomeTabelaValido(c.chat_table) ? 'nome de tabela inválido' : !c.whatsapp_instance ? 'empresa sem instância do WhatsApp' : '';
    if (falta) { console.error(`campanhas: histórico NÃO gravado (empresa ${companyId}): ${falta}`); return false; }
    // O agente guarda a conversa sob o número que o WhatsApp mostra no recebimento (muitas vezes sem o "9" extra),
    // e nunca sob o identificador interno (@lid). Procuramos a conversa que já existe; se não houver, usamos o número do envio.
    const so = (v) => String(v || '').replace(/@.*$/, '').replace(/\D/g, '');
    const candidatos = [];
    const add = (v) => { const d = so(v); if (d && !candidatos.includes(d)) candidatos.push(d); };
    if (!/@lid$/i.test(String(resp?.chatid || ''))) add(resp?.chatid);
    if (!/@lid$/i.test(String(job.chat_id || ''))) add(job.chat_id);
    add(job.phone);
    for (const d of [...candidatos]) { if (/^55\d{2}9\d{8}$/.test(d)) add(d.slice(0, 4) + d.slice(5)); }
    const sessoes = candidatos.map((d) => `${c.whatsapp_instance} ${d} chats`);
    const achada = (await pool.query(`SELECT session_id FROM "${c.chat_table}" WHERE session_id = ANY($1::text[]) LIMIT 1`, [sessoes])).rows[0]?.session_id;
    const sessao = achada || sessoes[0];
    await pool.query(`INSERT INTO "${c.chat_table}" (session_id, message) VALUES ($1, $2::jsonb)`,
      [sessao, JSON.stringify({ type: 'ai', content: comoResponsavel ? `${MARCA_RESPONSAVEL} ${job.text}` : job.text, tool_calls: [], additional_kwargs: {}, response_metadata: {}, invalid_tool_calls: [] })]);
    console.log(`campanhas: histórico gravado (empresa ${companyId}, sessão "${sessao}", ${achada ? 'conversa já existente' : 'conversa nova'}; WhatsApp respondeu chatid=${resp?.chatid ?? 'nada'})`);
    return true;
  } catch (e) { console.error('campanhas: histórico da conversa:', e.message); return false; }
}

// O painel tem o relógio e envia direto pela conexão de WhatsApp de cada empresa (configurada na Administração).
let ticking = false;
export async function dispatchDue() {
  if (ticking) return;
  ticking = true;
  try {
    const { rows } = await qg('SELECT id FROM companies ORDER BY id');
    for (const { id } of rows) {
      const con = await conexaoWhats(id);
      if (!con) continue;
      let due;
      try {
        due = (await tx(id, async (t) => (await t(
          "SELECT 1 FROM campaigns WHERE status='running' AND (next_send_at IS NULL OR next_send_at <= now()) LIMIT 1")).rowCount));
      } catch { continue; } // empresa ainda sem as tabelas de campanha
      if (!due) continue;
      const job = await claimNext(id);
      if (!job) continue;
      await enviarDireto(id, con, job);
    }
  } catch (e) { console.error('campanhas:', e.message); }
  finally { ticking = false; }
}
export function startCampaignScheduler() {
  const ms = Math.max(Number(process.env.CAMPAIGN_TICK_MS) || 15000, 500);
  setInterval(() => { dispatchDue(); }, ms).unref();
  console.log('Campanhas: painel confere os envios a cada', ms / 1000, 's');
}

export function registerCampaignRoutes(r, wrap) {

  const SEM_EXCECAO = 'phone NOT IN (SELECT phone FROM campaign_exclusions)';
  // devolve os contatos escolhidos, sem os da lista de exceções (a quantidade deixada de fora vai em .ignorados)
  async function pickRecipients(sel) {
    const mode = sel?.mode;
    if (mode === 'exceptions') { // campanha de teste: só quem está na lista "Não enviar para" (com ou sem cadastro de contato)
      const ex = (await q(`SELECT e.phone, e.note, c.id, btrim(concat_ws(' ', c.name, c.last_name)) AS name, c.chat_id FROM campaign_exclusions e LEFT JOIN customers c ON c.phone=e.phone ORDER BY e.id`)).rows;
      return Object.assign(ex.map((x) => ({ id: x.id || null, name: x.name || x.note || '', phone: x.phone, chat_id: x.chat_id || null })), { ignorados: 0 });
    }
    let todos = [];
    if (mode === 'selected') {
      const ids = (sel.ids || []).map(Number).filter(Number.isInteger);
      if (ids.length) todos = (await q("SELECT id, btrim(concat_ws(' ', name, last_name)) AS name, phone, chat_id FROM customers WHERE id = ANY($1) AND phone IS NOT NULL", [ids])).rows;
    } else {
      const where = mode === 'clients' ? "WHERE phone IS NOT NULL AND status='client'" : mode === 'leads' ? "WHERE phone IS NOT NULL AND status='lead'" : mode === 'all' ? 'WHERE phone IS NOT NULL' : null;
      if (where !== null) todos = (await q(`SELECT id, btrim(concat_ws(' ', name, last_name)) AS name, phone, chat_id FROM customers ${where}`)).rows;
    }
    if (!todos.length) return Object.assign([], { ignorados: 0 });
    const fora = new Set((await q('SELECT phone FROM campaign_exclusions WHERE phone = ANY($1)', [todos.map((x) => x.phone)])).rows.map((x) => x.phone));
    return Object.assign(todos.filter((x) => !fora.has(x.phone)), { ignorados: fora.size ? todos.filter((x) => fora.has(x.phone)).length : 0 });
  }

  const cheio = async (t) => {
    const n = (await t("SELECT COUNT(*)::int AS n FROM campaigns WHERE kind='manual'")).rows[0].n;
    return n >= LIMITS.SAVED_MAX ? `Você já tem ${LIMITS.SAVED_MAX} campanhas guardadas. Apague alguma para criar outra.` : null;
  };

  const cleanBody = (b) => ({
    name: String(b.name || '').trim(),
    messages: Array.isArray(b.messages) ? b.messages.map((m) => String(m || '').trim()) : [],
    greeting_random: true,
    interval_min: Number(b.interval_min), interval_max: Number(b.interval_max),
    batch_size: Number(b.batch_size), batch_pause_min: Number(b.batch_pause_min),
    daily_limit: Number(b.daily_limit),
  });

  // Saudações e cumprimentos da empresa (sem lista própria, valem os padrões).
  const lerFrases = async () => {
    const st = (await q('SELECT greetings, compliments FROM campaign_settings WHERE id=1')).rows[0] || {};
    return { greetings: st.greetings || DEFAULT_GREETINGS, compliments: st.compliments || DEFAULT_COMPLIMENTS,
             personalizada: !!(st.greetings || st.compliments),
             minimos: { greetings: LIMITS.GREETINGS_MIN, compliments: LIMITS.COMPLIMENTS_MIN },
             padrao: { greetings: DEFAULT_GREETINGS, compliments: DEFAULT_COMPLIMENTS } };
  };
  r.get('/campaigns/phrases', wrap(async (req, res) => res.json(await lerFrases())));
  r.put('/campaigns/phrases', wrap(async (req, res) => {
    const g = cleanPhrases(req.body?.greetings, LIMITS.GREETINGS_MIN, 'saudações');
    if (g.error) return res.status(400).json({ error: g.error });
    const k = cleanPhrases(req.body?.compliments, LIMITS.COMPLIMENTS_MIN, 'cumprimentos');
    if (k.error) return res.status(400).json({ error: k.error });
    await q(`INSERT INTO campaign_settings (id, greetings, compliments, greetings_bag, compliments_bag)
             VALUES (1,$1,$2,NULL,NULL)
             ON CONFLICT (id) DO UPDATE SET greetings=$1, compliments=$2, greetings_bag=NULL, compliments_bag=NULL`,
      [JSON.stringify(g.list), JSON.stringify(k.list)]);
    res.json(await lerFrases());
  }));
  r.delete('/campaigns/phrases', wrap(async (req, res) => {
    await q('UPDATE campaign_settings SET greetings=NULL, compliments=NULL, greetings_bag=NULL, compliments_bag=NULL WHERE id=1');
    res.json(await lerFrases());
  }));

  // ---- lista de exceções: números que não recebem campanhas ----
  const numeros = (txt) => {
    const ok = [], ruins = [];
    for (const parte of String(txt ?? '').split(/[\n,;]+/).map((x) => x.trim()).filter(Boolean)) {
      const n = normPhone(parte);
      n && n.length >= 10 ? ok.push(n) : ruins.push(parte);
    }
    return { ok: [...new Set(ok)], ruins };
  };
  r.get('/campaigns/exclusions', wrap(async (req, res) => {
    res.json((await q(
      `SELECT e.id, e.phone, e.note, e.created_at, c.id AS customer_id, c.name, c.last_name
       FROM campaign_exclusions e LEFT JOIN customers c ON c.phone=e.phone ORDER BY e.id DESC LIMIT 2000`)).rows);
  }));
  r.post('/campaigns/exclusions', wrap(async (req, res) => {
    const lista = Array.isArray(req.body?.phones) ? req.body.phones.join('\n') : req.body?.phones;
    const { ok, ruins } = numeros(lista);
    const note = String(req.body?.note ?? '').trim().slice(0, 120) || null;
    if (!ok.length) return res.status(400).json({ error: ruins.length ? `Número inválido: ${ruins[0]}` : 'Informe ao menos um número' });
    let novos = 0;
    for (const ph of ok) novos += (await q('INSERT INTO campaign_exclusions (phone, note) VALUES ($1,$2) ON CONFLICT (phone) DO NOTHING', [ph, note])).rowCount;
    res.status(201).json({ added: novos, already: ok.length - novos, invalid: ruins });
  }));
  r.put('/campaigns/exclusions/:id', wrap(async (req, res) => {
    const note = String(req.body?.note ?? '').trim().slice(0, 120) || null;
    const { rowCount } = await q('UPDATE campaign_exclusions SET note=$2 WHERE id=$1', [req.params.id, note]);
    rowCount ? res.json({ ok: true }) : res.status(404).json({ error: 'Não encontrado' });
  }));
  r.post('/campaigns/exclusions/bulk-delete', wrap(async (req, res) => {
    const ids = [...new Set((Array.isArray(req.body?.ids) ? req.body.ids : []).map(Number).filter((n) => Number.isInteger(n) && n > 0))].slice(0, 2000);
    if (!ids.length) return res.status(400).json({ error: 'Nenhum item selecionado' });
    if (req.body.dry_run === true) return res.json({ found: (await q('SELECT count(*)::int AS n FROM campaign_exclusions WHERE id = ANY($1::bigint[])', [ids])).rows[0].n });
    res.json({ deleted: (await q('DELETE FROM campaign_exclusions WHERE id = ANY($1::bigint[])', [ids])).rowCount });
  }));
  // tira da lista pelo número (usado pela ficha do cliente)
  r.post('/campaigns/exclusions/remove', wrap(async (req, res) => {
    const n = normPhone(req.body?.phone);
    if (!n) return res.status(400).json({ error: 'Número inválido' });
    await q('DELETE FROM campaign_exclusions WHERE phone=$1', [n]);
    res.json({ ok: true });
  }));

  // Limites de envio desta empresa (o administrador ajusta na Administração); a tela de nova campanha usa estes valores.
  r.get('/campaigns/limits', wrap(async (req, res) => {
    const L = await limitesDaEmpresa(currentCompany());
    res.json({ daily_max: L.DAILY_MAX, interval_min: L.INTERVAL_MIN });
  }));

  // Previsão sem salvar nada.
  r.post('/campaigns/simulate', wrap(async (req, res) => {
    const c = cleanBody(req.body);
    const rc = req.body.total === undefined ? await pickRecipients(req.body.recipients) : null;
    const total = req.body.total ?? rc.length;
    res.json({ total, ignorados: rc?.ignorados ?? 0, ...simulate(c, total), has_link: hasLink(c.messages), limits: await limitesDaEmpresa(currentCompany()) });
  }));

  r.get('/campaigns', wrap(async (req, res) => {
    const { rows } = await q(
      `SELECT c.*,
         COUNT(r.id)::int AS total,
         COUNT(r.id) FILTER (WHERE r.status='sent')::int AS sent,
         COUNT(r.id) FILTER (WHERE r.status='failed')::int AS failed,
         COUNT(r.id) FILTER (WHERE r.status IN ('pending','sending'))::int AS remaining
       FROM campaigns c LEFT JOIN campaign_recipients r ON r.campaign_id=c.id
       WHERE c.kind='manual'
       GROUP BY c.id ORDER BY c.id DESC`);
    res.json(rows.map(toCampaign));
  }));

  r.get('/campaigns/:id', wrap(async (req, res) => {
    const c = (await q('SELECT * FROM campaigns WHERE id=$1', [req.params.id])).rows[0];
    if (!c) return res.status(404).json({ error: 'Não encontrada' });
    const rec = (await q('SELECT id,customer_id,name,phone,status,sent_at,error FROM campaign_recipients WHERE campaign_id=$1 ORDER BY id', [c.id])).rows;
    let proximo = { at: null, motivo: null };
    if (c.status === 'running') {
      const cfg = await companyCfg(currentCompany());
      const tz = cfg.timezone || 'America/Sao_Paulo';
      const sentToday = (await q(
        `SELECT COUNT(*)::int AS n FROM campaign_recipients WHERE sent_at IS NOT NULL
           AND (sent_at AT TIME ZONE $1)::date = (now() AT TIME ZONE $1)::date`, [tz])).rows[0].n;
      proximo = proximoEnvio({ nextSendAt: c.next_send_at, sentToday, dailyLimit: Math.min(c.daily_limit, Math.max(LIMITS.DAILY_MAX, cfg.campaign_daily_max ?? 0)), tz, semJanela: !!c.allow_excluded });
    }
    res.json({ ...toCampaign(c), recipients: rec, proximo_envio: proximo, ...simulate(c, rec.filter((x) => ['pending', 'sending'].includes(x.status)).length) });
  }));

  async function saveDraft(req, res, id) {
    const c = cleanBody(req.body);
    const err = validateConfig(c, await limitesDaEmpresa(currentCompany()));
    if (err) return res.status(400).json({ error: err });
    const recips = await pickRecipients(req.body.recipients);
    if (!recips.length) return res.status(400).json({ error: 'Escolha pelo menos um contato' });
    const companyId = currentCompany();
    const out = await tx(companyId, async (t) => {
      let cid = id;
      if (cid) {
        const cur = (await t('SELECT status FROM campaigns WHERE id=$1 FOR UPDATE', [cid])).rows[0];
        if (!cur) return { code: 404, error: 'Não encontrada' };
        if (!['draft', 'paused'].includes(cur.status)) return { code: 409, error: 'Só dá para editar uma campanha que ainda não começou ou que está pausada' };
        await t(`UPDATE campaigns SET name=$2,messages=$3,greeting_random=$4,interval_min=$5,interval_max=$6,
                 batch_size=$7,batch_pause_min=$8,daily_limit=$9,allow_excluded=$10 WHERE id=$1`,
          [cid, c.name, JSON.stringify(c.messages), c.greeting_random, c.interval_min, c.interval_max, c.batch_size, c.batch_pause_min, c.daily_limit, req.body?.recipients?.mode === 'exceptions']);
        if (cur.status === 'draft') await t('DELETE FROM campaign_recipients WHERE campaign_id=$1', [cid]);
        // pausada: quem já foi tratado (enviado, falha, enviando) fica como está; só a fila de quem ainda não recebeu muda
        else await t(`DELETE FROM campaign_recipients WHERE campaign_id=$1 AND status IN ('pending','cancelled') AND NOT (phone = ANY($2))`, [cid, recips.map((p) => p.phone)]);
      } else {
        const lotado = await cheio(t);
        if (lotado) return { code: 409, error: lotado };
        cid = (await t(`INSERT INTO campaigns (name,messages,greeting_random,interval_min,interval_max,batch_size,batch_pause_min,daily_limit,allow_excluded)
                        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id`,
          [c.name, JSON.stringify(c.messages), c.greeting_random, c.interval_min, c.interval_max, c.batch_size, c.batch_pause_min, c.daily_limit, req.body?.recipients?.mode === 'exceptions'])).rows[0].id;
      }
      for (const p of recips) {
        await t(`INSERT INTO campaign_recipients (campaign_id,customer_id,name,phone,chat_id) VALUES ($1,$2,$3,$4,$5)
                 ON CONFLICT (campaign_id,phone) DO UPDATE SET status='pending', error=NULL
                 WHERE campaign_recipients.status='cancelled'`, [cid, p.id, p.name, p.phone, p.chat_id]);
      }
      return { id: cid };
    });
    if (out.error) return res.status(out.code).json({ error: out.error });
    res.status(id ? 200 : 201).json({ id: out.id, total: recips.length, ignorados: recips.ignorados, has_link: hasLink(c.messages), ...simulate(c, recips.length) });
  }
  r.post('/campaigns', wrap((req, res) => saveDraft(req, res, null)));
  r.put('/campaigns/:id', wrap((req, res) => saveDraft(req, res, Number(req.params.id))));

  r.delete('/campaigns/:id', wrap(async (req, res) => {
    const { rowCount } = await q("DELETE FROM campaigns WHERE id=$1 AND kind='manual' AND status IN ('draft','stopped','done')", [req.params.id]);
    if (!rowCount) return res.status(409).json({ error: 'Pare a campanha antes de apagar' });
    res.json({ ok: true });
  }));

  // Duplicar: nova campanha em rascunho com o mesmo texto, ritmo e contatos (para mudar só os detalhes).
  r.post('/campaigns/:id/duplicate', wrap(async (req, res) => {
    const out = await tx(currentCompany(), async (t) => {
      const c = (await t('SELECT * FROM campaigns WHERE id=$1', [req.params.id])).rows[0];
      if (!c) return null;
      const lotado = await cheio(t);
      if (lotado) return { error: lotado };
      // restantes: continuação de uma campanha parada — só quem não recebeu (e não está na lista de exceções)
      const restantes = req.body?.restantes === true;
      if (restantes && c.status === 'running') return { error: 'Pare a campanha antes de continuar de onde ela parou' };
      const nid = (await t(`INSERT INTO campaigns (name,messages,greeting_random,interval_min,interval_max,batch_size,batch_pause_min,daily_limit)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id`,
        [`${c.name} (${restantes ? 'continuação' : 'cópia'})`.slice(0, 120), JSON.stringify(c.messages), c.greeting_random, c.interval_min, c.interval_max, c.batch_size, c.batch_pause_min, c.daily_limit])).rows[0].id;
      await t(`INSERT INTO campaign_recipients (campaign_id,customer_id,name,phone,chat_id)
               SELECT $2, x.id, x.name, x.phone, x.chat_id FROM campaign_recipients r JOIN customers x ON x.id=r.customer_id
               WHERE r.campaign_id=$1
                 ${restantes ? "AND r.status IN ('cancelled','pending') AND r.phone NOT IN (SELECT phone FROM campaign_exclusions)" : ''}`, [c.id, nid]);
      if (restantes && !(await t('SELECT 1 FROM campaign_recipients WHERE campaign_id=$1', [nid])).rowCount) {
        await t('DELETE FROM campaigns WHERE id=$1', [nid]);
        return { error: 'Todos os contatos desta campanha já foram atendidos. Não sobrou ninguém para continuar.' };
      }
      return { id: nid };
    });
    if (!out) return res.status(404).json({ error: 'Não encontrada' });
    if (out.error) return res.status(409).json({ error: out.error });
    res.status(201).json({ id: out.id });
  }));

  // Play: exige o aceite do aviso de risco (fica registrado).
  r.post('/campaigns/:id/start', wrap(async (req, res) => {
    if (req.body?.accept !== true) return res.status(400).json({ error: 'É preciso confirmar o aviso antes de iniciar' });
    const c = (await q('SELECT * FROM campaigns WHERE id=$1', [req.params.id])).rows[0];
    if (!c) return res.status(404).json({ error: 'Não encontrada' });
    if (c.status !== 'draft') return res.status(409).json({ error: 'Esta campanha já foi iniciada' });
    // só uma campanha ativa por vez (em andamento ou pausada)
    const outra = (await q("SELECT name FROM campaigns WHERE status IN ('running','paused') AND kind='manual' AND id<>$1 LIMIT 1", [c.id])).rows[0];
    if (outra) return res.status(409).json({ error: `Já existe uma campanha ativa (“${outra.name}”). Pare ou conclua essa antes de iniciar outra.` });
    const err = validateConfig(toCampaign(c), await limitesDaEmpresa(currentCompany()));
    if (err) return res.status(400).json({ error: err });
    await q(`UPDATE campaigns SET status='running', started_at=now(), last_play_at=now(), accepted_at=now(), accepted_by=$2, next_send_at=now()
             WHERE id=$1`, [c.id, String(req.user?.email || req.user?.id || '')]);
    res.json({ ok: true });
  }));
  r.post('/campaigns/:id/pause', wrap(async (req, res) => {
    const { rowCount } = await q("UPDATE campaigns SET status='paused', pause_reason=NULL WHERE id=$1 AND kind='manual' AND status='running'", [req.params.id]);
    if (!rowCount) return res.status(409).json({ error: 'A campanha não está em andamento' });
    res.json({ ok: true });
  }));
  r.post('/campaigns/:id/resume', wrap(async (req, res) => {
    const { rowCount } = await q(
      "UPDATE campaigns SET status='running', last_play_at=now(), pause_reason=NULL, consecutive_failures=0, next_send_at=GREATEST(COALESCE(next_send_at, now()), now()) WHERE id=$1 AND kind='manual' AND status='paused'",
      [req.params.id]);
    if (!rowCount) return res.status(409).json({ error: 'A campanha não está pausada' });
    res.json({ ok: true });
  }));
  r.post('/campaigns/:id/stop', wrap(async (req, res) => {
    const out = await tx(currentCompany(), async (t) => {
      const u = await t("UPDATE campaigns SET status='stopped', finished_at=now() WHERE id=$1 AND kind='manual' AND status IN ('running','paused') RETURNING id", [req.params.id]);
      if (!u.rowCount) return false;
      await t("UPDATE campaign_recipients SET status='cancelled' WHERE campaign_id=$1 AND status='pending'", [req.params.id]);
      return true;
    });
    if (!out) return res.status(409).json({ error: 'A campanha não está em andamento' });
    res.json({ ok: true });
  }));

  // ---- Envio ----
  // Modo "puxar": um fluxo pergunta de tempos em tempos (usado se CAMPAIGN_WEBHOOK_URL não estiver definida).
  // Devolve no máximo UMA mensagem por chamada, só quando todas as regras permitem.
  r.post('/campaigns/claim', wrap(async (req, res) => res.json(await claimNext(currentCompany()))));

  // Resultado do envio. Falhou = marcado como falho e nunca é reenviado nesta campanha.
  r.post('/campaigns/recipients/:id/report', wrap(async (req, res) => {
    const ok = req.body?.ok === true;
    const out = await reportResult(currentCompany(), req.params.id, ok, req.body?.error);
    if (!out) return res.status(404).json({ error: 'Envio não encontrado ou já registrado' });
    res.json(out);
  }));
}

// Confere, sem deixar rastro, se o painel consegue gravar no histórico de conversas do agente desta empresa.
// Devolve { ok, motivo }: o motivo é uma frase pronta para a Administração mostrar.
async function verificarConversas(companyId) {
  const c = (await qg('SELECT chat_table, whatsapp_instance, conv_db_url, redis_url FROM companies WHERE id=$1', [companyId])).rows[0];
  if (!c) return { ok: false, motivo: 'Empresa não encontrada.' };
  const pool = poolDaEmpresa(c);
  if (!pool) return { ok: false, motivo: c.conv_db_url ? 'Não consegui abrir o endereço guardado do banco de conversas desta empresa. Cadastre o endereço de novo.' : 'Falta a ligação com o banco de conversas do agente: cadastre o endereço do banco desta empresa, ou a variável N8N_DATABASE_URL no servidor.' };
  if (!c.whatsapp_instance) return { ok: false, motivo: 'Falta o nome da instância do WhatsApp desta empresa (campo "instância do WhatsApp").' };
  if (!c.chat_table) return { ok: false, motivo: 'Falta a tabela das conversas do agente desta empresa (campo "Conversas do agente").' };
  if (!nomeTabelaValido(c.chat_table)) return { ok: false, motivo: 'O nome da tabela das conversas é inválido.' };
  const client = await pool.connect().catch((e) => { throw Object.assign(new Error('Não consegui conectar ao banco de conversas do agente: ' + e.message), { aviso: true }); });
  try {
    await client.query('BEGIN');
    await client.query(`INSERT INTO "${c.chat_table}" (session_id, message) VALUES ($1, $2::jsonb)`, ['teste-painel ' + c.whatsapp_instance + ' chats', JSON.stringify({ type: 'ai', content: 'teste', additional_kwargs: {}, response_metadata: {} })]);
    await client.query('ROLLBACK');
    return { ok: true, motivo: `Tudo certo: o painel grava na tabela ${c.chat_table} (instância ${c.whatsapp_instance}).` };
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    return { ok: false, motivo: `Não consegui gravar na tabela ${c.chat_table}: ${e.message}` };
  } finally { client.release(); }
}

// "Testar ligação": confere o banco das conversas e, em seguida, o Redis dos bloqueios (o da empresa, se tiver; senão o do servidor).
export async function verificarHistorico(companyId) {
  const conv = await verificarConversas(companyId);
  const c = (await qg('SELECT redis_url FROM companies WHERE id=$1', [companyId])).rows[0] || {};
  let red;
  if (c.redis_url && !decifrar(c.redis_url)) red = { ok: false, motivo: 'Não consegui abrir o endereço guardado do Redis desta empresa. Cadastre o endereço de novo.' };
  else {
    const r = await testarRedis({ redisUrl: decifrar(c.redis_url) });
    red = r.motivo === 'sem_redis' ? { ok: true, motivo: 'Bloqueios: sem Redis cadastrado (a lista de atendimentos bloqueados fica desligada).' }
      : r.ok ? { ok: true, motivo: 'Bloqueios: o painel alcança o Redis.' }
        : { ok: false, motivo: 'Bloqueios: não consegui falar com o Redis: ' + r.motivo };
  }
  return { ok: conv.ok && red.ok, motivo: conv.motivo + ' ' + red.motivo };
}
