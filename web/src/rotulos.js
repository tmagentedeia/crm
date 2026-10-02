// Nomes que cada empresa dá às coisas de um módulo (o administrador define em Administração).
// Só muda o texto das telas; o funcionamento é o mesmo.
export const ROTULOS = {
  pedidos: {
    group: { label: 'Nome de cada ocasião (singular)', padrao: 'Live' },
    groups: { label: 'Nome das ocasiões (plural)', padrao: 'Lives' },
    item: { label: 'Nome de cada registro (singular)', padrao: 'Pedido' },
    items: { label: 'Nome dos registros (plural)', padrao: 'Pedidos' },
    song: { label: 'Nome do que é pedido', padrao: 'Música' },
    dedication: { label: 'Nome do campo de recado', padrao: 'Dedicatória' },
    queue: { label: 'Nome da fila', padrao: 'Fila' },
  },
};
export const rotulosDe = (company, modulo) => {
  const mine = company?.module_labels?.[modulo] || {};
  return Object.fromEntries(Object.entries(ROTULOS[modulo]).map(([k, v]) => [k, (mine[k] || '').trim() || v.padrao]));
};
export const minusc = (t) => String(t).charAt(0).toLowerCase() + String(t).slice(1);
