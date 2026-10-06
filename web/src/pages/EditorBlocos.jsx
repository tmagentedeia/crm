import React, { useEffect, useRef, useState } from 'react';
import { api } from '../api.js';

// Editor visual dos modelos de documento: o modelo é uma lista de blocos que o cliente move, ajusta e preenche sem código.
export const NOVO_DOC = {
  config: { fonte: 'sans', cor: '#1f2937', destaque: '#1f2937', fundo: '#ffffff', moldura: 'simples', largura: 0, margem: 28 },
  blocos: [
    { tipo: 'logo', alinhamento: 'center', altura: 70 },
    { tipo: 'titulo', texto: 'Título do documento', tamanho: 30, alinhamento: 'center', negrito: true },
    { tipo: 'texto', texto: 'Cliente: {{nome}}', tamanho: 15, alinhamento: 'left' },
  ],
};

const NOMES = {
  logo: 'Logotipo', titulo: 'Título', texto: 'Texto', faixa: 'Faixa de seção', dados: 'Tabela de dados', lista: 'Lista com marcadores',
  qrcode: 'QR Code', atendente: 'Dados enviados pelo atendimento', espaco: 'Espaço em branco', linha: 'Linha divisória',
};
const PADRAO = {
  logo: { tipo: 'logo', alinhamento: 'center', altura: 70 },
  titulo: { tipo: 'titulo', texto: 'Título', tamanho: 28, alinhamento: 'center', negrito: true, cor: '' },
  texto: { tipo: 'texto', texto: 'Escreva aqui. Use as variáveis para os dados do cliente.', tamanho: 15, alinhamento: 'left', cor: '', negrito: false, italico: false },
  faixa: { tipo: 'faixa', texto: 'Seção', fundo: '', cor: '#ffffff', alinhamento: 'left' },
  dados: { tipo: 'dados', larguraRotulo: 35, linhas: [{ rotulo: 'Nome', valor: '{{nome}}' }, { rotulo: 'Telefone', valor: '{{telefone}}' }] },
  lista: { tipo: 'lista', tamanho: 14, itens: ['Primeiro item', 'Segundo item'] },
  qrcode: { tipo: 'qrcode', alinhamento: 'center', mostrarCodigo: true },
  atendente: { tipo: 'atendente', tamanho: 16, alinhamento: 'left', negrito: false },
  espaco: { tipo: 'espaco', altura: 20 },
  linha: { tipo: 'linha', cor: '#d8d8d8' },
};
const ALINHA = [['left', 'Esquerda'], ['center', 'Centro'], ['right', 'Direita']];
const FONTES = [['sans', 'Moderna (sem serifa)'], ['serif', 'Clássica (com serifa)'], ['mono', 'Máquina de escrever']];
const cx = { display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'flex-end' };

// campo de texto que lembra o foco para receber variáveis
const Campo = ({ foco, valor, aoMudar, multi, rows = 3, ...resto }) => {
  const Tag = multi ? 'textarea' : 'input';
  return <Tag {...resto} rows={multi ? rows : undefined} value={valor} onChange={(e) => aoMudar(e.target.value)}
    onFocus={(e) => { foco.current = { el: e.target, aplicar: aoMudar }; }} />;
};
const Alinha = ({ valor, aoMudar }) => (
  <div className="field"><label>Alinhamento</label>
    <select value={valor} onChange={(e) => aoMudar(e.target.value)}>{ALINHA.map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></div>
);
const Num = ({ rotulo, valor, aoMudar, min, max, passo = 1 }) => (
  <div className="field" style={{ width: 110 }}><label>{rotulo}</label><input type="number" min={min} max={max} step={passo} value={valor} onChange={(e) => aoMudar(Number(e.target.value))} /></div>
);
const Cor = ({ rotulo, valor, aoMudar, padrao }) => (
  <div className="field" style={{ width: 120 }}><label>{rotulo}</label>
    <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
      <input type="color" value={valor || padrao} onChange={(e) => aoMudar(e.target.value)} style={{ width: 44, padding: 0 }} />
      {valor && valor !== padrao && <button type="button" className="btn sm" onClick={() => aoMudar('')} title="Voltar à cor padrão">padrão</button>}
    </div></div>
);
const Marca = ({ rotulo, valor, aoMudar }) => <label style={{ display: 'flex', gap: 6, alignItems: 'center', paddingBottom: 8 }}><input type="checkbox" checked={!!valor} onChange={(e) => aoMudar(e.target.checked)} /> {rotulo}</label>;


export default function EditorBlocos({ doc, onChange, variaveis, logo }) {
  const foco = useRef(null);          // último campo de texto em que a pessoa clicou: é nele que a variável entra
  const [html, setHtml] = useState('');
  const [erro, setErro] = useState('');

  useEffect(() => {
    const t = setTimeout(() => {
      api('/documents/preview', { method: 'POST', body: { blocks: doc } }).then((r) => { setHtml(r.html); setErro(''); }).catch((e) => setErro(e.message));
    }, 450);
    return () => clearTimeout(t);
  }, [doc, logo]);

  const setBloco = (i, patch) => onChange({ ...doc, blocos: doc.blocos.map((b, j) => (j === i ? { ...b, ...patch } : b)) });
  const mover = (i, d) => {
    const j = i + d; if (j < 0 || j >= doc.blocos.length) return;
    const l = [...doc.blocos]; [l[i], l[j]] = [l[j], l[i]]; onChange({ ...doc, blocos: l });
  };
  const tirar = (i) => onChange({ ...doc, blocos: doc.blocos.filter((_, j) => j !== i) });
  const duplicar = (i) => { const l = [...doc.blocos]; l.splice(i + 1, 0, JSON.parse(JSON.stringify(l[i]))); onChange({ ...doc, blocos: l }); };
  const incluir = (tipo) => { if (tipo) onChange({ ...doc, blocos: [...doc.blocos, JSON.parse(JSON.stringify(PADRAO[tipo]))] }); };
  const setCfg = (patch) => onChange({ ...doc, config: { ...doc.config, ...patch } });

  function inserirVariavel(nome) {
    const f = foco.current;
    if (!nome || !f?.el) return;
    const el = f.el; const ini = el.selectionStart ?? el.value.length; const fim = el.selectionEnd ?? ini;
    const v = el.value.slice(0, ini) + `{{${nome}}}` + el.value.slice(fim);
    f.aplicar(v);
  }
  function corpo(b, i) {
    const up = (patch) => setBloco(i, patch);
    switch (b.tipo) {
      case 'logo': return (
        <div style={cx}>
          <Alinha valor={b.alinhamento} aoMudar={(v) => up({ alinhamento: v })} />
          <Num rotulo="Altura da área (px)" valor={b.altura} min={20} max={220} aoMudar={(v) => up({ altura: v })} />
          <Num rotulo="Largura da área (0 = automática)" valor={b.largura || 0} min={0} max={600} aoMudar={(v) => up({ largura: v && v < 40 ? 40 : v })} />
          <Marca rotulo="Moldura ao redor" valor={b.caixa} aoMudar={(v) => up({ caixa: v })} />
          {!logo && <span className="muted" style={{ fontSize: 13 }}>Logotipo ainda não enviado (veja o aviso no topo).</span>}
        </div>);
      case 'titulo': return (
        <>
          <div className="field"><label>Texto</label><Campo foco={foco} valor={b.texto} aoMudar={(v) => up({ texto: v })} /></div>
          <div style={cx}>
            <Num rotulo="Tamanho" valor={b.tamanho} min={14} max={64} aoMudar={(v) => up({ tamanho: v })} />
            <Alinha valor={b.alinhamento} aoMudar={(v) => up({ alinhamento: v })} />
            <Cor rotulo="Cor" valor={b.cor} padrao={doc.config.cor} aoMudar={(v) => up({ cor: v })} />
            <Marca rotulo="Negrito" valor={b.negrito} aoMudar={(v) => up({ negrito: v })} />
          </div>
        </>);
      case 'texto': return (
        <>
          <div className="field"><label>Texto</label><Campo foco={foco} multi rows={3} valor={b.texto} aoMudar={(v) => up({ texto: v })} /></div>
          <div style={cx}>
            <Num rotulo="Tamanho" valor={b.tamanho} min={9} max={40} aoMudar={(v) => up({ tamanho: v })} />
            <Alinha valor={b.alinhamento} aoMudar={(v) => up({ alinhamento: v })} />
            <Cor rotulo="Cor" valor={b.cor} padrao={doc.config.cor} aoMudar={(v) => up({ cor: v })} />
            <Marca rotulo="Negrito" valor={b.negrito} aoMudar={(v) => up({ negrito: v })} />
            <Marca rotulo="Itálico" valor={b.italico} aoMudar={(v) => up({ italico: v })} />
          </div>
        </>);
      case 'faixa': return (
        <>
          <div className="field"><label>Texto</label><Campo foco={foco} valor={b.texto} aoMudar={(v) => up({ texto: v })} /></div>
          <div style={cx}>
            <Cor rotulo="Cor da faixa" valor={b.fundo} padrao={doc.config.destaque} aoMudar={(v) => up({ fundo: v })} />
            <Cor rotulo="Cor do texto" valor={b.cor} padrao="#ffffff" aoMudar={(v) => up({ cor: v || '#ffffff' })} />
            <Alinha valor={b.alinhamento} aoMudar={(v) => up({ alinhamento: v })} />
          </div>
        </>);
      case 'dados': return (
        <>
          {b.linhas.map((l, k) => (
            <div key={k} style={{ ...cx, marginBottom: 4 }}>
              <div className="field" style={{ flex: 1, minWidth: 120 }}><Campo foco={foco} placeholder="Título (ex.: Nome)" valor={l.rotulo} aoMudar={(v) => up({ linhas: b.linhas.map((x, n) => (n === k ? { ...x, rotulo: v } : x)) })} /></div>
              <div className="field" style={{ flex: 2, minWidth: 160 }}><Campo foco={foco} placeholder="Valor (ex.: {{nome}})" valor={l.valor} aoMudar={(v) => up({ linhas: b.linhas.map((x, n) => (n === k ? { ...x, valor: v } : x)) })} /></div>
              <button type="button" className="btn sm" disabled={k === 0} onClick={() => { const a = [...b.linhas]; [a[k - 1], a[k]] = [a[k], a[k - 1]]; up({ linhas: a }); }} title="Subir linha">↑</button>
              <button type="button" className="btn sm" disabled={k === b.linhas.length - 1} onClick={() => { const a = [...b.linhas]; [a[k + 1], a[k]] = [a[k], a[k + 1]]; up({ linhas: a }); }} title="Descer linha">↓</button>
              <button type="button" className="btn sm" onClick={() => up({ linhas: b.linhas.filter((_, n) => n !== k) })}>Remover</button>
            </div>
          ))}
          <div style={cx}>
            <button type="button" className="btn sm" onClick={() => up({ linhas: [...b.linhas, { rotulo: '', valor: '' }] })}>Adicionar linha</button>
            <Num rotulo="Largura do título (%)" valor={b.larguraRotulo} min={20} max={60} aoMudar={(v) => up({ larguraRotulo: v })} />
          </div>
        </>);
      case 'lista': return (
        <>
          <div className="field"><label>Itens (um por linha)</label><Campo foco={foco} multi rows={4} valor={b.itens.join('\n')} aoMudar={(v) => up({ itens: v.split('\n') })} /></div>
          <Num rotulo="Tamanho" valor={b.tamanho} min={9} max={30} aoMudar={(v) => up({ tamanho: v })} />
        </>);
      case 'qrcode': return (
        <div style={cx}>
          <Alinha valor={b.alinhamento} aoMudar={(v) => up({ alinhamento: v })} />
          <Marca rotulo="Moldura ao redor" valor={b.caixa} aoMudar={(v) => up({ caixa: v })} />
          <Marca rotulo="Mostrar o código escrito abaixo" valor={b.mostrarCodigo} aoMudar={(v) => up({ mostrarCodigo: v })} />
          <span className="muted" style={{ fontSize: 13 }}>O QR Code é gerado sozinho para cada ingresso.</span>
        </div>);
      case 'atendente': return (
        <div style={cx}>
          <Num rotulo="Tamanho" valor={b.tamanho} min={9} max={40} aoMudar={(v) => up({ tamanho: v })} />
          <Alinha valor={b.alinhamento} aoMudar={(v) => up({ alinhamento: v })} />
          <Marca rotulo="Negrito" valor={b.negrito} aoMudar={(v) => up({ negrito: v })} />
          <span className="muted" style={{ fontSize: 13 }}>Aqui entram os dados que o atendimento informa na hora de gerar o documento.</span>
        </div>);
      case 'espaco': return <div style={cx}><Num rotulo="Altura (px)" valor={b.altura} min={4} max={200} aoMudar={(v) => up({ altura: v })} /></div>;
      case 'linha': return <div style={cx}><Cor rotulo="Cor" valor={b.cor} padrao="#d8d8d8" aoMudar={(v) => up({ cor: v || '#d8d8d8' })} /></div>;
      default: return null;
    }
  }

  return (
    <>
    {!logo && (
      <div className="card" style={{ marginTop: 10, borderColor: '#d9a441' }}>
        <strong>Envie o logotipo antes de montar o documento.</strong>
        <p className="muted" style={{ margin: '4px 0 0' }}>Ele ainda não foi enviado, então a prévia sai sem ele. Envie em “Dados fixos”, no campo “Logotipo para documentos”, para ver o resultado de verdade e não precisar refazer depois.</p>
      </div>
    )}
    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(340px,1fr))', gap: 14, marginTop: 10 }}>
      <div>
        <div className="card" style={{ marginBottom: 10 }}>
          <strong>Aparência geral</strong>
          <div style={{ ...cx, marginTop: 6 }}>
            <div className="field"><label>Letra</label>
              <select value={doc.config.fonte} onChange={(e) => setCfg({ fonte: e.target.value })}>{FONTES.map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></div>
            <Cor rotulo="Cor do texto" valor={doc.config.cor} padrao="#1f2937" aoMudar={(v) => setCfg({ cor: v || '#1f2937' })} />
            <Cor rotulo="Cor de destaque" valor={doc.config.destaque} padrao="#1f2937" aoMudar={(v) => setCfg({ destaque: v || '#1f2937' })} />
            <Cor rotulo="Fundo do miolo" valor={doc.config.fundo} padrao="#ffffff" aoMudar={(v) => setCfg({ fundo: v || '#ffffff' })} />
            {doc.config.moldura === 'ingresso' && <Cor rotulo="Cor da moldura" valor={doc.config.corMoldura} padrao="#e6e6e6" aoMudar={(v) => setCfg({ corMoldura: v || '#e6e6e6' })} />}
            <Num rotulo="Margem (px)" valor={doc.config.margem} min={0} max={80} aoMudar={(v) => setCfg({ margem: v })} />
            <div className="field"><label>Moldura</label>
              <select value={doc.config.moldura || (doc.config.borda === false ? 'nenhuma' : 'simples')} onChange={(e) => setCfg({ moldura: e.target.value })}>
                <option value="nenhuma">Sem moldura</option><option value="simples">Simples</option><option value="ingresso">Bilhete de ingresso</option></select></div>
            <Num rotulo="Largura (px, 0 = toda)" valor={doc.config.largura || 0} min={0} max={900} aoMudar={(v) => setCfg({ largura: v && v < 260 ? 260 : v })} />
          </div>
        </div>
        <div className="row" style={{ gap: 8, flexWrap: 'wrap', marginBottom: 8, alignItems: 'center' }}>
          <select value="" onChange={(e) => { inserirVariavel(e.target.value); e.target.value = ''; }} title="Clique antes em um campo de texto">
            <option value="">Inserir variável no campo selecionado…</option>
            {variaveis.map((v) => <option key={v.nome} value={v.nome}>{v.rotulo}</option>)}
          </select>
          <select value="" onChange={(e) => { incluir(e.target.value); e.target.value = ''; }}>
            <option value="">Adicionar bloco…</option>
            {Object.entries(NOMES).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
          </select>
        </div>
        {doc.blocos.map((b, i) => (
          <div className="card" key={i} style={{ marginBottom: 8, padding: 10 }}>
            <div style={{ display: 'flex', gap: 6, alignItems: 'center', marginBottom: 6 }}>
              <strong style={{ flex: 1 }}>{NOMES[b.tipo]}</strong>
              <button type="button" className="btn sm" disabled={i === 0} onClick={() => mover(i, -1)} title="Subir">↑</button>
              <button type="button" className="btn sm" disabled={i === doc.blocos.length - 1} onClick={() => mover(i, 1)} title="Descer">↓</button>
              <button type="button" className="btn sm" onClick={() => duplicar(i)}>Duplicar</button>
              <button type="button" className="btn sm" onClick={() => tirar(i)}>Remover</button>
            </div>
            {corpo(b, i)}
          </div>
        ))}
        {doc.blocos.length === 0 && <p className="muted">O documento está vazio. Use “Adicionar bloco…”.</p>}
      </div>
      <div>
        <div className="muted" style={{ marginBottom: 6 }}>Prévia com dados de exemplo</div>
        {erro && <div className="error">{erro}</div>}
        <iframe title="Prévia do documento" sandbox="" srcDoc={html} style={{ width: '100%', height: 640, border: '1px solid #ccc', background: '#fff' }} />
      </div>
    </div>
    </>
  );
}
