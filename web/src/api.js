const KEY = 'crm_token';
export const ADMIN_KEY = 'crm_admin_token'; // guarda o acesso do administrador enquanto ele vê o painel de uma empresa
// Cada ABA fica presa à conta com que foi aberta (sessionStorage). O localStorage guarda só o último login, para abas novas.
// Antes todas as abas usavam o mesmo token do localStorage: entrar em outra empresa numa aba trocava a empresa de todas as outras,
// e uma aba mostrava a tela de uma empresa com dados de outra. O "Abrir painel" da Administração também vale só para a aba.
const PIN = 'crm_token_aba', VISITA = 'crm_visita_aba', EMPRESA_ABA = 'crm_company_aba';
const sess = (f) => { try { return f(); } catch { return null; } };
const ss = { get: (k) => sess(() => sessionStorage.getItem(k)), set: (k, v) => sess(() => sessionStorage.setItem(k, v)), del: (k) => sess(() => sessionStorage.removeItem(k)) };
const dono = (t) => { try { const p = JSON.parse(atob(t.split('.')[1].replace(/-/g, '+').replace(/_/g, '/'))); return `${p.companyId}:${p.id}`; } catch { return null; } };
export const emVisita = () => ss.get(VISITA) === '1';
export const getToken = () => {
  const fixo = ss.get(PIN);
  if (fixo) return fixo;
  const geral = localStorage.getItem(KEY);
  if (geral) ss.set(PIN, geral);   // aba nova: fica presa ao último login
  return geral;
};
export const setToken = (t) => {
  if (!t) { sair(); return; }
  const antes = ss.get(PIN);
  ss.set(PIN, t);
  if (emVisita()) return;
  // renovação do token desta aba só mexe no "último login" se ele for da mesma conta
  const geral = localStorage.getItem(KEY);
  if (!antes || !geral || dono(geral) === dono(antes) || dono(geral) === dono(t)) localStorage.setItem(KEY, t);
};
function sair() { localStorage.removeItem(KEY); ss.del(PIN); ss.del(VISITA); ss.del(EMPRESA_ABA); }
export const entrarComoEmpresa = (token, company) => { ss.set(PIN, token); ss.set(VISITA, '1'); ss.set(EMPRESA_ABA, JSON.stringify(company)); };
export const sairDaEmpresa = () => { ss.del(PIN); ss.del(VISITA); ss.del(EMPRESA_ABA); };
export const lerEmpresa = () => {
  try {
    const t = getToken();
    const daAba = ss.get(EMPRESA_ABA);
    if (daAba) return JSON.parse(daAba);
    const geral = JSON.parse(localStorage.getItem('crm_company') || '{}');
    return t && geral.id && String(dono(t)).split(':')[0] === String(geral.id) ? geral : {};   // dados de outra empresa nunca valem
  } catch { return {}; }
};
export const guardarEmpresa = (c) => { ss.set(EMPRESA_ABA, JSON.stringify(c)); if (!emVisita()) sess(() => localStorage.setItem('crm_company', JSON.stringify(c))); };

export async function api(path, { method = 'GET', body } = {}) {
  const res = await fetch('/api' + path, {
    method,
    cache: 'no-store',
    headers: {
      'Content-Type': 'application/json',
      ...(getToken() ? { Authorization: 'Bearer ' + getToken() } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  const renovado = res.headers.get('x-new-token');
  if (renovado && getToken()) setToken(renovado);   // sessão renovada pelo uso
  // só sai quando a sessão realmente acabou (um 401 de outro tipo não derruba o login)
  if (res.status === 401 && path !== '/auth/login' && /Sessão inválida|Não autenticado/.test(data.error || '')) {
    setToken(null);
    localStorage.removeItem(ADMIN_KEY);
    localStorage.removeItem('crm_company');
    location.reload();
  }
  if (!res.ok) { const err = new Error(data.error || 'Erro na requisição'); err.data = data; throw err; }
  return data;
}

export const money = (v) => (v === null ? '—' : Number(v || 0).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' }));
export const fmtDate = (d) => (d ? new Date(d).toLocaleDateString('pt-BR') : '—');
export const fmtTime = (d) => new Date(d).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
export const fmtPhone = (p) => {
  const s = String(p || '');
  return s.length >= 12 ? `+${s.slice(0, 2)} ${s.slice(2, 4)} ${s.slice(4, -4)}-${s.slice(-4)}` : s;
};
export const WEEKDAYS = ['Domingo', 'Segunda', 'Terça', 'Quarta', 'Quinta', 'Sexta', 'Sábado'];
