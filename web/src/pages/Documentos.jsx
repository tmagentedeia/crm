import React, { useEffect, useRef, useState } from 'react';
import { api } from '../api.js';

const TIPOS = { ingresso: 'Ingresso', contrato: 'Contrato', proposta: 'Proposta', outro: 'Outro' };
const quando = (iso) => new Date(iso).toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' });
const BASE = ['numero', 'numero_curto', 'data', 'hora', 'empresa', 'nome', 'telefone', 'text'];

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
        {st.admin && <button className={'btn sm' + (aba === 'modelos' ? ' primary' : '')} onClick={() => setAba('modelos')}>Modelos</button>}
      </div>
      {aba === 'gerados' && <Gerados configured={st.configured} />}
      {aba === 'dados' && <DadosFixos />}
      {aba === 'modelos' && st.admin && <Modelos />}
    </>
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
    try {
      const vars = {};
      for (const l of linhas) if (l.k.trim()) vars[l.k.trim()] = l.v;
      const r = await api('/documents/settings', { method: 'PUT', body: { vars } });
      setLinhas(Object.entries(r.vars).map(([k, v]) => ({ k, v }))); setMsg('Salvo');
    } catch (e) { setErr(e.message); }
  }
  return (
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
  );
}

// Edição dos modelos (só o administrador)
function Modelos() {
  const [lista, setLista] = useState(null);
  const [m, setM] = useState(null);          // modelo aberto: { id?, name, kind, html, is_default }
  const [prev, setPrev] = useState('');
  const [faltam, setFaltam] = useState([]);
  const [saude, setSaude] = useState(null);
  const [err, setErr] = useState('');
  const [msg, setMsg] = useState('');
  const area = useRef(null);
  const carregar = () => api('/documents/templates').then(setLista).catch((e) => setErr(e.message));
  useEffect(() => { carregar(); }, []);

  async function abrir(id) {
    setErr(''); setMsg(''); setPrev('');
    try { setM(await api(`/documents/templates/${id}`)); } catch (e) { setErr(e.message); }
  }
  async function salvar() {
    setErr(''); setMsg('');
    try {
      const corpo = { name: m.name, kind: m.kind, html: m.html, is_default: m.is_default };
      if (m.id) await api(`/documents/templates/${m.id}`, { method: 'PUT', body: corpo });
      else { const r = await api('/documents/templates', { method: 'POST', body: corpo }); setM({ ...m, id: r.id }); }
      setMsg('Modelo salvo'); carregar();
    } catch (e) { setErr(e.message); }
  }
  async function apagar() {
    if (!window.confirm(`Apagar o modelo "${m.name}"?`)) return;
    try { await api(`/documents/templates/${m.id}`, { method: 'DELETE' }); setM(null); carregar(); } catch (e) { setErr(e.message); }
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
          <button className="btn primary" onClick={() => { setPrev(''); setMsg(''); setM({ name: '', kind: 'contrato', html: '<!DOCTYPE html>\n<html lang="pt-BR"><head><meta charset="UTF-8"></head>\n<body>\n<h1>Título</h1>\n<p>Cliente: {{nome}}</p>\n<div>{{{text}}}</div>\n</body></html>', is_default: false }); }}>Novo modelo</button>
          <button className="btn" onClick={exemplos}>Adicionar modelos de exemplo</button>
          <button className="btn" onClick={testar}>Testar serviço de PDF</button>
          {saude && <span className={saude.ok ? '' : 'error'}>{saude.ok ? 'Serviço de PDF funcionando' : saude.motivo}</span>}
        </div>
        {lista.length > 0 && (
          <table style={{ marginTop: 10 }}><tbody>{lista.map((t) => (
            <tr key={t.id}><td><strong>{t.name}</strong> {t.is_default && <span className="muted">· padrão</span>}</td><td>{TIPOS[t.kind]}</td>
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
          <div className="field"><label>Conteúdo (HTML)</label>
            <textarea ref={area} rows={16} spellCheck={false} style={{ fontFamily: 'monospace', fontSize: 13 }} value={m.html} onChange={(e) => setM({ ...m, html: e.target.value })} /></div>
          <p className="muted">
            Variáveis: escreva <code>{'{{nome}}'}</code> para um valor simples ou <code>{'{{{text}}}'}</code> (três chaves) para um bloco com quebras de linha. Já existem: {BASE.map((v) => `{{${v}}}`).join(', ')}. Os dados fixos e quaisquer campos enviados pelo atendente também viram variáveis.
            {usadas.length > 0 && <> Neste modelo: {usadas.join(', ')}.</>}
          </p>
          <div className="row" style={{ flexWrap: 'wrap', gap: 8 }}>
            <label className="btn">Inserir imagem<input type="file" accept="image/png,image/jpeg,image/gif,image/webp" onChange={imagem} style={{ display: 'none' }} /></label>
            <button className="btn" onClick={previa}>Pré-visualizar</button>
            <button className="btn primary" onClick={salvar}>Salvar modelo</button>
            {m.id && <button className="btn" onClick={apagar}>Apagar</button>}
            <button className="btn" onClick={() => setM(null)}>Fechar</button>
          </div>
          {faltam.length > 0 && <p className="muted">Sem valor na pré-visualização: {faltam.join(', ')}. Elas saem em branco se o atendente não enviar.</p>}
          {prev && <iframe title="Pré-visualização" sandbox="" srcDoc={prev} style={{ width: '100%', height: 520, border: '1px solid #ccc', background: '#fff', marginTop: 10 }} />}
        </div>
      )}
    </>
  );
}
