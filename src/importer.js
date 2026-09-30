import { pool } from './db.js';

// ---------- utilidades ----------
const norm = (s) => String(s ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().trim();
const digits = (s) => String(s ?? '').replace(/\D/g, '');
const txt = (v) => String(v ?? '').trim();

// aceita cabeçalhos com acento/maiúscula/parênteses: "Duração (min)" -> "duracao"
function rowGet(row, ...names) {
  const map = {};
  for (const [k, v] of Object.entries(row || {})) map[norm(k).replace(/\(.*?\)/g, '').replace(/[^a-z0-9 ]/g, '').trim()] = v;
  for (const n of names) if (map[n] !== undefined && txt(map[n]) !== '') return map[n];
  return '';
}

const DAYS = { dom: 0, seg: 1, ter: 2, qua: 3, qui: 4, sex: 5, sab: 6 };
const dayIdx = (t) => DAYS[norm(t).slice(0, 3)];
export function parseDays(v) {
  const t = norm(v);
  if (!t) return null;
  if (/^todos?/.test(t)) return [0, 1, 2, 3, 4, 5, 6];
  const out = new Set();
  for (const part of t.split(/[,;/]| e /).map((x) => x.trim()).filter(Boolean)) {
    const m = part.match(/^([a-z]+)\s*(?:-|a|ate)\s*([a-z]+)$/);
    if (m) {
      const a = dayIdx(m[1]), b = dayIdx(m[2]);
      if (a === undefined || b === undefined) return undefined;
      for (let d = a; ; d = (d + 1) % 7) { out.add(d); if (d === b) break; }
    } else {
      const d = dayIdx(part);
      if (d === undefined) return undefined;
      out.add(d);
    }
  }
  return [...out].sort();
}
const toHHMM = (h, m) => {
  const hh = Number(h), mm = Number(m || 0);
  return hh > 23 || mm > 59 ? null : `${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}`;
};
export function parseRange(v) {
  const t = norm(v).replace(/\s+/g, '');
  if (!t) return null;
  const m = t.match(/^(\d{1,2})(?::|h)?(\d{2})?(?:-|as|a)(\d{1,2})(?::|h)?(\d{2})?h?$/);
  if (!m) return undefined;
  const a = toHHMM(m[1], m[2]), b = toHHMM(m[3], m[4]);
  return a && b && b > a ? [a, b] : undefined;
}
const num = (v) => {
  const s = txt(v).replace(/[^\d,.-]/g, '');
  if (!s) return NaN;
  return Number(s.includes(',') ? s.replace(/\./g, '').replace(',', '.') : s);
};
function calendarId(v) {
  const t = txt(v);
  const m = t.match(/[?&](cid|src)=([^&#]+)/);
  if (!m) return t;
  const raw = decodeURIComponent(m[2]);
  if (m[1] === 'src') return raw;
  try {
    const d = Buffer.from(raw.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');
    return /^[\w.+-]+@[\w.-]+$/.test(d) ? d : t;
  } catch { return t; }
}
const splitList = (v) => txt(v).split(/[,;\n]/).map((x) => x.trim()).filter(Boolean);

// ---------- importação ----------
// data: { services:[rows], professionals:[rows], customers:[rows] }. dryRun = simula e desfaz.
export async function runImport(salonId, data, dryRun) {
  const rep = {
    dry_run: !!dryRun,
    services: { created: 0, updated: 0 }, categories: { created: 0 },
    professionals: { created: 0, updated: 0 }, customers: { created: 0, updated: 0 },
    warnings: [], errors: [],
  };
  const cx = await pool.connect();
  try {
    await cx.query('BEGIN');
    const q = (t, p) => cx.query(t, p);

    // categorias e serviços já existentes
    const cats = new Map((await q('SELECT id,name FROM categories WHERE salon_id=$1', [salonId])).rows.map((c) => [norm(c.name), c.id]));
    const svcs = new Map((await q('SELECT id,name FROM services WHERE salon_id=$1', [salonId])).rows.map((s) => [norm(s.name), s.id]));
    const getCat = async (name) => {
      const k = norm(name);
      if (!k) return null;
      if (!cats.has(k)) {
        cats.set(k, (await q('INSERT INTO categories (salon_id,name) VALUES ($1,$2) RETURNING id', [salonId, txt(name)])).rows[0].id);
        rep.categories.created++;
      }
      return cats.get(k);
    };

    // --- serviços ---
    for (const [i, row] of (data.services || []).entries()) {
      const line = `Serviços, linha ${i + 2}`;
      const name = txt(rowGet(row, 'servico', 'nome', 'servicos'));
      if (!name) continue;
      const price = rowGet(row, 'preco', 'valor') === '' ? 0 : num(rowGet(row, 'preco', 'valor'));
      const dur = rowGet(row, 'duracao', 'tempo') === '' ? 30 : Math.round(num(rowGet(row, 'duracao', 'tempo')));
      if (isNaN(price) || price < 0) { rep.errors.push(`${line} (${name}): preço inválido`); continue; }
      if (isNaN(dur) || dur < 5) { rep.errors.push(`${line} (${name}): duração inválida`); continue; }
      const catId = await getCat(rowGet(row, 'categoria'));
      const k = norm(name);
      if (svcs.has(k)) {
        await q(`UPDATE services SET price=$2, duration_min=$3, active=true,
                 category_id=COALESCE($4, category_id) WHERE id=$1`, [svcs.get(k), price, dur, catId]);
        rep.services.updated++;
      } else {
        svcs.set(k, (await q('INSERT INTO services (salon_id,name,price,duration_min,category_id) VALUES ($1,$2,$3,$4,$5) RETURNING id',
          [salonId, name, price, dur, catId])).rows[0].id);
        rep.services.created++;
      }
    }

    // --- profissionais ---
    const lim = (await q('SELECT max_barbers FROM salons WHERE id=$1', [salonId])).rows[0]?.max_barbers;
    const barbers = new Map((await q('SELECT id,name,active FROM barbers WHERE salon_id=$1', [salonId])).rows.map((b) => [norm(b.name), b]));
    let ativos = [...barbers.values()].filter((b) => b.active).length;
    for (const [i, row] of (data.professionals || []).entries()) {
      const name = txt(rowGet(row, 'nome', 'profissional', 'barbeiro'));
      if (!name) continue;
      const line = `Profissionais, linha ${i + 2} (${name})`;
      const days = parseDays(rowGet(row, 'dias', 'dias de trabalho'));
      const hours = parseRange(rowGet(row, 'horario', 'expediente'));
      const brk = parseRange(rowGet(row, 'pausa', 'intervalo', 'almoco'));
      if (days === undefined) { rep.errors.push(`${line}: dias inválidos (use "Seg-Sáb", "Seg, Qua, Sex" ou "Todos")`); continue; }
      if (hours === undefined) { rep.errors.push(`${line}: horário inválido (use "09:00-18:00")`); continue; }
      if (brk === undefined) { rep.errors.push(`${line}: pausa inválida (use "12:00-13:00")`); continue; }
      const k = norm(name);
      const ex = barbers.get(k);
      if (!ex && lim !== null && lim !== undefined && ativos >= lim) {
        rep.errors.push(`${line}: limite de ${lim} profissionais do plano atingido`); continue;
      }
      // serviços do profissional: cria os que não existem
      const listed = splitList(rowGet(row, 'servicos', 'servico'));
      const ids = [];
      for (const sn of listed) {
        if (!svcs.has(norm(sn))) {
          svcs.set(norm(sn), (await q('INSERT INTO services (salon_id,name,price,duration_min) VALUES ($1,$2,0,30) RETURNING id', [salonId, sn])).rows[0].id);
          rep.services.created++;
          rep.warnings.push(`${line}: serviço "${sn}" não estava na lista e foi criado com preço 0 e 30 min — ajuste em Serviços`);
        }
        ids.push(svcs.get(norm(sn)));
      }
      const phone = digits(rowGet(row, 'telefone', 'celular', 'whatsapp')) || null;
      const gcal = calendarId(rowGet(row, 'id google agenda', 'google agenda', 'google', 'agenda google')) || null;
      let bid;
      if (ex) {
        bid = ex.id;
        await q(`UPDATE barbers SET phone=COALESCE($2,phone), google_calendar_id=COALESCE($3,google_calendar_id), active=true WHERE id=$1`, [bid, phone, gcal]);
        if (!ex.active) ativos++;
        rep.professionals.updated++;
      } else {
        bid = (await q('INSERT INTO barbers (salon_id,name,phone,google_calendar_id) VALUES ($1,$2,$3,$4) RETURNING id', [salonId, name, phone, gcal])).rows[0].id;
        barbers.set(k, { id: bid, name, active: true });
        ativos++;
        rep.professionals.created++;
      }
      // horários: só mexe se veio dias ou horário; novo profissional sem nada recebe Seg–Sáb 09–18
      if (days || hours || !ex) {
        if (!ex && !days && !hours) rep.warnings.push(`${line}: sem dias/horário — usei Seg–Sáb, 09:00–18:00`);
        const dd = days || [1, 2, 3, 4, 5, 6];
        const [hs, he] = hours || ['09:00', '18:00'];
        await q('DELETE FROM barber_schedules WHERE barber_id=$1', [bid]);
        for (const d of dd) {
          await q('INSERT INTO barber_schedules (barber_id,weekday,start_time,end_time,break_start,break_end) VALUES ($1,$2,$3,$4,$5,$6)',
            [bid, d, hs, he, brk?.[0] ?? null, brk?.[1] ?? null]);
        }
      }
      if (listed.length) {
        await q('DELETE FROM barber_services WHERE barber_id=$1', [bid]);
        for (const sid of new Set(ids)) await q('INSERT INTO barber_services (barber_id,service_id) VALUES ($1,$2)', [bid, sid]);
      }
    }

    // --- clientes ---
    for (const [i, row] of (data.customers || []).entries()) {
      const name = txt(rowGet(row, 'nome', 'cliente'));
      const rawPhone = rowGet(row, 'telefone', 'celular', 'whatsapp');
      if (!name && !rawPhone) continue;
      const line = `Clientes, linha ${i + 2}${name ? ` (${name})` : ''}`;
      let phone = digits(rawPhone);
      if (phone.length === 10 || phone.length === 11) phone = '55' + phone;
      // WhatsApp/UAZAPI entrega o número BR sem o 9 extra (55 + DDD + 8 dígitos); padroniza para casar com o agente
      if (phone.length === 13 && phone.startsWith('55') && phone[4] === '9') phone = phone.slice(0, 4) + phone.slice(5);
      if (phone.length < 12) { rep.errors.push(`${line}: telefone inválido (use DDD + número)`); continue; }
      const r = await q(
        `INSERT INTO customers (salon_id,name,phone,status,source) VALUES ($1,$2,$3,'client','manual')
         ON CONFLICT (salon_id,phone) DO UPDATE SET name=COALESCE(NULLIF(EXCLUDED.name,''),customers.name)
         RETURNING (xmax = 0) AS inserted`, [salonId, name || null, phone]);
      r.rows[0].inserted ? rep.customers.created++ : rep.customers.updated++;
    }

    await q(dryRun ? "ROLLBACK" : "COMMIT");
  } catch (e) {
    await cx.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    cx.release();
  }
  return rep;
}
