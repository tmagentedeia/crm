// Parcerias entre programas de assinatura: uma empresa propõe um benefício aos membros do programa de outra,
// a outra aceita (e, se quiser, oferece um benefício em troca). Quem dá o benefício confere o telefone no programa do parceiro:
// a consulta responde só "é membro?" e o nível, nunca a lista.
import { q, qg, runAs, currentCompany } from './db.js';
import { normPhone } from './phone.js';

export const PARCERIAS_SQL = `
  CREATE TABLE IF NOT EXISTS program_partnerships (
    id          BIGSERIAL PRIMARY KEY,
    proposer_id BIGINT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
    partner_id  BIGINT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
    status      TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','active','declined','ended')),
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    CHECK (proposer_id <> partner_id)
  );
  CREATE UNIQUE INDEX IF NOT EXISTS uq_program_partnership_open ON program_partnerships (LEAST(proposer_id, partner_id), GREATEST(proposer_id, partner_id)) WHERE status IN ('pending','active');
  -- benefício que "from_id" dá aos membros do programa da outra empresa
  CREATE TABLE IF NOT EXISTS program_partnership_offers (
    partnership_id   BIGINT NOT NULL REFERENCES program_partnerships(id) ON DELETE CASCADE,
    from_id          BIGINT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
    benefit_text     TEXT NOT NULL,
    discount_percent NUMERIC(5,2) CHECK (discount_percent IS NULL OR (discount_percent > 0 AND discount_percent <= 100)),
    companions       INT NOT NULL DEFAULT 0 CHECK (companions BETWEEN 0 AND 20),
    updated_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (partnership_id, from_id)
  );`;

const erro = (status, msg) => Object.assign(new Error(msg), { status });
const idOk = (v) => (/^\d+$/.test(String(v ?? '')) ? Number(v) : null);

// lê e confere o benefício do corpo
function lerOferta(b) {
  const texto = String(b?.benefit_text ?? '').trim();
  if (!texto) throw erro(400, 'Escreva o benefício que você oferece');
  if (texto.length > 500 || /[\u0000-\u0008\u000b-\u001f<>]/.test(texto)) throw erro(400, 'Benefício inválido (até 500 letras)');
  let pct = null;
  if (b.discount_percent !== undefined && b.discount_percent !== null && String(b.discount_percent).trim() !== '') {
    pct = Number(String(b.discount_percent).replace(',', '.'));
    if (!Number.isFinite(pct) || pct <= 0 || pct > 100) throw erro(400, 'O desconto precisa ficar entre 0 e 100%');
  }
  const comp = b.companions === undefined || b.companions === null || b.companions === '' ? 0 : Number(b.companions);
  if (!Number.isInteger(comp) || comp < 0 || comp > 20) throw erro(400, 'Número de acompanhantes inválido');
  return { texto, pct, comp };
}

const nomeDoPrograma = (id) => runAs(id, async () => (await q('SELECT program_name FROM loyalty_settings WHERE id=1')).rows[0]?.program_name || 'Programa de assinaturas');
const ehMembroDe = (id, phone) => runAs(id, async () => (await q(
  `SELECT c.name, l.name AS level FROM customers c LEFT JOIN loyalty_levels l ON l.id = c.club_level_id WHERE c.club_status = 'member' AND c.phone = $1 LIMIT 1`, [phone])).rows[0] || null);

// Benefícios que a empresa atual dá a membros de programas parceiros e que valem para este telefone
export async function beneficiosDeParceiros(phone) {
  const eu = currentCompany();
  const fone = normPhone(phone);
  if (!eu || !fone) return [];
  const ofertas = (await qg(
    `SELECT p.id, o.benefit_text, o.discount_percent::float AS discount_percent, o.companions,
            CASE WHEN p.proposer_id = $1 THEN p.partner_id ELSE p.proposer_id END AS other_id
     FROM program_partnerships p JOIN program_partnership_offers o ON o.partnership_id = p.id AND o.from_id = $1
     WHERE p.status = 'active' AND (p.proposer_id = $1 OR p.partner_id = $1)`, [eu])).rows;
  const out = [];
  for (const o of ofertas) {
    const m = await ehMembroDe(o.other_id, fone);
    if (!m) continue;
    const emp = (await qg('SELECT name FROM companies WHERE id=$1', [o.other_id])).rows[0];
    out.push({ partnership_id: String(o.id), partner: emp?.name || '', program: await nomeDoPrograma(o.other_id), level: m.level || null, benefit: o.benefit_text, discount_percent: o.discount_percent, companions: o.companions });
  }
  return out;
}

// Texto para o atendente: o que a empresa oferece a membros de programas parceiros
export async function textoDeParcerias() {
  const eu = currentCompany();
  if (!eu) return '';
  const linhas = (await qg(
    `SELECT o.benefit_text, c.name AS empresa, c.id AS other_id
     FROM program_partnerships p JOIN program_partnership_offers o ON o.partnership_id = p.id AND o.from_id = $1
     JOIN companies c ON c.id = CASE WHEN p.proposer_id = $1 THEN p.partner_id ELSE p.proposer_id END
     WHERE p.status = 'active' AND (p.proposer_id = $1 OR p.partner_id = $1) ORDER BY p.id`, [eu])).rows;
  if (!linhas.length) return '';
  const itens = [];
  for (const l of linhas) itens.push(`- Quem é do programa "${await nomeDoPrograma(l.other_id)}" (${l.empresa}): ${l.benefit_text}`);
  return 'PARCERIAS COM OUTROS PROGRAMAS. Estas empresas parceiras dão este benefício aos membros dos programas delas. Confirme que a pessoa é membro consultando as parcerias pelo telefone dela antes de conceder o benefício; nunca conceda só porque ela disse que é.\n' + itens.join('\n');
}

export function registerParceriasRoutes(r, wrap) {
  const tratar = (fn) => wrap(async (req, res) => { try { await fn(req, res); } catch (e) { if (e.status) return res.status(e.status).json({ error: e.message }); throw e; } });
  const souPainel = (req) => !(req.baseUrl || '').includes('n8n');

  // monta uma parceria para a tela, do ponto de vista da empresa atual
  async function visao(p, eu) {
    const outro = Number(p.proposer_id) === eu ? Number(p.partner_id) : Number(p.proposer_id);
    const emp = (await qg('SELECT name FROM companies WHERE id=$1', [outro])).rows[0];
    const ofertas = (await qg('SELECT from_id, benefit_text, discount_percent::float AS discount_percent, companions FROM program_partnership_offers WHERE partnership_id=$1', [p.id])).rows;
    const of = (id) => { const o = ofertas.find((x) => Number(x.from_id) === id); return o ? { benefit_text: o.benefit_text, discount_percent: o.discount_percent, companions: o.companions } : null; };
    return {
      id: String(p.id), status: p.status, partner_id: String(outro), partner_name: emp?.name || '', program_name: await nomeDoPrograma(outro),
      incoming: p.status === 'pending' && Number(p.partner_id) === eu,        // proposta que chegou e espera resposta
      outgoing: p.status === 'pending' && Number(p.proposer_id) === eu,       // proposta que enviei
      my_offer: of(eu), their_offer: of(outro), created_at: p.created_at, updated_at: p.updated_at,
    };
  }

  // Empresas com programa de assinaturas ligado (menos a atual), com a situação da parceria
  r.get('/club/partnerships/programs', tratar(async (req, res) => {
    const eu = currentCompany();
    const emps = (await qg(`SELECT id, name FROM companies WHERE id <> $1 AND (modules->>'clube') = 'true' ORDER BY name`, [eu])).rows;
    const abertas = (await qg(`SELECT * FROM program_partnerships WHERE status IN ('pending','active') AND (proposer_id=$1 OR partner_id=$1)`, [eu])).rows;
    const out = [];
    for (const e of emps) {
      const p = abertas.find((x) => x.proposer_id === e.id || x.partner_id === e.id);
      out.push({ company_id: String(e.id), company_name: e.name, program_name: await nomeDoPrograma(e.id), partnership: p ? { id: String(p.id), status: p.status } : null });
    }
    res.json(out);
  }));

  r.get('/club/partnerships', tratar(async (req, res) => {
    const eu = currentCompany();
    const ps = (await qg(`SELECT * FROM program_partnerships WHERE status <> 'declined' AND (proposer_id=$1 OR partner_id=$1) ORDER BY updated_at DESC, id DESC LIMIT 200`, [eu])).rows;
    const out = [];
    for (const p of ps) out.push(await visao(p, eu));
    res.json(out);
  }));

  // Corpo: { partner_id, benefit_text, discount_percent?, companions? }
  r.post('/club/partnerships', tratar(async (req, res) => {
    if (!souPainel(req)) throw erro(403, 'Só pelo painel');
    const eu = currentCompany();
    const outro = idOk(req.body?.partner_id);
    if (!outro || outro === eu) throw erro(400, 'Escolha o programa parceiro');
    const emp = (await qg(`SELECT id FROM companies WHERE id=$1 AND (modules->>'clube') = 'true'`, [outro])).rows[0];
    if (!emp) throw erro(404, 'Programa não encontrado');
    const o = lerOferta(req.body);
    let id;
    try {
      id = (await qg(`INSERT INTO program_partnerships (proposer_id, partner_id) VALUES ($1,$2) RETURNING id`, [eu, outro])).rows[0].id;
    } catch (e) {
      if (e.code === '23505') throw erro(409, 'Já existe uma parceria ou proposta em andamento com esse programa');
      throw e;
    }
    await qg('INSERT INTO program_partnership_offers (partnership_id, from_id, benefit_text, discount_percent, companions) VALUES ($1,$2,$3,$4,$5)', [id, eu, o.texto, o.pct, o.comp]);
    res.status(201).json(await visao((await qg('SELECT * FROM program_partnerships WHERE id=$1', [id])).rows[0], eu));
  }));

  // Responde a uma proposta recebida. Corpo: { accept: true|false, benefit_text?, discount_percent?, companions? } (o benefício em troca é opcional)
  r.post('/club/partnerships/:id/respond', tratar(async (req, res) => {
    if (!souPainel(req)) throw erro(403, 'Só pelo painel');
    const eu = currentCompany();
    const p = (await qg(`SELECT * FROM program_partnerships WHERE id=$1 AND partner_id=$2 AND status='pending'`, [idOk(req.params.id) || 0, eu])).rows[0];
    if (!p) throw erro(404, 'Proposta não encontrada');
    if (typeof req.body?.accept !== 'boolean') throw erro(400, 'Informe se aceita ou recusa');
    if (!req.body.accept) {
      await qg(`UPDATE program_partnerships SET status='declined', updated_at=now() WHERE id=$1`, [p.id]);
      return res.json({ ok: true });
    }
    const quer = String(req.body.benefit_text ?? '').trim() !== '';
    const o = quer ? lerOferta(req.body) : null;
    await qg(`UPDATE program_partnerships SET status='active', updated_at=now() WHERE id=$1`, [p.id]);
    if (o) await qg(`INSERT INTO program_partnership_offers (partnership_id, from_id, benefit_text, discount_percent, companions) VALUES ($1,$2,$3,$4,$5)
                     ON CONFLICT (partnership_id, from_id) DO UPDATE SET benefit_text=$3, discount_percent=$4, companions=$5, updated_at=now()`, [p.id, eu, o.texto, o.pct, o.comp]);
    res.json(await visao((await qg('SELECT * FROM program_partnerships WHERE id=$1', [p.id])).rows[0], eu));
  }));

  // Muda (ou passa a dar) o meu benefício numa parceria em andamento. Corpo: { benefit_text, discount_percent?, companions? }
  r.put('/club/partnerships/:id/offer', tratar(async (req, res) => {
    if (!souPainel(req)) throw erro(403, 'Só pelo painel');
    const eu = currentCompany();
    const p = (await qg(`SELECT * FROM program_partnerships WHERE id=$1 AND status IN ('pending','active') AND (proposer_id=$2 OR partner_id=$2)`, [idOk(req.params.id) || 0, eu])).rows[0];
    if (!p) throw erro(404, 'Parceria não encontrada');
    if (p.status === 'pending' && Number(p.partner_id) === eu) throw erro(409, 'Responda à proposta primeiro');
    const o = lerOferta(req.body);
    await qg(`INSERT INTO program_partnership_offers (partnership_id, from_id, benefit_text, discount_percent, companions) VALUES ($1,$2,$3,$4,$5)
              ON CONFLICT (partnership_id, from_id) DO UPDATE SET benefit_text=$3, discount_percent=$4, companions=$5, updated_at=now()`, [p.id, eu, o.texto, o.pct, o.comp]);
    await qg('UPDATE program_partnerships SET updated_at=now() WHERE id=$1', [p.id]);
    res.json(await visao((await qg('SELECT * FROM program_partnerships WHERE id=$1', [p.id])).rows[0], eu));
  }));

  // Encerra (qualquer um dos lados) ou cancela a proposta enviada. Os benefícios deixam de valer na hora.
  r.post('/club/partnerships/:id/end', tratar(async (req, res) => {
    if (!souPainel(req)) throw erro(403, 'Só pelo painel');
    const eu = currentCompany();
    const p = (await qg(`SELECT * FROM program_partnerships WHERE id=$1 AND status IN ('pending','active') AND (proposer_id=$2 OR partner_id=$2)`, [idOk(req.params.id) || 0, eu])).rows[0];
    if (!p) throw erro(404, 'Parceria não encontrada');
    if (p.status === 'pending' && Number(p.partner_id) === eu) throw erro(409, 'Para uma proposta recebida, use recusar');
    await qg(`UPDATE program_partnerships SET status='ended', updated_at=now() WHERE id=$1`, [p.id]);
    res.json({ ok: true });
  }));

  // Este telefone é membro de algum programa parceiro que dá benefício aqui? Devolve os benefícios que valem.
  r.get('/club/partnerships/check', tratar(async (req, res) => {
    const fone = normPhone(req.query.phone);
    if (!/^\d{8,15}$/.test(fone)) throw erro(400, 'Telefone inválido');
    res.json(await beneficiosDeParceiros(fone));
  }));
}
