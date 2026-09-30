import React, { useEffect, useState } from 'react';
import { api, money } from '../api.js';

export default function Servicos() {
  const [list, setList] = useState([]);
  const [edit, setEdit] = useState(null);
  const [err, setErr] = useState('');
  const load = () => api('/services').then(setList);
  useEffect(() => { load(); }, []);

  async function save(e) {
    e.preventDefault(); setErr('');
    try {
      const body = { name: edit.name, price: Number(edit.price), duration_min: Number(edit.duration_min), category: edit.category || '' };
      if (edit.id) await api('/services/' + edit.id, { method: 'PUT', body });
      else await api('/services', { method: 'POST', body });
      setEdit(null); load();
    } catch (e2) { setErr(e2.message); }
  }
  const toggle = (s) => api('/services/' + s.id, { method: 'PUT', body: { active: !s.active } }).then(load);

  return (
    <>
      <div className="row" style={{ justifyContent: 'space-between', marginBottom: 16 }}>
        <div><h1>Serviços</h1><p className="muted">Alterações valem na hora para o agente de IA</p></div>
        <button className="btn primary" onClick={() => setEdit({ name: '', price: '', duration_min: 30 })}>+ Novo serviço</button>
      </div>
      <div className="card table-wrap">
        <table>
          <thead><tr><th>Nome</th><th>Categoria</th><th>Preço</th><th>Duração</th><th>Status</th><th></th></tr></thead>
          <tbody>
            {list.map((s) => (
              <tr key={s.id} style={{ opacity: s.active ? 1 : 0.5 }}>
                <td>{s.name}</td><td>{s.category || <span className="muted">—</span>}</td><td>{money(s.price)}</td><td>{s.duration_min} min</td>
                <td>{s.active ? 'Ativo' : 'Inativo'}</td>
                <td style={{ textAlign: 'right' }}>
                  <button className="btn sm" onClick={() => setEdit(s)}>Editar</button>{' '}
                  <button className="btn sm" onClick={() => toggle(s)}>{s.active ? 'Desativar' : 'Ativar'}</button>
                </td>
              </tr>
            ))}
            {!list.length && <tr><td colSpan="6" className="muted">Nenhum serviço cadastrado.</td></tr>}
          </tbody>
        </table>
      </div>
      {edit && (
        <div className="modal-bg" onClick={() => setEdit(null)}>
          <form className="modal" onClick={(e) => e.stopPropagation()} onSubmit={save}>
            <h2>{edit.id ? 'Editar serviço' : 'Novo serviço'}</h2>
            {err && <div className="error">{err}</div>}
            <div className="field"><label>Nome</label><input value={edit.name} onChange={(e) => setEdit({ ...edit, name: e.target.value })} required /></div>
            <div className="field"><label>Categoria (opcional)</label>
              <input list="cats" value={edit.category || ''} onChange={(e) => setEdit({ ...edit, category: e.target.value })} placeholder="ex.: Cabelo, Barba, Unhas" />
              <datalist id="cats">{[...new Set(list.map((x) => x.category).filter(Boolean))].map((c) => <option key={c} value={c} />)}</datalist></div>
            <div className="row">
              <div className="field"><label>Preço (R$)</label><input type="number" step="0.01" min="0" value={edit.price} onChange={(e) => setEdit({ ...edit, price: e.target.value })} required /></div>
              <div className="field"><label>Duração (min)</label><input type="number" min="5" step="5" value={edit.duration_min} onChange={(e) => setEdit({ ...edit, duration_min: e.target.value })} required /></div>
            </div>
            <div className="row"><button className="btn primary">Salvar</button><button type="button" className="btn" onClick={() => setEdit(null)}>Cancelar</button></div>
          </form>
        </div>
      )}
    </>
  );
}
