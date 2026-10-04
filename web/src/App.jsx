import React, { useState, useEffect } from 'react';
import { api, getToken, setToken, ADMIN_KEY } from './api.js';
import Login from './pages/Login.jsx';
import Dashboard from './pages/Dashboard.jsx';
import Servicos from './pages/Servicos.jsx';
import Profissionais from './pages/Profissionais.jsx';
import Agenda from './pages/Agenda.jsx';
import Clientes from './pages/Clientes.jsx';
import Fila from './pages/Fila.jsx';
import Inativos from './pages/Inativos.jsx';
import Config from './pages/Config.jsx';
import Delivery from './pages/Delivery.jsx';
import Equipe from './pages/Equipe.jsx';
import { RstSalao, RstCozinha, RstCaixa, RstGestao } from './pages/Restaurante.jsx';
import Admin from './pages/Admin.jsx';
import Atendente from './pages/Atendente.jsx';
import Comandos from './pages/Comandos.jsx';
import Bloqueios from './pages/Bloqueios.jsx';
import Campanhas from './pages/Campanhas.jsx';
import Clube from './pages/Clube.jsx';
import Pedidos from './pages/Pedidos.jsx';
import Eventos from './pages/Eventos.jsx';
import Financeiro from './pages/Financeiro.jsx';
import Comissoes from './pages/Comissoes.jsx';
import CasaDeShows from './pages/CasaDeShows.jsx';
import Documentos from './pages/Documentos.jsx';
import Beneficios from './pages/Beneficios.jsx';
import { moduleOn } from './modules.js';
import UpgradeModal from './UpgradeModal.jsx';
import { IconeCadeado, IconeSair, IconeTema } from './icones.jsx';
import { MenuCustomContext, nomeDoMenu, iconeDoMenu } from './menu.jsx';

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
  { id: 'atendente', module: 'atendente', label: 'Atendente', icon: '🤖', comp: Atendente },
  { id: 'clientes', module: 'clientes', label: 'Clientes e Leads', icon: '👥', comp: Clientes },
  { id: 'agenda', module: 'agenda', label: 'Agenda', icon: '📅', comp: Agenda },
  { id: 'profissionais', module: 'profissionais', label: 'Profissionais', icon: '✂️', comp: Profissionais },
  { id: 'servicos', module: 'servicos', label: 'Produtos e Serviços', icon: '🏢', comp: Servicos },
  { id: 'inativos', module: 'inativos', label: 'Retorno de inativos', icon: '🔁', comp: Inativos },
  { id: 'campanhas', module: 'campanhas', label: 'Campanhas', icon: '📣', comp: Campanhas },
  { id: 'clube', module: 'clube', label: 'Programa de assinaturas', icon: '⭐', comp: Clube },
  { id: 'pedidos', module: 'pedidos', label: 'Pedidos', icon: '🎵', comp: Pedidos },
  { id: 'eventos', module: 'eventos', label: 'Eventos', icon: '🗓️', comp: Eventos },
  { id: 'financeiro', module: 'financeiro', label: 'Recebimentos', icon: '💰', comp: Financeiro },
  { id: 'comissoes', module: 'comissoes', label: 'Comissões', icon: '💸', comp: Comissoes },
  { id: 'casa_de_shows', module: 'casa_de_shows', label: 'Casa de Shows', icon: '🎟️', comp: CasaDeShows },
  { id: 'fila', module: 'fila', label: 'Fila de espera', icon: '⏳', comp: Fila },
  { id: 'comandos', module: 'comandos', label: 'Comandos', icon: '🎛️', comp: Comandos },
  { id: 'bloqueios', module: 'bloqueios', label: 'Atendimentos bloqueados', icon: '🚫', comp: Bloqueios },
  { id: 'delivery', module: 'delivery', label: 'Delivery', icon: '🛵', comp: Delivery },
  { id: 'rst_salao', module: 'restaurante', label: 'Salão', icon: '🍽️', comp: RstSalao },
  { id: 'rst_cozinha', module: 'restaurante', label: 'Cozinha', icon: '👨‍🍳', comp: RstCozinha },
  { id: 'rst_caixa', module: 'restaurante', label: 'Caixa', icon: '🧾', comp: RstCaixa },
  { id: 'rst_gestao', module: 'restaurante', label: 'Gestão', icon: '🏪', comp: RstGestao },
  { id: 'documentos', module: 'documentos', label: 'Documentos', icon: '📄', comp: Documentos },
  { id: 'beneficios', module: 'beneficios', label: 'Programa de benefícios M2', icon: '🎁', comp: Beneficios },
  { id: 'equipe', label: 'Equipe e acessos', icon: '🔑', comp: Equipe, soDono: true },
  { id: 'config', label: 'Configurações', icon: '⚙️', comp: Config, soDono: true },
];

export default function App() {
  const [admin, setAdmin] = useState(false);
  const [equipe, setEquipe] = useState(null); // telas da pessoa da equipe (null = administrador da empresa, vê tudo)
  const [logged, setLogged] = useState(!!getToken());
  const [page, setPage] = useState(() => location.hash.slice(1) || 'dashboard');
  const [nomeProg, setNomeProg] = useState('');
  const [upgrade, setUpgrade] = useState(null); // nome da função apagada que a pessoa tocou
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
    if (logged) api('/me').then((m) => { setAdmin(!!m.admin); setEquipe(m.equipe || null); }).catch(() => setAdmin(false));
    else setAdmin(false);
  }, [logged]);
  // O nome do programa de benefícios pode ter sido trocado pelo administrador: confere a cada tela aberta
  useEffect(() => {
    if (logged) api('/benefits/name').then((r) => setNomeProg(r?.name || '')).catch(() => {});
  }, [logged, page]);

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
  // nome e ícone que a empresa escolheu para cada item (em Configurações); sem escolha, vale o padrão
  const custom = company.menu_custom || {};
  const personalizado = (m) => ({ ...m, label: m.id === 'beneficios' ? (nomeProg || m.label) : nomeDoMenu(custom, m.id, m.label), icon: iconeDoMenu(custom, m.id, m.icon) });
  // Função desligada que o administrador deixou à vista aparece apagada, com cadeado, convidando ao upgrade
  const bloqueada = (m) => !!m.module && !moduleOn(company.modules, m.module) && company.locked_modules?.[m.module] === true;
  const liberada = (m) => !equipe || (!m.soDono && equipe.telas.includes(m.id));
  const visible = BASE_MENU.filter(liberada).filter((m) => !m.module || moduleOn(company.modules, m.module) || bloqueada(m))
    .map((m) => ({ ...personalizado(m), locked: bloqueada(m) }));
  const MENU = admin ? [...visible, ADMIN_ITEM] : visible;
  // Sem nenhum módulo ligado, o administrador começa direto na Administração
  const inicial = admin && !visible.some((m) => m.module && !m.locked) ? ADMIN_ITEM : (equipe?.inicio && MENU.find((m) => m.id === equipe.inicio && !m.locked)) || MENU.find((m) => !m.locked) || MENU[0];

  if (!logged) return <Login theme={theme} onLogin={(s) => { setCompany(s); setLogged(true); }} />;

  const go = (id) => {
    setPage(id);
    location.hash = id;
    if (window.innerWidth < 760) setCollapsed(true);
  };
  // Administrador vendo o painel de uma empresa ("Abrir painel" na Administração)
  const modoAdmin = !!localStorage.getItem(ADMIN_KEY);
  const voltarAdmin = () => {
    setToken(localStorage.getItem(ADMIN_KEY));
    localStorage.removeItem(ADMIN_KEY);
    localStorage.removeItem('crm_company');
    location.hash = 'admin';
    location.reload();
  };
  const atual = MENU.find((m) => m.id === page && !m.locked) || inicial;
  const Current = atual.comp;

  return (
    <MenuCustomContext.Provider value={custom}>
    <div className="layout">
      <aside className={'sidebar' + (collapsed ? ' collapsed' : '')}>
        <div className="brand">
          {company.logo ? <img className="logo-img" src={company.logo} alt="" /> : <span className="nav-icon">🏢</span>}
          <span>{company.name || 'Minha Empresa'}</span>
        </div>
        {MENU.map((m) => (
          <a key={m.id} href={'#' + m.id} className={'nav-item' + (atual.id === m.id ? ' active' : '') + (m.locked ? ' bloqueado' : '')} title={m.locked ? m.label + ' — disponível em outro plano' : m.label}
            onClick={(e) => {
              if (m.locked) { e.preventDefault(); setUpgrade(m.label); return; }
              // Ctrl/Cmd/Shift + clique e clique do meio: deixa o navegador abrir em outra aba
              if (e.ctrlKey || e.metaKey || e.shiftKey || e.button === 1) return;
              e.preventDefault(); go(m.id);
            }}>
            <span className="nav-icon">{m.icon}</span>
            <span>{m.label}</span>
            {m.locked && <span style={{ marginLeft: 'auto', display: 'inline-flex' }}><IconeCadeado size={13} /></span>}
          </a>
        ))}
        <div className="spacer" />
        <button className="nav-item" onClick={() => { setToken(null); localStorage.removeItem(ADMIN_KEY); localStorage.removeItem('crm_company'); setLogged(false); }}>
          <span className="nav-icon" style={{ display: 'inline-flex', justifyContent: 'center' }}><IconeSair /></span><span>Sair</span>
        </button>
      </aside>
      {/* No celular, tocar fora do menu aberto (na área da página) fecha o menu e volta pra onde estava */}
      {!collapsed && <div className="menu-fundo" onClick={() => setCollapsed(true)} />}
      <main className="main">
        {modoAdmin && (
          <div className="admin-banner">
            <span>Você está vendo o painel de <strong>{company.name}</strong> como administrador.</span>
            <button className="btn sm" onClick={voltarAdmin}>Voltar à administração</button>
          </div>
        )}
        <div className="topbar">
          <button className="btn" onClick={() => setCollapsed(!collapsed)}>☰ Menu</button>
          <label className="tema-sel" title="Tema">
            <IconeTema />
            <select value={theme} onChange={(e) => setTheme(e.target.value)} aria-label="Tema">
              {THEMES.map((t) => <option key={t.id} value={t.id}>{t.label}</option>)}
            </select>
          </label>
        </div>
        <Current company={company} menu={visible} />
      </main>
      {upgrade && <UpgradeModal company={company} nome={upgrade} onClose={() => setUpgrade(null)} />}
    </div>
    </MenuCustomContext.Provider>
  );
}
