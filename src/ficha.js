// Leitura de campos da ficha do cliente (usada pelas rotas e pela importação de planilhas).

// Data de nascimento: aceita "dd/mm", "dd/mm/aaaa" ou "aaaa-mm-dd". Vazio apaga. Devolve null se for inválida.
// Sem ano na digitação, não devolve birth_year (quem chama mantém o ano que já estava).
export function parseBirthday(v) {
  if (v === null || v === undefined || String(v).trim() === '') return { birth_day: null, birth_month: null, birth_year: null };
  const t = String(v).trim();
  let m = t.match(/^(\d{1,2})[\/.\-](\d{1,2})(?:[\/.\-](\d{2,4}))?$/), d, mo, y = null;
  if (m) { d = +m[1]; mo = +m[2]; if (m[3]) y = m[3].length === 2 ? null : +m[3]; }
  else if ((m = t.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/))) { y = +m[1]; mo = +m[2]; d = +m[3]; }
  else return null;
  const max = [31, 29, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][mo - 1];
  if (!(mo >= 1 && mo <= 12) || !(d >= 1 && d <= max)) return null;
  if (y !== null && (y < 1900 || y > new Date().getFullYear())) return null;
  const out = { birth_day: d, birth_month: mo };
  if (y !== null) out.birth_year = y;
  return out;
}

// "Londrina - PR" -> { city: 'Londrina', state: 'PR' }; "MA" -> só estado; "Tokio - Japan" fica inteiro como cidade.
export function parseCityState(v) {
  const t = String(v ?? '').trim().replace(/\s+/g, ' ');
  if (!t) return { city: null, state: null };
  if (/^[A-Za-z]{2}$/.test(t)) return { city: null, state: t.toUpperCase() };
  const m = t.match(/^(.*\S)\s*[-\/,]\s*([A-Za-z]{2})$/);
  return m ? { city: m[1].trim(), state: m[2].toUpperCase() } : { city: t, state: null };
}

// "13/09/2026" ou "27/09/2026 17:54" (horário de Brasília) -> texto aceito pelo banco, ou null
export function parseDateTimeBr(v) {
  const m = String(v ?? '').trim().match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})(?:\s+(\d{1,2}):(\d{2}))?$/);
  if (!m) return null;
  const [d, mo, y, h = '0', mi = '0'] = m.slice(1);
  if (+mo < 1 || +mo > 12 || +d < 1 || +d > 31 || +h > 23 || +mi > 59) return null;
  const dt = new Date(Date.UTC(+y, +mo - 1, +d));
  if (dt.getUTCMonth() !== +mo - 1) return null;
  return `${y}-${mo.padStart(2, '0')}-${d.padStart(2, '0')} ${h.padStart(2, '0')}:${mi}:00-03`;
}
