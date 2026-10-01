import React, { useState, useEffect } from 'react';
import { api, getToken, setToken } from './api.js';
import Login from './pages/Login.jsx';
import Dashboard from './pages/Dashboard.jsx';
import Servicos from './pages/Servicos.jsx';
import Profissionais from './pages/Profissionais.jsx';
import Agenda from './pages/Agenda.jsx';
import Clientes from './pages/Clientes.jsx';
import Fila from './pages/Fila.jsx';
import Importar from './pages/Importar.jsx';
import Inativos from './pages/Inativos.jsx';
import Config from './pages/Config.jsx';
import Admin from './pages/Admin.jsx';
import { moduleOn } from './modules.js';

const THEMES = [
  { id: 'light', label: 'Claro', mode: 'light' },
  { id: 'lilac', label: 'Claro lilás', mode: 'light' },
  { id: 'rose', label: 'Claro rosé', mode: 'light' },
  { id: 'dark', label: 'Escuro', mode: 'dark' },
  { id: 'graphite', label: 'Escuro grafite', mode: 'dark' },
  { id: 'wood', label: 'Escuro madeira', mode: 'dark' },
];

const ADMIN_ITEM = { id: 'admin', label: 'Administração', icon: '🛠️', comp: Admin };

// module = módulo que precisa estar ligado para o item aparecer (sem module = sempre aparece)
const BASE_MENU = [
  { id: 'dashboard', module: 'dashboard', label: 'Dashboard', icon: '📊', comp: Dashboard },
  { id: 'agenda', module: 'agenda', label: 'Agenda', icon: '📅', comp: Agenda },
  { id: 'fila', module: 'agenda', label: 'Fila de espera', icon: '⏳', comp: Fila },
  { id: 'clientes', module: 'clientes', label: 'Clientes e Leads', icon: '👥', comp: Clientes },
  { id: 'inativos', module: 'clientes', label: 'Retorno de inativos', icon: '🔁', comp: Inativos },
  { id: 'profissionais', module: 'agenda', label: 'Profissionais', icon: '✂️', comp: Profissionais },
  { id: 'servicos', module: 'agenda', label: 'Serviços', icon: '🏢', comp: Servicos },
  { id: 'importar', module: 'clientes', label: 'Importar planilha', icon: '📥', comp: Importar },
  { id: 'config', label: 'Configurações', icon: '⚙️', comp: Config },
];

export default function App() {
  const [admin, setAdmin] = useState(false);
  const [logged, setLogged] = useState(!!getToken());
  const [page, setPage] = useState(() => location.hash.slice(1) || 'dashboard');
  const [collapsed, setCollapsed] = useState(window.innerWidth < 760);
  const [company, setCompany] = useState(() => JSON.parse(localStorage.getItem('crm_company') || '{}'));
  const [theme, setTheme] = useState(() => localStorage.getItem('crm_theme') ||
    (window.matchMedia?.('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'));

  useEffect(() => {
    document.documentElement.setAttribute('data-theme', theme);
    document.documentElement.setAttribute('data-mode', THEMES.find((t) => t.id === theme)?.mode || 'light');
    localStorage.setItem('crm_theme', theme);
  }, [theme]);

  useEffect(() => {
    if (logged) api('/me').then((m) => setAdmin(!!m.admin)).catch(() => setAdmin(false));
    else setAdmin(false);
  }, [logged]);

  // Atualiza os dados da empresa (inclusive os módulos) ao abrir, para uma mudança feita na Administração valer sem sair e entrar
  useEffect(() => {
    if (!logged) return;
    api('/company').then((c) => { setCompany(c); localStorage.setItem('crm_company', JSON.stringify(c)); }).catch(() => {});
  }, [logged]);

  // Config.jsx dispara este evento ao salvar nome/logo
  useEffect(() => {
    const h = (e) => { setCompany(e.detail); localStorage.setItem('crm_company', JSON.stringify(e.detail)); };
    window.addEventListener('company-updated', h);
    return () => window.removeEventListener('company-updated', h);
  }, []);

  // Só aparecem os módulos ligados da empresa; Configurações e Administração (para o administrador) sempre aparecem
  const visible = BASE_MENU.filter((m) => !m.module || moduleOn(company.modules, m.module));
  const MENU = admin ? [...visible, ADMIN_ITEM] : visible;
  // Sem nenhum módulo ligado, o administrador começa direto na Administração
  const inicial = admin && !visible.some((m) => m.module) ? ADMIN_ITEM : MENU[0];

  if (!logged) return <Login theme={theme} onLogin={(s) => { setCompany(s); setLogged(true); }} />;

  const go = (id) => {
    setPage(id);
    location.hash = id;
    if (window.innerWidth < 760) setCollapsed(true);
  };
  const atual = MENU.find((m) => m.id === page) || inicial;
  const Current = atual.comp;

  return (
    <div className="layout">
      <aside className={'sidebar' + (collapsed ? ' collapsed' : '')}>
        <div className="brand">
          {company.logo ? <img className="logo-img" src={company.logo} alt="" /> : <span className="nav-icon">🏢</span>}
          <span>{company.name || 'Minha Empresa'}</span>
        </div>
        {MENU.map((m) => (
          <button key={m.id} className={'nav-item' + (atual.id === m.id ? ' active' : '')} onClick={() => go(m.id)} title={m.label}>
            <span className="nav-icon">{m.icon}</span>
            <span>{m.label}</span>
          </button>
        ))}
        <div className="spacer" />
        <button className="nav-item" onClick={() => { setToken(null); localStorage.removeItem('crm_company'); setLogged(false); }}>
          <span className="nav-icon">🚪</span><span>Sair</span>
        </button>
      </aside>
      <main className="main">
        <div className="topbar">
          <button className="btn" onClick={() => setCollapsed(!collapsed)}>☰ Menu</button>
          <select value={theme} onChange={(e) => setTheme(e.target.value)} style={{ width: 'auto' }} title="Tema">
            {THEMES.map((t) => <option key={t.id} value={t.id}>🎨 {t.label}</option>)}
          </select>
        </div>
        <Current />
      </main>
    </div>
  );
}
