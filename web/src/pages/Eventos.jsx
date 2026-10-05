import React, { useEffect, useState } from 'react';
import { api } from '../api.js';
import ListaDoEvento from './ListaDoEvento.jsx';
import { useSelecao, CelulaTodos, CelulaLinha, ApagarSelecionados, resumoApagado } from '../selecao.jsx';

const quando = (d) => (d ? new Date(d).toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' }) : '—');
const paraInput = (d) => { if (!d) return ''; const x = new Date(d); x.setMinutes(x.getMinutes() - x.getTimezoneOffset()); return x.toISOString().slice(0, 16); };

export default function Eventos() {
  const [aba, setAba] = useState('proximos');
  const [rows, setRows] = useState([]);
  const [edit, setEdit] = useState(null);
  const [aviso, setAviso] = useState('');
  const [lista, setLista] = useState(null);   // evento cuja lista está aberta
  const sel = useSelecao(rows);
  const load = () => api('/events?quando=' + aba).then(setRows).catch((e) => setAviso(e.message));
  useEffect(() => { setAviso(''); load(); }, [aba]);
  const apagar = async (e) => {
    if (!confirm(`Apagar o evento "${e.title}"?`)) return;
    try { await api('/events/' + e.id, { method: 'DELETE' }); load(); } catch (x) { setAviso(x.message); }
  };
  if (lista) return <ListaDoEvento eventoId={lista} onVoltar={() => setLista(null)} />;
  return (
    <>
      <div className="row" style={{ justifyContent: 'space-between', marginBottom: 12 }}>
        <div><h1>Eventos</h1><p className="muted">Compromissos avulsos, como uma live, uma reunião ou um show. Não dependem de profissional nem de serviço.</p></div>
        <button className="btn primary" onClick={() => setEdit({ title: '', doors_at: '', starts_at: '', ends_at: '', place: '', notes: '' })}>+ Novo evento</button>
      </div>
      <div className="row" style={{ marginBottom: 12 }}>
        {[['proximos', 'Próximos'], ['passados', 'Passados'], ['todos', 'Todos']].map(([v, l]) => (
          <button key={v} className={'btn' + (aba === v ? ' primary' : '')} onClick={() => setAba(v)}>{l}</button>
        ))}
      </div>
      {aviso && <div className="error">{aviso}</div>}
      <ApagarSelecionados s={sel} total={rows.length} rotulo="evento(s)" rota="/events/bulk-delete" onDone={(r) => { setAviso(resumoApagado(r, 'evento(s)')); load(); }} />
      <div className="card table-wrap">
        <table>
          <thead><tr><CelulaTodos s={sel} /><th>Quando</th><th>Evento</th><th>Local</th><th>Observações</th><th></th></tr></thead>
          <tbody>
            {rows.map((e) => (
              <tr key={e.id}>
                <CelulaLinha s={sel} id={e.id} />
                <td>{e.doors_at && <div className="muted" style={{ fontSize: 12 }}>Abre {quando(e.doors_at)}</div>}{quando(e.starts_at)}{e.ends_at && <span className="muted"> até {quando(e.ends_at)}</span>}</td>
                <td><strong>{e.title}</strong></td>
                <td>{e.place || <span className="muted">—</span>}</td>
                <td>{e.notes || <span className="muted">—</span>}</td>
                <td className="row">
                  <button className="btn" onClick={() => setLista(e.id)}>Lista</button>
                  <button className="btn" onClick={() => setEdit({ id: e.id, title: e.title, doors_at: paraInput(e.doors_at), starts_at: paraInput(e.starts_at), ends_at: paraInput(e.ends_at), place: e.place || '', notes: e.notes || '' })}>Editar</button>
                  <button className="btn bad" onClick={() => apagar(e)}>Apagar</button>
                </td>
              </tr>
            ))}
            {!rows.length && <tr><td colSpan="6" className="muted">{aba === 'passados' ? 'Nenhum evento passado.' : 'Nenhum evento marcado.'}</td></tr>}
          </tbody>
        </table>
      </div>
      {edit && <FormEvento e={edit} onClose={() => setEdit(null)} onSaved={() => { setEdit(null); setAviso(''); load(); }} />}
    </>
  );
}

function FormEvento({ e, onClose, onSaved }) {
  const [f, setF] = useState(e);
  const [err, setErr] = useState('');
  const set = (k) => (ev) => setF({ ...f, [k]: ev.target.value });
  // Ao escolher quando o show começa, a abertura da casa já vem com o mesmo dia (e o mesmo horário, para ajustar) se ainda estiver vazia ou intocada
  const [aberturaAuto, setAberturaAuto] = useState(!e.id || !e.doors_at);
  const mudaInicio = (ev) => {
    const v = ev.target.value;
    setF({ ...f, starts_at: v, ...(v && aberturaAuto ? { doors_at: v } : {}) });
  };
  // botões "usar a data do início": copiam o dia do início e deixam o horário para a pessoa ajustar (o fim, por padrão, 3 horas depois, como o painel já considera)
  const copiaDia = (campo) => {
    if (!f.starts_at) return;
    const d = new Date(f.starts_at);
    if (campo === 'ends_at') d.setHours(d.getHours() + 3);
    const x = new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
    setF({ ...f, [campo]: x });
    if (campo === 'doors_at') setAberturaAuto(true);
  };
  const atalho = (campo) => f.starts_at && <button type="button" className="btn sm" style={{ marginTop: 4 }} onClick={() => copiaDia(campo)}>Usar o dia do início</button>;
  async function save(ev) {
    ev.preventDefault(); setErr('');
    try {
      const body = { title: f.title, doors_at: f.doors_at ? new Date(f.doors_at).toISOString() : null, starts_at: f.starts_at ? new Date(f.starts_at).toISOString() : '', ends_at: f.ends_at ? new Date(f.ends_at).toISOString() : null, place: f.place, notes: f.notes };
      await api(f.id ? '/events/' + f.id : '/events', { method: f.id ? 'PUT' : 'POST', body });
      onSaved();
    } catch (x) { setErr(x.message); }
  }
  return (
    <div className="modal-bg" onClick={onClose}>
      <form className="modal" onClick={(x) => x.stopPropagation()} onSubmit={save}>
        <h2>{f.id ? 'Editar evento' : 'Novo evento'}</h2>
        {err && <div className="error">{err}</div>}
        <div className="field"><label>Nome do evento *</label><input value={f.title} maxLength={120} onChange={set('title')} required autoFocus /></div>
        <div className="field"><label>Começa em * (início do show)</label><input type="datetime-local" value={f.starts_at} onChange={mudaInicio} required /></div>
        <div className="field"><label>Abre a casa em (opcional)</label><input type="datetime-local" value={f.doors_at} onChange={(ev) => { setAberturaAuto(false); set('doors_at')(ev); }} />{atalho('doors_at')}</div>
        <div className="field"><label>Termina em (opcional)</label><input type="datetime-local" value={f.ends_at} onChange={set('ends_at')} />{atalho('ends_at')}</div>
        <div className="field"><label>Local ou link (opcional)</label><input value={f.place} maxLength={200} onChange={set('place')} /></div>
        <div className="field"><label>Observações (opcional)</label><textarea rows="3" value={f.notes} maxLength={2000} onChange={set('notes')} /></div>
        <div className="row"><button className="btn primary">Salvar</button><button type="button" className="btn" onClick={onClose}>Cancelar</button></div>
      </form>
    </div>
  );
}
