// Comissões dos profissionais: percentual sobre serviços atendidos e sobre produtos vendidos, calculado por período.
// Regras:
//  - cada profissional tem um percentual padrão para serviços e outro para produtos; um serviço específico pode ter percentual próprio
//  - só contam atendimentos com status "atendido" e vendas de produto com profissional escolhido
//  - desconto opcional (ex.: taxa da maquininha), em %, abatido do valor antes de calcular
//  - o período (semanal, quinzenal ou mensal) é definido pela empresa; o fechamento é calculado na hora, nada fica "congelado"
import { q, qg, tx, currentCompany } from './db.js';

export const COMISSOES_SQL = `
  CREATE TABLE IF NOT EXISTS commission_settings (
    id            SMALLINT PRIMARY KEY CHECK (id = 1),
    period        TEXT NOT NULL DEFAULT 'monthly' CHECK (period IN ('weekly', 'biweekly', 'monthly')),
    deduction_pct NUMERIC(5,2) NOT NULL DEFAULT 0 CHECK (deduction_pct >= 0 AND deduction_pct < 100)
  );
  INSERT INTO commission_settings (id) VALUES (1) ON CONFLICT DO NOTHING;
  CREATE TABLE IF NOT EXISTS commission_rates (
    professional_id BIGINT PRIMARY KEY REFERENCES professionals(id) ON DELETE CASCADE,
    service_pct     NUMERIC(5,2) NOT NULL DEFAULT 0 CHECK (service_pct >= 0 AND service_pct <= 100),
    product_pct     NUMERIC(5,2) NOT NULL DEFAULT 0 CHECK (product_pct >= 0 AND product_pct <= 100)
  );
  CREATE TABLE IF NOT EXISTS commission_service_rates (
    professional_id BIGINT NOT NULL REFERENCES professionals(id) ON DELETE CASCADE,
    service_id      BIGINT NOT NULL REFERENCES services(id) ON DELETE CASCADE,
    pct             NUMERIC(5,2) NOT NULL CHECK (pct >= 0 AND pct <= 100),
    PRIMARY KEY (professional_id, service_id)
  );`;

export const PERIODOS = ['weekly', 'biweekly', 'monthly'];
const r2 = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;
const pct = (v) => { const n = Number(String(v ?? '').replace(',', '.')); return v !== '' && v !== null && v !== undefined && Number.isFinite(n) && n >= 0 && n <= 100 ? r2(n) : null; };
const idOk = (v) => /^\d+$/.test(String(v ?? '')) ? String(v) : null;

// Início e fim (datas AAAA-MM-DD) do período que contém `dia`.
export function periodoDe(period, dia) {
  const [y, m, d] = dia.split('-').map(Number);
  const iso = (dt) => dt.toISOString().slice(0, 10);
  const base = new Date(Date.UTC(y, m - 1, d));
  if (period === 'weekly') {
    const dow = (base.getUTCDay() + 6) % 7;   // segunda = 0
    const ini = new Date(base); ini.setUTCDate(d - dow);
    const fim = new Date(ini); fim.setUTCDate(ini.getUTCDate() + 6);
    return { from: iso(ini), to: iso(fim) };
  }
  if (period === 'biweekly') {
    return d <= 15 ? { from: iso(new Date(Date.UTC(y, m - 1, 1))), to: iso(new Date(Date.UTC(y, m - 1, 15))) }
                   : { from: iso(new Date(Date.UTC(y, m - 1, 16))), to: iso(new Date(Date.UTC(y, m, 0))) };
  }
  return { from: iso(new Date(Date.UTC(y, m - 1, 1))), to: iso(new Date(Date.UTC(y, m, 0))) };
}
const diaMais = (dia, n) => { const [y, m, d] = dia.split('-').map(Number); const x = new Date(Date.UTC(y, m - 1, d + n)); return x.toISOString().slice(0, 10); };

export function registerCommissionRoutes(r, wrap) {
  const fuso = async () => (await qg('SELECT timezone FROM companies WHERE id=$1', [currentCompany()])).rows[0]?.timezone || 'America/Sao_Paulo';
  const ajustes = async () => (await q('SELECT period, deduction_pct::float AS deduction_pct FROM commission_settings WHERE id=1')).rows[0];

  r.get('/commissions/settings', wrap(async (req, res) => res.json(await ajustes())));
  r.put('/commissions/settings', wrap(async (req, res) => {
    const { period, deduction_pct } = req.body || {};
    if (period !== undefined && !PERIODOS.includes(period)) return res.status(400).json({ error: 'Período inválido' });
    let ded = null;
    if (deduction_pct !== undefined) {
      ded = pct(deduction_pct);
      if (ded === null || ded >= 100) return res.status(400).json({ error: 'O desconto deve ficar entre 0 e 99,99%' });
    }
    await q('UPDATE commission_settings SET period=COALESCE($1, period), deduction_pct=COALESCE($2, deduction_pct) WHERE id=1', [period ?? null, ded]);
    res.json(await ajustes());
  }));

  // Percentuais de cada profissional ativo, com as exceções por serviço
  r.get('/commissions/rates', wrap(async (req, res) => {
    const profs = (await q(
      `SELECT p.id AS professional_id, p.name, COALESCE(c.service_pct, 0)::float AS service_pct, COALESCE(c.product_pct, 0)::float AS product_pct
       FROM professionals p LEFT JOIN commission_rates c ON c.professional_id = p.id WHERE p.active ORDER BY p.name`)).rows;
    const ov = (await q(
      `SELECT o.professional_id, o.service_id, s.name AS service_name, o.pct::float AS pct
       FROM commission_service_rates o JOIN services s ON s.id = o.service_id ORDER BY s.name`)).rows;
    res.json(profs.map((p) => ({ ...p, overrides: ov.filter((o) => String(o.professional_id) === String(p.professional_id)) })));
  }));
  r.put('/commissions/rates/:id', wrap(async (req, res) => {
    const pid = idOk(req.params.id);
    if (!pid || !(await q('SELECT 1 FROM professionals WHERE id=$1', [pid])).rows[0]) return res.status(404).json({ error: 'Profissional não encontrado' });
    const b = req.body || {};
    const sp = pct(b.service_pct), pp = pct(b.product_pct);
    if (sp === null || pp === null) return res.status(400).json({ error: 'Percentual inválido (use de 0 a 100)' });
    const lista = Array.isArray(b.overrides) ? b.overrides : [];
    const vistos = new Set(), ovs = [];
    for (const o of lista) {
      const sid = idOk(o?.service_id), v = pct(o?.pct);
      if (!sid || v === null) return res.status(400).json({ error: 'Percentual de serviço inválido (use de 0 a 100)' });
      if (vistos.has(sid)) continue;
      vistos.add(sid); ovs.push([sid, v]);
    }
    if (ovs.length) {
      const ok = (await q("SELECT id FROM services WHERE kind='service' AND id = ANY($1::bigint[])", [ovs.map((x) => x[0])])).rows.length;
      if (ok !== ovs.length) return res.status(400).json({ error: 'Serviço não encontrado' });
    }
    await tx(currentCompany(), async (t) => {
      await t(`INSERT INTO commission_rates (professional_id, service_pct, product_pct) VALUES ($1,$2,$3)
               ON CONFLICT (professional_id) DO UPDATE SET service_pct=EXCLUDED.service_pct, product_pct=EXCLUDED.product_pct`, [pid, sp, pp]);
      await t('DELETE FROM commission_service_rates WHERE professional_id=$1', [pid]);
      for (const [sid, v] of ovs) await t('INSERT INTO commission_service_rates (professional_id, service_id, pct) VALUES ($1,$2,$3)', [pid, sid, v]);
    });
    res.json({ ok: true });
  }));

  // Fechamento do período que contém `date` (padrão: hoje, no fuso da empresa)
  r.get('/commissions', wrap(async (req, res) => {
    const tz = await fuso();
    const cfg = await ajustes();
    let dia = String(req.query.date || '');
    if (!/^\d{4}-\d{2}-\d{2}$/.test(dia) || isNaN(new Date(dia + 'T00:00:00Z'))) {
      dia = (await q("SELECT to_char(now() AT TIME ZONE $1, 'YYYY-MM-DD') AS d", [tz])).rows[0].d;
    }
    const { from, to } = periodoDe(cfg.period, dia);
    const ded = cfg.deduction_pct;

    const aten = (await q(
      `SELECT a.id, a.professional_id, a.service_id, a.starts_at, a.price::float AS price, sv.name AS service_name,
              NULLIF(btrim(concat_ws(' ', c.name, c.last_name)), '') AS customer_name
       FROM appointments a JOIN services sv ON sv.id = a.service_id LEFT JOIN customers c ON c.id = a.customer_id
       WHERE a.status = 'attended' AND (a.starts_at AT TIME ZONE $1)::date BETWEEN $2::date AND $3::date
       ORDER BY a.starts_at`, [tz, from, to])).rows;
    const vendas = (await q(
      `SELECT s.id, s.professional_id, s.product_name, s.quantity, s.unit_price::float AS unit_price, (s.quantity * s.unit_price)::float AS total, s.sold_at,
              NULLIF(btrim(concat_ws(' ', c.name, c.last_name)), '') AS customer_name
       FROM product_sales s LEFT JOIN customers c ON c.id = s.customer_id
       WHERE (s.sold_at AT TIME ZONE $1)::date BETWEEN $2::date AND $3::date ORDER BY s.sold_at`, [tz, from, to])).rows;
    const profs = (await q(
      `SELECT p.id, p.name, p.active, COALESCE(c.service_pct, 0)::float AS service_pct, COALESCE(c.product_pct, 0)::float AS product_pct
       FROM professionals p LEFT JOIN commission_rates c ON c.professional_id = p.id ORDER BY p.name`)).rows;
    const ov = new Map((await q('SELECT professional_id, service_id, pct::float AS pct FROM commission_service_rates')).rows
      .map((o) => [o.professional_id + ':' + o.service_id, o.pct]));

    const base = (v) => r2(v * (1 - ded / 100));
    const out = [];
    for (const p of profs) {
      const itensS = aten.filter((a) => String(a.professional_id) === String(p.id)).map((a) => {
        const taxa = ov.has(p.id + ':' + a.service_id) ? ov.get(p.id + ':' + a.service_id) : p.service_pct;
        const b = base(a.price);
        return { id: a.id, when: a.starts_at, name: a.service_name, customer: a.customer_name, value: a.price, base: b, pct: taxa, commission: r2(b * taxa / 100), custom_rate: ov.has(p.id + ':' + a.service_id) };
      });
      const itensP = vendas.filter((s) => String(s.professional_id) === String(p.id)).map((s) => {
        const b = base(s.total);
        return { id: s.id, when: s.sold_at, name: s.product_name, quantity: s.quantity, customer: s.customer_name, value: s.total, base: b, pct: p.product_pct, commission: r2(b * p.product_pct / 100) };
      });
      if (!p.active && !itensS.length && !itensP.length) continue;
      const soma = (l, k) => r2(l.reduce((a, x) => a + x[k], 0));
      out.push({
        professional_id: p.id, name: p.name, active: p.active, service_pct: p.service_pct, product_pct: p.product_pct,
        services: itensS, products: itensP,
        services_total: soma(itensS, 'value'), products_total: soma(itensP, 'value'),
        services_commission: soma(itensS, 'commission'), products_commission: soma(itensP, 'commission'),
        commission_total: r2(soma(itensS, 'commission') + soma(itensP, 'commission')),
      });
    }
    const semProf = vendas.filter((s) => !s.professional_id);
    res.json({
      period: cfg.period, deduction_pct: ded, from, to, prev_date: diaMais(from, -1), next_date: diaMais(to, 1),
      professionals: out,
      total_commission: r2(out.reduce((a, x) => a + x.commission_total, 0)),
      unassigned_sales: { count: semProf.length, total: r2(semProf.reduce((a, s) => a + s.total, 0)) },
    });
  }));
}
