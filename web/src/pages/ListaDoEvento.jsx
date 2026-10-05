import React, { useEffect, useMemo, useState } from 'react';
import { api, getToken, fmtPhone } from '../api.js';

const PAGTO = { paid: 'Pago', partial: 'Parcial', pending: 'Pendente', courtesy: 'Cortesia', no_price: '—' };
const ACAO = { entrada: 'marcou entrada', entrada_desfeita: 'desfez a entrada', comentario: 'comentou', edicao: 'editou' };
const quando = (d) => new Date(d).toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' });
const hora = (d) => new Date(d).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
const dinheiro = (v) => (v === null || v === undefined ? '—' : Number(v).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' }));

// Lista do evento: uma linha por pessoa. Três níveis de acesso:
// editor edita, comentarista marca entrada e comenta, leitor só consulta.
export default function ListaDoEvento() {
  const [nivel, setNivel] = useState(null);
  const [eventos, setEventos] = useState([]);
  const [ev, setEv] = useState('');
  const [d, setD] = useState(null);
  const [erro, setErro] = useState('');
  const [busca, setBusca] = useState('');
  const [filtro, setFiltro] = useState('todos');
  const [edit, setEdit] = useState(null);
  const [nota, setNota] = useState(null);
  const [registro, setRegistro] = useState(null);

  useEffect(() => {
    api('/me').then((m) => {
      const t = m.equipe?.telas;
      setNivel(!t || t.includes('lista_evento_editor') ? 'editor' : t.includes('lista_evento_comentarista') ? 'comentarista' : 'leitor');
    }).catch(() => setNivel('leitor'));
    Promise.all([api('/events?quando=proximos'), api('/events?quando=passados').catch(() => [])]).then(([p, o]) => {
      const l = [...p, ...o.slice(0, 60)];
      setEventos(l);
      if (l[0]) setEv(String(l[0].id));
    }).catch((e) => setErro(e.message));
  }, []);

  const carregar = () => ev && api(`/event-list?event_id=${ev}`).then((x) => { setD(x); setErro(''); }).catch((e) => setErro(e.message));
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
  const entrada = (r) => agir(() => api(`/event-list-comment/${r.sale_id}/${r.seq}/entry`, { method: 'PUT', body: { entered: !r.entered_at } }));
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
    agir(async () => { await api(`/event-list-comment/${nota.sale_id}/${nota.seq}/note`, { method: 'PUT', body: { note: nota.door_note } }); setNota(null); });
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
      <div className="row" style={{ marginBottom: 12, gap: 8, flexWrap: 'wrap' }}>
        <select value={ev} onChange={(e) => setEv(e.target.value)} style={{ minWidth: 220, flex: '1 1 220px' }}>
          {!eventos.length && <option value="">Nenhum evento</option>}
          {eventos.map((e) => <option key={e.id} value={e.id}>{e.title} · {new Date(e.starts_at).toLocaleDateString('pt-BR')}</option>)}
        </select>
        <input placeholder="Buscar por nome, mesa ou telefone" value={busca} onChange={(e) => setBusca(e.target.value)} style={{ flex: '2 1 220px' }} />
        <button className="btn" onClick={baixar} disabled={!ev}>Baixar planilha</button>
        <button className="btn" onClick={abrirRegistro} disabled={!ev}>Quem mexeu</button>
      </div>
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
