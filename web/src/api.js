const KEY = 'crm_token';
export const ADMIN_KEY = 'crm_admin_token'; // guarda o acesso do administrador enquanto ele vê o painel de uma empresa
// "Abrir painel" da Administração vale só para a ABA em que foi aberto (sessionStorage): outras abas continuam na sua própria empresa.
// Antes o acesso ficava no localStorage, compartilhado por todas as abas, e duas abas de empresas diferentes se misturavam.
const KEY_ABA = 'crm_token_aba', EMPRESA_ABA = 'crm_company_aba';
const sess = (f) => { try { return f(); } catch { return null; } };
export const emVisita = () => !!sess(() => sessionStorage.getItem(KEY_ABA));
export const getToken = () => sess(() => sessionStorage.getItem(KEY_ABA)) || localStorage.getItem(KEY);
export const setToken = (t) => {
  if (!t) sair();
  else if (emVisita()) sess(() => sessionStorage.setItem(KEY_ABA, t));
  else localStorage.setItem(KEY, t);
};
function sair() { localStorage.removeItem(KEY); sess(() => { sessionStorage.removeItem(KEY_ABA); sessionStorage.removeItem(EMPRESA_ABA); }); }
export const entrarComoEmpresa = (token, company) => sess(() => { sessionStorage.setItem(KEY_ABA, token); sessionStorage.setItem(EMPRESA_ABA, JSON.stringify(company)); });
export const sairDaEmpresa = () => sess(() => { sessionStorage.removeItem(KEY_ABA); sessionStorage.removeItem(EMPRESA_ABA); });
export const lerEmpresa = () => { try { return JSON.parse((emVisita() ? sessionStorage.getItem(EMPRESA_ABA) : localStorage.getItem('crm_company')) || '{}'); } catch { return {}; } };
export const guardarEmpresa = (c) => { try { emVisita() ? sessionStorage.setItem(EMPRESA_ABA, JSON.stringify(c)) : localStorage.setItem('crm_company', JSON.stringify(c)); } catch { /* sem armazenamento */ } };

export async function api(path, { method = 'GET', body } = {}) {
  const res = await fetch('/api' + path, {
    method,
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

export const money = (v) => Number(v || 0).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
export const fmtDate = (d) => (d ? new Date(d).toLocaleDateString('pt-BR') : '—');
export const fmtTime = (d) => new Date(d).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
export const fmtPhone = (p) => {
  const s = String(p || '');
  return s.length >= 12 ? `+${s.slice(0, 2)} ${s.slice(2, 4)} ${s.slice(4, -4)}-${s.slice(-4)}` : s;
};
export const WEEKDAYS = ['Domingo', 'Segunda', 'Terça', 'Quarta', 'Quinta', 'Sexta', 'Sábado'];
