import React, { useState, useEffect } from 'react';
import { api, getToken, setToken } from './api.js';
import Login from './pages/Login.jsx';
import Dashboard from './pages/Dashboard.jsx';
import Servicos from './pages/Servicos.jsx';
import Barbeiros from './pages/Barbeiros.jsx';
import Agenda from './pages/Agenda.jsx';
import Clientes from './pages/Clientes.jsx';
import Inativos from './pages/Inativos.jsx';
import Config from './pages/Config.jsx';
import Admin from './pages/Admin.jsx';

const THEMES = [
  { id: 'light', label: 'Claro', mode: 'light' },
  { id: 'lilac', label: 'Claro lilás', mode: 'light' },
  { id: 'rose', label: 'Claro rosé', mode: 'light' },
  { id: 'dark', label: 'Escuro', mode: 'dark' },
  { id: 'graphite', label: 'Escuro grafite', mode: 'dark' },
  { id: 'wood', label: 'Escuro madeira', mode: 'dark' },
];

const ADMIN_ITEM = { id: 'admin', label: 'Administração', icon: '🛠️', comp: Admin };

const BASE_MENU = [
  { id: 'dashboard', label: 'Dashboard', icon: '📊', comp: Dashboard },
  { id: 'agenda', label: 'Agenda', icon: '📅', comp: Agenda },
  { id: 'clientes', label: 'Clientes e Leads', icon: '👥', comp: Clientes },
  { id: 'inativos', label: 'Retorno de inativos', icon: '🔁', comp: Inativos },
  { id: 'barbeiros', label: 'Barbeiros', icon: '✂️', comp: Barbeiros },
  { id: 'servicos', label: 'Serviços', icon: '💈', comp: Servicos },
  { id: 'config', label: 'Configurações', icon: '⚙️', comp: Config },
];

export default function App() {
  const [admin, setAdmin] = useState(false);
  const [logged, setLogged] = useState(!!getToken());
  const [page, setPage] = useState(() => location.hash.slice(1) || 'dashboard');
  const [collapsed, setCollapsed] = useState(window.innerWidth < 760);
  const [salon, setSalon] = useState(() => JSON.parse(localStorage.getItem('crm_salon') || '{}'));
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

  // Config.jsx dispara este evento ao salvar nome/logo
  useEffect(() => {
    const h = (e) => { setSalon(e.detail); localStorage.setItem('crm_salon', JSON.stringify(e.detail)); };
    window.addEventListener('salon-updated', h);
    return () => window.removeEventListener('salon-updated', h);
  }, []);

  const MENU = admin ? [...BASE_MENU, ADMIN_ITEM] : BASE_MENU;

  if (!logged) return <Login theme={theme} onLogin={(s) => { setSalon(s); setLogged(true); }} />;

  const go = (id) => {
    setPage(id);
    location.hash = id;
    if (window.innerWidth < 760) setCollapsed(true);
  };
  const Current = (MENU.find((m) => m.id === page) || MENU[0]).comp;

  return (
    <div className="layout">
      <aside className={'sidebar' + (collapsed ? ' collapsed' : '')}>
        <div className="brand">
          {salon.logo ? <img className="logo-img" src={salon.logo} alt="" /> : <span className="nav-icon">💈</span>}
          <span>{salon.name || 'Meu Salão'}</span>
        </div>
        {MENU.map((m) => (
          <button key={m.id} className={'nav-item' + (page === m.id ? ' active' : '')} onClick={() => go(m.id)} title={m.label}>
            <span className="nav-icon">{m.icon}</span>
            <span>{m.label}</span>
          </button>
        ))}
        <div className="spacer" />
        <button className="nav-item" onClick={() => { setToken(null); localStorage.removeItem('crm_salon'); setLogged(false); }}>
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
