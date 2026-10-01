import React, { useEffect, useState } from 'react';
import { Nome } from '../menu.jsx';
import { api, money } from '../api.js';

export default function Servicos() {
  const [list, setList] = useState([]);
  const [edit, setEdit] = useState(null);
  const [err, setErr] = useState('');
  const [cats, setCats] = useState([]);
  const [catEdit, setCatEdit] = useState(null);
  const load = () => Promise.all([api('/services'), api('/categories')]).then(([sv, c]) => { setList(sv); setCats(c); });
  useEffect(() => { load(); }, []);

  async function save(e) {
    e.preventDefault(); setErr('');
    try {
      const body = { name: edit.name, price: Number(edit.price), duration_min: Number(edit.duration_min), category_id: edit.category_id ? Number(edit.category_id) : null };
      if (edit.id) await api('/services/' + edit.id, { method: 'PUT', body });
      else await api('/services', { method: 'POST', body });
      setEdit(null); load();
    } catch (e2) { setErr(e2.message); }
  }
  async function saveCat(e) {
    e.preventDefault(); setErr('');
    try {
      if (catEdit.id) await api('/categories/' + catEdit.id, { method: 'PUT', body: { name: catEdit.name } });
      else await api('/categories', { method: 'POST', body: { name: catEdit.name } });
      setCatEdit(null); load();
    } catch (e2) { setErr(e2.message); }
  }
  async function delCat(c) {
    if (!confirm(`Apagar a categoria "${c.name}"? Os serviços dela ficam sem categoria.`)) return;
    await api('/categories/' + c.id, { method: 'DELETE' }); load();
  }
  const excluir = async (s) => {
    if (!confirm(`Excluir o serviço "${s.name}" de vez? Não dá para desfazer.`)) return;
    try { await api('/services/' + s.id + '/permanent', { method: 'DELETE' }); load(); } catch (e) {
      if (!e.data?.tem_historico) return alert(e.message);
      if (!confirm(`"${s.name}" tem agendamentos no histórico.\n\nExcluir mesmo assim APAGA também todos esses agendamentos, de forma definitiva.\n\nQuer apagar o serviço e o histórico dele?`)) return;
      try { await api('/services/' + s.id + '/permanent?com_historico=1', { method: 'DELETE' }); load(); } catch (e2) { alert(e2.message); }
    }
  };
  const toggle = (s) => api('/services/' + s.id, { method: 'PUT', body: { active: !s.active } }).then(load);

  return (
    <>
      <div className="row" style={{ justifyContent: 'space-between', marginBottom: 16 }}>
        <div><h1><Nome id="servicos">Serviços</Nome></h1><p className="muted">Alterações valem na hora para o agente de IA</p></div>
        <div className="row">
          <button className="btn" onClick={() => { setErr(''); setCatEdit({ name: '' }); }}>+ Nova categoria</button>
          <button className="btn primary" onClick={() => { setErr(''); setEdit({ name: '', price: '', duration_min: 30, category_id: '' }); }}>+ Novo serviço</button>
        </div>
      </div>
      <div className="card" style={{ marginBottom: 16 }}>
        <strong>Categorias</strong>
        <div className="row" style={{ flexWrap: 'wrap', gap: 8, marginTop: 8 }}>
          {cats.map((c) => (
            <span key={c.id} className="row" style={{ gap: 6, border: '1px solid var(--border, #ddd)', borderRadius: 999, padding: '4px 10px' }}>
              {c.name}
              <button className="btn sm" onClick={() => { setErr(''); setCatEdit(c); }}>Editar</button>
              <button className="btn sm" onClick={() => delCat(c)}>Apagar</button>
            </span>
          ))}
          {!cats.length && <span className="muted">Nenhuma categoria. Crie uma (ex.: Cabelo, Manicure) para organizar os serviços.</span>}
        </div>
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
                  <button className="btn sm" onClick={() => toggle(s)}>{s.active ? 'Desativar' : 'Ativar'}</button>{' '}
                  <button className="btn sm" onClick={() => excluir(s)}>Excluir</button>
                </td>
              </tr>
            ))}
            {!list.length && <tr><td colSpan="6" className="muted">Nenhum serviço cadastrado.</td></tr>}
          </tbody>
        </table>
      </div>
      {catEdit && (
        <div className="modal-bg" onClick={() => setCatEdit(null)}>
          <form className="modal" onClick={(e) => e.stopPropagation()} onSubmit={saveCat}>
            <h2>{catEdit.id ? 'Editar categoria' : 'Nova categoria'}</h2>
            {err && <div className="error">{err}</div>}
            <div className="field"><label>Nome</label><input value={catEdit.name} onChange={(e) => setCatEdit({ ...catEdit, name: e.target.value })} placeholder="ex.: Cabelo, Manicure, Barba" required autoFocus /></div>
            <div className="row"><button className="btn primary">Salvar</button><button type="button" className="btn" onClick={() => setCatEdit(null)}>Cancelar</button></div>
          </form>
        </div>
      )}
      {edit && (
        <div className="modal-bg" onClick={() => setEdit(null)}>
          <form className="modal" onClick={(e) => e.stopPropagation()} onSubmit={save}>
            <h2>{edit.id ? 'Editar serviço' : 'Novo serviço'}</h2>
            {err && <div className="error">{err}</div>}
            <div className="field"><label>Nome</label><input value={edit.name} onChange={(e) => setEdit({ ...edit, name: e.target.value })} required /></div>
            <div className="field"><label>Categoria (opcional)</label>
              <select value={edit.category_id || ''} onChange={(e) => setEdit({ ...edit, category_id: e.target.value })}>
                <option value="">Sem categoria</option>
                {cats.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
              </select></div>
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
