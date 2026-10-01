import React, { useEffect, useState } from 'react';
import { Nome } from '../menu.jsx';
import { api } from '../api.js';

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

function Manual() {
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

  const load = (preencher = true) => api('/agent-manual').then((i) => {
    setInfo(i);
    if (preencher) { setTexto(i.draft ? i.draft.content : i.current ? i.current.content : ''); setSujo(false); }
  }).catch((e) => setErr(e.message));
  useEffect(() => { load(); }, []);
  if (!info) return <p className="muted">Carregando…</p>;

  const run = async (fn, ok) => { setErr(''); setMsg(''); try { await fn(); await load(); setMsg(ok); } catch (e) { setErr(e.message); } };
  const salvar = () => run(() => api('/agent-manual', { method: 'PUT', body: { content: texto } }), 'Rascunho salvo. O atendente ainda usa a versão publicada.');
  const publicar = () => run(async () => {
    await api('/agent-manual', { method: 'PUT', body: { content: texto } });
    await api('/agent-manual/publish', { method: 'POST' });
  }, 'Publicado! O atendente já passa a usar este manual.');
  const restaurar = (v) => {
    if (sujo && !window.confirm('Você tem alterações não salvas. Trocar pelo texto desta versão?')) return;
    run(() => api(`/agent-manual/restore/${v.id}`, { method: 'POST' }), 'Versão carregada no rascunho. Confira e publique se quiser usá-la.');
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
    setMsg(`${achados.length} ${achados.length === 1 ? 'troca feita' : 'trocas feitas'} no texto. Confira e publique para o atendente passar a usar.`);
  };
  const desfazerTroca = () => { setTexto(antesDaTroca); setAntesDaTroca(null); setSujo(true); setMsg('Troca desfeita.'); };
  return (
    <>
      <p className="muted" style={{ marginBottom: 10 }}>
        Escreva aqui, em linguagem comum, como o atendente deve falar e agir: o jeito de tratar o cliente, regras da casa, o que pode e o que não pode prometer.
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
        <textarea value={texto} onChange={(e) => { setTexto(e.target.value); setSujo(true); setAntesDaTroca(null); }} rows={18}
          style={{ width: '100%', fontFamily: 'inherit' }} placeholder="Ex.: Você é a atendente da empresa… Seja simpática e objetiva…" />
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

function Atualizacoes() {
  const [data, setData] = useState(null);
  const vazio = { text: '', starts_at: '', ends_at: '' };
  const [form, setForm] = useState(vazio);
  const [reativando, setReativando] = useState(null); // { id, ends_at }
  const [msg, setMsg] = useState('');
  const [err, setErr] = useState('');
  const [verEnc, setVerEnc] = useState(false);
  const load = () => api('/agent-updates').then(setData).catch((e) => setErr(e.message));
  useEffect(() => { load(); }, []);
  if (!data) return <p className="muted">Carregando…</p>;

  const run = async (fn, ok) => { setErr(''); setMsg(''); try { await fn(); await load(); if (ok) setMsg(ok); } catch (e) { setErr(e.message); } };
  const emVigor = data.updates.filter((n) => n.state !== 'ended');
  const encerradas = data.updates.filter((n) => n.state === 'ended');
  const criar = (e) => {
    e.preventDefault();
    run(async () => {
      await api('/agent-updates', { method: 'POST', body: form });
      setForm(vazio);
    }, 'Atualização criada.');
  };
  const confirmarReativar = () => run(async () => {
    await api('/agent-updates/' + reativando.id, { method: 'PUT', body: { active: true, ends_at: reativando.ends_at || null } });
    setReativando(null);
  }, 'Atualização reativada.');

  return (
    <>
      <p className="muted" style={{ marginBottom: 10 }}>
        Atualizações provisórias são informações passageiras que o atendente passa a saber na hora (ex.: "amanhã fechamos às 15h").
        Você escolhe o dia e a hora em que deixam de valer; depois disso saem sozinhas. Elas têm prioridade sobre o manual.
      </p>
      {msg && <div className="card" style={{ marginBottom: 12, color: 'var(--ok)' }}>{msg}</div>}
      {err && <div className="error">{err}</div>}
      {emVigor.length >= 5 && (
        <div className="card" style={{ marginBottom: 12, color: 'var(--warn, #b45309)' }}>
          Você tem {emVigor.length} atualizações em vigor (o máximo é {data.max}). Muitas atualizações deixam o atendente confuso: encerre as que já não servem e, se algo virou regra fixa, passe para o manual.
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
                  <button className="btn sm" onClick={() => run(() => api('/agent-updates/' + n.id, { method: 'PUT', body: { active: false } }), 'Atualização encerrada.')}>Encerrar</button>
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
                        <button className="btn sm" onClick={() => window.confirm('Apagar esta atualização de vez?') && run(() => api('/agent-updates/' + n.id, { method: 'DELETE' }))}>Apagar</button>
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

export default function Atendente() {
  const [aba, setAba] = useState('manual');
  return (
    <>
      <h1><Nome id="atendente">Atendente</Nome></h1>
      <div style={{ display: 'flex', gap: 8, margin: '12px 0 16px' }}>
        <button className={'btn' + (aba === 'manual' ? ' primary' : '')} onClick={() => setAba('manual')}>Manual</button>
        <button className={'btn' + (aba === 'atualizacoes' ? ' primary' : '')} onClick={() => setAba('atualizacoes')}>Atualizações provisórias</button>
      </div>
      {aba === 'manual' ? <Manual /> : <Atualizacoes />}
    </>
  );
}
