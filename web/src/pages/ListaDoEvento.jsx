import React, { useEffect, useMemo, useState } from 'react';
import { api, getToken, fmtPhone } from '../api.js';
import LeitorQr from './LeitorQr.jsx';

const PAGTO = { paid: 'Pago', partial: 'Parcial', pending: 'Pendente', courtesy: 'Cortesia', no_price: '—' };
const ACAO = { entrada: 'marcou entrada', entrada_desfeita: 'desfez a entrada', comentario: 'comentou', edicao: 'editou' };
const quando = (d) => new Date(d).toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' });
const hora = (d) => new Date(d).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
const guarda = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* sem espaço: segue sem cópia */ } };
const le = (k, padrao) => { try { return JSON.parse(localStorage.getItem(k)) ?? padrao; } catch { return padrao; } };
const semConexao = (e) => !e?.data && !/Sessão|autoriz|permiss/i.test(e?.message || '');
const dinheiro = (v) => (v === null || v === undefined ? '—' : Number(v).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' }));

// Lista do evento: uma linha por pessoa. Três níveis de acesso:
// editor edita, comentarista marca entrada e comenta, leitor só consulta.
export default function ListaDoEvento({ eventoId = null, onVoltar = null }) {
  const [nivel, setNivel] = useState(null);
  const [dono, setDono] = useState(false);   // dono da empresa (a equipe não mexe no envio)
  const [eventos, setEventos] = useState([]);
  const [ev, setEv] = useState('');
  const [d, setD] = useState(null);
  const [erro, setErro] = useState('');
  const [busca, setBusca] = useState('');
  const [filtro, setFiltro] = useState('todos');
  const [edit, setEdit] = useState(null);
  const [leitor, setLeitor] = useState(false);
  const [ingresso, setIngresso] = useState('');
  const [nota, setNota] = useState(null);
  const [registro, setRegistro] = useState(null);
  const [offline, setOffline] = useState(null);   // hora da cópia salva, quando a lista não carregou
  const [fila, setFila] = useState(() => le('lista_evento_fila', []));   // marcações feitas sem internet, ainda por enviar

  useEffect(() => {
    api('/me').then((m) => {
      const t = m.equipe?.telas;
      setDono(!t);
      setNivel(!t || t.includes('lista_evento_editor') ? 'editor' : t.includes('lista_evento_comentarista') ? 'comentarista' : 'leitor');
    }).catch(() => setNivel('leitor'));
    Promise.all([api('/events?quando=proximos'), api('/events?quando=passados').catch(() => [])]).then(([p, o]) => {
      const l = [...p, ...o.slice(0, 60)];
      setEventos(l);
      setEv(eventoId ? String(eventoId) : l[0] ? String(l[0].id) : '');
    }).catch((e) => setErro(e.message));
  }, []);

  const aplicar = (x, itens) => {   // põe por cima da lista as marcações ainda não enviadas
    if (!itens.length) return x;
    const rows = x.rows.map((r) => {
      let out = r;
      for (const it of itens) {
        if (String(it.sale_id) !== String(r.sale_id) || it.ev !== ev) continue;
        if (it.tipo === 'entrada' && (it.seq === r.seq || it.seq === 0)) out = { ...out, entered_at: it.entered ? it.at : null, entered_by: it.entered ? 'você (sem internet)' : null };
        if (it.tipo === 'nota' && it.seq === r.seq) out = { ...out, door_note: it.note };
      }
      return out;
    });
    return { ...x, rows, summary: { ...x.summary, entered: rows.filter((r) => r.entered_at).length } };
  };
  const mandar = (it) => it.tipo === 'entrada'
    ? api(it.seq === 0 ? `/event-list-comment/${it.sale_id}/entry` : `/event-list-comment/${it.sale_id}/${it.seq}/entry`, { method: 'PUT', body: { entered: it.entered, at: it.at } })
    : api(`/event-list-comment/${it.sale_id}/${it.seq}/note`, { method: 'PUT', body: { note: it.note } });
  const enviarFila = async () => {   // manda o que ficou guardado, na ordem; para na primeira falha de conexão
    let atual = le('lista_evento_fila', []);
    while (atual.length) {
      try { await mandar(atual[0]); } catch (e) { if (semConexao(e)) break; }   // recusada pelo servidor (ex.: venda cancelada): descarta
      atual = atual.slice(1);
      guarda('lista_evento_fila', atual); setFila(atual);
    }
  };
  const carregar = async () => {
    if (!ev) return;
    await enviarFila();
    try {
      const x = await api(`/event-list?event_id=${ev}`);
      guarda('lista_evento_copia_' + ev, { x, at: new Date().toISOString() });
      setD(aplicar(x, le('lista_evento_fila', []))); setErro(''); setOffline(null);
    } catch (e) {
      const c = le('lista_evento_copia_' + ev, null);
      if (semConexao(e) && c) { setD(aplicar(c.x, le('lista_evento_fila', []))); setOffline(c.at); setErro(''); } else setErro(e.message);
    }
  };
  useEffect(() => { const h = () => carregar(); window.addEventListener('online', h); return () => window.removeEventListener('online', h); }, [ev]);
  useEffect(() => { setD(null); carregar(); }, [ev]);
  // a portaria vê a lista andar sozinha
  useEffect(() => { const t = setInterval(carregar, 20000); return () => clearInterval(t); }, [ev]);

  const rows = useMemo(() => {
    if (!d) return [];
    const b = busca.trim().toLowerCase();
    return d.rows.filter((r) => {
      if (filtro === 'entrou' && !r.entered_at) return false;
      if (filtro === 'faltam' && r.entered_at) return false;
      if (filtro === 'pendentes' && !['pending', 'partial'].includes(r.payment)) return false;
      return !b || [r.name, r.sector, r.table, r.phone, r.buyer, r.note, r.door_note].some((v) => String(v || '').toLowerCase().includes(b));
    });
  }, [d, busca, filtro]);

  const agir = async (fn) => { try { await fn(); await carregar(); } catch (e) { setErro(e.message); } };
  // Marcação com internet vai direto; sem internet fica guardada no aparelho e sobe sozinha quando voltar
  const registrarMarca = async (it) => {
    try { await mandar(it); await carregar(); }
    catch (e) {
      if (!semConexao(e)) { setErro(e.message); return; }
      const nova = [...le('lista_evento_fila', []), it];
      guarda('lista_evento_fila', nova); setFila(nova);
      setD((x) => aplicar(x, [it]));
    }
  };
  const entrada = (r) => registrarMarca({ tipo: 'entrada', ev, sale_id: r.sale_id, seq: r.seq, entered: !r.entered_at, at: new Date().toISOString() });
  const baixar = async () => {
    try {
      const res = await fetch(`/api/event-list/export?event_id=${ev}`, { headers: { Authorization: 'Bearer ' + getToken() } });
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || 'Não foi possível baixar');
      const url = URL.createObjectURL(await res.blob());
      const a = document.createElement('a'); a.href = url; a.download = 'lista-do-evento.csv'; a.click();
      URL.revokeObjectURL(url);
    } catch (e) { setErro(e.message); }
  };
  const abrirRegistro = () => api(`/event-list/log?event_id=${ev}`).then(setRegistro).catch((e) => setErro(e.message));
  const salvarEdicao = (e) => {
    e.preventDefault();
    agir(async () => { await api(`/event-list/${edit.sale_id}/${edit.seq}`, { method: 'PUT', body: { name: edit.name, phone: edit.phone, note: edit.note } }); setEdit(null); });
  };
  const salvarNota = (e) => {
    e.preventDefault();
    registrarMarca({ tipo: 'nota', ev, sale_id: nota.sale_id, seq: nota.seq, note: nota.door_note });
    setNota(null);
  };

  const [envio, setEnvio] = useState(null);   // { enabled, phones, connected, next }
  const [telefones, setTelefones] = useState('');
  const [paraAdm, setParaAdm] = useState(true);
  const [paraEmpresa, setParaEmpresa] = useState(false);
  const [aviso, setAviso] = useState('');
  const carregarEnvio = () => api('/event-list-settings').then((x) => { setEnvio(x); setTelefones(x.phones.join('\n')); setParaAdm(x.to_admin); setParaEmpresa(x.to_company); }).catch(() => {});
  useEffect(() => { if (dono) carregarEnvio(); }, [dono]);
  const salvarEnvio = async (enabled) => {
    setAviso(''); setErro('');
    try {
      await api('/event-list-settings', { method: 'PUT', body: { enabled, to_admin: paraAdm, to_company: paraEmpresa, phones: telefones.split(/[\n,;]+/).map((x) => x.trim()).filter(Boolean) } });
      await carregarEnvio(); setAviso(enabled ? 'Envio ligado.' : 'Envio salvo.');
    } catch (e) { setErro(e.message); }
  };
  const enviarAgora = async () => {
    setAviso(''); setErro('');
    try { await api('/event-list/send-now', { method: 'POST', body: { event_id: ev } }); setAviso('Lista enviada.'); } catch (e) { setErro(e.message); }
  };
  const gerarIngresso = async (r) => {   // PDF do ingresso desta pessoa, com QR Code
    setIngresso('');
    const aba = window.open('', '_blank');
    try {
      const x = await api(`/event-list/${r.sale_id}/${r.seq}/ticket`, { method: 'POST' });
      if (aba) aba.location.href = x.url; else setIngresso(x.url);
    } catch (e) { aba?.close(); setErro(e.message); }
  };
  const podeMarcar = nivel === 'editor' || nivel === 'comentarista';
  return (
    <>
      <div style={{ marginBottom: 12 }}>
        <h1>Lista do evento</h1>
        <p className="muted">
          Todas as pessoas do evento, uma por linha.
          {nivel === 'editor' && ' Você pode editar os dados, marcar a entrada e comentar.'}
          {nivel === 'comentarista' && ' Marque quem entrou e deixe seus comentários.'}
          {nivel === 'leitor' && ' Somente consulta.'}
        </p>
      </div>
      {erro && <p className="error">{erro}</p>}
      {ingresso && <p><a href={ingresso} target="_blank" rel="noreferrer">Abrir o ingresso</a></p>}
      {offline && <p className="error">Sem conexão. Mostrando a lista salva neste aparelho às {hora(offline)}. Você pode continuar marcando as entradas: elas sobem sozinhas quando a internet voltar.</p>}
      {fila.length > 0 && <p className="muted">{fila.length} marcação(ões) aguardando para enviar.</p>}
      <div className="row" style={{ marginBottom: 12, gap: 8, flexWrap: 'wrap' }}>
        {onVoltar && <button className="btn" onClick={onVoltar}>← Eventos</button>}
        {!eventoId && (
          <select value={ev} onChange={(e) => setEv(e.target.value)} style={{ minWidth: 220, flex: '1 1 220px' }}>
            {!eventos.length && <option value="">Nenhum evento</option>}
            {eventos.map((e) => <option key={e.id} value={e.id}>{e.title} · {new Date(e.starts_at).toLocaleDateString('pt-BR')}</option>)}
          </select>
        )}
        <input placeholder="Buscar por nome, mesa ou telefone" value={busca} onChange={(e) => setBusca(e.target.value)} style={{ flex: '2 1 220px' }} />
        {nivel && nivel !== 'leitor' && <button className="btn primary" onClick={() => setLeitor(true)} disabled={!ev}>Ler QR Code</button>}
        <button className="btn" onClick={baixar} disabled={!ev}>Baixar planilha</button>
        <button className="btn" onClick={abrirRegistro} disabled={!ev}>Quem mexeu</button>
      </div>
      {dono && envio && (
        <details className="card" style={{ padding: 12, marginBottom: 12 }}>
          <summary style={{ cursor: 'pointer' }}>Enviar a lista pelo WhatsApp {envio.enabled ? <span className="muted">· ligado</span> : null}</summary>
          {!envio.connected
            ? <p className="muted" style={{ marginTop: 8 }}>O envio pelo WhatsApp ainda não foi liberado para esta empresa. Peça ao administrador do sistema.</p>
            : (
              <div style={{ marginTop: 8 }}>
                <p className="muted" style={{ fontSize: 13 }}>No horário em que a casa abre (ou no começo do show, se não houver horário de abertura), a lista do evento chega em planilha, uma vez por evento. Escolha quem recebe:</p>
                <label style={{ display: 'block' }}><input type="checkbox" checked={paraAdm} onChange={(e) => setParaAdm(e.target.checked)} /> WhatsApp do administrador{envio.admin_phone ? ' (' + fmtPhone(envio.admin_phone) + ')' : ' — cadastre em Configurações'}</label>
                <label style={{ display: 'block' }}><input type="checkbox" checked={paraEmpresa} onChange={(e) => setParaEmpresa(e.target.checked)} /> Telefone da empresa{envio.company_phone ? ' (' + fmtPhone(envio.company_phone) + ')' : ' — cadastre em Configurações'}</label>
                <label style={{ display: 'block', opacity: 0.6 }}><input type="checkbox" disabled /> E-mail (em breve)</label>
                <label>Incluir outras pessoas (um telefone por linha, com DDD)</label>
                <textarea rows="3" value={telefones} onChange={(e) => setTelefones(e.target.value)} placeholder="32 99999-9999" style={{ maxWidth: 320 }} />
                {envio.next && <p className="muted" style={{ fontSize: 13 }}>Próximo envio: <strong>{envio.next.title}</strong>, {new Date(envio.next.envia_em).toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' })}.</p>}
                <div className="row" style={{ marginTop: 8 }}>
                  <button className="btn primary" onClick={() => salvarEnvio(true)}>{envio.enabled ? 'Salvar' : 'Ligar o envio'}</button>
                  {envio.enabled && <button className="btn" onClick={() => salvarEnvio(false)}>Desligar</button>}
                  <button className="btn" onClick={enviarAgora} disabled={!ev || !envio.recipients}>Enviar agora a lista deste evento</button>
                </div>
                {aviso && <p className="muted" style={{ marginTop: 6 }}>{aviso}</p>}
              </div>
            )}
        </details>
      )}
      {d && (
        <>
          <div className="row" style={{ gap: 8, marginBottom: 12, flexWrap: 'wrap' }}>
            {[['todos', `Todos · ${d.summary.people}`], ['entrou', `Entraram · ${d.summary.entered}`], ['faltam', `Faltam · ${d.summary.people - d.summary.entered}`], ['pendentes', `Pagamento pendente · ${d.summary.pending_payment}`]].map(([v, l]) => (
              <button key={v} className={'btn sm' + (filtro === v ? ' primary' : '')} onClick={() => setFiltro(v)}>{l}</button>
            ))}
          </div>
          <div className="card table-wrap">
            <table>
              <thead><tr><th>Entrou</th><th>Nome</th><th>Setor</th><th>Mesa</th><th>Telefone</th><th>Valor</th><th>Pagamento</th><th>Observações da casa</th><th>Comentário da equipe</th>{nivel !== 'leitor' && <th></th>}</tr></thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.key} style={r.entered_at ? { opacity: 0.75 } : undefined}>
                    <td style={{ whiteSpace: 'nowrap' }}>
                      {podeMarcar
                        ? <button className={'btn sm' + (r.entered_at ? ' primary' : '')} onClick={() => entrada(r)}>{r.entered_at ? `Entrou ${hora(r.entered_at)}` : 'Marcar'}</button>
                        : (r.entered_at ? `Entrou ${hora(r.entered_at)}` : '—')}
                    </td>
                    <td>{r.name}{r.entered_by && <div className="muted" style={{ fontSize: 12 }}>por {r.entered_by}</div>}</td>
                    <td>{r.sector}</td>
                    <td>{r.table}</td>
                    <td>{r.phone ? fmtPhone(r.phone) : '—'}</td>
                    <td>{dinheiro(r.unit_price)}</td>
                    <td>{PAGTO[r.payment]}</td>
                    <td style={{ maxWidth: 200 }}>{r.note}</td>
                    <td style={{ maxWidth: 200 }}>{r.door_note}</td>
                    {nivel !== 'leitor' && (
                      <td style={{ whiteSpace: 'nowrap' }}>
                        {nivel === 'editor' && <button className="btn sm" onClick={() => setEdit({ ...r })}>Editar</button>}{' '}
                        {nivel === 'editor' && <button className="btn sm" onClick={() => gerarIngresso(r)}>Ingresso</button>}{' '}
                        <button className="btn sm" onClick={() => setNota({ ...r })}>Comentar</button>
                      </td>
                    )}
                  </tr>
                ))}
                {!rows.length && <tr><td colSpan="10" className="muted">Ninguém na lista com esse filtro.</td></tr>}
              </tbody>
            </table>
          </div>
        </>
      )}
      {leitor && <LeitorQr eventoId={ev} onFechar={() => setLeitor(false)} onMarcou={carregar} />}
      {edit && (
        <div className="modal-bg" onClick={() => setEdit(null)}>
          <form className="modal" style={{ maxWidth: 460 }} onClick={(e) => e.stopPropagation()} onSubmit={salvarEdicao}>
            <h2>Editar pessoa</h2>
            <label>Nome</label>
            <input value={edit.name} maxLength="120" onChange={(e) => setEdit({ ...edit, name: e.target.value })} />
            <label>Telefone</label>
            <input value={edit.phone || ''} onChange={(e) => setEdit({ ...edit, phone: e.target.value })} />
            <label>Observações</label>
            <textarea rows="3" value={edit.note} onChange={(e) => setEdit({ ...edit, note: e.target.value })} />
            <div className="row" style={{ marginTop: 12, justifyContent: 'flex-end' }}>
              <button type="button" className="btn" onClick={() => setEdit(null)}>Cancelar</button>
              <button className="btn primary">Salvar</button>
            </div>
          </form>
        </div>
      )}
      {nota && (
        <div className="modal-bg" onClick={() => setNota(null)}>
          <form className="modal" style={{ maxWidth: 460 }} onClick={(e) => e.stopPropagation()} onSubmit={salvarNota}>
            <h2>Comentário</h2>
            <p className="muted">{nota.name}</p>
            <textarea rows="3" autoFocus value={nota.door_note} onChange={(e) => setNota({ ...nota, door_note: e.target.value })} />
            <div className="row" style={{ marginTop: 12, justifyContent: 'flex-end' }}>
              <button type="button" className="btn" onClick={() => setNota(null)}>Cancelar</button>
              <button className="btn primary">Salvar</button>
            </div>
          </form>
        </div>
      )}
      {registro && (
        <div className="modal-bg" onClick={() => setRegistro(null)}>
          <div className="modal" style={{ maxWidth: 560 }} onClick={(e) => e.stopPropagation()}>
            <h2>Quem mexeu na lista</h2>
            {!registro.length && <p className="muted">Ninguém mexeu ainda.</p>}
            <div style={{ maxHeight: '60vh', overflow: 'auto' }}>
              {registro.map((x) => (
                <div key={x.id} style={{ padding: '6px 0', borderBottom: '1px solid var(--border, #ddd)' }}>
                  <b>{x.actor}</b> {ACAO[x.action] || x.action} · {x.person}
                  {x.detail && <div className="muted" style={{ fontSize: 13 }}>{x.detail}</div>}
                  <div className="muted" style={{ fontSize: 12 }}>{quando(x.at)}</div>
                </div>
              ))}
            </div>
            <div className="row" style={{ marginTop: 12, justifyContent: 'flex-end' }}><button className="btn" onClick={() => setRegistro(null)}>Fechar</button></div>
          </div>
        </div>
      )}
    </>
  );
}
