import React, { createContext, useContext } from 'react';

// Nomes e ícones do menu que a empresa escolheu (company.menu_custom). Só aparência: o painel segue
// identificando cada tela pelo código de sempre.
export const MenuCustomContext = createContext({});

export const nomeDoMenu = (custom, id, padrao) => custom?.[id]?.label || padrao;
export const iconeDoMenu = (custom, id, padrao) => custom?.[id]?.icon || padrao;

// Título de página que acompanha o nome escolhido para o item do menu
export function Nome({ id, children }) {
  const custom = useContext(MenuCustomContext);
  return <>{nomeDoMenu(custom, id, children)}</>;
}

// Ícones sugeridos na hora de escolher
export const ICONES = ['📊','📅','🗓️','⏳','👥','👤','🧑‍💼','🔁','✂️','💈','💇‍♀️','💅','🏢','🏠','📥','📋','📝','🤖','🎛️','⚙️','💬','📞','⭐','💰','🧾','📦','🛒','🔧','🩺','🦷','🐶','🎵','🎤','🎬','📷','🚗','🍽️','🍰','☕','🏋️','📚','🎓','🔔','📌','🔍','📈','💡','🎯','🤝','❤️'];

// Itens do menu que a empresa pode renomear / trocar o ícone (mesmos padrões do menu em App.jsx)
export const MENU_PADRAO = [
  { id: 'dashboard', label: 'Dashboard', icon: '📊' },
  { id: 'agenda', label: 'Agenda', icon: '📅' },
  { id: 'fila', label: 'Fila de espera', icon: '⏳' },
  { id: 'clientes', label: 'Clientes e Leads', icon: '👥' },
  { id: 'inativos', label: 'Retorno de inativos', icon: '🔁' },
  { id: 'profissionais', label: 'Profissionais', icon: '✂️' },
  { id: 'servicos', label: 'Serviços', icon: '🏢' },
  { id: 'importar', label: 'Importar planilha', icon: '📥' },
  { id: 'atendente', label: 'Atendente', icon: '🤖' },
  { id: 'comandos', label: 'Comandos', icon: '🎛️' },
  { id: 'bloqueios', label: 'Atendimentos bloqueados', icon: '🚫' },
  { id: 'config', label: 'Configurações', icon: '⚙️' },
];
