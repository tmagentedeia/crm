// Manual do atendente em várias caixas de texto.
// O manual continua sendo um texto só (é esse texto que o atendente recebe): as caixas ficam separadas por uma
// linha com "=====", que o painel tira do texto antes de entregar ao atendente. Quem nunca dividiu em caixas
// continua com o texto corrido, sem nada mudar.

export const SEPARADOR = '=====';
const ehSeparador = (l) => /^={5}[ \t]*$/.test(l);

export const temSecoes = (texto) => String(texto || '').split('\n').some(ehSeparador);

// texto -> [{ corpo }]
export function lerSecoes(texto) {
  const caixas = [[]];
  for (const l of String(texto || '').split('\n')) {
    if (ehSeparador(l)) caixas.push([]);
    else caixas[caixas.length - 1].push(l);
  }
  return caixas.map((linhas) => ({ corpo: linhas.join('\n') }));
}

// [{ corpo }] -> texto
export const juntarSecoes = (secs) => secs.map((s) => s.corpo).join(`\n${SEPARADOR}\n`);

// primeira linha com texto: serve de nome da caixa na lista
export function rotulo(corpo) {
  const l = String(corpo || '').split('\n').find((x) => x.trim());
  return l ? (l.trim().length > 80 ? `${l.trim().slice(0, 80)}…` : l.trim()) : '(vazia)';
}

// Uma linha parece título? (tudo em maiúsculas, curta, sem ser frase solta nem item de lista)
export function pareceTitulo(linha) {
  const t = linha.trim();
  if (t.length < 6 || t.length > 90) return false;
  if (/^[-*•]|^\d+[.)]\s/.test(t)) return false;
  if (/[.!?]$/.test(t)) return false;
  const semParenteses = t.replace(/\([^)]*\)/g, ' ');
  if (/:\s*\S/.test(semParenteses)) return false;          // "TÍTULO: texto" é frase, não título
  const letras = semParenteses.match(/\p{L}/gu) || [];
  if (letras.length < 6) return false;
  const maiusculas = semParenteses.match(/\p{Lu}/gu) || [];
  return maiusculas.length / letras.length >= 0.8;
}

// Divide em caixas antes de cada título em maiúsculas (o título fica no começo da caixa dele).
export function sugerirSecoes(texto) {
  const saida = [];
  let n = 0;
  let jaTemTexto = false;
  for (const l of String(texto || '').split('\n')) {
    if (!ehSeparador(l) && jaTemTexto && pareceTitulo(l)) {
      // não separa duas vezes seguidas (título logo abaixo de outro título)
      const ant = saida.slice().reverse().find((x) => x.trim());
      if (ant !== undefined && !ehSeparador(ant)) { saida.push(SEPARADOR); n++; }
    }
    if (l.trim()) jaTemTexto = true;
    saida.push(l);
  }
  return { texto: saida.join('\n'), quantas: n };
}

// tira os separadores (usado pelo teste; o painel faz o mesmo no servidor)
export const semSeparadores = (texto) => String(texto || '').split('\n').filter((l) => !ehSeparador(l)).join('\n');
