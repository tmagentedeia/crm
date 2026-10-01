// Módulos que o administrador liga e desliga por empresa (companies.modules, JSONB: { agenda: true, clientes: false, ... }).
// Um módulo só está desligado quando vale explicitamente false: empresas que nunca tiveram módulos configurados
// (modules = {}) continuam vendo tudo. Desligar um módulo esconde o item do menu do painel; as rotas continuam respondendo.
// A mesma lista existe no painel (web/src/modules.js): mantenha as duas iguais.
export const MODULE_KEYS = ['dashboard', 'agenda', 'fila', 'profissionais', 'servicos', 'clientes', 'inativos', 'importar', 'atendente', 'comandos'];

// Aceita só módulos conhecidos com valor true/false. Devolve o objeto limpo, ou null se algo estiver errado.
export function cleanModules(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return null;
  const out = {};
  for (const [k, v] of Object.entries(input)) {
    if (!MODULE_KEYS.includes(k) || typeof v !== 'boolean') return null;
    out[k] = v;
  }
  return out;
}
