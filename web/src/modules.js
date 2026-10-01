// Módulos que o administrador liga e desliga por empresa. Mesma lista de src/modules.js, no servidor.
export const MODULES = [
  { key: 'agenda', label: 'Agenda', desc: 'Agenda, Profissionais, Serviços e Fila de espera' },
  { key: 'clientes', label: 'Clientes e Leads', desc: 'Clientes e Leads, Retorno de inativos e Importar planilha' },
  { key: 'dashboard', label: 'Dashboard', desc: 'Tela de números e gráficos' },
  { key: 'atendente', label: 'Atendente', desc: 'Manual e avisos do atendente' },
];

// Um módulo só está desligado quando vale explicitamente false: empresas que nunca tiveram módulos configurados veem tudo.
export const moduleOn = (modules, key) => modules?.[key] !== false;
