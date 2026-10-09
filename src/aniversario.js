// Campanha automática de aniversariantes: benefício do módulo Campanhas (plano Advanced).
// Todo dia o painel olha quem faz aniversário daqui a N dias e coloca a pessoa na fila de uma campanha permanente,
// uma vez por ano por pessoa. O envio usa o mesmo motor das campanhas (janela de horário, intervalos, limite diário,
// lista "Não enviar para"), então as regras de segurança são as mesmas.
import { q, qg, tx, currentCompany } from './db.js';
import { LIMITS, validateConfig, hasLink, limitesDaEmpresa, VARIAVEIS_ANIVERSARIO, extrasUsados } from './campaigns.js';

export const ANIVERSARIO_SQL = `
  ALTER TABLE campaigns ADD COLUMN IF NOT EXISTS kind TEXT NOT NULL DEFAULT 'manual';
  CREATE TABLE IF NOT EXISTS birthday_settings (
    id          INT PRIMARY KEY DEFAULT 1 CHECK (id = 1),
    enabled     BOOLEAN NOT NULL DEFAULT false,
    days_ahead  INT NOT NULL DEFAULT 15 CHECK (days_ahead BETWEEN 3 AND 60),
    audience    TEXT NOT NULL DEFAULT 'clients' CHECK (audience IN ('clients','all')),
    daily_limit INT NOT NULL DEFAULT 20,
    messages    JSONB NOT NULL DEFAULT '[]',
    campaign_id BIGINT REFERENCES campaigns(id) ON DELETE SET NULL,
    last_run    DATE
  );
  INSERT INTO birthday_settings (id) VALUES (1) ON CONFLICT DO NOTHING;
  CREATE TABLE IF NOT EXISTS birthday_sends (
    customer_id BIGINT NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
    year        INT NOT NULL,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (customer_id, year)
  );`;

// Serviço e produto que as variáveis {servico} e {produto} representam (o evento é sempre o próximo da agenda)
export const ANIVERSARIO_VARIAVEIS_SQL = `
  ALTER TABLE birthday_settings ADD COLUMN IF NOT EXISTS featured_service_id BIGINT REFERENCES services(id) ON DELETE SET NULL;
  ALTER TABLE birthday_settings ADD COLUMN IF NOT EXISTS featured_product_id BIGINT REFERENCES services(id) ON DELETE SET NULL;`;

// Texto de partida. Variáveis: {saudacao}, {nome}, {cumprimento}, {evento} (próximo evento), {servico}, {produto}, {empresa} (nome da empresa), {adm} (primeiro nome do administrador).
// A mensagem que usa {evento} só sai se houver evento; a terceira versão não depende de nada e serve de reserva.
// Cada versão termina com a frase de saída em forma de pergunta.
export const MENSAGENS_PADRAO = [
  '{saudacao} {nome}! Que dia especial, né? Desejamos tudo de melhor para você! E {adm} pediu para avisar que você e um acompanhante são nossos convidados VIPs, além de darmos 20% de desconto na entrada dos seus amigos no próximo evento: {evento}. Que tal? Se quiser, é só confirmar aqui comigo e mandar seus amigos me procurarem falando o seu nome para obterem o desconto, tá? Um grande abraço para você e aproveite seu dia! Se preferir não receber mais mensagens, é só avisar, ok?',
  '{saudacao} {nome}, tudo bem? {cumprimento} Seu aniversário está chegando e queremos comemorar com você! Você e um acompanhante são nossos convidados VIPs, e os seus amigos pagam 20% menos na entrada do nosso próximo evento: {evento}. Se topar, é só me confirmar aqui e pedir para eles me procurarem falando o seu nome. Um grande abraço e que seja um dia incrível! Se não quiser mais receber, é só me avisar, ok?',
  '{saudacao} {nome}! Que dia especial, né? Desejamos tudo de melhor para você. Passando para avisar que você e um acompanhante são nossos convidados VIPs, e os seus amigos ganham 20% de desconto na entrada dos nossos eventos. Quer combinar? É só confirmar aqui comigo e mandar seus amigos me procurarem falando o seu nome. Um grande abraço e aproveite o seu dia! Se preferir não receber mais mensagens, é só avisar, tudo bem?',
];

const DIAS_DE_FOLGA = 2; // se o painel ficar fora do ar, pega também quem faria aniversário 1–2 dias antes do alvo
const tzDe = async (id) => (await qg('SELECT timezone FROM companies WHERE id=$1', [id])).rows[0]?.timezone || 'America/Sao_Paulo';
const bissexto = (y) => (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;

// Datas-alvo (mês, dia, ano do aniversário) a partir de "hoje" no fuso da empresa
export function alvos(hojeIso, daysAhead) {
  const [y, m, d] = hojeIso.split('-').map(Number);
  const out = [];
  for (let k = daysAhead - DIAS_DE_FOLGA; k <= daysAhead; k++) {
    const dt = new Date(Date.UTC(y, m - 1, d + k));
    const item = { m: dt.getUTCMonth() + 1, d: dt.getUTCDate(), y: dt.getUTCFullYear() };
    out.push(item);
    // quem nasceu em 29/02 comemora em 28/02 nos anos não bissextos
    if (item.m === 2 && item.d === 28 && !bissexto(item.y)) out.push({ m: 2, d: 29, y: item.y });
  }
  return out;
}

const lerConfig = async (t) => (await t("SELECT *, to_char(last_run,'YYYY-MM-DD') AS last_run_txt FROM birthday_settings WHERE id=1")).rows[0];

// Garante a campanha permanente (criada quando a função é ligada pela primeira vez)
async function garantirCampanha(t, st) {
  let cid = st.campaign_id;
  const msgs = JSON.stringify(st.messages);
  const L = await limitesDaEmpresa(currentCompany());
  const lim = Math.min(st.daily_limit, L.DAILY_MAX);
  if (cid && (await t('SELECT 1 FROM campaigns WHERE id=$1', [cid])).rowCount) {
    await t('UPDATE campaigns SET messages=$2, daily_limit=$3 WHERE id=$1', [cid, msgs, lim]);
    return cid;
  }
  cid = (await t(`INSERT INTO campaigns (name,kind,status,messages,interval_min,interval_max,batch_size,batch_pause_min,daily_limit,accepted_at,started_at,last_play_at,next_send_at)
                  VALUES ('Aniversariantes','birthday','paused',$1,$2,$3,10,$4,$5,now(),now(),now(),now()) RETURNING id`,
    [msgs, L.INTERVAL_MIN, L.INTERVAL_MAX_MIN, LIMITS.BATCH_PAUSE_MIN, lim])).rows[0].id;
  await t('UPDATE birthday_settings SET campaign_id=$1 WHERE id=1', [cid]);
  return cid;
}

// Coloca na fila quem faz aniversário na janela. Roda no máximo uma vez por dia por empresa.
export async function birthdayTick(companyId) {
  const tz = await tzDe(companyId);
  const hoje = new Date().toLocaleDateString('en-CA', { timeZone: tz });
  return tx(companyId, async (t) => {
    const st = await lerConfig(t);
    if (!st?.enabled || !st.campaign_id) return { queued: 0 };
    if (st.last_run_txt === hoje) return { queued: 0, skipped: true };
    const a = alvos(hoje, st.days_ahead);
    const pessoas = (await t(
      `SELECT c.id, c.name, c.phone, c.chat_id, x.y FROM customers c
         JOIN unnest($1::int[], $2::int[], $3::int[]) AS x(m,d,y) ON c.birth_month=x.m AND c.birth_day=x.d
        WHERE c.phone IS NOT NULL
          AND c.phone NOT IN (SELECT phone FROM campaign_exclusions)
          AND NOT EXISTS (SELECT 1 FROM birthday_sends s WHERE s.customer_id=c.id AND s.year=x.y)
          ${st.audience === 'clients' ? "AND c.status='client'" : ''}`,
      [a.map((x) => x.m), a.map((x) => x.d), a.map((x) => x.y)])).rows;
    for (const p of pessoas) {
      await t('INSERT INTO birthday_sends (customer_id, year) VALUES ($1,$2) ON CONFLICT DO NOTHING', [p.id, p.y]);
      // a pessoa já pode ter uma linha de anos anteriores: reaproveita (só se aquela já foi resolvida)
      await t(`INSERT INTO campaign_recipients (campaign_id,customer_id,name,phone,chat_id) VALUES ($1,$2,$3,$4,$5)
               ON CONFLICT (campaign_id,phone) DO UPDATE SET status='pending', sent_text=NULL, sent_at=NULL, claimed_at=NULL, error=NULL,
                 customer_id=EXCLUDED.customer_id, name=EXCLUDED.name, chat_id=EXCLUDED.chat_id
               WHERE campaign_recipients.status IN ('sent','failed','cancelled')`, [st.campaign_id, p.id, p.name, p.phone, p.chat_id]);
    }
    await t('UPDATE birthday_settings SET last_run=$1 WHERE id=1', [hoje]);
    return { queued: pessoas.length };
  });
}

// Chamado pelo agendador do painel, para todas as empresas que têm Campanhas ligado
export async function birthdayTickAll() {
  const { rows } = await qg('SELECT id, modules FROM companies ORDER BY id');
  for (const c of rows) {
    if (c.modules?.campanhas === false) continue;
    try { await birthdayTick(c.id); } catch { /* empresa sem as tabelas ainda */ }
  }
}

export function registerBirthdayRoutes(r, wrap) {
  const ler = async () => {
    const st = (await q('SELECT * FROM birthday_settings WHERE id=1')).rows[0];
    const custom = Array.isArray(st.messages) && st.messages.length === LIMITS.VARIANTS;
    let andamento = null;
    if (st.campaign_id) {
      andamento = (await q(
        `SELECT c.status, c.pause_reason,
           COUNT(r.id) FILTER (WHERE r.status IN ('pending','sending'))::int AS na_fila,
           COUNT(r.id) FILTER (WHERE r.status='sent' AND r.sent_at > now() - interval '365 days')::int AS enviadas
         FROM campaigns c LEFT JOIN campaign_recipients r ON r.campaign_id=c.id WHERE c.id=$1 GROUP BY c.id`, [st.campaign_id])).rows[0] || null;
    }
    const mod = (await qg('SELECT modules FROM companies WHERE id=$1', [currentCompany()])).rows[0]?.modules || {};
    const itens = async (kind) => (await q('SELECT id::text AS id, name FROM services WHERE kind=$1 AND active ORDER BY name LIMIT 300', [kind])).rows;
    const variaveis = [
      { chave: 'saudacao', rotulo: 'Saudação', disponivel: true },
      { chave: 'nome', rotulo: 'Nome', disponivel: true },
      { chave: 'cumprimento', rotulo: 'Cumprimento', disponivel: true },
      { chave: 'evento', rotulo: 'Próximo evento', disponivel: mod.eventos !== false },
      { chave: 'servico', rotulo: 'Serviço', disponivel: mod.servicos !== false },
      { chave: 'produto', rotulo: 'Produto', disponivel: mod.servicos !== false },
      { chave: 'empresa', rotulo: 'Nome da empresa', disponivel: true },
      { chave: 'adm', rotulo: 'Nome do administrador', disponivel: true },
    ];
    return { variaveis, servicos: variaveis[4].disponivel ? await itens('service') : [], produtos: variaveis[5].disponivel ? await itens('product') : [],
             servico_id: st.featured_service_id ? String(st.featured_service_id) : '', produto_id: st.featured_product_id ? String(st.featured_product_id) : '',
             enabled: st.enabled, days_ahead: st.days_ahead, audience: st.audience, daily_limit: st.daily_limit,
             messages: custom ? st.messages : MENSAGENS_PADRAO, padrao: MENSAGENS_PADRAO, personalizada: custom,
             campanha: andamento, limites: { daily_max: (await limitesDaEmpresa(currentCompany())).DAILY_MAX } };
  };
  r.get('/campaigns/birthday', wrap(async (req, res) => res.json(await ler())));

  r.put('/campaigns/birthday', wrap(async (req, res) => {
    const b = req.body || {};
    const days = Number(b.days_ahead), lim = Number(b.daily_limit);
    const messages = Array.isArray(b.messages) ? b.messages.map((m) => String(m || '').trim()) : [];
    if (!Number.isInteger(days) || days < 3 || days > 60) return res.status(400).json({ error: 'Escolha de 3 a 60 dias de antecedência' });
    const L = await limitesDaEmpresa(currentCompany());
    if (!Number.isInteger(lim) || lim < 1 || lim > L.DAILY_MAX) return res.status(400).json({ error: `O limite por dia vai de 1 a ${L.DAILY_MAX} envios` });
    if (!['clients', 'all'].includes(b.audience)) return res.status(400).json({ error: 'Escolha para quem enviar' });
    const falha = validateConfig({ name: 'Aniversariantes', messages, interval_min: L.INTERVAL_MIN, interval_max: L.INTERVAL_MAX_MIN,
      batch_size: 10, batch_pause_min: LIMITS.BATCH_PAUSE_MIN, daily_limit: lim }, L);
    if (falha) return res.status(400).json({ error: falha });
    if (hasLink(messages)) return res.status(400).json({ error: 'A mensagem não pode ter link' });
    const desconhecida = messages.flatMap((m) => [...m.matchAll(/\{([^{}\s]*)\}/g)].map((x) => x[1])).find((v) => !VARIAVEIS_ANIVERSARIO.includes(v));
    if (desconhecida !== undefined) return res.status(400).json({ error: `A variável {${desconhecida}} não existe. Use: ${VARIAVEIS_ANIVERSARIO.map((v) => '{' + v + '}').join(', ')}` });
    const usadas = new Set(messages.flatMap(extrasUsados));
    const mod = (await qg('SELECT modules FROM companies WHERE id=$1', [currentCompany()])).rows[0]?.modules || {};
    if (usadas.has('evento') && mod.eventos === false) return res.status(400).json({ error: 'Esta empresa não usa Eventos; tire {evento} da mensagem' });
    if ((usadas.has('servico') || usadas.has('produto')) && mod.servicos === false) return res.status(400).json({ error: 'Esta empresa não usa Serviços e produtos; tire {servico} e {produto} da mensagem' });
    const idDe = async (v, kind) => {
      if (v === undefined || v === null || v === '') return null;
      if (!/^\d+$/.test(String(v)) || !(await q('SELECT 1 FROM services WHERE id=$1 AND kind=$2 AND active', [v, kind])).rowCount) return undefined;
      return String(v);
    };
    const servicoId = await idDe(b.servico_id, 'service'), produtoId = await idDe(b.produto_id, 'product');
    if (servicoId === undefined) return res.status(400).json({ error: 'Serviço inválido' });
    if (produtoId === undefined) return res.status(400).json({ error: 'Produto inválido' });
    if (usadas.has('servico') && !servicoId) return res.status(400).json({ error: 'Escolha qual serviço a variável {servico} representa' });
    if (usadas.has('produto') && !produtoId) return res.status(400).json({ error: 'Escolha qual produto a variável {produto} representa' });
    const ligar = b.enabled === true;
    const antes = (await q('SELECT enabled FROM birthday_settings WHERE id=1')).rows[0];
    if (ligar && !antes.enabled && b.accept !== true) return res.status(400).json({ error: 'É preciso confirmar o aviso antes de ligar' });
    await tx(currentCompany(), async (t) => {
      await t('UPDATE birthday_settings SET enabled=$1, days_ahead=$2, audience=$3, daily_limit=$4, messages=$5, last_run=CASE WHEN $6 THEN NULL ELSE last_run END, featured_service_id=$7, featured_product_id=$8 WHERE id=1',
        [ligar, days, b.audience, lim, JSON.stringify(messages), ligar && !antes.enabled, servicoId, produtoId]);
      const st = await lerConfig(t);
      const cid = await garantirCampanha(t, st);
      if (ligar) await t("UPDATE campaigns SET status='running', pause_reason=NULL, consecutive_failures=0, next_send_at=GREATEST(COALESCE(next_send_at, now()), now()) WHERE id=$1", [cid]);
      else await t("UPDATE campaigns SET status='paused', pause_reason=NULL WHERE id=$1", [cid]);
    });
    // já enfileira o dia, sem esperar o agendador
    if (ligar) await birthdayTick(currentCompany());
    res.json(await ler());
  }));
}
