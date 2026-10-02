// Campanhas: envio em lote com ritmo controlado. Todas as regras de segurança valem aqui no servidor,
// independentemente do que a tela mostrar.
import { q, qg, tx, currentCompany } from './db.js';

export const LIMITS = {
  INTERVAL_MIN: 5,        // menor intervalo permitido entre mensagens (minutos)
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
export function validateConfig(c) {
  const n = (v) => Number.isInteger(v);
  if (!c.name || !String(c.name).trim()) return 'Dê um nome para a campanha';
  if (!Array.isArray(c.messages) || c.messages.length !== LIMITS.VARIANTS
      || c.messages.some((m) => !String(m || '').trim()))
    return `Escreva a mensagem e mais ${LIMITS.VARIANTS - 1} variações`;
  if (c.messages.some((m) => !OPT_OUT_END.test(String(m).trim())))
    return 'Cada versão da mensagem deve terminar com a frase de saída em forma de pergunta (por exemplo: "Se não quiser mais receber, é só avisar, tá?")';
  if (!n(c.interval_min) || c.interval_min < LIMITS.INTERVAL_MIN)
    return `O intervalo mínimo entre mensagens é de ${LIMITS.INTERVAL_MIN} minutos`;
  if (!n(c.interval_max) || c.interval_max < LIMITS.INTERVAL_MAX_MIN)
    return `O intervalo máximo precisa ser de pelo menos ${LIMITS.INTERVAL_MAX_MIN} minutos`;
  if (c.interval_max < c.interval_min) return 'O intervalo máximo não pode ser menor que o mínimo';
  if (!n(c.batch_size) || c.batch_size < 1 || c.batch_size > LIMITS.BATCH_MAX)
    return `Cada lote pode ter de 1 a ${LIMITS.BATCH_MAX} envios seguidos`;
  if (!n(c.batch_pause_min) || c.batch_pause_min < LIMITS.BATCH_PAUSE_MIN)
    return `A pausa entre lotes é de pelo menos ${LIMITS.BATCH_PAUSE_MIN} minutos`;
  if (!n(c.daily_limit) || c.daily_limit < 1 || c.daily_limit > LIMITS.DAILY_MAX)
    return `O limite por dia vai de 1 a ${LIMITS.DAILY_MAX} envios`;
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
export function proximoEnvio({ nextSendAt, sentToday, dailyLimit, tz, now = new Date() }) {
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
  if (!inWindow(tz, t)) { andar(() => !inWindow(tz, t)); motivo = motivo === 'limite_do_dia' ? motivo : 'fora_do_horario'; }
  return { at: motivo ? t.toISOString() : (sorteado ? t.toISOString() : null), motivo };
}

const companyCfg = async (id) => (await qg('SELECT timezone, whatsapp_instance FROM companies WHERE id=$1', [id])).rows[0] || {};

// Reserva o próximo envio permitido da empresa (ou devolve null). Quem decide o quê e quando é o painel.
export async function claimNext(companyId) {
  const cfg = await companyCfg(companyId);
  const tz = cfg.timezone || 'America/Sao_Paulo';
  if (!inWindow(tz)) return null;
  const out = await tx(companyId, async (t) => {
    // quem ficou "enviando" sem resposta por mais de 30 min é dado como falho (nunca reenvia)
    await t(`UPDATE campaign_recipients SET status='failed', error='Sem retorno do envio'
             WHERE status='sending' AND claimed_at < now() - interval '30 minutes'`);
    const cs = (await t(
      `SELECT * FROM campaigns WHERE status='running' AND (next_send_at IS NULL OR next_send_at <= now())
       ORDER BY id FOR UPDATE SKIP LOCKED`)).rows;
    for (const c of cs) {
      const sentToday = (await t(
        `SELECT COUNT(*)::int AS n FROM campaign_recipients WHERE sent_at IS NOT NULL
           AND (sent_at AT TIME ZONE $1)::date = (now() AT TIME ZONE $1)::date`, [tz])).rows[0].n;
      // o limite diário vale para todas as campanhas da empresa juntas
      if (sentToday >= Math.min(c.daily_limit, LIMITS.DAILY_MAX)) continue;
      const rec = (await t(
        `SELECT * FROM campaign_recipients WHERE campaign_id=$1 AND status='pending'
         ORDER BY id LIMIT 1 FOR UPDATE SKIP LOCKED`, [c.id])).rows[0];
      if (!rec) {
        const open = (await t("SELECT 1 FROM campaign_recipients WHERE campaign_id=$1 AND status='sending'", [c.id])).rowCount;
        if (!open) await t("UPDATE campaigns SET status='done', finished_at=now() WHERE id=$1", [c.id]);
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

// Modo "empurrar": o painel tem o relógio e aciona o N8N (webhook) na hora de cada envio.
// Cada empresa tem o seu endereço (definido na Administração). O N8N só executa quando há mensagem para mandar.
let ticking = false;
export async function dispatchDue() {
  if (ticking) return;
  ticking = true;
  try {
    const { rows } = await qg('SELECT id, campaign_webhook_url FROM companies ORDER BY id');
    for (const { id, campaign_webhook_url } of rows) {
      // endereço da empresa; se não tiver, vale o padrão da variável de ambiente (opcional)
      const url = campaign_webhook_url || process.env.CAMPAIGN_WEBHOOK_URL;
      if (!url) continue;
      let due;
      try {
        due = (await tx(id, async (t) => (await t(
          "SELECT 1 FROM campaigns WHERE status='running' AND (next_send_at IS NULL OR next_send_at <= now()) LIMIT 1")).rowCount));
      } catch { continue; } // empresa ainda sem as tabelas de campanha
      if (!due) continue;
      const job = await claimNext(id);
      if (!job) continue;
      const payload = { company_id: Number(id), ...job };
      try {
        const r = await fetch(url, {
          method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify(payload), signal: AbortSignal.timeout(15000),
        });
        if (!r.ok) await reportResult(id, job.recipient_id, false, `O fluxo de envio respondeu ${r.status}`);
      } catch (e) {
        // sem resposta no prazo: o envio pode ter acontecido, então fica "enviando" (o resultado chega pelo fluxo)
        if (e?.name !== 'TimeoutError' && e?.name !== 'AbortError')
          await reportResult(id, job.recipient_id, false, 'Não foi possível acionar o fluxo de envio');
      }
    }
  } catch (e) { console.error('campanhas:', e.message); }
  finally { ticking = false; }
}
export function startCampaignScheduler() {
  const ms = Math.max(Number(process.env.CAMPAIGN_TICK_MS) || 15000, 500);
  setInterval(() => { dispatchDue(); }, ms).unref();
  console.log('Campanhas: painel aciona o fluxo de envio a cada', ms / 1000, 's');
}

export function registerCampaignRoutes(r, wrap) {

  async function pickRecipients(sel) {
    const mode = sel?.mode;
    if (mode === 'selected') {
      const ids = (sel.ids || []).map(Number).filter(Number.isInteger);
      if (!ids.length) return [];
      return (await q('SELECT id,name,phone,chat_id FROM customers WHERE id = ANY($1)', [ids])).rows;
    }
    const where = mode === 'clients' ? "WHERE status='client'" : mode === 'leads' ? "WHERE status='lead'" : mode === 'all' ? '' : null;
    if (where === null) return [];
    return (await q(`SELECT id,name,phone,chat_id FROM customers ${where}`)).rows;
  }

  const cheio = async (t) => {
    const n = (await t('SELECT COUNT(*)::int AS n FROM campaigns')).rows[0].n;
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

  // Previsão sem salvar nada.
  r.post('/campaigns/simulate', wrap(async (req, res) => {
    const c = cleanBody(req.body);
    const total = req.body.total ?? (await pickRecipients(req.body.recipients)).length;
    res.json({ total, ...simulate(c, total), has_link: hasLink(c.messages), limits: LIMITS });
  }));

  r.get('/campaigns', wrap(async (req, res) => {
    const { rows } = await q(
      `SELECT c.*,
         COUNT(r.id)::int AS total,
         COUNT(r.id) FILTER (WHERE r.status='sent')::int AS sent,
         COUNT(r.id) FILTER (WHERE r.status='failed')::int AS failed,
         COUNT(r.id) FILTER (WHERE r.status IN ('pending','sending'))::int AS remaining
       FROM campaigns c LEFT JOIN campaign_recipients r ON r.campaign_id=c.id
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
      proximo = proximoEnvio({ nextSendAt: c.next_send_at, sentToday, dailyLimit: Math.min(c.daily_limit, LIMITS.DAILY_MAX), tz });
    }
    res.json({ ...toCampaign(c), recipients: rec, proximo_envio: proximo, ...simulate(c, rec.filter((x) => ['pending', 'sending'].includes(x.status)).length) });
  }));

  async function saveDraft(req, res, id) {
    const c = cleanBody(req.body);
    const err = validateConfig(c);
    if (err) return res.status(400).json({ error: err });
    const recips = await pickRecipients(req.body.recipients);
    if (!recips.length) return res.status(400).json({ error: 'Escolha pelo menos um contato' });
    const companyId = currentCompany();
    const out = await tx(companyId, async (t) => {
      let cid = id;
      if (cid) {
        const cur = (await t('SELECT status FROM campaigns WHERE id=$1 FOR UPDATE', [cid])).rows[0];
        if (!cur) return { code: 404, error: 'Não encontrada' };
        if (cur.status !== 'draft') return { code: 409, error: 'Só dá para editar uma campanha que ainda não começou' };
        await t(`UPDATE campaigns SET name=$2,messages=$3,greeting_random=$4,interval_min=$5,interval_max=$6,
                 batch_size=$7,batch_pause_min=$8,daily_limit=$9 WHERE id=$1`,
          [cid, c.name, JSON.stringify(c.messages), c.greeting_random, c.interval_min, c.interval_max, c.batch_size, c.batch_pause_min, c.daily_limit]);
        await t('DELETE FROM campaign_recipients WHERE campaign_id=$1', [cid]);
      } else {
        const lotado = await cheio(t);
        if (lotado) return { code: 409, error: lotado };
        cid = (await t(`INSERT INTO campaigns (name,messages,greeting_random,interval_min,interval_max,batch_size,batch_pause_min,daily_limit)
                        VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id`,
          [c.name, JSON.stringify(c.messages), c.greeting_random, c.interval_min, c.interval_max, c.batch_size, c.batch_pause_min, c.daily_limit])).rows[0].id;
      }
      for (const p of recips) {
        await t(`INSERT INTO campaign_recipients (campaign_id,customer_id,name,phone,chat_id) VALUES ($1,$2,$3,$4,$5)
                 ON CONFLICT (campaign_id,phone) DO NOTHING`, [cid, p.id, p.name, p.phone, p.chat_id]);
      }
      return { id: cid };
    });
    if (out.error) return res.status(out.code).json({ error: out.error });
    res.status(id ? 200 : 201).json({ id: out.id, total: recips.length, has_link: hasLink(c.messages), ...simulate(c, recips.length) });
  }
  r.post('/campaigns', wrap((req, res) => saveDraft(req, res, null)));
  r.put('/campaigns/:id', wrap((req, res) => saveDraft(req, res, Number(req.params.id))));

  r.delete('/campaigns/:id', wrap(async (req, res) => {
    const { rowCount } = await q("DELETE FROM campaigns WHERE id=$1 AND status IN ('draft','stopped','done')", [req.params.id]);
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
      const nid = (await t(`INSERT INTO campaigns (name,messages,greeting_random,interval_min,interval_max,batch_size,batch_pause_min,daily_limit)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id`,
        [`${c.name} (cópia)`.slice(0, 120), JSON.stringify(c.messages), c.greeting_random, c.interval_min, c.interval_max, c.batch_size, c.batch_pause_min, c.daily_limit])).rows[0].id;
      await t(`INSERT INTO campaign_recipients (campaign_id,customer_id,name,phone,chat_id)
               SELECT $2, x.id, x.name, x.phone, x.chat_id FROM campaign_recipients r JOIN customers x ON x.id=r.customer_id
               WHERE r.campaign_id=$1`, [c.id, nid]);
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
    const outra = (await q("SELECT name FROM campaigns WHERE status IN ('running','paused') AND id<>$1 LIMIT 1", [c.id])).rows[0];
    if (outra) return res.status(409).json({ error: `Já existe uma campanha ativa (“${outra.name}”). Pare ou conclua essa antes de iniciar outra.` });
    const err = validateConfig(toCampaign(c));
    if (err) return res.status(400).json({ error: err });
    await q(`UPDATE campaigns SET status='running', started_at=now(), last_play_at=now(), accepted_at=now(), accepted_by=$2, next_send_at=now()
             WHERE id=$1`, [c.id, String(req.user?.email || req.user?.id || '')]);
    res.json({ ok: true });
  }));
  r.post('/campaigns/:id/pause', wrap(async (req, res) => {
    const { rowCount } = await q("UPDATE campaigns SET status='paused', pause_reason=NULL WHERE id=$1 AND status='running'", [req.params.id]);
    if (!rowCount) return res.status(409).json({ error: 'A campanha não está em andamento' });
    res.json({ ok: true });
  }));
  r.post('/campaigns/:id/resume', wrap(async (req, res) => {
    const { rowCount } = await q(
      "UPDATE campaigns SET status='running', last_play_at=now(), pause_reason=NULL, consecutive_failures=0, next_send_at=GREATEST(COALESCE(next_send_at, now()), now()) WHERE id=$1 AND status='paused'",
      [req.params.id]);
    if (!rowCount) return res.status(409).json({ error: 'A campanha não está pausada' });
    res.json({ ok: true });
  }));
  r.post('/campaigns/:id/stop', wrap(async (req, res) => {
    const out = await tx(currentCompany(), async (t) => {
      const u = await t("UPDATE campaigns SET status='stopped', finished_at=now() WHERE id=$1 AND status IN ('running','paused') RETURNING id", [req.params.id]);
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
