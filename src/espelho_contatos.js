// Espelho dos contatos numa planilha da empresa, em segundo plano.
// Cada contato novo ou alterado fica "pendente" (marcado por um gatilho do banco, qualquer que seja o caminho que o criou)
// e o painel envia um por vez, devagar, para o endereço do fluxo da empresa, que grava na planilha.
// Falhou? Continua pendente e tenta de novo. Nunca atrapalha o cadastro: o espelho é só uma cópia.
// Liga e desliga por empresa na Administração. Ao ligar não se copia o passado (só o que mudar dali em diante);
import { q, qg, tx, runAs } from './db.js';
import { configContatos } from './contatos.js';

export const ESPELHO_SQL = `
  ALTER TABLE customers ADD COLUMN IF NOT EXISTS mirror_pending BOOLEAN NOT NULL DEFAULT false;
  CREATE OR REPLACE FUNCTION customers_mirror_flag() RETURNS trigger AS $f$
  BEGIN NEW.mirror_pending := true; RETURN NEW; END $f$ LANGUAGE plpgsql;
  DROP TRIGGER IF EXISTS customers_mirror ON customers;
  CREATE TRIGGER customers_mirror BEFORE INSERT OR UPDATE OF name, last_name, phone, status, client_kinds, subject, city, notes, club_status, club_level_id, birth_day, birth_month, birth_year
    ON customers FOR EACH ROW EXECUTE FUNCTION customers_mirror_flag();
`;

const POR_VEZ = () => Math.max(Number(process.env.ESPELHO_POR_VEZ) || 4, 1);   // envios por rodada (rodada = 15 s → ~16/min, abaixo do limite do Google)
const urlOk = (u) => { try { const x = new URL(u); return u.length <= 500 && (x.protocol === 'https:' || x.protocol === 'http:'); } catch { return false; } };

// dd/MM/aaaa; sem o ano (nem todo mundo informa), só dd/MM
const nascimento = (c) => {
  if (!c.birth_day || !c.birth_month) return '';
  const base = `${String(c.birth_day).padStart(2, '0')}/${String(c.birth_month).padStart(2, '0')}`;
  return c.birth_year ? `${base}/${c.birth_year}` : base;
};

function payload(companyId, c, cfg) {
  const rotulo = Object.fromEntries(cfg.kinds.map((k) => [k.key, k.label]));
  const tipos = (c.client_kinds || []).map((k) => rotulo[k] || k).join(', ');
  return {
    event: 'contact', company_id: Number(companyId), id: Number(c.id), phone: c.phone,
    name: c.name || '', last_name: c.last_name || '', full_name: [c.name, c.last_name].filter(Boolean).join(' '),
    status: c.status === 'client' ? 'Cliente' : 'Lead', types: tipos,
    subject_label: cfg.subject_label, subject: c.subject || '', city: c.city || '', notes: c.notes || '',
    club_status: c.club_status || '', plan: c.plan || '', birth_date: nascimento(c), created_at: c.created_at, updated_at: c.updated_at,
  };
}

let rodando = false;
export async function espelharPendentes() {
  if (rodando) return;
  rodando = true;
  try {
    const { rows } = await qg('SELECT id, contact_mirror_url FROM companies WHERE contact_mirror_on AND contact_mirror_url IS NOT NULL ORDER BY id');
    for (const emp of rows) {
      try {
        await runAs(emp.id, async () => {
          const t = q;
          const cfg = await configContatos();
          // marca como enviado antes de mandar; se falhar, volta a marcar (assim uma edição no meio do envio não se perde)
          const lote = (await t(`SELECT c.id, c.name, c.last_name, c.phone, c.status, c.client_kinds, c.subject, c.city, c.notes, c.club_status,
                                        c.birth_day, c.birth_month, c.birth_year, c.created_at, c.updated_at,
                                        CASE WHEN c.club_status = 'member' THEN lv.name END AS plan
                                 FROM customers c LEFT JOIN loyalty_levels lv ON lv.id = c.club_level_id
                                 WHERE c.mirror_pending AND c.phone IS NOT NULL ORDER BY c.id LIMIT $1`, [POR_VEZ()])).rows;
          for (const c of lote) {
            await t('UPDATE customers SET mirror_pending=false WHERE id=$1', [c.id]);
            let ok = false;
            try {
              const r = await fetch(emp.contact_mirror_url, { method: 'POST', headers: { 'content-type': 'application/json' },
                body: JSON.stringify(payload(emp.id, c, cfg)), signal: AbortSignal.timeout(15000) });
              ok = r.ok;
            } catch { ok = false; }
            if (!ok) { await t('UPDATE customers SET mirror_pending=true WHERE id=$1', [c.id]); break; } // para e tenta de novo na próxima rodada
          }
        });
      } catch (e) { console.error('espelho de contatos (empresa ' + emp.id + '):', e.message); }
    }
  } catch (e) { console.error('espelho de contatos:', e.message); }
  finally { rodando = false; }
}
export function startEspelhoContatos() {
  const ms = Math.max(Number(process.env.ESPELHO_TICK_MS) || 15000, 200);
  setInterval(() => { espelharPendentes(); }, ms).unref();
}

export function registerEspelhoAdmin(app, requireUser, requireAdmin) {
  const idDe = (req) => { const id = Number(req.params.id); return Number.isSafeInteger(id) && id > 0 ? id : null; };
  // liga/desliga e endereço
  app.put('/api/admin/companies/:id/contact-mirror', requireUser, requireAdmin, async (req, res) => {
    try {
      const id = idDe(req); if (!id) return res.status(404).json({ error: 'Empresa não encontrada' });
      const atual = (await qg('SELECT contact_mirror_url, contact_mirror_on FROM companies WHERE id=$1', [id])).rows[0];
      if (!atual) return res.status(404).json({ error: 'Empresa não encontrada' });
      const url = req.body.url === undefined ? (atual.contact_mirror_url || '') : String(req.body.url ?? '').trim();
      if (url && !urlOk(url)) return res.status(400).json({ error: 'Endereço inválido (use um endereço completo, começando com https://)' });
      const on = req.body.on === undefined ? !!atual.contact_mirror_on : !!req.body.on;
      if (on && !url) return res.status(400).json({ error: 'Informe o endereço do fluxo antes de ligar' });
      // ao ligar não se copia o passado: o que estava pendente de antes é descartado
      if (on && !atual.contact_mirror_on) await tx(id, (t) => t('UPDATE customers SET mirror_pending=false WHERE mirror_pending'));
      await qg("UPDATE companies SET contact_mirror_url=NULLIF($2,''), contact_mirror_on=$3 WHERE id=$1", [id, url, on && !!url]);
      res.json({ ok: true, url, on: on && !!url });
    } catch (e) { console.error(e); res.status(500).json({ error: 'Erro interno' }); }
  });
}
