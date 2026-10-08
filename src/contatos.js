// Assunto do contato e tipos de cliente que cada empresa define (nome do campo, tipos manuais, nomes dos tipos automáticos).
// Comprador e contratante continuam automáticos (venda, entrega, contrato); os tipos que a empresa cria são marcados à mão
// ou pela atendente. Nada disso exige mexer no fluxo da atendente: o texto que ela recebe sai do painel.
import { q } from './db.js';

export const CONTATOS_SQL = `
  ALTER TABLE customers ADD COLUMN IF NOT EXISTS subject TEXT;                    -- assunto atual do contato (o que ele quer / procura)
  ALTER TABLE customers ADD COLUMN IF NOT EXISTS subject_at TIMESTAMPTZ;
  CREATE TABLE IF NOT EXISTS customer_subject_log (
    id          BIGSERIAL PRIMARY KEY,
    customer_id BIGINT NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
    subject     TEXT NOT NULL,
    at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    actor       TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_customer_subject_log ON customer_subject_log (customer_id, at DESC);
  CREATE TABLE IF NOT EXISTS customer_settings (
    id              INT PRIMARY KEY DEFAULT 1 CHECK (id = 1),
    subject_label   TEXT,                                   -- nome que a empresa dá ao campo (padrão: Assunto)
    kinds           JSONB NOT NULL DEFAULT '[]',            -- tipos criados pela empresa: [{ key, label }]
    labels          JSONB NOT NULL DEFAULT '{}',            -- nomes dos tipos automáticos: { buyer, hirer }
    agent_registers BOOLEAN NOT NULL DEFAULT false          -- a atendente registra assunto e tipo dos contatos
  );
  INSERT INTO customer_settings (id) VALUES (1) ON CONFLICT DO NOTHING;
`;

export const AUTOMATICOS = [['buyer', 'Comprador'], ['hirer', 'Contratante']];
const norm = (s) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/\s+/g, ' ').trim();
const textoOk = (t, max) => { const s = String(t ?? '').trim().replace(/\s+/g, ' '); return s && s.length <= max && !/[\u0000-\u001f<>]/.test(s) ? s : null; };

export async function configContatos() {
  const c = (await q('SELECT subject_label, kinds, labels, agent_registers FROM customer_settings WHERE id=1')).rows[0] || {};
  const labels = c.labels || {};
  const custom = Array.isArray(c.kinds) ? c.kinds : [];
  return {
    subject_label: c.subject_label || 'Assunto',
    agent_registers: !!c.agent_registers,
    kinds: [
      ...AUTOMATICOS.map(([key, padrao]) => ({ key, label: labels[key] || padrao, auto: true })),
      ...custom.map((k) => ({ key: k.key, label: k.label, auto: false })),
    ],
  };
}
export async function chavesDePerfil() { return (await configContatos()).kinds.map((k) => k.key); }

// Primeira letra da frase em maiúscula (o resto fica como foi escrito)
export const capitalizar = (t) => { const x = String(t ?? '').trim(); return x ? x.charAt(0).toLocaleUpperCase('pt-BR') + x.slice(1) : x; };

// Grava o assunto (e guarda o anterior no histórico). Texto vazio apaga o assunto atual.
export async function definirAssunto(id, texto, ator) {
  const novo = capitalizar(texto) || null;
  const atual = (await q('SELECT subject FROM customers WHERE id=$1', [id])).rows[0];
  if (!atual || (atual.subject || null) === novo) return false;
  await q('UPDATE customers SET subject=$2, subject_at=CASE WHEN $2::text IS NULL THEN NULL ELSE now() END, updated_at=now() WHERE id=$1', [id, novo]);
  if (novo) await q('INSERT INTO customer_subject_log (customer_id, subject, actor) VALUES ($1,$2,$3)', [id, novo, ator || null]);
  return true;
}

// Texto que o painel entrega à atendente (só quando a empresa ligou o registro)
export async function textoDeCadastroContato() {
  const c = await configContatos();
  if (!c.agent_registers) return '';
  const manuais = c.kinds.filter((k) => !k.auto);
  return [
    `CADASTRO DO CONTATO. Sempre que o cliente disser o que procura ou o que quer, ou o assunto da conversa mudar, use a tool Atualizar Contato informando o campo "${c.subject_label}" com o assunto GERAL de interesse, em poucas palavras: o nome do show, evento, atração, produto ou serviço procurado (exemplo: "Baile do Miranda"). Não coloque detalhes como quantidade de lugares, tipo de mesa, horário ou valor; só o assunto principal. Faça isso em silêncio: não pergunte nada ao cliente só para preencher e nunca diga que está cadastrando.`,
    manuais.length ? `Se a conversa deixar claro que o contato se encaixa em um destes tipos, informe também o tipo: ${manuais.map((k) => k.label).join(', ')}.` : '',
  ].filter(Boolean).join(' ');
}

export function registerContatosRoutes(r, wrap, { custPhone, digits }) {
  r.get('/customers/settings', wrap(async (req, res) => res.json(await configContatos())));

  r.put('/customers/settings', wrap(async (req, res) => {
    const b = req.body || {};
    const atual = (await q('SELECT kinds, labels FROM customer_settings WHERE id=1')).rows[0] || { kinds: [], labels: {} };
    let subject_label = null;
    if (b.subject_label !== undefined && String(b.subject_label).trim() !== '') {
      subject_label = textoOk(b.subject_label, 40);
      if (!subject_label) return res.status(400).json({ error: 'Nome do campo inválido (até 40 letras)' });
    }
    const labels = { ...(atual.labels || {}) };
    for (const [key] of AUTOMATICOS) {
      if (b.labels?.[key] === undefined) continue;
      const t = String(b.labels[key]).trim();
      if (!t) delete labels[key];
      else { const ok = textoOk(t, 40); if (!ok) return res.status(400).json({ error: 'Nome de tipo inválido (até 40 letras)' }); labels[key] = ok; }
    }
    let kinds = Array.isArray(atual.kinds) ? atual.kinds : [];
    if (b.kinds !== undefined) {
      if (!Array.isArray(b.kinds) || b.kinds.length > 12) return res.status(400).json({ error: 'Use até 12 tipos' });
      const vistos = new Set(AUTOMATICOS.map(([k, p]) => norm(labels[k] || p)));
      const proximos = [];
      for (const k of b.kinds) {
        const label = textoOk(k?.label, 40);
        if (!label) return res.status(400).json({ error: 'Nome de tipo inválido (até 40 letras)' });
        if (vistos.has(norm(label))) return res.status(400).json({ error: `Já existe um tipo chamado "${label}"` });
        vistos.add(norm(label));
        const existente = kinds.find((x) => x.key === k.key);
        const key = existente ? existente.key : 'k' + Date.now().toString(36) + proximos.length;
        proximos.push({ key, label });
      }
      // tipo apagado: sai de todos os contatos que o tinham
      for (const velho of kinds.filter((x) => !proximos.some((p) => p.key === x.key)))
        await q('UPDATE customers SET client_kinds = array_remove(client_kinds, $1)', [velho.key]);
      kinds = proximos;
    }
    await q(`UPDATE customer_settings SET subject_label=CASE WHEN $1::text IS NOT NULL THEN $1 WHEN $5::boolean THEN NULL ELSE subject_label END, kinds=$2::jsonb, labels=$3::jsonb,
             agent_registers=COALESCE($4::boolean, agent_registers) WHERE id=1`,
      [subject_label, JSON.stringify(kinds), JSON.stringify(labels), typeof b.agent_registers === 'boolean' ? b.agent_registers : null, b.subject_label !== undefined && String(b.subject_label).trim() === '']);
    res.json(await configContatos());
  }));

  // Histórico do assunto de um contato
  r.get('/customers/:id/subjects', wrap(async (req, res) => {
    if (!/^\d+$/.test(req.params.id)) return res.status(404).json({ error: 'Não encontrado' });
    res.json((await q('SELECT subject, at, actor FROM customer_subject_log WHERE customer_id=$1 ORDER BY at DESC, id DESC LIMIT 50', [req.params.id])).rows);
  }));

  // A atendente atualiza o contato: assunto e, se a empresa criou tipos, o tipo. Cria o contato (lead) se ainda não existe.
  r.post('/customers/update-contact', wrap(async (req, res) => {
    const b = req.body || {};
    const nao = (message) => res.json({ ok: false, message });
    const phone = custPhone(b.phone);
    if (digits(phone).length < 10) return nao('Não consegui identificar o telefone do cliente.');
    const assunto = capitalizar(String(b.subject ?? '').replace(/\s+/g, ' '));
    if (assunto.length > 300 || /[\u0000-\u001f<>]/.test(assunto)) return nao('O assunto está inválido ou grande demais. Resuma em poucas palavras.');
    const cfg = await configContatos();
    let tipo = null;
    const pedido = String(b.kind ?? '').trim();
    if (pedido) {
      tipo = cfg.kinds.filter((k) => !k.auto).find((k) => norm(k.label) === norm(pedido) || k.key === pedido);
      if (!tipo) {
        const lista = cfg.kinds.filter((k) => !k.auto).map((k) => k.label);
        return nao(lista.length ? `Não existe esse tipo. Tipos disponíveis: ${lista.join(', ')}. Comprador e contratante o painel marca sozinho.` : 'Esta empresa não tem tipos para marcar; registre só o assunto. Comprador e contratante o painel marca sozinho.');
      }
    }
    const completo = String(b.name ?? '').trim().replace(/\s+/g, ' ');
    const [primeiro, ...resto] = completo.slice(0, 120).split(' ');
    const ins = (await q(
      `INSERT INTO customers (name,last_name,phone,chat_id,source,status) VALUES (NULLIF($1,''),NULLIF($2,''),$3,$4,'ia','lead')
       ON CONFLICT (phone) DO UPDATE SET chat_id = COALESCE(customers.chat_id, EXCLUDED.chat_id) RETURNING id, (xmax = 0) AS created`,
      [primeiro || '', resto.join(' '), phone, b.chat_id ? String(b.chat_id).slice(0, 80) : null])).rows[0];
    if (assunto) await definirAssunto(ins.id, assunto, 'IA');
    if (tipo) await q(`UPDATE customers SET client_kinds = CASE WHEN $2 = ANY(client_kinds) THEN client_kinds ELSE array_append(client_kinds, $2) END, updated_at=now() WHERE id=$1`, [ins.id, tipo.key]);
    res.status(ins.created ? 201 : 200).json({ ok: true, id: ins.id, created: ins.created, message: `Contato atualizado${assunto ? ` (${cfg.subject_label}: ${assunto})` : ''}${tipo ? `, tipo ${tipo.label}` : ''}. Não avise o cliente.` });
  }));
}
