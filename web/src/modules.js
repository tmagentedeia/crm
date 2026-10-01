// Módulos que o administrador liga e desliga por empresa. Mesma lista de src/modules.js, no servidor.
// Cada módulo é um item do menu do painel.
export const MODULES = [
  { key: 'dashboard', label: 'Dashboard', desc: 'Tela de números e gráficos' },
  { key: 'agenda', label: 'Agenda', desc: 'Agenda de horários' },
  { key: 'fila', label: 'Fila de espera', desc: 'Clientes aguardando um horário' },
  { key: 'profissionais', label: 'Profissionais', desc: 'Cadastro e horários dos profissionais' },
  { key: 'servicos', label: 'Serviços', desc: 'Serviços, preços e categorias' },
  { key: 'clientes', label: 'Clientes e Leads', desc: 'Cadastro de clientes e leads' },
  { key: 'inativos', label: 'Retorno de inativos', desc: 'Clientes que sumiram e podem voltar' },
  { key: 'importar', label: 'Importar planilha', desc: 'Trazer clientes de uma planilha' },
  { key: 'atendente', label: 'Atendente', desc: 'Manual e atualizações provisórias do atendente' },
  { key: 'comandos', label: 'Comandos', desc: 'Comandos para pausar e liberar o atendente' },
  { key: 'bloqueios', label: 'Atendimentos bloqueados', desc: 'Bloquear e liberar contatos que o atendente não deve atender' },
];

// Antes, alguns módulos eram um só (ex.: "agenda" ligava também Fila, Profissionais e Serviços).
// Enquanto uma empresa não tiver o módulo novo definido, ele segue o módulo antigo.
const PAI = { fila: 'agenda', profissionais: 'agenda', servicos: 'agenda', inativos: 'clientes', importar: 'clientes', comandos: 'atendente', bloqueios: 'atendente' };

// Um módulo só está desligado quando vale explicitamente false: empresas que nunca tiveram módulos configurados veem tudo.
export const moduleOn = (modules, key) =>
  modules?.[key] !== undefined ? modules[key] !== false : PAI[key] ? modules?.[PAI[key]] !== false : true;
