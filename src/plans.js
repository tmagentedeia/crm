// Planos comerciais: cada plano é um conjunto de módulos ligados. Aplicar um plano a uma empresa liga esses módulos, desliga os demais
// e deixa à vista, apagados com cadeado (convite de upgrade), os que ficam de fora. O limite de profissionais NÃO muda com o plano.
// A mesma lista existe no painel (web/src/plans.js): mantenha as duas iguais.
import { MODULE_KEYS } from './modules.js';

const STARTER = ['dashboard', 'agenda', 'fila', 'profissionais', 'servicos', 'clientes', 'inativos', 'importar', 'atendente', 'comandos', 'eventos', 'financeiro'];
const PRO = [...STARTER, 'bloqueios', 'pedidos', 'comissoes', 'lembrete_cliente'];
const ADVANCED = [...PRO, 'campanhas', 'clube', 'assistente'];
export const PLANOS = { starter: STARTER, pro: PRO, advanced: ADVANCED };

// Módulos sem item de menu próprio: não entram na vitrine de upgrade
const SEM_MENU = ['assistente', 'lembrete_cliente'];
// Módulos fora dos planos: o administrador liga caso a caso; aplicar um plano não liga, não desliga e não coloca cadeado
const FORA_DOS_PLANOS = ['scenarium', 'beneficios', 'documentos'];

// { modules, locks } completos do plano, ou null se o plano não existe
export function aplicacaoDoPlano(plano) {
  const ligados = PLANOS[plano];
  if (!ligados) return null;
  const modules = Object.fromEntries(MODULE_KEYS.filter((k) => !FORA_DOS_PLANOS.includes(k)).map((k) => [k, ligados.includes(k)]));
  const locks = Object.fromEntries(MODULE_KEYS.filter((k) => !ligados.includes(k) && !SEM_MENU.includes(k) && !FORA_DOS_PLANOS.includes(k)).map((k) => [k, true]));
  return { modules, locks };
}
