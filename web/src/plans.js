// Planos comerciais: mesma lista de src/plans.js, no servidor.
import { moduleOn } from './modules.js';

const STARTER = ['dashboard', 'agenda', 'fila', 'profissionais', 'servicos', 'clientes', 'inativos', 'importar', 'atendente', 'comandos', 'eventos', 'financeiro'];
const PRO = [...STARTER, 'bloqueios', 'pedidos', 'comissoes', 'lembrete_cliente', 'documentos'];
const ADVANCED = [...PRO, 'campanhas', 'clube', 'assistente'];
export const PLANOS = [
  { id: 'starter', nome: 'Starter', ligados: STARTER },
  { id: 'pro', nome: 'Pro', ligados: PRO },
  { id: 'advanced', nome: 'Advanced', ligados: ADVANCED },
];
const TODOS = ADVANCED;

// Plano em que a empresa se encaixa exatamente (pelos módulos ligados), ou null se foi personalizada
export const planoDe = (modules) => PLANOS.find((p) => TODOS.every((k) => moduleOn(modules, k) === p.ligados.includes(k)))?.nome || null;
