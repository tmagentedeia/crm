// Módulos que o administrador liga e desliga por empresa (companies.modules, JSONB: { agenda: true, clientes: false, ... }).
// Um módulo só está desligado quando vale explicitamente false: empresas que nunca tiveram módulos configurados
// (modules = {}) continuam vendo tudo. Desligar um módulo esconde o item do menu do painel; as rotas continuam respondendo.
// A mesma lista existe no painel (web/src/modules.js): mantenha as duas iguais.
export const MODULE_KEYS = ['dashboard', 'agenda', 'fila', 'profissionais', 'servicos', 'clientes', 'inativos', 'importar', 'atendente', 'comandos', 'bloqueios', 'campanhas', 'clube', 'pedidos', 'eventos'];

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

// Nomes e ícones do menu escolhidos pela empresa (companies.menu_custom: { profissionais: { icon: '💇', label: 'Equipe' } }).
// É só aparência: o painel continua identificando cada tela pelo mesmo código, então nada da lógica interna muda.
export const MENU_IDS = ['dashboard', 'agenda', 'fila', 'clientes', 'inativos', 'profissionais', 'servicos', 'importar', 'atendente', 'comandos', 'bloqueios', 'campanhas', 'clube', 'pedidos', 'eventos', 'config'];

// Devolve o objeto limpo (campos vazios somem), ou null se algo estiver errado.
export function cleanMenuCustom(input) {
  if (input === null || input === undefined) return {};
  if (typeof input !== 'object' || Array.isArray(input)) return null;
  const out = {};
  for (const [id, v] of Object.entries(input)) {
    if (!MENU_IDS.includes(id) || !v || typeof v !== 'object' || Array.isArray(v)) return null;
    const item = {};
    for (const [k, val] of Object.entries(v)) {
      if (k !== 'icon' && k !== 'label') return null;
      if (val === null || val === undefined) continue;
      if (typeof val !== 'string') return null;
      const t = val.trim();
      if (/[\u0000-\u001f<>]/.test(t)) return null;
      if (t === '') continue;
      if (k === 'icon' && t.length > 16) return null;
      if (k === 'label' && t.length > 30) return null;
      item[k] = t;
    }
    if (Object.keys(item).length) out[id] = item;
  }
  return out;
}
