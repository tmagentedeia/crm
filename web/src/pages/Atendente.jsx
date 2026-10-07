import React, { useEffect, useState } from 'react';
import UpgradeModal from '../UpgradeModal.jsx';
import { IconeCadeado } from '../icones.jsx';
import { Nome } from '../menu.jsx';
import { api } from '../api.js';
import { lerSecoes, juntarSecoes, sugerirSecoes, temSecoes, rotulo } from '../manualSecoes.js';

const fmtMomento = (s) => (s ? `${s.slice(8, 10)}/${s.slice(5, 7)}/${s.slice(0, 4)} ${s.slice(11, 16)}` : '');
const fmtDataHora = (d) => new Date(d).toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' });

// Acha todas as ocorrências de "busca" em "texto". Por padrão ignora maiúsculas/minúsculas e acentos (Vitória = vitoria).
// Devolve intervalos [início, fim) no texto original.
const semAcento = (t) => t.normalize('NFD').replace(/\p{M}/gu, '');
function achar(texto, busca, exato) {
  if (!busca) return [];
  const map = [];
  let norm = '';
  for (let i = 0; i < texto.length; i++) {
    const b = exato ? texto[i] : semAcento(texto[i]).toLowerCase();
    for (let k = 0; k < b.length; k++) { norm += b[k]; map.push(i); }
  }
  const q = exato ? busca : semAcento(busca).toLowerCase();
  if (!q) return [];
  const achados = [];
  let ini = 0;
  while ((ini = norm.indexOf(q, ini)) !== -1) {
    achados.push([map[ini], map[ini + q.length - 1] + 1]);
    ini += q.length;
  }
  return achados;
}


// Caixa de texto que pinta o trecho procurado: uma camada atrás da caixa repete o texto com os achados marcados.
const ESTILO_TEXTO = { fontFamily: 'inherit', fontSize: 14, lineHeight: '20px', padding: 8, margin: 0, border: '1px solid var(--line, #ccc)', borderRadius: 6, boxSizing: 'border-box', whiteSpace: 'pre-wrap', overflowWrap: 'break-word', wordBreak: 'normal', overflowY: 'scroll', letterSpacing: 'normal' };
function CaixaTexto({ id, valor, onChange, rows, busca }) {
  const taRef = React.useRef(null);
  const fundoRef = React.useRef(null);
  const achados = achar(valor, busca, false);
  const sincroniza = () => { if (fundoRef.current && taRef.current) fundoRef.current.scrollTop = taRef.current.scrollTop; };
  // ao procurar, leva a caixa até o primeiro trecho achado
  useEffect(() => {
    if (!busca || !achados.length || !taRef.current) return;
    const linha = valor.slice(0, achados[0][0]).split('\n').length - 1;
    taRef.current.scrollTop = Math.max(0, linha * 20 - 40);
    sincroniza();
  }, [busca]);
  const pedacos = [];
  let pos = 0;
  achados.forEach(([a, b], k) => {
    pedacos.push(valor.slice(pos, a));
    pedacos.push(<mark key={k} style={{ background: '#ffd84d', color: 'transparent', borderRadius: 2 }}>{valor.slice(a, b)}</mark>);
    pos = b;
  });
  pedacos.push(valor.slice(pos) + '\n');
  return (
    <div style={{ position: 'relative', width: '100%' }}>
      <div ref={fundoRef} aria-hidden="true" style={{ ...ESTILO_TEXTO, position: 'absolute', inset: 0, color: 'transparent', pointerEvents: 'none', overflow: 'hidden', overflowY: 'scroll', background: 'var(--card, #fff)' }}>{pedacos}</div>
      <textarea ref={taRef} id={id} value={valor} onChange={onChange} onScroll={sincroniza} rows={rows}
        style={{ ...ESTILO_TEXTO, position: 'relative', display: 'block', width: '100%', background: 'transparent', color: 'var(--text, inherit)', resize: 'vertical' }} />
    </div>
  );
}

// Editor do manual em várias caixas de texto: cada caixa é um pedaço do manual; o manual continua sendo um texto só.
function Secoes({ texto, onChange, nome = 'manual' }) {
  const secs = lerSecoes(texto);
  const [abertas, setAbertas] = useState(() => new Set());
  const [filtro, setFiltro] = useState('');
  const [arrasta, setArrasta] = useState(null);   // caixa sendo arrastada
  const [sobre, setSobre] = useState(null);       // caixa sobre a qual ela está
  const aplicar = (novas, abrir) => {
    onChange(juntarSecoes(novas));
    if (abrir !== undefined) setAbertas(new Set(abrir));
  };
  const alternar = (i) => setAbertas((a) => (a.has(i) ? new Set() : new Set([i])));   // uma aberta por vez, as outras ficam fechadas e juntinhas
  const f = semAcento(filtro).toLowerCase();
  const visivel = (s) => !f || semAcento(s.corpo).toLowerCase().includes(f);
  const editar = (i, valor) => aplicar(secs.map((s, k) => (k === i ? { corpo: valor } : s)));
  const mover = (i, d) => {
    const novas = [...secs]; const j = i + d;
    if (j < 0 || j >= novas.length) return;
    [novas[i], novas[j]] = [novas[j], novas[i]];
    aplicar(novas, [j]);
  };
  const soltar = (para) => {
    const de = arrasta;
    setArrasta(null); setSobre(null);
    if (de === null || para === null || de === para) return;
    const novas = [...secs];
    const [item] = novas.splice(de, 1);
    novas.splice(para, 0, item);
    aplicar(novas, [para]);
  };
  const excluir = (i) => {
    if (!window.confirm(`Apagar esta caixa e o texto dela?\n\n${rotulo(secs[i].corpo)}`)) return;
    aplicar(secs.length > 1 ? secs.filter((_, k) => k !== i) : [{ corpo: '' }], []);
  };
  const juntarComAnterior = (i) => {
    const novas = secs.filter((_, k) => k !== i);
    novas[i - 1] = { corpo: secs[i - 1].corpo ? `${secs[i - 1].corpo}\n${secs[i].corpo}` : secs[i].corpo };
    aplicar(novas, [i - 1]);
  };
  const dividir = (i) => {
    const ta = document.getElementById(`sec-ta-${i}`);
    const pos = ta ? ta.selectionStart : 0;
    const corpo = secs[i].corpo;
    if (!ta || pos <= 0 || pos >= corpo.length) { window.alert('Clique dentro do texto, no ponto onde a nova caixa deve começar, e aperte “Dividir aqui” de novo.'); return; }
    const novas = [...secs];
    novas.splice(i, 1, { corpo: corpo.slice(0, pos).replace(/\n+$/, '') }, { corpo: corpo.slice(pos).replace(/^\n+/, '') });
    aplicar(novas, [i + 1]);
  };
  // Põe em maiúsculas só o trecho selecionado (o cursor volta para o começo dele, pronto para "Dividir aqui")
  const maiusculas = (i) => {
    const ta = document.getElementById(`sec-ta-${i}`);
    const ini = ta ? ta.selectionStart : 0;
    const fim = ta ? ta.selectionEnd : 0;
    if (!ta || fim <= ini) { window.alert('Selecione primeiro o trecho (por exemplo, a frase do título) e aperte “MAIÚSCULAS” de novo.'); return; }
    const corpo = secs[i].corpo;
    editar(i, corpo.slice(0, ini) + corpo.slice(ini, fim).toLocaleUpperCase('pt-BR') + corpo.slice(fim));
    setTimeout(() => { const t = document.getElementById(`sec-ta-${i}`); if (t) { t.focus(); t.setSelectionRange(ini, ini); } }, 0);
  };
  const nova = (depoisDe) => {
    const novas = [...secs];
    novas.splice(depoisDe + 1, 0, { corpo: '' });
    aplicar(novas, [depoisDe + 1]);
  };

  return (
    <div>
      <p className="muted" style={{ margin: '0 0 10px' }}>
        Cada caixa é um pedaço {nome === 'manual' ? 'do manual; quem lê o manual vê' : 'das diretrizes; o agente recebe'} tudo como um texto só, na ordem. Escreva o título em maiúsculas na primeira linha da caixa: ele aparece na lista.
      </p>
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center', marginBottom: 10 }}>
        <input value={filtro} onChange={(e) => setFiltro(e.target.value)} placeholder="🔎 Procurar nas caixas" style={{ flex: 1, minWidth: 220 }} />
      </div>
      {secs.map((s, i) => {
        if (!visivel(s)) return null;
        const aberta = abertas.has(i) || !!f;
        return (
          <div key={i} onDragOver={(e) => { if (arrasta !== null) { e.preventDefault(); if (sobre !== i) setSobre(i); } }} onDrop={(e) => { e.preventDefault(); soltar(i); }}
            style={{ border: '1px solid var(--border, #ddd)', borderRadius: 6, marginBottom: 3, opacity: arrasta === i ? 0.4 : 1,
              boxShadow: arrasta !== null && sobre === i && arrasta !== i ? (arrasta < i ? '0 3px 0 0 var(--primary)' : '0 -3px 0 0 var(--primary)') : undefined }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '4px 10px', cursor: 'pointer' }} onClick={() => alternar(i)}
              draggable={!f} onDragStart={(e) => { setArrasta(i); e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('text/plain', String(i)); }} onDragEnd={() => { setArrasta(null); setSobre(null); }}
              title={f ? undefined : 'Arraste para reorganizar'}>
              {!f && <span className="muted" style={{ cursor: 'grab' }} aria-hidden="true">⠿</span>}
              <span>{aberta ? '▾' : '▸'}</span>
              <strong style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{rotulo(s.corpo)}</strong>
              <span className="muted">{f ? `${achar(s.corpo, filtro, false).length}× · ` : ''}{s.corpo.length} caracteres</span>
            </div>
            {aberta && (
              <div style={{ padding: '0 10px 10px' }}>
                <CaixaTexto id={`sec-ta-${i}`} valor={s.corpo} onChange={(e) => editar(i, e.target.value)} busca={filtro}
                  rows={Math.min(30, Math.max(5, s.corpo.split('\n').length + 1))} />
                <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginTop: 6 }}>
                  <button className="btn sm" onClick={() => maiusculas(i)} title="Selecione um trecho do texto e aperte para deixá-lo em letras maiúsculas">Colocar em MAIÚSCULAS</button>
                  <button className="btn sm" onClick={() => dividir(i)}>Dividir aqui</button>
                  <button className="btn sm" onClick={() => nova(i)}>＋ Caixa depois desta</button>
                  {i > 0 && <button className="btn sm" onClick={() => juntarComAnterior(i)}>Juntar com a anterior</button>}
                  <button className="btn sm" onClick={() => mover(i, -1)} disabled={i === 0}>↑ Subir</button>
                  <button className="btn sm" onClick={() => mover(i, 1)} disabled={i === secs.length - 1}>↓ Descer</button>
                  <button className="btn sm" onClick={() => excluir(i)}>Apagar caixa</button>
                </div>
              </div>
            )}
          </div>
        );
      })}
      {f && !secs.some(visivel) && <p className="muted">Nada encontrado.</p>}
      <button className="btn sm" style={{ marginTop: 6 }} onClick={() => nova(secs.length - 1)} title="Adicionar caixa de texto no final">＋</button>
    </div>
  );
}

function Manual({ P, papel }) {
  const [info, setInfo] = useState(null);
  const [texto, setTexto] = useState('');
  const [sujo, setSujo] = useState(false);
  const [msg, setMsg] = useState('');
  const [err, setErr] = useState('');
  const [verHist, setVerHist] = useState(false);
  const [troca, setTroca] = useState(false);           // painel "Localizar e substituir" aberto
  const [buscar, setBuscar] = useState('');
  const [trocarPor, setTrocarPor] = useState('');
  const [exato, setExato] = useState(false);           // true = diferencia maiúsculas e acentos
  const [antesDaTroca, setAntesDaTroca] = useState(null); // texto antes da última troca, para desfazer
  const [visao, setVisao] = useState(null);             // 'secoes' | 'texto' (null = escolhe sozinho ao abrir)
  const [antesDeOrganizar, setAntesDeOrganizar] = useState(null);

  const load = (preencher = true) => api(`/${P}-manual`).then((i) => {
    setInfo(i);
    if (preencher) {
      const t = i.draft ? i.draft.content : i.current ? i.current.content : '';
      setTexto(t); setSujo(false);
      setVisao((v) => v || (temSecoes(t) ? 'secoes' : 'texto'));
    }
  }).catch((e) => setErr(e.message));
  useEffect(() => { load(); }, []);
  if (!info) return <p className="muted">Carregando…</p>;

  const run = async (fn, ok) => { setErr(''); setMsg(''); try { await fn(); await load(); setMsg(ok); } catch (e) { setErr(e.message); } };
  const salvar = () => run(() => api(`/${P}-manual`, { method: 'PUT', body: { content: texto } }), `Rascunho salvo. O ${papel} ainda usa a versão publicada.`);
  const publicar = () => run(async () => {
    await api(`/${P}-manual`, { method: 'PUT', body: { content: texto } });
    await api(`/${P}-manual/publish`, { method: 'POST' });
  }, `Publicado! O ${papel} já passa a usar este manual.`);
  const restaurar = (v) => {
    if (sujo && !window.confirm('Você tem alterações não salvas. Trocar pelo texto desta versão?')) return;
    run(() => api(`/${P}-manual/restore/${v.id}`, { method: 'POST' }), 'Versão carregada no rascunho. Confira e publique se quiser usá-la.');
  };

  const igualAoPublicado = info.current && texto === info.current.content;
  const achados = achar(texto, buscar, exato);
  const substituirTudo = () => {
    if (!achados.length) return;
    let novo = texto;
    for (let i = achados.length - 1; i >= 0; i--) novo = novo.slice(0, achados[i][0]) + trocarPor + novo.slice(achados[i][1]);
    setAntesDaTroca(texto);
    setTexto(novo);
    setSujo(true);
    setErr('');
    setMsg(`${achados.length} ${achados.length === 1 ? 'troca feita' : 'trocas feitas'} no texto. Confira e publique para o ${papel} passar a usar.`);
  };
  const organizar = () => {
    const r = sugerirSecoes(texto);
    if (!r.quantas) { setErr('Não achei títulos em letras maiúsculas para separar. Use “Dividir aqui” dentro da visão por caixas.'); setVisao('secoes'); return; }
    setAntesDeOrganizar(texto);
    setTexto(r.texto); setSujo(true); setErr(''); setVisao('secoes');
    setMsg(`Separei em ${r.quantas + 1} caixas, uma por título em maiúsculas. Confira, junte ou divida o que precisar. Nada foi publicado ainda.`);
  };
  const desfazerOrganizar = () => { setTexto(antesDeOrganizar); setAntesDeOrganizar(null); setSujo(true); setMsg('Organização desfeita.'); };
  const desfazerTroca = () => { setTexto(antesDaTroca); setAntesDaTroca(null); setSujo(true); setMsg('Troca desfeita.'); };
  return (
    <>
      <p className="muted" style={{ marginBottom: 10 }}>
        Escreva aqui, em linguagem comum, {P === 'assistant' ? 'como o assistente pessoal deve trabalhar: o que ele faz, as regras da casa, o jeito de falar e o que pode e o que não pode fazer.' : 'como o atendente deve falar e agir: o jeito de tratar o cliente, regras da casa, o que pode e o que não pode prometer.'}
        Serviços, preços e horários dos profissionais já vêm do cadastro, não precisa repetir.
      </p>
      {msg && <div className="card" style={{ marginBottom: 12, color: 'var(--ok)' }}>{msg}</div>}
      {err && <div className="error">{err}</div>}
      <div className="card">
        <div style={{ marginBottom: 10 }}>
          <button className="btn sm" onClick={() => setTroca(!troca)}>{troca ? 'Fechar' : '🔎 Localizar e substituir'}</button>
          {troca && (
            <div style={{ marginTop: 10, display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'flex-end' }}>
              <div className="field" style={{ margin: 0 }}><label>Localizar</label><input value={buscar} onChange={(e) => setBuscar(e.target.value)} placeholder="Ex.: Vitória" /></div>
              <div className="field" style={{ margin: 0 }}><label>Substituir por</label><input value={trocarPor} onChange={(e) => setTrocarPor(e.target.value)} placeholder="Ex.: Cláudia" /></div>
              <button className="btn primary" onClick={substituirTudo} disabled={!achados.length}>Substituir tudo</button>
              {antesDaTroca !== null && <button className="btn" onClick={desfazerTroca}>Desfazer</button>}
              <label style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                <input type="checkbox" checked={exato} onChange={(e) => setExato(e.target.checked)} style={{ width: 'auto' }} />
                Diferenciar maiúsculas e acentos
              </label>
              <span className="muted">{buscar ? (achados.length ? `Aparece ${achados.length} ${achados.length === 1 ? 'vez' : 'vezes'}` : 'Não encontrado') : ''}</span>
            </div>
          )}
        </div>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center', marginBottom: 10 }}>
          <button className={'btn sm' + (visao === 'secoes' ? ' primary' : '')} onClick={() => setVisao('secoes')}>Por caixas</button>
          <button className={'btn sm' + (visao === 'texto' ? ' primary' : '')} onClick={() => setVisao('texto')}>Texto completo</button>
          {!temSecoes(texto) && texto.trim() && <button className="btn sm" onClick={organizar}>✨ Separar em caixas automaticamente</button>}
          {antesDeOrganizar !== null && <button className="btn sm" onClick={desfazerOrganizar}>Desfazer organização</button>}
        </div>
        {visao === 'secoes'
          ? <Secoes texto={texto} onChange={(t) => { setTexto(t); setSujo(true); setAntesDaTroca(null); setAntesDeOrganizar(null); }} />
          : <textarea value={texto} onChange={(e) => { setTexto(e.target.value); setSujo(true); setAntesDaTroca(null); }} rows={18}
              style={{ width: '100%', fontFamily: 'inherit' }} placeholder={P === 'assistant' ? 'Ex.: Você é o assistente pessoal do proprietário… Seja direto e objetivo…' : 'Ex.: Você é a atendente da empresa… Seja simpática e objetiva…'} />}
        <div className="muted" style={{ margin: '6px 0 10px' }}>
          {texto.length} caracteres ·{' '}
          {info.current ? <>publicado em {fmtDataHora(info.current.published_at)}{igualAoPublicado ? '' : ' (você tem alterações ainda não publicadas)'}</> : 'nada publicado ainda'}
        </div>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          <button className="btn" onClick={salvar} disabled={!sujo}>Salvar rascunho</button>
          <button className="btn primary" onClick={publicar} disabled={!texto.trim() || igualAoPublicado}>Publicar</button>
        </div>
      </div>

      <div className="card" style={{ marginTop: 16 }}>
        <button className="btn sm" onClick={() => setVerHist(!verHist)}>{verHist ? 'Esconder' : 'Ver'} versões anteriores ({info.versions.length})</button>
        {verHist && (
          <table style={{ marginTop: 10 }}>
            <tbody>
              {info.versions.map((v, i) => (
                <tr key={v.id}>
                  <td style={{ whiteSpace: 'nowrap' }}>{fmtDataHora(v.published_at)}{i === 0 && <strong> · em uso</strong>}</td>
                  <td className="muted">{v.content.slice(0, 90).replace(/\s+/g, ' ')}{v.content.length > 90 ? '…' : ''}</td>
                  <td style={{ textAlign: 'right' }}>{i > 0 && <button className="btn sm" onClick={() => restaurar(v)}>Voltar para esta</button>}</td>
                </tr>
              ))}
              {!info.versions.length && <tr><td className="muted">Nenhuma versão publicada ainda.</td></tr>}
            </tbody>
          </table>
        )}
      </div>
    </>
  );
}

function Atualizacoes({ P, papel }) {
  const [data, setData] = useState(null);
  const vazio = { text: '', starts_at: '', ends_at: '' };
  const [form, setForm] = useState(vazio);
  const [reativando, setReativando] = useState(null); // { id, ends_at }
  const [msg, setMsg] = useState('');
  const [err, setErr] = useState('');
  const [verEnc, setVerEnc] = useState(false);
  const load = () => api(`/${P}-updates`).then(setData).catch((e) => setErr(e.message));
  useEffect(() => { load(); }, []);
  if (!data) return <p className="muted">Carregando…</p>;

  const run = async (fn, ok) => { setErr(''); setMsg(''); try { await fn(); await load(); if (ok) setMsg(ok); } catch (e) { setErr(e.message); } };
  const emVigor = data.updates.filter((n) => n.state !== 'ended');
  const encerradas = data.updates.filter((n) => n.state === 'ended');
  const criar = (e) => {
    e.preventDefault();
    run(async () => {
      await api(`/${P}-updates`, { method: 'POST', body: form });
      setForm(vazio);
    }, 'Atualização criada.');
  };
  const confirmarReativar = () => run(async () => {
    await api(`/${P}-updates/` + reativando.id, { method: 'PUT', body: { active: true, ends_at: reativando.ends_at || null } });
    setReativando(null);
  }, 'Atualização reativada.');

  return (
    <>
      <p className="muted" style={{ marginBottom: 10 }}>
        Atualizações provisórias são informações passageiras que o {papel} passa a saber na hora (ex.: "amanhã fechamos às 15h").
        Você escolhe o dia e a hora em que deixam de valer; depois disso saem sozinhas. Elas têm prioridade sobre o manual.
      </p>
      {msg && <div className="card" style={{ marginBottom: 12, color: 'var(--ok)' }}>{msg}</div>}
      {err && <div className="error">{err}</div>}
      {emVigor.length >= 5 && (
        <div className="card" style={{ marginBottom: 12, color: 'var(--warn, #b45309)' }}>
          Você tem {emVigor.length} atualizações em vigor (o máximo é {data.max}). Muitas atualizações deixam o {papel} confuso: encerre as que já não servem e, se algo virou regra fixa, passe para o manual.
        </div>
      )}

      <form className="card" style={{ marginBottom: 16 }} onSubmit={criar}>
        <h2 style={{ marginBottom: 10 }}>Nova atualização provisória</h2>
        <div className="field">
          <label>Texto ({form.text.length}/1000)</label>
          <textarea rows={3} maxLength={1000} value={form.text} onChange={(e) => setForm({ ...form, text: e.target.value })} required style={{ width: '100%' }} />
        </div>
        <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
          <div className="field"><label>Vale a partir de (opcional)</label><input type="datetime-local" value={form.starts_at} onChange={(e) => setForm({ ...form, starts_at: e.target.value })} /></div>
          <div className="field"><label>Deixa de valer em (opcional)</label><input type="datetime-local" value={form.ends_at} min={form.starts_at || undefined} onChange={(e) => setForm({ ...form, ends_at: e.target.value })} /></div>
        </div>
        <button className="btn primary" disabled={!form.text.trim()}>Criar atualização</button>
      </form>

      <div className="card table-wrap">
        <h2 style={{ marginBottom: 10 }}>Em vigor</h2>
        <table>
          <thead><tr><th>Atualização</th><th>Período</th><th></th></tr></thead>
          <tbody>
            {emVigor.map((n) => (
              <tr key={n.id}>
                <td>{n.text}</td>
                <td style={{ whiteSpace: 'nowrap' }}>
                  {n.state === 'upcoming' ? `começa em ${fmtMomento(n.starts_at)}` : 'valendo'}
                  {n.ends_at ? ` · até ${fmtMomento(n.ends_at)}` : ' · sem data final'}
                </td>
                <td style={{ textAlign: 'right' }}>
                  <button className="btn sm" onClick={() => run(() => api(`/${P}-updates/` + n.id, { method: 'PUT', body: { active: false } }), 'Atualização encerrada.')}>Encerrar</button>
                </td>
              </tr>
            ))}
            {!emVigor.length && <tr><td colSpan="3" className="muted">Nenhuma atualização em vigor.</td></tr>}
          </tbody>
        </table>
      </div>

      <div className="card" style={{ marginTop: 16 }}>
        <button className="btn sm" onClick={() => setVerEnc(!verEnc)}>{verEnc ? 'Esconder' : 'Ver'} encerradas ({encerradas.length})</button>
        {verEnc && (
          <table style={{ marginTop: 10 }}>
            <tbody>
              {encerradas.map((n) => (
                <tr key={n.id}>
                  <td>{n.text}</td>
                  <td className="muted" style={{ whiteSpace: 'nowrap' }}>{n.ends_at ? `até ${fmtMomento(n.ends_at)}` : 'encerrada'}</td>
                  <td style={{ textAlign: 'right', whiteSpace: 'nowrap' }}>
                    {reativando?.id === n.id ? (
                      <>
                        <input type="datetime-local" value={reativando.ends_at} style={{ width: 'auto' }} onChange={(e) => setReativando({ ...reativando, ends_at: e.target.value })} />{' '}
                        <button className="btn sm primary" onClick={confirmarReativar}>Reativar até aqui</button>{' '}
                        <button className="btn sm" onClick={() => setReativando(null)}>Cancelar</button>
                      </>
                    ) : (
                      <>
                        <button className="btn sm" onClick={() => setReativando({ id: n.id, ends_at: '' })}>Reativar</button>{' '}
                        <button className="btn sm" onClick={() => window.confirm('Apagar esta atualização de vez?') && run(() => api(`/${P}-updates/` + n.id, { method: 'DELETE' }))}>Apagar</button>
                      </>
                    )}
                  </td>
                </tr>
              ))}
              {!encerradas.length && <tr><td className="muted">Nenhuma atualização encerrada.</td></tr>}
            </tbody>
          </table>
        )}
        {verEnc && reativando && <p className="muted" style={{ marginTop: 8 }}>Deixe o campo vazio para a atualização ficar valendo sem data final.</p>}
      </div>
    </>
  );
}

// Nome do agente e do proprietário/ADM (vão no início do prompt e geram as frases dos Comandos).
// Mesmo dado da aba Comandos: qualquer alteração avisa as outras telas, que recarregam na hora.
function NomeAgente() {
  const [nome, setNome] = useState('');
  const [adm, setAdm] = useState('');
  const [salvo, setSalvo] = useState({ nome: '', adm: '' });
  const [msg, setMsg] = useState('');
  const [err, setErr] = useState('');
  const carregar = () => api('/agent-config').then((c) => {
    const n = c.agent_name || '', a = c.adm_name || '';
    setNome(n); setAdm(a); setSalvo({ nome: n, adm: a });
  }).catch(() => {});
  useEffect(() => {
    carregar();
    window.addEventListener('agent-config-changed', carregar);
    window.addEventListener('focus', carregar);
    return () => { window.removeEventListener('agent-config-changed', carregar); window.removeEventListener('focus', carregar); };
  }, []);
  const mudou = nome.trim() !== salvo.nome || adm.trim() !== salvo.adm;
  const gravar = async () => {
    setErr(''); setMsg('');
    try {
      await api('/agent-config', { method: 'PUT', body: { agent_name: nome, adm_name: adm } });
      setSalvo({ nome: nome.trim(), adm: adm.trim() }); setNome(nome.trim()); setAdm(adm.trim()); setMsg('Nomes salvos');
      window.dispatchEvent(new Event('agent-config-changed'));
    } catch (e) { setErr(e.message); }
  };
  const enter = (e) => e.key === 'Enter' && mudou && gravar();
  return (
    <div className="card" style={{ marginBottom: 12 }}>
      <div className="row" style={{ alignItems: 'flex-end', flexWrap: 'wrap' }}>
        <div className="field" style={{ margin: 0, minWidth: 200, flex: '0 1 260px' }}>
          <label>Nome do agente</label>
          <input value={nome} maxLength={40} placeholder="ex.: Iara" onChange={(e) => { setNome(e.target.value); setMsg(''); }} onKeyDown={enter} />
        </div>
        <div className="field" style={{ margin: 0, minWidth: 200, flex: '0 1 260px' }}>
          <label>Proprietário / ADM</label>
          <input value={adm} maxLength={40} placeholder="ex.: Thiago" onChange={(e) => { setAdm(e.target.value); setMsg(''); }} onKeyDown={enter} />
        </div>
        {mudou && <button className="btn primary" onClick={gravar}>Salvar</button>}
        {msg && <span className="muted">{msg}</span>}
        {err && <span className="error" style={{ margin: 0 }}>{err}</span>}
      </div>
      <p className="muted" style={{ margin: '6px 0 0' }}>Vão na primeira linha do texto do agente e geram as frases dos Comandos (“<em>ADM</em> aqui” e “tá contigo <em>agente</em>”). São os mesmos campos da aba Comandos.</p>
    </div>
  );
}

// Campo de texto em caixas, igual ao do manual: por caixas ou texto completo, separar por títulos, localizar e substituir.
function CampoCaixas({ titulo, ajuda, ph, max, valor, onChange }) {
  const [visao, setVisao] = useState(() => (temSecoes(valor) ? 'secoes' : 'texto'));
  const [troca, setTroca] = useState(false);
  const [buscar, setBuscar] = useState(''); const [trocarPor, setTrocarPor] = useState(''); const [exato, setExato] = useState(false);
  const [antes, setAntes] = useState(null);          // texto antes da última troca/organização, para desfazer
  const [aviso, setAviso] = useState('');
  const achados = achar(valor, buscar, exato);
  const mudar = (t) => { onChange(t); setAntes(null); setAviso(''); };
  const substituir = () => {
    if (!achados.length) return;
    let novo = valor;
    for (let i = achados.length - 1; i >= 0; i--) novo = novo.slice(0, achados[i][0]) + trocarPor + novo.slice(achados[i][1]);
    setAntes(valor); onChange(novo); setAviso(`${achados.length} ${achados.length === 1 ? 'troca feita' : 'trocas feitas'}. Confira e salve.`);
  };
  const organizar = () => {
    const r = sugerirSecoes(valor);
    if (!r.quantas) { setAviso('Não achei títulos em letras maiúsculas para separar. Use “Dividir aqui” dentro da visão por caixas.'); setVisao('secoes'); return; }
    setAntes(valor); onChange(r.texto); setVisao('secoes'); setAviso(`Separei em ${r.quantas + 1} caixas, uma por título em maiúsculas. Confira e salve.`);
  };
  return (
    <div className="field" style={{ marginBottom: 22 }}>
      <label>{titulo}</label>
      <div style={{ marginBottom: 10 }}>
        <button className="btn sm" onClick={() => setTroca(!troca)}>{troca ? 'Fechar' : '🔎 Localizar e substituir'}</button>
        {troca && (
          <div style={{ marginTop: 10, display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'flex-end' }}>
            <div className="field" style={{ margin: 0 }}><label>Localizar</label><input value={buscar} onChange={(e) => setBuscar(e.target.value)} /></div>
            <div className="field" style={{ margin: 0 }}><label>Substituir por</label><input value={trocarPor} onChange={(e) => setTrocarPor(e.target.value)} /></div>
            <button className="btn primary" onClick={substituir} disabled={!achados.length}>Substituir tudo</button>
            {antes !== null && <button className="btn" onClick={() => { onChange(antes); setAntes(null); setAviso('Desfeito.'); }}>Desfazer</button>}
            <label style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
              <input type="checkbox" checked={exato} onChange={(e) => setExato(e.target.checked)} style={{ width: 'auto' }} />
              Diferenciar maiúsculas e acentos
            </label>
            <span className="muted">{buscar ? (achados.length ? `Aparece ${achados.length} ${achados.length === 1 ? 'vez' : 'vezes'}` : 'Não encontrado') : ''}</span>
          </div>
        )}
      </div>
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center', marginBottom: 10 }}>
        <button className={'btn sm' + (visao === 'secoes' ? ' primary' : '')} onClick={() => setVisao('secoes')}>Por caixas</button>
        <button className={'btn sm' + (visao === 'texto' ? ' primary' : '')} onClick={() => setVisao('texto')}>Texto completo</button>
        {!temSecoes(valor) && valor.trim() && <button className="btn sm" onClick={organizar}>✨ Separar em caixas automaticamente</button>}
        {antes !== null && !troca && <button className="btn sm" onClick={() => { onChange(antes); setAntes(null); setAviso('Desfeito.'); }}>Desfazer</button>}
      </div>
      {aviso && <p style={{ color: 'var(--ok)', margin: '0 0 8px' }}>{aviso}</p>}
      {visao === 'secoes'
        ? <Secoes nome="diretrizes" texto={valor} onChange={mudar} />
        : <textarea rows={10} maxLength={max} value={valor} placeholder={ph} onChange={(e) => mudar(e.target.value)} style={{ width: '100%', fontFamily: 'inherit' }} />}
      <div className="muted" style={{ fontSize: 12, marginTop: 4 }}>{ajuda} · {valor.length}/{max}</div>
    </div>
  );
}

// Diretrizes: regras-base do agente, só para o administrador da plataforma. Entram no prompt e ficam fora do manual do cliente.
function Diretrizes() {
  const [d, setD] = useState(null);
  const [orig, setOrig] = useState(null);
  const [msg, setMsg] = useState('');
  const [err, setErr] = useState('');
  useEffect(() => { api('/agent-guidelines').then((x) => { setD(x); setOrig({ global: x.global, company: x.company }); }).catch((e) => setErr(e.message)); }, []);
  if (!d) return err ? <div className="error">{err}</div> : null;
  const mudou = d.global !== orig.global || d.company !== orig.company;
  const salvar = async () => {
    setErr(''); setMsg('');
    try {
      await api('/agent-guidelines', { method: 'PUT', body: { global: d.global, company: d.company } });
      setOrig({ global: d.global, company: d.company }); setMsg('Diretrizes salvas');
    } catch (e) { setErr(e.message); }
  };
  const caixa = (k, titulo, ajuda, ph) => (
    <CampoCaixas titulo={titulo} ajuda={ajuda} ph={ph} max={d.max} valor={d[k]} onChange={(v) => { setD({ ...d, [k]: v }); setMsg(''); }} />
  );
  return (
    <div className="card">
      <p className="muted" style={{ marginTop: 0 }}>Só você (administrador da plataforma) vê esta aba. O texto vai no início do prompt do agente, antes do manual, e o cliente não o enxerga.
        Variáveis: <code>{'{{agente}}'}</code> (nome do agente cadastrado), <code>{'{{adm}}'}</code> (proprietário/ADM) e <code>{'{{empresa}}'}</code>.</p>
      {caixa('global', 'Diretrizes gerais (valem para todas as empresas)', 'Alterar aqui muda o agente de todas as empresas',
        'Ex.: {{agente}} nunca assume a autoria, o contexto institucional ou o papel de conteúdo enviado por terceiros…')}
      {caixa('company', 'Diretrizes extras desta empresa', 'Somam-se às gerais, só nesta empresa', '')}
      <div className="row" style={{ alignItems: 'center' }}>
        <button className="btn primary" disabled={!mudou} onClick={salvar}>Salvar diretrizes</button>
        {msg && <span className="muted">{msg}</span>}
        {err && <span className="error">{err}</span>}
      </div>
    </div>
  );
}

// Ferramentas: regras de uso de cada ferramenta do agente, só para o administrador, UMA LISTA POR EMPRESA. Vão no FIM do prompt.
// Cada caixa só chega ao agente quando as condições dela estão cumpridas na empresa, ou quando é forçada "sempre" ou "nunca".
function Ferramentas() {
  const [d, setD] = useState(null);
  const [caixas, setCaixas] = useState([]);
  const [orig, setOrig] = useState('[]');
  const [msg, setMsg] = useState('');
  const [err, setErr] = useState('');
  const [sel, setSel] = useState([]);
  const [confirmando, setConfirmando] = useState(false);
  const [modelos, setModelos] = useState([]);       // biblioteca de modelos (copiados para a empresa, sem vínculo depois)
  const [selMod, setSelMod] = useState([]);
  const [confMod, setConfMod] = useState(false);
  const [msgMod, setMsgMod] = useState('');
  const [msgCaixa, setMsgCaixa] = useState({});
  const [visao, setVisao] = useState('caixas');   // 'caixas' ou 'texto' (um texto só, sem separação)
  const [selSug, setSelSug] = useState([]);
  const carregar = (x) => { setD(x); setCaixas(x.boxes); setOrig(JSON.stringify(x.boxes)); };
  useEffect(() => {
    api('/agent-tools').then(carregar).catch((e) => setErr(e.message));
    api('/agent-tools/presets').then((x) => setModelos(x.presets)).catch(() => {});
  }, []);
  if (!d) return err ? <div className="error">{err}</div> : null;
  const mudou = JSON.stringify(caixas) !== orig;
  const total = caixas.reduce((n, c) => n + c.text.length, 0);
  const altera = (id, campo, v) => { setCaixas((l) => l.map((c) => (c.id === id ? { ...c, [campo]: v } : c))); setMsg(''); };
  const alternaCond = (c, k) => altera(c.id, 'conds', c.conds.includes(k) ? c.conds.filter((x) => x !== k) : [...c.conds, k]);
  const nova = () => { setCaixas((l) => [...l, { id: novoId(), title: '', text: '', conds: [], mode: 'auto', ref: '' }]); setMsg(''); };
  const sobe = (i, dir) => setCaixas((l) => { const a = [...l]; const j = i + dir; if (j < 0 || j >= a.length) return a; [a[i], a[j]] = [a[j], a[i]]; return a; });
  const alternaSel = (id) => { setConfirmando(false); setSel((a) => (a.includes(id) ? a.filter((x) => x !== id) : [...a, id])); };
  const alternaTodas = () => { setConfirmando(false); setSel(sel.length === caixas.length ? [] : caixas.map((c) => c.id)); };
  const apagarSel = () => { setCaixas((l) => l.filter((c) => !sel.includes(c.id))); setSel([]); setConfirmando(false); setMsg(''); };
  // texto completo: as caixas viram um texto só; "=====" separa caixas. Título, condições e modo ficam com a caixa da mesma posição.
  const textoCompleto = caixas.map((c) => c.text).join('\n=====\n');
  const mudaTextoCompleto = (v) => {
    const partes = v.split(/^={5}[ \t]*\r?\n?/m);
    const limpa = (t, i) => (i < partes.length - 1 ? t.replace(/\n$/, '') : t);   // o "\n" antes de cada "=====" é do separador
    setCaixas((l) => partes.map((t, i) => (l[i] ? { ...l[i], text: limpa(t, i) } : { id: novoId(), title: '', text: limpa(t, i), conds: [], mode: 'auto', ref: '' })));
    setMsg('');
  };
  const criarSugeridas = () => {
    const novas = d.suggestions.filter((x) => selSug.includes(x.ref)).map((x) => ({ id: novoId(), title: x.title, text: '', conds: x.conds, mode: 'auto', ref: x.ref }));
    setCaixas((l) => [...l, ...novas]); setSelSug([]);
    setMsg(`${novas.length} ${novas.length === 1 ? 'caixa criada' : 'caixas criadas'}. Escreva o texto de cada uma e salve.`);
  };
  const novoId = () => 'f' + Date.now().toString(36) + Math.random().toString(36).slice(2, 5);
  const gravaModelos = async (lista) => { const x = await api('/agent-tools/presets', { method: 'PUT', body: { presets: lista } }); setModelos(x.presets); };
  const salvarComoModelo = async (c) => {
    setMsgCaixa((m) => ({ ...m, [c.id]: '' }));
    try {
      const novo = { id: modelos.find((m) => m.title && m.title === c.title)?.id || novoId(), title: c.title, text: c.text, conds: c.conds, mode: 'auto' };
      await gravaModelos(modelos.some((m) => m.id === novo.id) ? modelos.map((m) => (m.id === novo.id ? novo : m)) : [...modelos, novo]);
      setMsgCaixa((m) => ({ ...m, [c.id]: 'Salvo como modelo (outras empresas podem copiá-lo)' }));
    } catch (e) { setMsgCaixa((m) => ({ ...m, [c.id]: e.message })); }
  };
  const usarModelos = () => {
    const novas = modelos.filter((m) => selMod.includes(m.id)).map((m) => ({ ...m, id: novoId(), mode: 'auto' }));
    setCaixas((l) => [...l, ...novas]); setSelMod([]); setMsg(`${novas.length} ${novas.length === 1 ? 'caixa copiada' : 'caixas copiadas'} do modelo. Ajuste o que precisar e salve.`);
  };
  const apagarModelos = async () => {
    setMsgMod('');
    try { await gravaModelos(modelos.filter((m) => !selMod.includes(m.id))); setSelMod([]); setConfMod(false); setMsgMod('Modelos apagados'); }
    catch (e) { setMsgMod(e.message); }
  };
  const salvar = async () => {
    setErr(''); setMsg('');
    try { carregar(await api('/agent-tools', { method: 'PUT', body: { boxes: caixas } })); setMsg('Ferramentas salvas'); }
    catch (e) { setErr(e.message); }
  };
  return (
    <div className="card">
      <p className="muted" style={{ marginTop: 0 }}>Só você (administrador da plataforma) vê esta aba. As caixas são <strong>desta empresa</strong>: cada empresa tem as suas, com as particularidades do ramo dela.
        Cada caixa explica ao agente como usar uma ferramenta e vai no fim do prompt, depois do manual. Ela só chega ao agente quando todas as condições marcadas estão cumpridas.
        Variáveis: <code>{'{{agente}}'}</code>, <code>{'{{adm}}'}</code> e <code>{'{{empresa}}'}</code>.</p>
      <details style={{ marginBottom: 10 }}>
        <summary style={{ cursor: 'pointer' }}>Modelos prontos ({modelos.length})</summary>
        <p className="muted" style={{ margin: '6px 0' }}>Os modelos facilitam montar as caixas de uma empresa. Ao usar um modelo, o texto é <strong>copiado</strong> para esta empresa e passa a ser dela: mudar a caixa aqui não altera o modelo nem as outras empresas.
          Para criar um modelo, use “Salvar como modelo” numa caixa.</p>
        {modelos.length > 0 && (
          <div>
            <label style={{ display: 'flex', gap: 6, alignItems: 'center', marginBottom: 4 }}>
              <input type="checkbox" checked={selMod.length === modelos.length} onChange={() => { setConfMod(false); setSelMod(selMod.length === modelos.length ? [] : modelos.map((m) => m.id)); }} /> Selecionar todos
            </label>
            {modelos.map((m) => (
              <label key={m.id} style={{ display: 'flex', gap: 6, alignItems: 'center', padding: '2px 0' }}>
                <input type="checkbox" checked={selMod.includes(m.id)} onChange={() => { setConfMod(false); setSelMod((a) => (a.includes(m.id) ? a.filter((x) => x !== m.id) : [...a, m.id])); }} />
                <strong>{m.title || 'Sem nome'}</strong> <span className="muted">{m.text.slice(0, 70)}{m.text.length > 70 ? '…' : ''}</span>
              </label>
            ))}
            <div className="row" style={{ alignItems: 'center', gap: 8, marginTop: 6 }}>
              <button className="btn primary sm" disabled={!selMod.length} onClick={usarModelos}>Copiar para esta empresa</button>
              {!confMod && <button className="btn sm" disabled={!selMod.length} onClick={() => setConfMod(true)}>Apagar modelos selecionados</button>}
              {confMod && <span>Apagar {selMod.length} {selMod.length === 1 ? 'modelo' : 'modelos'}? As caixas já copiadas para empresas não mudam. <button className="btn primary sm" onClick={apagarModelos}>Sim, apagar</button> <button className="btn sm" onClick={() => setConfMod(false)}>Cancelar</button></span>}
              {msgMod && <span className="muted">{msgMod}</span>}
            </div>
          </div>
        )}
      </details>
      {(() => {
        const faltam = d.suggestions.filter((x) => !x.existe && !caixas.some((c) => c.ref === x.ref));
        const prontas = faltam.filter((x) => x.disponivel), outras = faltam.filter((x) => !x.disponivel);
        const linha = (x) => (
          <label key={x.ref} style={{ display: 'flex', gap: 6, alignItems: 'center', padding: '2px 0' }}>
            <input type="checkbox" checked={selSug.includes(x.ref)} onChange={() => setSelSug((a) => (a.includes(x.ref) ? a.filter((k) => k !== x.ref) : [...a, x.ref]))} /> {x.title}
          </label>
        );
        if (!faltam.length) return null;
        return (
          <div style={{ border: '1px dashed var(--line, #ccc)', borderRadius: 8, padding: 10, marginBottom: 10 }}>
            <strong>Ferramentas sugeridas para esta empresa</strong>
            <p className="muted" style={{ margin: '4px 0 6px' }}>Já vêm com o nome e as condições certas, só faltando o texto. As primeiras são as dos módulos ligados nesta empresa.</p>
            {prontas.length > 0 && (
              <label style={{ display: 'flex', gap: 6, alignItems: 'center', marginBottom: 2 }}>
                <input type="checkbox" checked={prontas.every((x) => selSug.includes(x.ref))} onChange={() => setSelSug((a) => (prontas.every((x) => a.includes(x.ref)) ? a.filter((k) => !prontas.some((x) => x.ref === k)) : [...new Set([...a, ...prontas.map((x) => x.ref)])]))} /> Selecionar todas as sugeridas
              </label>
            )}
            {prontas.map(linha)}
            {!prontas.length && <span className="muted">Todas as ferramentas dos módulos ligados já têm caixa.</span>}
            {outras.length > 0 && (
              <details style={{ marginTop: 6 }}>
                <summary className="muted" style={{ cursor: 'pointer' }}>Outras ferramentas (módulo desligado nesta empresa)</summary>
                {outras.map(linha)}
              </details>
            )}
            <button className="btn primary sm" style={{ marginTop: 6 }} disabled={!selSug.length} onClick={criarSugeridas}>Criar caixas selecionadas</button>
          </div>
        );
      })()}
      <div className="row" style={{ gap: 6, marginBottom: 8 }}>
        <button className={'btn sm' + (visao === 'caixas' ? ' primary' : '')} onClick={() => setVisao('caixas')}>Por caixas</button>
        <button className={'btn sm' + (visao === 'texto' ? ' primary' : '')} onClick={() => setVisao('texto')}>Texto completo</button>
      </div>
      {visao === 'texto' && (
        <div style={{ marginBottom: 10 }}>
          <p className="muted" style={{ margin: '0 0 4px' }}>Todo o texto de uma vez. Uma linha <code>=====</code> separa uma caixa da outra; apague essas linhas para ter um texto único.
            As condições e o modo de cada caixa ficam com a caixa da mesma posição: em um texto único, valem as da primeira caixa.</p>
          <textarea rows={16} value={textoCompleto} onChange={(e) => mudaTextoCompleto(e.target.value)} style={{ width: '100%', fontFamily: 'inherit' }} />
        </div>
      )}
      {visao === 'caixas' && caixas.length > 0 && (
        <div className="row" style={{ alignItems: 'center', gap: 12, marginBottom: 8 }}>
          <label style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
            <input type="checkbox" checked={sel.length === caixas.length} onChange={alternaTodas} /> Selecionar todas
          </label>
          {sel.length > 0 && !confirmando && <button className="btn sm" onClick={() => setConfirmando(true)}>Apagar selecionadas ({sel.length})</button>}
          {sel.length > 0 && confirmando && (
            <span>Apagar {sel.length} {sel.length === 1 ? 'caixa' : 'caixas'}? <button className="btn primary sm" onClick={apagarSel}>Sim, apagar</button> <button className="btn sm" onClick={() => setConfirmando(false)}>Cancelar</button></span>
          )}
        </div>
      )}
      {visao === 'caixas' && caixas.map((c, i) => {
        const salva = d.boxes.some((b) => b.id === c.id);
        return (
          <div key={c.id} style={{ border: '1px solid var(--line, #ddd)', borderRadius: 8, padding: 10, marginBottom: 10 }}>
            <div className="row" style={{ alignItems: 'center', gap: 8 }}>
              <input type="checkbox" checked={sel.includes(c.id)} onChange={() => alternaSel(c.id)} title="Selecionar" />
              <input value={c.title} maxLength={80} placeholder="Nome da ferramenta (ex.: Agendamento)" onChange={(e) => altera(c.id, 'title', e.target.value)} style={{ flex: 1 }} />
              <button className="btn sm" disabled={i === 0} onClick={() => sobe(i, -1)} title="Subir">↑</button>
              <button className="btn sm" disabled={i === caixas.length - 1} onClick={() => sobe(i, 1)} title="Descer">↓</button>
            </div>
            <textarea rows={6} value={c.text} placeholder="Como o agente deve usar esta ferramenta: quando usar, o que confirmar antes, o que dizer depois, o que nunca fazer."
              onChange={(e) => altera(c.id, 'text', e.target.value)} style={{ width: '100%', fontFamily: 'inherit', marginTop: 8 }} />
            <details style={{ marginTop: 6 }}>
              <summary className="muted" style={{ cursor: 'pointer' }}>Condições para chegar ao agente ({c.conds.length ? c.conds.length + ' marcadas' : 'nenhuma: chega sempre'})</summary>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(240px, 1fr))', gap: 4, marginTop: 6 }}>
                {d.conditions.map((k) => (
                  <label key={k.key} style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                    <input type="checkbox" checked={c.conds.includes(k.key)} onChange={() => alternaCond(c, k.key)} /> {k.label}
                  </label>
                ))}
              </div>
            </details>
            <div className="row" style={{ alignItems: 'center', gap: 8, marginTop: 8, flexWrap: 'wrap' }}>
              <select value={c.mode || 'auto'} onChange={(e) => altera(c.id, 'mode', e.target.value)}>
                <option value="auto">Automático (pelas condições)</option>
                <option value="on">Sempre chega ao agente</option>
                <option value="off">Nunca chega ao agente</option>
              </select>
              {salva
                ? <strong style={{ color: d.active[c.id] ? 'var(--ok)' : 'var(--muted, #888)' }}>{d.active[c.id] ? 'Chega ao agente' : 'Não chega ao agente'}</strong>
                : <span className="muted">Salve para ver se chega ao agente</span>}
              <button className="btn sm" disabled={!c.title.trim() || !c.text.trim()} onClick={() => salvarComoModelo(c)}>Salvar como modelo</button>
              {msgCaixa[c.id] && <span className="muted">{msgCaixa[c.id]}</span>}
            </div>
          </div>
        );
      })}
      {!caixas.length && <p className="muted">Nenhuma caixa ainda.</p>}
      <div className="row" style={{ alignItems: 'center', gap: 8 }}>
        {visao === 'caixas' && <button className="btn" onClick={nova}>Nova caixa</button>}
        <button className="btn primary" disabled={!mudou} onClick={salvar}>Salvar ferramentas</button>
        <span className="muted">{total}/{d.max}</span>
        {msg && <span className="muted">{msg}</span>}
        {err && <span className="error">{err}</span>}
      </div>
    </div>
  );
}

export default function Atendente({ company }) {
  const [aba, setAba] = useState('manual');
  // O assistente é opcional: só aparece quando o administrador liga para a empresa
  const temAssistente = company?.modules?.assistente === true;
  const [quem, setQuem] = useState('agent');
  const [upg, setUpg] = useState(false);
  const [ehAdmin, setEhAdmin] = useState(false);
  useEffect(() => { api('/me').then((m) => setEhAdmin(!!m.platform_admin)).catch(() => {}); }, []);
  // sem o assistente no plano, a aba aparece sempre apagada, com cadeado e convite de upgrade (serve a qualquer negócio)
  const assistenteBloqueado = !temAssistente;
  const P = temAssistente ? quem : 'agent';
  const papel = P === 'assistant' ? 'assistente pessoal' : 'atendente';
  return (
    <>
      <h1><Nome id="atendente">Atendente</Nome></h1>
      {temAssistente && (
        <div style={{ display: 'flex', gap: 8, margin: '12px 0 0' }}>
          <button className={'btn' + (P === 'agent' ? ' primary' : '')} onClick={() => setQuem('agent')}>Atendente</button>
          <button className={'btn' + (P === 'assistant' ? ' primary' : '')} onClick={() => setQuem('assistant')}>Assistente pessoal</button>
        </div>
      )}
      {assistenteBloqueado && (
        <div style={{ display: 'flex', gap: 8, margin: '12px 0 0' }}>
          <button className="btn primary">Atendente</button>
          <button className="btn" style={{ opacity: .55, display: 'inline-flex', alignItems: 'center', gap: 6 }} title="Disponível em outro plano" onClick={() => setUpg(true)}>Assistente pessoal <IconeCadeado size={13} /></button>
        </div>
      )}
      {upg && <UpgradeModal company={company} nome="Assistente pessoal" onClose={() => setUpg(false)} />}
      {P === 'agent' && <NomeAgente />}
      <div style={{ display: 'flex', gap: 8, margin: '12px 0 16px' }}>
        <button className={'btn' + (aba === 'manual' ? ' primary' : '')} onClick={() => setAba('manual')}>Manual</button>
        <button className={'btn' + (aba === 'atualizacoes' ? ' primary' : '')} onClick={() => setAba('atualizacoes')}>Atualizações provisórias</button>
        {ehAdmin && P === 'agent' && <button className={'btn' + (aba === 'diretrizes' ? ' primary' : '')} onClick={() => setAba('diretrizes')}>Diretrizes</button>}
        {ehAdmin && P === 'agent' && <button className={'btn' + (aba === 'ferramentas' ? ' primary' : '')} onClick={() => setAba('ferramentas')}>Ferramentas</button>}
      </div>
      {aba === 'ferramentas' && ehAdmin && P === 'agent' ? <Ferramentas /> : aba === 'diretrizes' && ehAdmin && P === 'agent' ? <Diretrizes /> : aba === 'atualizacoes' ? <Atualizacoes key={P} P={P} papel={papel} /> : <Manual key={P} P={P} papel={papel} />}
    </>
  );
}
