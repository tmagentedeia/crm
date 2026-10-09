import React, { useEffect, useRef, useState } from 'react';
import { api } from '../api.js';
import EditorBlocos, { NOVO_DOC } from './EditorBlocos.jsx';

const TIPOS = { ingresso: 'Ingresso', contrato: 'Contrato', proposta: 'Proposta', outro: 'Outro' };
const quando = (iso) => new Date(iso).toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' });
const ROTULOS = { nome: 'Nome do cliente', telefone: 'Telefone', empresa: 'Nome da empresa', data: 'Data de hoje', hora: 'Hora', numero: 'Número do documento', numero_curto: 'Número curto', evento: 'Evento', evento_data: 'Data do evento', abertura: 'Abertura das portas', local: 'Local', endereco: 'Endereço do local', lugares_mesa: 'Lugares da mesa', comprador: 'Nome do comprador', setor: 'Setor', mesa: 'Mesa', pessoa: 'Pessoa (1 de 4)', codigo: 'Código do ingresso' };
const BASE = ['numero', 'numero_curto', 'data', 'hora', 'empresa', 'nome', 'telefone', 'text', 'qrcode', 'codigo', 'evento', 'evento_data', 'abertura', 'local', 'endereco', 'setor', 'mesa', 'lugares_mesa', 'comprador', 'pessoa'];

export default function Documentos() {
  const [st, setSt] = useState(null);
  const [aba, setAba] = useState('gerados');
  useEffect(() => { api('/documents/status').then(setSt).catch(() => setSt({ configured: false, admin: false })); }, []);
  if (!st) return <p className="muted">Carregando…</p>;
  return (
    <>
      <div style={{ marginBottom: 12 }}>
        <h1>Documentos</h1>
        <p className="muted">Ingressos, contratos e propostas em PDF, montados a partir de modelos que você personaliza. O atendente também gera por aqui e envia o link ao cliente.</p>
      </div>
      {!st.configured && <div className="card" style={{ marginBottom: 12 }}><p>A geração de PDF ainda não está ligada neste servidor. Os modelos podem ser editados, mas os documentos só saem depois que o administrador ligar o serviço.</p></div>}
      <div className="row" style={{ gap: 6, marginBottom: 12 }}>
        <button className={'btn sm' + (aba === 'gerados' ? ' primary' : '')} onClick={() => setAba('gerados')}>Gerados</button>
        <button className={'btn sm' + (aba === 'dados' ? ' primary' : '')} onClick={() => setAba('dados')}>Dados fixos</button>
        <button className={'btn sm' + (aba === 'modelos' ? ' primary' : '')} onClick={() => setAba('modelos')}>Modelos</button>
      </div>
      <Vagas />
      {aba === 'gerados' && <Gerados configured={st.configured} />}
      {aba === 'dados' && <DadosFixos />}
      {aba === 'modelos' && <Modelos admin={st.admin} />}
    </>
  );
}

// Documentos do plano: quantos tipos podem ser usados ao mesmo tempo, o nível (simples ou completo) e a edição do mês.
function Vagas() {
  const [v, setV] = useState(null);
  const [err, setErr] = useState('');
  useEffect(() => { api('/documents/slots').then(setV).catch(() => {}); }, []);
  async function parar(k) {
    if (!window.confirm(`Parar de usar ${TIPOS[k].toLowerCase()}? Os modelos ficam guardados, mas este tipo só volta a ser usado se houver espaço no plano.`)) return;
    try { setV(await api('/documents/slots/release', { method: 'POST', body: { kind: k } })); } catch (e) { setErr(e.message); }
  }
  if (!v || v.total === null) return null;
  return (
    <div className="card" style={{ marginBottom: 12 }}>
      <strong>Tipos de documento do seu plano: {v.ativos.length} de {v.total} em uso</strong>
      <p className="muted" style={{ margin: '4px 0 8px' }}>
        Seu plano permite usar {v.total} tipo{v.total === 1 ? '' : 's'} de documento ao mesmo tempo{v.nivel === 'simples' ? `, de texto simples (até ${v.limite_texto.toLocaleString('pt-BR')} caracteres)` : v.nivel === 'completo' ? ', inclusive documentos completos, como contratos' : ''}.
        Você pode editar os modelos quantas vezes quiser. Para trocar de tipo, pare de usar um. Precisa de mais? Peça um tipo de documento adicional à M2.
      </p>
      {err && <div className="error">{err}</div>}
      <div className="row" style={{ gap: 14, flexWrap: 'wrap' }}>
        {v.ativos.map((k) => (
          <span key={k} className="row" style={{ gap: 8, alignItems: 'center' }}>
            <strong>{TIPOS[k]}</strong>
            <button className="btn sm" onClick={() => parar(k)}>Parar de usar</button>
          </span>
        ))}
        {v.ativos.length === 0 && <span className="muted">Nenhum tipo em uso ainda. O primeiro documento que você criar ou gerar passa a ocupar um lugar do plano.</span>}
      </div>
    </div>
  );
}

function Gerados({ configured }) {
  const [lista, setLista] = useState(null);
  const [modelos, setModelos] = useState([]);
  const [f, setF] = useState({ template: '', name: '', number: '', text: '' });
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const carregar = () => api('/documents').then(setLista).catch((e) => setErr(e.message));
  useEffect(() => { carregar(); api('/documents/templates').then(setModelos).catch(() => {}); }, []);
  async function gerar(e) {
    e.preventDefault(); setErr(''); setBusy(true);
    try {
      const r = await api('/documents/generate', { method: 'POST', body: { ...f, text: f.text.split('\n').map((l) => l.trim()).filter(Boolean).map((l) => l.replace(/&/g, '&amp;').replace(/</g, '&lt;')).join('<br>') } });
      setF({ ...f, name: '', number: '', text: '' });
      await carregar();
      window.open(r.url, '_blank', 'noopener');
    } catch (e2) { setErr(e2.message); } finally { setBusy(false); }
  }
  async function apagar(d) {
    if (!window.confirm(`Apagar "${d.title}"?`)) return;
    try { await api(`/documents/${d.id}`, { method: 'DELETE' }); carregar(); } catch (e) { setErr(e.message); }
  }
  async function copiar(d) { try { await navigator.clipboard.writeText(`${location.origin}/d/${d.token}.pdf`); } catch { /* sem permissão */ } }
  return (
    <>
      {err && <div className="error">{err}</div>}
      <form className="card" onSubmit={gerar} style={{ marginBottom: 12 }}>
        <h3>Gerar um documento</h3>
        <div className="row" style={{ alignItems: 'flex-end', flexWrap: 'wrap' }}>
          <div className="field"><label>Modelo</label>
            <select value={f.template} onChange={(e) => setF({ ...f, template: e.target.value })} required>
              <option value="">Escolha…</option>
              {modelos.map((m) => <option key={m.id} value={m.id}>{TIPOS[m.kind]} — {m.name}</option>)}
            </select></div>
          <div className="field"><label>Nome do cliente</label><input value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} required /></div>
          <div className="field"><label>WhatsApp (opcional)</label><input value={f.number} onChange={(e) => setF({ ...f, number: e.target.value })} placeholder="32 99999-9999" /></div>
        </div>
        <div className="field"><label>Dados do documento (um por linha)</label><textarea rows={4} value={f.text} onChange={(e) => setF({ ...f, text: e.target.value.replace(/<[^>]*>/g, '') })} placeholder={'Data do evento: 20/12/2026\nLocal: Clube X\nValor total: R$ 1.500,00'} /></div>
        <button className="btn primary" disabled={busy || !configured}>{busy ? 'Gerando…' : 'Gerar PDF'}</button>
      </form>
      {lista && lista.length > 0 ? (
        <div className="card table-wrap">
          <table>
            <thead><tr><th>Quando</th><th>Documento</th><th>Cliente</th><th></th></tr></thead>
            <tbody>{lista.map((d) => (
              <tr key={d.id}><td style={{ whiteSpace: 'nowrap' }}>{quando(d.created_at)}</td><td>{d.title}</td><td>{d.customer || '—'}</td>
                <td style={{ textAlign: 'right', whiteSpace: 'nowrap' }}>
                  <a className="btn sm" href={`/d/${d.token}.pdf`} target="_blank" rel="noopener noreferrer">Abrir</a>{' '}
                  <button className="btn sm" onClick={() => copiar(d)}>Copiar link</button>{' '}
                  <button className="btn sm" onClick={() => apagar(d)}>Apagar</button></td></tr>
            ))}</tbody>
          </table>
        </div>
      ) : lista && <div className="card muted">Nenhum documento gerado ainda.</div>}
    </>
  );
}

// Dados que se repetem em todos os documentos (nome de quem presta o serviço, chave Pix, telefone...)
function DadosFixos() {
  const [linhas, setLinhas] = useState(null);
  const [msg, setMsg] = useState('');
  const [err, setErr] = useState('');
  useEffect(() => { api('/documents/settings').then((r) => setLinhas(Object.entries(r.vars || {}).map(([k, v]) => ({ k, v })))).catch((e) => setErr(e.message)); }, []);
  if (!linhas) return err ? <div className="error">{err}</div> : <p className="muted">Carregando…</p>;
  const mudar = (i, campo, valor) => setLinhas(linhas.map((l, j) => (j === i ? { ...l, [campo]: valor } : l)));
  async function salvar() {
    setErr(''); setMsg('');
    if (m.id && !window.confirm(`Salvar por cima do modelo "${m.name}"? O conteúdo atual será substituído (a versão anterior fica guardada em "Versões anteriores").`)) return;
    try {
      const vars = {};
      for (const l of linhas) if (l.k.trim()) vars[l.k.trim()] = l.v;
      const r = await api('/documents/settings', { method: 'PUT', body: { vars } });
      setLinhas(Object.entries(r.vars).map(([k, v]) => ({ k, v }))); setMsg('Salvo');
    } catch (e) { setErr(e.message); }
  }
  return (
    <>
    <Logotipo />
    <div className="card">
      <h3>Dados fixos</h3>
      <p className="muted">Valores que entram sozinhos em todos os documentos. O nome é o que aparece no modelo entre chaves, por exemplo <code>{'{{chave_pix}}'}</code>. Use letras, números e sublinhado, sem espaços.</p>
      {err && <div className="error">{err}</div>}
      {linhas.map((l, i) => (
        <div className="row" key={i} style={{ alignItems: 'flex-end' }}>
          <div className="field"><label>Nome</label><input value={l.k} onChange={(e) => mudar(i, 'k', e.target.value.replace(/[^A-Za-z0-9_]/g, ''))} placeholder="chave_pix" /></div>
          <div className="field" style={{ flex: 1 }}><label>Valor</label><input value={l.v} onChange={(e) => mudar(i, 'v', e.target.value)} /></div>
          <button className="btn sm" onClick={() => setLinhas(linhas.filter((_, j) => j !== i))}>Remover</button>
        </div>
      ))}
      <div className="row" style={{ marginTop: 8 }}>
        <button className="btn" onClick={() => setLinhas([...linhas, { k: '', v: '' }])}>Adicionar dado</button>
        <button className="btn primary" onClick={salvar}>Salvar</button>
        {msg && <span className="muted">{msg}</span>}
      </div>
    </div>
    </>
  );
}

// Logotipo da empresa: entra nos documentos pelo bloco “Logotipo” (ou por {{{logotipo}}} nos modelos escritos à mão)
function Logotipo() {
  const [logo, setLogo] = useState(undefined);
  const [err, setErr] = useState('');
  useEffect(() => { api('/documents/logo').then((r) => setLogo(r.logo)).catch((e) => setErr(e.message)); }, []);
  function enviar(e) {
    const arq = e.target.files?.[0]; e.target.value = '';
    if (!arq) return;
    setErr('');
    if (!/^image\/(png|jpe?g|gif|webp)$/.test(arq.type) || arq.size > 1024 * 1024) { setErr('Use uma imagem PNG, JPG, WebP ou GIF de até 1 MB.'); return; }
    const rd = new FileReader();
    rd.onload = () => api('/documents/logo', { method: 'PUT', body: { logo: rd.result } }).then((r) => setLogo(r.logo)).catch((x) => setErr(x.message));
    rd.readAsDataURL(arq);
  }
  const tirar = () => api('/documents/logo', { method: 'PUT', body: { logo: null } }).then(() => setLogo(null)).catch((x) => setErr(x.message));
  return (
    <div className="card" style={{ marginBottom: 12 }}>
      <h3>Logotipo para documentos</h3>
      <p className="muted">Envie, de preferência, um PNG com o desenho em cor escura e fundo transparente (vazado). Assim ele aparece bem no papel branco; um logotipo branco some. Envie antes de montar os modelos.</p>
      {err && <div className="error">{err}</div>}
      <div className="row" style={{ alignItems: 'center', gap: 12 }}>
        {logo ? <img src={logo} alt="Logotipo" style={{ maxHeight: 70, maxWidth: 220, background: '#fff', border: '1px solid #ddd', padding: 6 }} /> : logo === null ? <span className="muted">Nenhum logotipo enviado.</span> : <span className="muted">Carregando…</span>}
        <label className="btn">{logo ? 'Trocar logotipo' : 'Enviar logotipo'}<input type="file" accept="image/png,image/jpeg,image/gif,image/webp" onChange={enviar} style={{ display: 'none' }} /></label>
        {logo && <button className="btn" onClick={tirar}>Remover</button>}
      </div>
    </div>
  );
}

// Edição dos modelos (só o administrador)
function Modelos({ admin }) {
  const [lista, setLista] = useState(null);
  const [m, setM] = useState(null);          // modelo aberto: { id?, name, kind, html, is_default }
  const [prev, setPrev] = useState('');
  const [faltam, setFaltam] = useState([]);
  const [saude, setSaude] = useState(null);
  const [err, setErr] = useState('');
  const [msg, setMsg] = useState('');
  const area = useRef(null);
  const [logo, setLogo] = useState(null);
  const [fixas, setFixas] = useState([]);
  const [avancado, setAvancado] = useState(false);
  const [limite, setLimite] = useState(null);
  const [versoes, setVersoes] = useState(null);
  const carregar = () => api('/documents/templates').then(setLista).catch((e) => setErr(e.message));
  useEffect(() => {
    carregar();
    api('/documents/logo').then((r) => setLogo(r.logo)).catch(() => {});
    api('/documents/settings').then((r) => setFixas(Object.keys(r.vars || {}))).catch(() => {});
    api('/documents/slots').then((r) => setLimite(r.limite_texto || null)).catch(() => {});
  }, []);
  const variaveis = [
    ...['nome', 'telefone', 'empresa', 'data', 'hora', 'evento', 'evento_data', 'abertura', 'local', 'endereco', 'setor', 'mesa', 'lugares_mesa', 'comprador', 'pessoa', 'numero', 'numero_curto', 'codigo'].map((n) => ({ nome: n, rotulo: ROTULOS[n] })),
    ...fixas.map((n) => ({ nome: n, rotulo: `Dado fixo: ${n}` })),
  ];

  async function abrir(id) {
    setErr(''); setMsg(''); setPrev(''); setAvancado(false); setVersoes(null);
    try { setM(await api(`/documents/templates/${id}`)); } catch (e) { setErr(e.message); }
  }
  async function salvar() {
    setErr(''); setMsg('');
    try {
      const corpo = { name: m.name, kind: m.kind, is_default: m.is_default, ...(m.blocks ? { blocks: m.blocks } : { html: m.html }) };
      if (m.id) await api(`/documents/templates/${m.id}`, { method: 'PUT', body: corpo });
      else { const r = await api('/documents/templates', { method: 'POST', body: corpo }); setM({ ...m, id: r.id }); }
      setMsg('Modelo salvo'); setVersoes(null); carregar();
    } catch (e) { setErr(e.message); }
  }
  async function verVersoes() {
    setErr('');
    try { setVersoes(await api(`/documents/templates/${m.id}/versions`)); } catch (e) { setErr(e.message); }
  }
  async function restaurar(v) {
    if (!window.confirm(`Voltar o modelo para a versão de ${new Date(v.saved_at).toLocaleString('pt-BR')}? O conteúdo atual também fica guardado.`)) return;
    try { await api(`/documents/templates/${m.id}/versions/${v.id}/restore`, { method: 'POST' }); setVersoes(null); setMsg('Versão restaurada'); await abrir(m.id); carregar(); } catch (e) { setErr(e.message); }
  }
  async function apagar() {
    if (!window.confirm(`Apagar o modelo "${m.name}"?`)) return;
    try { await api(`/documents/templates/${m.id}`, { method: 'DELETE' }); setM(null); carregar(); } catch (e) { setErr(e.message); }
  }
  async function irParaCodigo() {
    if (!window.confirm('Ao editar o código, este modelo deixa de ser editável pelos blocos. Continuar?')) return;
    try { const r = await api('/documents/blocks-html', { method: 'POST', body: { blocks: m.blocks, name: m.name } }); setM({ ...m, html: r.html, blocks: null }); setAvancado(true); } catch (e) { setErr(e.message); }
  }
  function recomecarComBlocos() {
    if (!window.confirm('Isto troca o conteúdo atual por um modelo novo em blocos. Continuar?')) return;
    setM({ ...m, blocks: NOVO_DOC }); setAvancado(false);
  }
  async function previa() {
    setErr('');
    try { const r = await api('/documents/preview', { method: 'POST', body: { html: m.html } }); setPrev(r.html); setFaltam(r.missing || []); }
    catch (e) { setErr(e.message); }
  }
  async function exemplos() {
    try { const r = await api('/documents/templates/examples', { method: 'POST' }); setMsg(r.added ? 'Modelos de exemplo adicionados' : 'Os exemplos já estavam na lista'); carregar(); } catch (e) { setErr(e.message); }
  }
  async function testar() { try { setSaude(await api('/documents/health')); } catch (e) { setSaude({ ok: false, motivo: e.message }); } }
  function imagem(e) {
    const arq = e.target.files?.[0]; e.target.value = '';
    if (!arq) return;
    if (!/^image\/(png|jpe?g|gif|webp)$/.test(arq.type) || arq.size > 1024 * 1024) { setErr('Use uma imagem PNG, JPG, GIF ou WebP de até 1 MB.'); return; }
    const rd = new FileReader();
    rd.onload = () => {
      const ta = area.current; const pos = ta ? ta.selectionStart : m.html.length;
      const tag = `<img src="${rd.result}" alt="" style="max-width:100%">`;
      setM({ ...m, html: m.html.slice(0, pos) + tag + m.html.slice(pos) });
    };
    rd.readAsDataURL(arq);
  }
  if (!lista) return err ? <div className="error">{err}</div> : <p className="muted">Carregando…</p>;
  const usadas = m ? [...new Set([...m.html.matchAll(/\{\{\{?\s*([A-Za-z_][A-Za-z0-9_]*)\s*\}?\}\}/g)].map((x) => x[1]))] : [];
  return (
    <>
      {err && <div className="error">{err}</div>}
      {msg && <p>{msg}</p>}
      <div className="card" style={{ marginBottom: 12 }}>
        <div className="row" style={{ flexWrap: 'wrap', gap: 8 }}>
          <button className="btn primary" onClick={() => { setPrev(''); setMsg(''); setAvancado(false); setM({ name: '', kind: 'contrato', blocks: NOVO_DOC, html: '', is_default: false }); }}>Novo modelo</button>
          <button className="btn" onClick={exemplos}>Adicionar modelos de exemplo</button>
          {admin && <button className="btn" onClick={testar}>Testar serviço de PDF</button>}
          {saude && <span className={saude.ok ? '' : 'error'}>{saude.ok ? 'Serviço de PDF funcionando' : saude.motivo}{!saude.ok && saude.detalhe && <span className="muted" style={{ display: 'block', fontSize: 12 }}>{saude.detalhe}</span>}</span>}
        </div>
        {lista.length > 0 && (
          <table style={{ marginTop: 10 }}><tbody>{lista.map((t) => (
            <tr key={t.id}><td><strong>{t.name}</strong> {t.is_default && <span className="muted">· padrão</span>}</td><td>{TIPOS[t.kind]}{t.sem_vaga && <span className="muted"> · fora do plano</span>}</td>
              <td style={{ textAlign: 'right' }}><button className="btn sm" onClick={() => abrir(t.id)}>Editar</button></td></tr>
          ))}</tbody></table>
        )}
      </div>
      {m && (
        <div className="card">
          <div className="row" style={{ alignItems: 'flex-end', flexWrap: 'wrap' }}>
            <div className="field" style={{ flex: 1 }}><label>Nome do modelo</label><input value={m.name} onChange={(e) => setM({ ...m, name: e.target.value })} /></div>
            <div className="field"><label>Tipo</label>
              <select value={m.kind} onChange={(e) => setM({ ...m, kind: e.target.value })}>{Object.entries(TIPOS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></div>
            <label style={{ display: 'flex', gap: 6, alignItems: 'center' }}><input type="checkbox" checked={!!m.is_default} onChange={(e) => setM({ ...m, is_default: e.target.checked })} /> Modelo padrão do tipo</label>
          </div>
          {m.blocks ? (
            <>
              <EditorBlocos doc={m.blocks} onChange={(d) => setM({ ...m, blocks: d })} variaveis={variaveis} logo={logo} limiteTexto={limite} />
              <p className="muted" style={{ marginTop: 8 }}>Prefere escrever em código? <button type="button" className="btn sm" onClick={irParaCodigo}>Modo avançado (HTML)</button></p>
            </>
          ) : (
            <>
              <p className="muted">Este modelo está em código. <button type="button" className="btn sm" onClick={recomecarComBlocos}>Recomeçar com o editor de blocos</button></p>
            <div className="field"><label>Conteúdo (HTML)</label>
              <textarea ref={area} rows={16} spellCheck={false} style={{ fontFamily: 'monospace', fontSize: 13 }} value={m.html} onChange={(e) => setM({ ...m, html: e.target.value })} /></div>
            <p className="muted">
              Variáveis: escreva <code>{'{{nome}}'}</code> para um valor simples ou <code>{'{{{text}}}'}</code> (três chaves) para um bloco com quebras de linha. Já existem: {BASE.map((v) => `{{${v}}}`).join(', ')}. Os dados fixos e quaisquer campos enviados pelo atendente também viram variáveis.
              {usadas.length > 0 && <> Neste modelo: {usadas.join(', ')}.</>}
            </p>

            </>
          )}
          <div className="row" style={{ flexWrap: 'wrap', gap: 8 }}>
            {!m.blocks && <label className="btn">Inserir imagem<input type="file" accept="image/png,image/jpeg,image/gif,image/webp" onChange={imagem} style={{ display: 'none' }} /></label>}
            {!m.blocks && <button className="btn" onClick={previa}>Pré-visualizar</button>}
            <button className="btn primary" onClick={salvar}>Salvar modelo</button>
            {m.id && <button className="btn" onClick={versoes ? () => setVersoes(null) : verVersoes}>Versões anteriores</button>}
            {m.id && <button className="btn" onClick={apagar}>Apagar</button>}
            <button className="btn" onClick={() => setM(null)}>Fechar</button>
          </div>
          {versoes && (
            <div style={{ marginTop: 10 }}>
              {versoes.length === 0 && <p className="muted">Ainda não há versões anteriores. Elas passam a ser guardadas a cada vez que você salva por cima.</p>}
              {versoes.map((v) => (
                <div key={v.id} className="row" style={{ justifyContent: 'space-between', gap: 8, padding: '6px 0', borderBottom: '1px solid var(--border)' }}>
                  <span>{new Date(v.saved_at).toLocaleString('pt-BR')} <span className="muted">· {v.name}</span></span>
                  <button className="btn sm" onClick={() => restaurar(v)}>Restaurar</button>
                </div>
              ))}
            </div>
          )}
          {faltam.length > 0 && <p className="muted">Sem valor na pré-visualização: {faltam.join(', ')}. Elas saem em branco se o atendente não enviar.</p>}
          {!m.blocks && prev && <iframe title="Pré-visualização" sandbox="" srcDoc={prev} style={{ width: '100%', height: 520, border: '1px solid #ccc', background: '#fff', marginTop: 10 }} />}
        </div>
      )}
    </>
  );
}
