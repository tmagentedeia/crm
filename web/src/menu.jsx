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
  { id: 'atendente', label: 'Atendente', icon: '🤖' },
  { id: 'clientes', label: 'Clientes e Leads', icon: '👥' },
  { id: 'agenda', label: 'Agenda', icon: '📅' },
  { id: 'profissionais', label: 'Profissionais', icon: '✂️' },
  { id: 'servicos', label: 'Produtos e Serviços', icon: '🏢' },
  { id: 'inativos', label: 'Retorno de inativos', icon: '🔁' },
  { id: 'campanhas', label: 'Campanhas', icon: '📣' },
  { id: 'clube', label: 'Programa de assinaturas', icon: '⭐' },
  { id: 'pedidos', label: 'Pedidos', icon: '🎵' },
  { id: 'eventos', label: 'Eventos', icon: '🗓️' },
  { id: 'comissoes', label: 'Comissões', icon: '💸' },
  { id: 'casa_de_shows', label: 'Casa de Shows', icon: '🎟️' },
  { id: 'lista_evento', label: 'Lista do evento', icon: '📋' },
  { id: 'financeiro', label: 'Recebimentos', icon: '💰' },
  { id: 'fila', label: 'Fila de espera', icon: '⏳' },
  { id: 'comandos', label: 'Comandos', icon: '🎛️' },
  { id: 'bloqueios', label: 'Atendimentos bloqueados', icon: '🚫' },
  { id: 'delivery', label: 'Delivery', icon: '🛵' },
  { id: 'rst_salao', label: 'Salão', icon: '🍽️' },
  { id: 'rst_cozinha', label: 'Cozinha', icon: '👨‍🍳' },
  { id: 'rst_caixa', label: 'Caixa', icon: '🧾' },
  { id: 'rst_gestao', label: 'Gestão', icon: '🏪' },
  { id: 'documentos', label: 'Documentos', icon: '📄' },
  { id: 'beneficios', label: 'Programa de benefícios M2', icon: '🎁' },
  { id: 'config', label: 'Configurações', icon: '⚙️' },
];
