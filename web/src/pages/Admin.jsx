import React, { useEffect, useState } from 'react';
import { api, fmtDate } from '../api.js';

export default function Admin() {
  const [list, setList] = useState([]);
  const [edit, setEdit] = useState({}); // id -> valor digitado
  const [msg, setMsg] = useState('');
  const [err, setErr] = useState('');
  const load = () => api('/admin/salons').then(setList).catch((e) => setErr(e.message));
  useEffect(() => { load(); }, []);

  const shown = (s) => (s.id in edit ? edit[s.id] : s.max_barbers ?? '');

  async function save(s) {
    setErr(''); setMsg('');
    try {
      await api('/admin/salons/' + s.id, { method: 'PUT', body: { max_barbers: edit[s.id] === '' ? null : Number(edit[s.id]) } });
      setEdit(({ [s.id]: _, ...rest }) => rest);
      setMsg(`Limite de "${s.name}" atualizado.`);
      load();
    } catch (e) { setErr(e.message); }
  }

  return (
    <>
      <h1>Administração</h1>
      <p className="muted" style={{ marginBottom: 16 }}>Salões cadastrados e limite de profissionais de cada plano. Deixe o limite vazio para não ter limite.</p>
      {msg && <div className="card" style={{ marginBottom: 12, color: 'var(--ok)' }}>{msg}</div>}
      {err && <div className="error">{err}</div>}
      <div className="card table-wrap">
        <table>
          <thead><tr><th>Salão</th><th>E-mail do responsável</th><th>Criado em</th><th>Ativos</th><th>Limite</th><th></th></tr></thead>
          <tbody>
            {list.map((s) => {
              const changed = s.id in edit;
              return (
                <tr key={s.id}>
                  <td>{s.name}</td>
                  <td>{s.owner_email || <span className="muted">—</span>}</td>
                  <td>{fmtDate(s.created_at)}</td>
                  <td>{s.ativos}</td>
                  <td style={{ width: 130 }}>
                    <input type="number" min="0" placeholder="sem limite" value={shown(s)}
                      onChange={(e) => setEdit({ ...edit, [s.id]: e.target.value })}
                      onKeyDown={(e) => e.key === 'Enter' && changed && save(s)} />
                  </td>
                  <td style={{ textAlign: 'right' }}>
                    {changed && <button className="btn sm primary" onClick={() => save(s)}>Salvar</button>}
                  </td>
                </tr>
              );
            })}
            {!list.length && <tr><td colSpan="6" className="muted">Nenhum salão cadastrado.</td></tr>}
          </tbody>
        </table>
      </div>
    </>
  );
}
