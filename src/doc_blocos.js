// Modelos de documento montados por blocos (logotipo, título, texto, tabela de dados, QR Code...).
// O cliente edita os blocos no painel, sem mexer em código; aqui eles viram o HTML com variáveis {{assim}} que o gerador de PDF já usa.
const FONTES = {
  sans: 'Arial,Helvetica,sans-serif',
  serif: 'Georgia,"Times New Roman",serif',
  mono: '"Courier New",monospace',
};
const IMG_MAX = 1024 * 1024 * 1.4;   // texto da imagem em base64 (~1 MB de arquivo)
const imagemOk = (v) => (typeof v === 'string' && v.length <= IMG_MAX && /^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/.test(v) ? v : '');
const AJUSTES = { cobrir: 'cover', conter: 'contain', esticar: '100% 100%' };
const MOLDURAS = ['nenhuma', 'simples', 'ingresso', 'bilhete'];
const ALINHA = ['left', 'center', 'right'];
export const TIPOS_BLOCO = ['logo', 'titulo', 'texto', 'faixa', 'dados', 'lista', 'qrcode', 'atendente', 'espaco', 'linha'];
const MAX_BLOCOS = 60;

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const cor = (v, pad) => (/^#[0-9a-fA-F]{6}$/.test(String(v ?? '')) ? String(v) : pad);
const num = (v, min, max, pad) => { const n = Number(v); return Number.isFinite(n) ? Math.min(max, Math.max(min, Math.round(n))) : pad; };
const txt = (v, max = 2000) => String(v ?? '').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '').slice(0, max);
const alinha = (v, pad = 'left') => (ALINHA.includes(v) ? v : pad);
// texto simples com {{variáveis}}: letras escapadas, quebras de linha viram <br>
const linhas = (s) => esc(s).replace(/\r?\n/g, '<br>');

// Garante um documento válido e dentro dos limites, venha o que vier do navegador
export function normalizarDoc(d) {
  const doc = d && typeof d === 'object' && !Array.isArray(d) ? d : {};
  const cfg = doc.config && typeof doc.config === 'object' ? doc.config : {};
  const config = {
    fonte: FONTES[cfg.fonte] ? cfg.fonte : 'sans',
    cor: cor(cfg.cor, '#1f2937'),
    destaque: cor(cfg.destaque, '#1f2937'),
    fundo: cor(cfg.fundo, '#ffffff'),
    moldura: MOLDURAS.includes(cfg.moldura) ? cfg.moldura : cfg.borda === false ? 'nenhuma' : 'simples',
    corMoldura: cor(cfg.corMoldura, '#e6e6e6'),
    fundoImagem: imagemOk(cfg.fundoImagem),
    fundoAjuste: AJUSTES[cfg.fundoAjuste] ? cfg.fundoAjuste : 'cobrir',
    alturaMin: num(cfg.alturaMin, 0, 1800, 0),
    largura: cfg.largura === 0 || cfg.largura === '0' ? 0 : num(cfg.largura, 260, 900, 0),
    margem: num(cfg.margem, 0, 80, 28),
  };
  const lista = Array.isArray(doc.blocos) ? doc.blocos.slice(0, MAX_BLOCOS) : [];
  const blocos = [];
  for (const b of lista) {
    if (!b || typeof b !== 'object' || !TIPOS_BLOCO.includes(b.tipo)) continue;
    const o = { tipo: b.tipo };
    switch (b.tipo) {
      case 'logo': o.alinhamento = alinha(b.alinhamento, 'center'); o.altura = num(b.altura, 20, 220, 70); o.largura = b.largura === 0 ? 0 : num(b.largura, 40, 600, 0); o.caixa = !!b.caixa; break;
      case 'titulo': o.texto = txt(b.texto, 300); o.tamanho = num(b.tamanho, 14, 64, 30); o.alinhamento = alinha(b.alinhamento, 'center'); o.cor = cor(b.cor, ''); o.negrito = b.negrito === undefined ? true : !!b.negrito; break;
      case 'texto': o.texto = txt(b.texto, 20000); o.tamanho = num(b.tamanho, 9, 40, 15); o.alinhamento = alinha(b.alinhamento); o.cor = cor(b.cor, ''); o.negrito = !!b.negrito; o.italico = !!b.italico; break;
      case 'faixa': o.texto = txt(b.texto, 200); o.fundo = cor(b.fundo, ''); o.cor = cor(b.cor, '#ffffff'); o.alinhamento = alinha(b.alinhamento); break;
      case 'dados': o.linhas = (Array.isArray(b.linhas) ? b.linhas.slice(0, 40) : []).map((l) => ({ rotulo: txt(l?.rotulo, 120), valor: txt(l?.valor, 400) })); o.larguraRotulo = num(b.larguraRotulo, 20, 60, 35); break;
      case 'lista': o.itens = (Array.isArray(b.itens) ? b.itens.slice(0, 40) : []).map((i) => txt(i, 400)); o.tamanho = num(b.tamanho, 9, 30, 14); break;
      case 'qrcode': o.alinhamento = alinha(b.alinhamento, 'center'); o.caixa = !!b.caixa; o.mostrarCodigo = b.mostrarCodigo === undefined ? true : !!b.mostrarCodigo; break;
      case 'atendente': o.tamanho = num(b.tamanho, 9, 40, 16); o.alinhamento = alinha(b.alinhamento); o.negrito = !!b.negrito; break;
      case 'espaco': o.altura = num(b.altura, 4, 200, 20); break;
      case 'linha': o.cor = cor(b.cor, '#d8d8d8'); break;
    }
    blocos.push(o);
  }
  return { config, blocos };
}

function htmlDoBloco(b, config) {
  switch (b.tipo) {
    case 'logo': return `<div style="text-align:${b.alinhamento};margin:8px 0"><div style="display:inline-block;${b.largura ? `width:${b.largura}px;max-width:100%;` : 'max-width:100%;'}height:${b.altura}px;line-height:0;${b.caixa ? 'border:1px solid #222;padding:8px;box-sizing:content-box;' : ''}"><img src="{{logotipo_src}}" alt="" style="display:block;margin:0 auto;height:100%;${b.largura ? 'width:100%;' : 'max-width:100%;'}object-fit:contain"></div></div>`;
    case 'titulo': return `<div style="font-size:${b.tamanho}px;font-weight:${b.negrito ? 'bold' : 'normal'};text-align:${b.alinhamento};margin:10px 0${b.cor ? `;color:${b.cor}` : ''}">${linhas(b.texto)}</div>`;
    case 'texto': return `<div style="font-size:${b.tamanho}px;text-align:${b.alinhamento};margin:8px 0;line-height:1.45${b.negrito ? ';font-weight:bold' : ''}${b.italico ? ';font-style:italic' : ''}${b.cor ? `;color:${b.cor}` : ''}">${linhas(b.texto)}</div>`;
    case 'faixa': return `<div style="background:${b.fundo || config.destaque};color:${b.cor};padding:8px 12px;border-radius:5px;font-size:16px;font-weight:bold;text-align:${b.alinhamento};margin:16px 0 8px">${linhas(b.texto)}</div>`;
    case 'dados': return `<table style="width:100%;border-collapse:collapse;margin:6px 0">${b.linhas.map((l) => `<tr><td style="width:${b.larguraRotulo}%;padding:8px 10px;border-bottom:1px solid #e3e3e3;background:#f7f7f7;font-weight:bold;vertical-align:top">${linhas(l.rotulo)}</td><td style="padding:8px 10px;border-bottom:1px solid #e3e3e3;vertical-align:top">${linhas(l.valor)}</td></tr>`).join('')}</table>`;
    case 'lista': return `<ul style="font-size:${b.tamanho}px;line-height:1.5;margin:8px 0;padding-left:22px">${b.itens.filter(Boolean).map((i) => `<li>${linhas(i)}</li>`).join('')}</ul>`;
    case 'qrcode': return `<div style="text-align:${b.alinhamento};margin:16px 0"><div style="display:inline-block;${b.caixa ? 'border:1px solid #222;padding:10px;' : ''}">{{{qrcode}}}</div>${b.mostrarCodigo ? '<div style="font-size:11px;color:#666;margin-top:4px">{{codigo}}</div>' : ''}</div>`;
    case 'atendente': return `<div style="font-size:${b.tamanho}px;text-align:${b.alinhamento};margin:10px 0${b.negrito ? ';font-weight:bold' : ''}">{{{text}}}</div>`;
    case 'espaco': return `<div style="height:${b.altura}px"></div>`;
    case 'linha': return `<hr style="border:0;border-top:1px solid ${b.cor};margin:14px 0">`;
    default: return '';
  }
}

export function blocosParaHtml(entrada, titulo = 'Documento') {
  const { config, blocos } = normalizarDoc(entrada);
  const miolo = blocos.map((b) => htmlDoBloco(b, config)).join('\n');
  const arte = config.fundoImagem ? `;background-image:url('${config.fundoImagem}');background-size:${AJUSTES[config.fundoAjuste]};background-position:center;background-repeat:no-repeat` : '';
  const base = `font-family:${FONTES[config.fonte]};color:${config.cor};background:${config.fundo};padding:${config.margem}px${arte}${config.alturaMin ? `;min-height:${config.alturaMin}px;box-sizing:border-box` : ''}`;
  const largura = config.largura ? `max-width:${config.largura}px;margin:0 auto;` : '';
  let corpo;
  // bilhete recortado: os quatro cantos ganham um arco para dentro (fundo escuro por baixo faz o contorno)
  const recorte = (r, cor) => ['0 0', '100% 0', '0 100%', '100% 100%'].map((c) => `radial-gradient(circle at ${c}, transparent ${r - 1}px, ${cor} ${r}px) ${c.replace('0 ', 'left ').replace('100% 0', 'right top').replace('0 100%', 'left bottom').replace('100% 100%', 'right bottom')}/51% 51% no-repeat`).join(',');
  if (config.moldura === 'bilhete') corpo = `<div style="${largura}background:${recorte(22, '#222')};padding:3px"><div style="background:${recorte(19, config.corMoldura)};padding:22px"><div style="${base};border:1px solid #222">\n${miolo}\n</div></div></div>`;
  else   if (config.moldura === 'ingresso') corpo = `<div style="${largura}background:${config.corMoldura};border:3px solid #222;border-radius:26px;padding:14px"><div style="${base};border:1px solid #222">\n${miolo}\n</div></div>`;
  else corpo = `<div style="${largura}${base}${config.moldura === 'simples' ? ';border:1px solid #d8d8d8;border-radius:14px' : ''}">\n${miolo}\n</div>`;
  return `<!DOCTYPE html><html lang="pt-BR"><head><meta charset="UTF-8"><title>${esc(titulo)}</title><style>body{margin:0;padding:24px;background:${config.moldura === 'nenhuma' ? config.fundo : '#ffffff'}}</style></head><body>${corpo}</body></html>`;
}

// Quantidade de caracteres do texto fixo do modelo (o que o cliente escreve), sem contar as variáveis nem o código.
// Define se o documento é "simples" ou "completo" no plano.
export const LIMITE_TEXTO_SIMPLES = 1500;
const semVariaveis = (t) => String(t ?? '').replace(/\{\{\{?[^}]*\}?\}\}/g, '');
export function contarTexto({ blocks, html }) {
  let partes = [];
  if (blocks) {
    for (const b of normalizarDoc(blocks).blocos) {
      if (['titulo', 'texto', 'faixa'].includes(b.tipo)) partes.push(b.texto);
      else if (b.tipo === 'dados') b.linhas.forEach((l) => partes.push(l.rotulo, l.valor));
      else if (b.tipo === 'lista') partes.push(...b.itens);
    }
  } else {
    partes.push(String(html ?? '').replace(/<(style|script)[\s\S]*?<\/\1>/gi, ' ').replace(/<[^>]*>/g, ' ').replace(/&nbsp;/g, ' '));
  }
  return semVariaveis(partes.join(' ')).replace(/\s+/g, ' ').trim().length;
}

// ---------- modelos de exemplo feitos de blocos ----------
export const INGRESSO_EXEMPLO = {
  config: { fonte: 'sans', cor: '#1f2937', destaque: '#111827', fundo: '#ffffff', moldura: 'simples', margem: 28 },
  blocos: [
    { tipo: 'logo', alinhamento: 'center', altura: 80 },
    { tipo: 'titulo', texto: 'INGRESSO', tamanho: 34, alinhamento: 'center', negrito: true },
    { tipo: 'texto', texto: '{{empresa}} · acesso ao evento', tamanho: 14, alinhamento: 'center', cor: '#666666' },
    { tipo: 'linha', cor: '#d8d8d8' },
    { tipo: 'faixa', texto: 'Seu ingresso', cor: '#ffffff', alinhamento: 'left' },
    { tipo: 'dados', larguraRotulo: 30, linhas: [
      { rotulo: 'Nome', valor: '{{nome}}' },
      { rotulo: 'Evento', valor: '{{evento}}' },
      { rotulo: 'Data', valor: '{{evento_data}}' },
      { rotulo: 'Portas', valor: '{{abertura}}' },
      { rotulo: 'Local', valor: '{{local}}' },
      { rotulo: 'Setor', valor: '{{setor}}' },
      { rotulo: 'Mesa', valor: '{{mesa}}' },
      { rotulo: 'Pessoa', valor: '{{pessoa}}' },
    ] },
    { tipo: 'atendente', tamanho: 15, alinhamento: 'left', negrito: false },
    { tipo: 'qrcode', alinhamento: 'center', mostrarCodigo: true },
    { tipo: 'texto', texto: 'Ingresso Nº #{{numero_curto}}', tamanho: 18, alinhamento: 'center', negrito: true },
    { tipo: 'faixa', texto: 'Informações importantes', cor: '#ffffff', alinhamento: 'left' },
    { tipo: 'lista', tamanho: 14, itens: ['Apresente o QR Code na entrada, em papel ou no celular.', 'Este ingresso é pessoal e tem validade única.'] },
  ],
};

// Ingresso vertical, no formato de um bilhete: moldura de ingresso, logotipo, evento, quem entra e o QR Code
export const INGRESSO_VERTICAL = {
  config: { fonte: 'sans', cor: '#111111', destaque: '#111111', fundo: '#ffffff', moldura: 'bilhete', largura: 380, margem: 22 },
  blocos: [
    { tipo: 'titulo', texto: 'INGRESSO', tamanho: 36, alinhamento: 'center', negrito: true },
    { tipo: 'logo', alinhamento: 'center', altura: 90, largura: 240, caixa: true },
    { tipo: 'espaco', altura: 6 },
    { tipo: 'titulo', texto: '{{evento}}', tamanho: 24, alinhamento: 'center', negrito: true },
    { tipo: 'texto', texto: '{{evento_data}}', tamanho: 17, alinhamento: 'center', negrito: true },
    { tipo: 'texto', texto: '{{local}}\n{{endereco}}', tamanho: 15, alinhamento: 'center', negrito: true },
    { tipo: 'espaco', altura: 6 },
    { tipo: 'titulo', texto: '{{nome}}', tamanho: 24, alinhamento: 'center', negrito: true },
    { tipo: 'texto', texto: '{{setor}}\nMesa para {{lugares_mesa}} lugares\nComprador: {{comprador}}', tamanho: 16, alinhamento: 'center', negrito: true },
    { tipo: 'qrcode', alinhamento: 'center', caixa: true, mostrarCodigo: true },
    { tipo: 'texto', texto: 'Apresente este QR Code na entrada, em papel ou no celular.\nIngresso pessoal e de uso único.', tamanho: 12, alinhamento: 'center', cor: '#444444' },
  ],
};
