// Vendas de produtos: cada venda leva o produto (do catálogo ou digitado), a quantidade, o valor e o profissional que vendeu.
// É a base da comissão sobre produtos. Fica em tabela própria, separada dos pedidos de música.
import { q, qg, currentCompany } from './db.js';

export const VENDAS_SQL = `
  CREATE TABLE IF NOT EXISTS product_sales (
    id              BIGSERIAL PRIMARY KEY,
    customer_id     BIGINT REFERENCES customers(id) ON DELETE SET NULL,      -- cliente é opcional
    service_id      BIGINT REFERENCES services(id) ON DELETE SET NULL,       -- produto do catálogo (vazio = digitado na hora)
    product_name    TEXT NOT NULL,                                           -- nome na hora da venda (não muda se o catálogo mudar)
    quantity        INT NOT NULL DEFAULT 1 CHECK (quantity > 0),
    unit_price      NUMERIC(10,2) NOT NULL DEFAULT 0 CHECK (unit_price >= 0),
    professional_id BIGINT REFERENCES professionals(id) ON DELETE SET NULL,
    sold_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
    note            TEXT,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
  );
  CREATE INDEX IF NOT EXISTS idx_product_sales_sold ON product_sales (sold_at);
  CREATE INDEX IF NOT EXISTS idx_product_sales_prof ON product_sales (professional_id);`;

const txt = (v, max) => { const s = String(v ?? '').trim(); return s.length <= max && !/[\u0000-\u0008\u000b-\u001f<>]/.test(s) ? s : null; };
const idOk = (v) => /^\d+$/.test(String(v ?? '')) ? String(v) : null;
const dinheiro = (v) => { const n = Number(String(v ?? '').replace(/[R$\s]/g, '').replace(',', '.')); return Number.isFinite(n) && n >= 0 && n <= 9999999 ? Math.round(n * 100) / 100 : null; };

const SELECT = `SELECT s.id, s.customer_id, s.service_id, s.product_name, s.quantity, s.unit_price::float AS unit_price,
                       (s.quantity * s.unit_price)::float AS total, s.professional_id, s.sold_at, s.note,
                       NULLIF(btrim(concat_ws(' ', c.name, c.last_name)), '') AS customer_name, c.phone AS customer_phone,
                       p.name AS professional_name
                FROM product_sales s LEFT JOIN customers c ON c.id = s.customer_id LEFT JOIN professionals p ON p.id = s.professional_id`;

export function registerSalesRoutes(r, wrap) {
  const fuso = async () => (await qg('SELECT timezone FROM companies WHERE id=$1', [currentCompany()])).rows[0]?.timezone || 'America/Sao_Paulo';

  r.get('/product-sales', wrap(async (req, res) => {
    const mes = /^\d{4}-\d{2}$/.test(String(req.query.month || '')) ? req.query.month : null;
    const tz = await fuso();
    const rows = (await q(`${SELECT} WHERE ($1::text IS NULL OR to_char(s.sold_at AT TIME ZONE $2, 'YYYY-MM') = $1) ORDER BY s.sold_at DESC, s.id DESC LIMIT 1000`, [mes, tz])).rows;
    res.json({ rows, total: Math.round(rows.reduce((a, x) => a + x.total, 0) * 100) / 100 });
  }));

  // Valida o corpo; devolve { erro } ou os campos prontos. `atual` = venda existente (na edição).
  async function ler(b, atual = null) {
    const c = {};
    if (b.service_id !== undefined || !atual) {
      const sid = b.service_id === null || b.service_id === '' || b.service_id === undefined ? null : idOk(b.service_id);
      if (b.service_id && !sid) return { erro: 'Produto inválido' };
      if (sid) {
        const p = (await q("SELECT id, name, price FROM services WHERE id=$1 AND kind='product'", [sid])).rows[0];
        if (!p) return { erro: 'Produto não encontrado no catálogo' };
        c.service_id = p.id; c.product_name = p.name;
        if (b.unit_price === undefined && !atual) c.unit_price = Number(p.price);
      } else { c.service_id = null; }
    }
    if (b.product_name !== undefined && !c.service_id && !(atual?.service_id && b.service_id === undefined)) {
      const n = txt(b.product_name, 120);
      if (!n) return { erro: 'Informe o nome do produto' };
      c.product_name = n;
    }
    if (!atual && !c.product_name) return { erro: 'Escolha um produto do catálogo ou informe o nome' };
    if (b.quantity !== undefined) {
      const n = Number(b.quantity);
      if (!Number.isInteger(n) || n < 1 || n > 9999) return { erro: 'Quantidade inválida' };
      c.quantity = n;
    }
    if (b.unit_price !== undefined) {
      const v = dinheiro(b.unit_price);
      if (v === null) return { erro: 'Valor inválido' };
      c.unit_price = v;
    }
    if (!atual && c.unit_price === undefined) return { erro: 'Informe o valor' };
    if (b.professional_id !== undefined) {
      const pid = b.professional_id === null || b.professional_id === '' ? null : idOk(b.professional_id);
      if (b.professional_id && !pid) return { erro: 'Profissional inválido' };
      if (pid && !(await q('SELECT 1 FROM professionals WHERE id=$1', [pid])).rows[0]) return { erro: 'Profissional não encontrado' };
      c.professional_id = pid;
    }
    if (b.customer_id !== undefined) {
      const cid = b.customer_id === null || b.customer_id === '' ? null : idOk(b.customer_id);
      if (b.customer_id && !cid) return { erro: 'Cliente inválido' };
      if (cid && !(await q('SELECT 1 FROM customers WHERE id=$1', [cid])).rows[0]) return { erro: 'Cliente não encontrado' };
      c.customer_id = cid;
    }
    if (b.sold_at !== undefined && b.sold_at !== null && b.sold_at !== '') {
      const d = new Date(b.sold_at);
      if (isNaN(d)) return { erro: 'Data inválida' };
      c.sold_at = d.toISOString();
    }
    if (b.note !== undefined) {
      const n = txt(b.note, 300);
      if (n === null) return { erro: 'Anotação inválida' };
      c.note = n || null;
    }
    return { c };
  }

  r.post('/product-sales', wrap(async (req, res) => {
    const { erro, c } = await ler(req.body || {});
    if (erro) return res.status(400).json({ error: erro });
    const id = (await q(
      `INSERT INTO product_sales (customer_id, service_id, product_name, quantity, unit_price, professional_id, sold_at, note)
       VALUES ($1,$2,$3,$4,$5,$6,COALESCE($7::timestamptz, now()),$8) RETURNING id`,
      [c.customer_id ?? null, c.service_id ?? null, c.product_name, c.quantity ?? 1, c.unit_price, c.professional_id ?? null, c.sold_at ?? null, c.note ?? null])).rows[0].id;
    res.status(201).json((await q(`${SELECT} WHERE s.id=$1`, [id])).rows[0]);
  }));

  r.put('/product-sales/:id', wrap(async (req, res) => {
    const atual = (await q('SELECT * FROM product_sales WHERE id=$1', [req.params.id])).rows[0];
    if (!atual) return res.status(404).json({ error: 'Venda não encontrada' });
    const { erro, c } = await ler(req.body || {}, atual);
    if (erro) return res.status(400).json({ error: erro });
    const tem = (k) => Object.prototype.hasOwnProperty.call(c, k);
    await q(
      `UPDATE product_sales SET
         customer_id = CASE WHEN $2::boolean THEN $3::bigint ELSE customer_id END,
         service_id = CASE WHEN $4::boolean THEN $5::bigint ELSE service_id END,
         product_name = COALESCE($6, product_name), quantity = COALESCE($7, quantity), unit_price = COALESCE($8, unit_price),
         professional_id = CASE WHEN $9::boolean THEN $10::bigint ELSE professional_id END,
         sold_at = COALESCE($11::timestamptz, sold_at),
         note = CASE WHEN $12::boolean THEN $13 ELSE note END
       WHERE id=$1`,
      [req.params.id, tem('customer_id'), c.customer_id ?? null, tem('service_id'), c.service_id ?? null, c.product_name ?? null,
       c.quantity ?? null, c.unit_price ?? null, tem('professional_id'), c.professional_id ?? null, c.sold_at ?? null, tem('note'), c.note ?? null]);
    res.json((await q(`${SELECT} WHERE s.id=$1`, [req.params.id])).rows[0]);
  }));

  r.delete('/product-sales/:id', wrap(async (req, res) => {
    const { rowCount } = await q('DELETE FROM product_sales WHERE id=$1', [req.params.id]);
    rowCount ? res.json({ ok: true }) : res.status(404).json({ error: 'Venda não encontrada' });
  }));
}
