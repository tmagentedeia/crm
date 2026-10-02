const KEY = 'crm_token';
export const ADMIN_KEY = 'crm_admin_token'; // guarda o acesso do administrador enquanto ele vê o painel de uma empresa
export const getToken = () => localStorage.getItem(KEY);
export const setToken = (t) => (t ? localStorage.setItem(KEY, t) : localStorage.removeItem(KEY));

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
