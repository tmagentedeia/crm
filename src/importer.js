import { tx, qg } from './db.js';

// ---------- utilidades ----------
const norm = (s) => String(s ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().trim();
import { normPhone } from './phone.js';
import { parseBirthday, parseCityState, parseDateTimeBr } from './ficha.js';
const digits = (s) => String(s ?? '').replace(/\D/g, '');
const txt = (v) => String(v ?? '').trim();

// nome de coluna sem acento, maiúscula nem parênteses
const chave = (k) => norm(k).replace(/\(.*?\)/g, '').replace(/[^a-z0-9 ]/g, '').trim();

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
export async function runImport(companyId, data, dryRun) {
  const rep = {
    dry_run: !!dryRun,
    services: { created: 0, updated: 0 }, categories: { created: 0 },
    professionals: { created: 0, updated: 0 }, customers: { created: 0, updated: 0 },
    warnings: [], errors: [], ignored_columns: [],
  };
  class Desfazer extends Error {}
  try {
    await tx(companyId, async (q) => {

    // categorias e serviços já existentes
    const cats = new Map((await q('SELECT id,name FROM categories')).rows.map((c) => [norm(c.name), c.id]));
    const svcs = new Map((await q('SELECT id,name FROM services')).rows.map((s) => [norm(s.name), s.id]));
    const getCat = async (name) => {
      const k = norm(name);
      if (!k) return null;
      if (!cats.has(k)) {
        cats.set(k, (await q('INSERT INTO categories (name) VALUES ($1) RETURNING id', [txt(name)])).rows[0].id);
        rep.categories.created++;
      }
      return cats.get(k);
    };

    // --- serviços ---
    // trava de segurança: linhas com telefone e sem preço são clientes mandados como serviços por engano
    const colsSvc = new Set((data.services || []).flatMap((r) => Object.keys(r || {})).map(chave));
    const pareceCliente = ['telefone', 'celular', 'whatsapp'].some((c) => colsSvc.has(c)) && !['preco', 'valor'].some((c) => colsSvc.has(c));
    if (pareceCliente) {
      rep.errors.push('Os dados enviados como "Serviços" têm coluna de telefone e nenhuma de preço: parecem ser clientes. Nada foi importado como serviço. Escolha "Clientes" e confira de novo.');
      data = { ...data, services: [] };
    }
    for (const [i, row] of (data.services || []).entries()) {
      const line = `Serviços, linha ${i + 2}`;
      const name = txt(rowGet(row, 'servico', 'nome', 'servicos'));
      if (!name) continue;
      const price = rowGet(row, 'preco', 'valor') === '' ? 0 : num(rowGet(row, 'preco', 'valor'));
      const dur = rowGet(row, 'duracao', 'tempo') === '' ? 30 : Math.round(num(rowGet(row, 'duracao', 'tempo')));
      if (isNaN(price) || price < 0) { rep.errors.push(`${line} (${name}): preço inválido`); continue; }
      if (isNaN(dur) || dur < 5) { rep.errors.push(`${line} (${name}): duração inválida`); continue; }
      const tipo = norm(rowGet(row, 'tipo'));
      const kind = ['produto', 'produtos'].includes(tipo) ? 'product' : 'service';
      const catId = kind === 'product' ? null : await getCat(rowGet(row, 'categoria'));
      const k = norm(name);
      if (svcs.has(k)) {
        await q(`UPDATE services SET price=$2, duration_min=$3, active=true,
                 category_id=COALESCE($4, category_id) WHERE id=$1`, [svcs.get(k), price, dur, catId]);
        rep.services.updated++;
      } else {
        svcs.set(k, (await q('INSERT INTO services (name,price,duration_min,category_id,kind) VALUES ($1,$2,$3,$4,$5) RETURNING id',
          [name, price, dur, catId, kind])).rows[0].id);
        rep.services.created++;
      }
    }

    // --- profissionais ---
    const lim = (await qg('SELECT max_professionals FROM companies WHERE id=$1', [companyId])).rows[0]?.max_professionals;
    const professionals = new Map((await q('SELECT id,name,active FROM professionals')).rows.map((b) => [norm(b.name), b]));
    let ativos = [...professionals.values()].filter((b) => b.active).length;
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
      const ex = professionals.get(k);
      if (!ex && lim !== null && lim !== undefined && ativos >= lim) {
        rep.errors.push(`${line}: limite de ${lim} profissionais do plano atingido`); continue;
      }
      // serviços do profissional: cria os que não existem
      const listed = splitList(rowGet(row, 'servicos', 'servico'));
      const ids = [];
      for (const sn of listed) {
        if (!svcs.has(norm(sn))) {
          svcs.set(norm(sn), (await q('INSERT INTO services (name,price,duration_min) VALUES ($1,0,30) RETURNING id', [sn])).rows[0].id);
          rep.services.created++;
          rep.warnings.push(`${line}: serviço "${sn}" não estava na lista e foi criado com preço 0 e 30 min — ajuste em Serviços`);
        }
        ids.push(svcs.get(norm(sn)));
      }
      // categorias do profissional: coluna "Categorias" ou, se vier só Serviços, as categorias desses serviços
      const listedCats = splitList(rowGet(row, 'categorias', 'categoria'));
      const catIds = new Set();
      for (const cn of listedCats) catIds.add(await getCat(cn));
      if (!listedCats.length && ids.length) {
        const r = await q('SELECT DISTINCT category_id FROM services WHERE id = ANY($1::bigint[]) AND category_id IS NOT NULL', [ids]);
        r.rows.forEach((x) => catIds.add(x.category_id));
      }
      if (!ex && !catIds.size) { rep.errors.push(`${line}: informe ao menos uma categoria (coluna "Categorias")`); continue; }
      const phone = digits(rowGet(row, 'telefone', 'celular', 'whatsapp')) || null;
      const gcal = calendarId(rowGet(row, 'id google agenda', 'google agenda', 'google', 'agenda google')) || null;
      let bid;
      if (ex) {
        bid = ex.id;
        await q(`UPDATE professionals SET phone=COALESCE($2,phone), google_calendar_id=COALESCE($3,google_calendar_id), active=true WHERE id=$1`, [bid, phone, gcal]);
        if (!ex.active) ativos++;
        rep.professionals.updated++;
      } else {
        bid = (await q('INSERT INTO professionals (name,phone,google_calendar_id) VALUES ($1,$2,$3) RETURNING id', [name, phone, gcal])).rows[0].id;
        professionals.set(k, { id: bid, name, active: true });
        ativos++;
        rep.professionals.created++;
      }
      // horários: só mexe se veio dias ou horário; novo profissional sem nada recebe Seg–Sáb 09–18
      if (days || hours || !ex) {
        if (!ex && !days && !hours) rep.warnings.push(`${line}: sem dias/horário — usei Seg–Sáb, 09:00–18:00`);
        const dd = days || [1, 2, 3, 4, 5, 6];
        const [hs, he] = hours || ['09:00', '18:00'];
        await q('DELETE FROM professional_schedules WHERE professional_id=$1', [bid]);
        for (const d of dd) {
          await q('INSERT INTO professional_schedules (professional_id,weekday,start_time,end_time,break_start,break_end) VALUES ($1,$2,$3,$4,$5,$6)',
            [bid, d, hs, he, brk?.[0] ?? null, brk?.[1] ?? null]);
        }
      }
      if (catIds.size) {
        await q('DELETE FROM professional_categories WHERE professional_id=$1', [bid]);
        for (const cid of catIds) await q('INSERT INTO professional_categories (professional_id,category_id) VALUES ($1,$2)', [bid, cid]);
      }
      if (listed.length) {
        await q('DELETE FROM professional_services WHERE professional_id=$1', [bid]);
        for (const sid of new Set(ids)) await q('INSERT INTO professional_services (professional_id,service_id) VALUES ($1,$2)', [bid, sid]);
      }
    }

    // --- clientes ---
    const custRows = data.customers || [];
    if (custRows.length) {
      // colunas que o painel entende (as outras são ignoradas e aparecem no relatório)
      const CONHECIDAS = ['nome', 'cliente', 'sobrenome', 'telefone', 'celular', 'whatsapp', 'tipo', 'situacao', 'programa', 'plano', 'nivel',
        'aniversario', 'nascimento', 'data de nascimento', 'cidade', 'estado', 'uf', 'genero', 'sexo', 'data do cadastro', 'cadastro', 'observacoes', 'obs', 'recados'];
      const vistas = new Set();
      custRows.forEach((r) => Object.keys(r || {}).forEach((k) => vistas.add(k)));
      rep.ignored_columns = [...vistas].filter((k) => !CONHECIDAS.includes(chave(k)));
      const niveis = new Map((await q('SELECT id,name FROM loyalty_levels')).rows.map((l) => [norm(l.name), l.id]));
      const SIT = { clube: 'member', membro: 'member', 'ex clube': 'former', 'ex-clube': 'former', 'ex membro': 'former', 'ex-membro': 'former', contribuinte: 'supporter', apoiador: 'supporter' };
      const tipoDe = (row) => norm(rowGet(row, 'tipo', 'situacao', 'programa')).replace(/\s+/g, ' ');
      // se a planilha usa a coluna de situação, quem está sem nada é só um contato (lead)
      const usaPrograma = custRows.some((r) => SIT[tipoDe(r)]);
      // perfis do cliente (Casa de Shows): "Comprador" e "Contratante" na coluna Tipo; quem não tem nada é só um contato (lead)
      const PERFIS_TIPO = { comprador: 'buyer', contratante: 'hirer' };
      const usaPerfis = custRows.some((r) => PERFIS_TIPO[tipoDe(r)]);
      const nivelAvisado = new Set();
      for (const [i, row] of custRows.entries()) {
        const name = txt(rowGet(row, 'nome', 'cliente'));
        const rawPhone = rowGet(row, 'telefone', 'celular', 'whatsapp');
        if (!name && !rawPhone) continue;
        const line = `Clientes, linha ${i + 2}${name ? ` (${name})` : ''}`;
        const phone = normPhone(rawPhone);
        if (phone.length < 12) { rep.errors.push(`${line}: telefone inválido (use DDD + número)`); continue; }

        const tipo = tipoDe(row);
        let club = SIT[tipo] || null;
        const perfil = PERFIS_TIPO[tipo] || null;
        let status = tipo === 'lead' ? 'lead' : tipo === 'cliente' ? 'client' : (club || perfil) ? 'client' : (usaPrograma || usaPerfis) ? 'lead' : 'client';
        let levelId = null;
        const plano = txt(rowGet(row, 'plano', 'nivel'));
        if (plano && club === 'member') {
          levelId = niveis.get(norm(plano)) || null;
          if (!levelId && !nivelAvisado.has(norm(plano))) { nivelAvisado.add(norm(plano)); rep.warnings.push(`O nível "${plano}" não existe no Clube. Crie esse nível antes de importar; por enquanto esses clientes entram sem nível.`); }
        }
        const nasc = rowGet(row, 'data de nascimento', 'nascimento', 'aniversario');
        let b = { birth_day: null, birth_month: null, birth_year: null };
        if (txt(nasc)) { b = parseBirthday(nasc); if (!b) { rep.warnings.push(`${line}: data de nascimento "${txt(nasc)}" não entendida — ignorada`); b = { birth_day: null, birth_month: null, birth_year: null }; } }
        const cs = parseCityState(rowGet(row, 'cidade'));
        const uf = txt(rowGet(row, 'estado', 'uf')).toUpperCase();
        const gRaw = norm(rowGet(row, 'genero', 'sexo'));
        const gender = ['feminino', 'f', 'mulher'].includes(gRaw) ? 'female' : ['masculino', 'm', 'homem'].includes(gRaw) ? 'male' : gRaw ? 'other' : null;
        const cad = txt(rowGet(row, 'data do cadastro', 'cadastro'));
        const created = parseDateTimeBr(cad);
        if (cad && !created) rep.warnings.push(`${line}: data do cadastro "${cad}" não entendida — usei a data de hoje`);
        const r = await q(
          `INSERT INTO customers (name,last_name,phone,status,source,city,state,birth_day,birth_month,birth_year,gender,club_status,club_level_id,notes,created_at,client_kinds)
           VALUES ($1,$2,$3,$4,'manual',$5,$6,$7,$8,$9,$10,$11,$12,$13,COALESCE($14::timestamptz, now()),$15::text[])
           ON CONFLICT (phone) DO UPDATE SET
             name=COALESCE(NULLIF(EXCLUDED.name,''),customers.name),
             last_name=COALESCE(EXCLUDED.last_name,customers.last_name),
             city=COALESCE(EXCLUDED.city,customers.city), state=COALESCE(EXCLUDED.state,customers.state),
             birth_day=COALESCE(EXCLUDED.birth_day,customers.birth_day), birth_month=COALESCE(EXCLUDED.birth_month,customers.birth_month),
             birth_year=COALESCE(EXCLUDED.birth_year,customers.birth_year), gender=COALESCE(EXCLUDED.gender,customers.gender),
             club_status=COALESCE(EXCLUDED.club_status,customers.club_status),
             club_level_id=CASE WHEN EXCLUDED.club_status IS NULL THEN customers.club_level_id ELSE EXCLUDED.club_level_id END,
             notes=COALESCE(EXCLUDED.notes,customers.notes),
             client_kinds=(SELECT COALESCE(array_agg(DISTINCT x), '{}') FROM unnest(customers.client_kinds || EXCLUDED.client_kinds) x),
             status=CASE WHEN cardinality(EXCLUDED.client_kinds) > 0 THEN 'client' ELSE customers.status END,
             updated_at=now()
           RETURNING (xmax = 0) AS inserted`,
          [name || null, txt(rowGet(row, 'sobrenome')) || null, phone, status, cs.city, cs.state || uf || null,
           b.birth_day, b.birth_month, b.birth_year ?? null, gender, club, levelId, txt(rowGet(row, 'observacoes', 'obs', 'recados')) || null, created, perfil ? [perfil] : []]);
        r.rows[0].inserted ? rep.customers.created++ : rep.customers.updated++;
      }
    }

    if (dryRun) throw new Desfazer(); // simulação: desfaz tudo
    });
  } catch (e) {
    if (!(e instanceof Desfazer)) throw e;
  }
  return rep;
}
