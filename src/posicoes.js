// Posições (1, 2, 3…) das pessoas de uma venda. Quem foi tirado da venda deixa a posição vaga e ninguém muda de lugar,
// para o ingresso de quem ficou continuar valendo. v = { people, removed_seqs }
export const retirados = (v) => (Array.isArray(v?.removed_seqs) ? v.removed_seqs.map(Number) : []);
export const posicoesDe = (v) => {
  const fora = retirados(v);
  return Array.from({ length: Number(v.people) + fora.length }, (_, i) => i + 1).filter((n) => !fora.includes(n));
};
