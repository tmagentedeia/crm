// Módulos que o administrador liga e desliga por empresa. Mesma lista de src/modules.js, no servidor.
// Cada módulo é um item do menu do painel.
export const MODULES = [
  { key: 'dashboard', label: 'Dashboard', desc: 'Tela de números e gráficos' },
  { key: 'atendente', label: 'Atendente', desc: 'Manual e atualizações provisórias do atendente' },
  { key: 'clientes', label: 'Clientes e Leads', desc: 'Cadastro de clientes e leads' },
  { key: 'clube', label: 'Programa de benefícios', desc: 'Marcar clientes como membros de um programa com níveis e benefícios' },
  { key: 'pedidos', label: 'Pedidos', desc: 'Pedidos de música por live, com franquia do programa de benefícios e resumo do mês' },
  { key: 'financeiro', label: 'Recebimentos', desc: 'Chaves Pix aceitas e conferência dos comprovantes recebidos' },
  { key: 'comissoes', label: 'Comissões', desc: 'Comissão dos profissionais sobre serviços e produtos, com fechamento por período' },
  { key: 'eventos', label: 'Eventos', desc: 'Compromissos avulsos (lives, reuniões, shows), sem profissional nem serviço' },
  { key: 'agenda', label: 'Agenda', desc: 'Agenda de horários' },
  { key: 'profissionais', label: 'Profissionais', desc: 'Cadastro e horários dos profissionais' },
  { key: 'servicos', label: 'Produtos e Serviços', desc: 'Serviços, produtos, preços e categorias' },
  { key: 'inativos', label: 'Retorno de inativos', desc: 'Clientes que sumiram e podem voltar' },
  { key: 'campanhas', label: 'Campanhas', desc: 'Envio de mensagens em lote para clientes e leads, com ritmo seguro' },
  { key: 'fila', label: 'Fila de espera', desc: 'Clientes aguardando um horário' },
  { key: 'comandos', label: 'Comandos', desc: 'Comandos para pausar e liberar o atendente' },
  { key: 'bloqueios', label: 'Atendimentos bloqueados', desc: 'Bloquear e liberar contatos que o atendente não deve atender' },
  { key: 'importar', label: 'Importar planilha', desc: 'Trazer clientes de uma planilha' },
];

// Antes, alguns módulos eram um só (ex.: "agenda" ligava também Fila, Profissionais e Serviços).
// Enquanto uma empresa não tiver o módulo novo definido, ele segue o módulo antigo.
const PAI = { fila: 'agenda', profissionais: 'agenda', servicos: 'agenda', inativos: 'clientes', campanhas: 'clientes', clube: 'clientes', importar: 'clientes', comandos: 'atendente', bloqueios: 'atendente' };

// Um módulo só está desligado quando vale explicitamente false: empresas que nunca tiveram módulos configurados veem tudo.
// O programa de benefícios e os Pedidos são opcionais: só aparece quando o administrador liga.
export const moduleOn = (modules, key) =>
  key === 'clube' || key === 'pedidos' || key === 'eventos' || key === 'financeiro' || key === 'assistente' || key === 'comissoes' ? modules?.[key] === true :
  modules?.[key] !== undefined ? modules[key] !== false : PAI[key] ? modules?.[PAI[key]] !== false : true;
