// Manual do atendente em caixas (lado do servidor). Mesma regra do painel (web/src/manualSecoes.js):
// as caixas ficam separadas por uma linha "=====" e o nome de cada caixa é a primeira linha com texto.
export const SEPARADOR = '=====';
const ehSeparador = (l) => /^={5}[ \t]*$/.test(l);

export const temSeparador = (texto) => String(texto ?? '').split('\n').some(ehSeparador);

export function lerCaixas(texto) {
  const caixas = [[]];
  for (const l of String(texto ?? '').split('\n')) {
    if (ehSeparador(l)) caixas.push([]);
    else caixas[caixas.length - 1].push(l);
  }
  return caixas.map((linhas) => linhas.join('\n'));
}

export const juntarCaixas = (caixas) => caixas.join(`\n${SEPARADOR}\n`);

// nome da caixa: primeira linha com texto
export function tituloDe(corpo) {
  const l = String(corpo ?? '').split('\n').find((x) => x.trim());
  return l ? l.trim() : '';
}

const norm = (s) => String(s ?? '').trim().replace(/\s+/g, ' ').toLocaleLowerCase('pt-BR');

// Acha UMA caixa por número (1, 2, 3…) ou por título. Devolve { i } ou { erro, status }.
export function acharCaixa(caixas, { n, titulo }) {
  if (n !== undefined && n !== null && n !== '') {
    const i = Number(n) - 1;
    if (!Number.isInteger(i) || i < 0 || i >= caixas.length) return { erro: `Não existe a caixa ${n}. O manual tem ${caixas.length} caixas.`, status: 404 };
    return { i };
  }
  const t = norm(titulo);
  if (!t) return { erro: 'Informe o título (ou o número) da caixa', status: 400 };
  const achadas = caixas.map((c, i) => [i, norm(tituloDe(c))]).filter(([, x]) => x === t);
  if (!achadas.length) return { erro: 'Não achei nenhuma caixa com esse título. Veja a lista de caixas e use o título exato.', status: 404 };
  if (achadas.length > 1) return { erro: `Há ${achadas.length} caixas com esse título. Use o número da caixa.`, status: 409 };
  return { i: achadas[0][0] };
}
