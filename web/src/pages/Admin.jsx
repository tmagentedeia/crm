import React, { useEffect, useState } from 'react';
import { api, fmtDate } from '../api.js';

export default function Admin() {
  const [list, setList] = useState([]);
  const [edit, setEdit] = useState({}); // id -> valor digitado
  const [msg, setMsg] = useState('');
  const [err, setErr] = useState('');
  const [novaChave, setNovaChave] = useState(null); // { empresa, chave } — mostrada uma única vez
  const [copiada, setCopiada] = useState(false);
  const load = () => api('/admin/companies').then(setList).catch((e) => setErr(e.message));
  useEffect(() => { load(); }, []);

  const shown = (s) => (s.id in edit ? edit[s.id] : s.max_professionals ?? '');

  async function save(s) {
    setErr(''); setMsg('');
    try {
      await api('/admin/companies/' + s.id, { method: 'PUT', body: { max_professionals: edit[s.id] === '' ? null : Number(edit[s.id]) } });
      setEdit(({ [s.id]: _, ...rest }) => rest);
      setMsg(`Limite de "${s.name}" atualizado.`);
      load();
    } catch (e) { setErr(e.message); }
  }

  async function gerarChave(s) {
    if (s.api_key_hint && !window.confirm(
      `Gerar uma nova chave para "${s.name}"?\n\nA chave atual deixa de funcionar na hora, e as integrações dessa empresa só voltam a funcionar quando receberem a nova.`)) return;
    setErr(''); setMsg(''); setCopiada(false);
    try {
      const r = await api(`/admin/companies/${s.id}/api-key`, { method: 'POST' });
      setNovaChave({ empresa: s.name, chave: r.api_key });
      load();
    } catch (e) { setErr(e.message); }
  }

  async function copiar() {
    try { await navigator.clipboard.writeText(novaChave.chave); setCopiada(true); } catch { setCopiada(false); }
  }

  return (
    <>
      <h1>Administração</h1>
      <p className="muted" style={{ marginBottom: 16 }}>Empresas cadastradas, limite de profissionais de cada plano e chave de integração de cada empresa. Deixe o limite vazio para não ter limite.</p>
      {msg && <div className="card" style={{ marginBottom: 12, color: 'var(--ok)' }}>{msg}</div>}
      {err && <div className="error">{err}</div>}
      {novaChave && (
        <div className="card" style={{ marginBottom: 16 }}>
          <strong>Nova chave de "{novaChave.empresa}"</strong>
          <p className="muted" style={{ margin: '6px 0 10px' }}>Copie e guarde agora: por segurança, ela não será mostrada de novo.</p>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            <input readOnly value={novaChave.chave} style={{ flex: 1, minWidth: 260, fontFamily: 'monospace' }}
              onFocus={(e) => e.target.select()} />
            <button className="btn primary" onClick={copiar}>{copiada ? 'Copiada!' : 'Copiar'}</button>
            <button className="btn" onClick={() => setNovaChave(null)}>Fechar</button>
          </div>
        </div>
      )}
      <div className="card table-wrap">
        <table>
          <thead><tr><th>Empresa</th><th>E-mail do responsável</th><th>Criado em</th><th>Ativos</th><th>Limite</th><th>Chave de integração</th><th></th></tr></thead>
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
                  <td>
                    {s.api_key_hint
                      ? <><span style={{ fontFamily: 'monospace' }}>crm_…{s.api_key_hint}</span> <span className="muted">· gerada em {fmtDate(s.api_key_created_at)}</span></>
                      : <span className="muted">Sem chave</span>}
                    {' '}
                    <button className="btn sm" onClick={() => gerarChave(s)}>{s.api_key_hint ? 'Regenerar' : 'Gerar chave'}</button>
                  </td>
                  <td style={{ textAlign: 'right' }}>
                    {changed && <button className="btn sm primary" onClick={() => save(s)}>Salvar</button>}
                  </td>
                </tr>
              );
            })}
            {!list.length && <tr><td colSpan="7" className="muted">Nenhuma empresa cadastrada.</td></tr>}
          </tbody>
        </table>
      </div>
    </>
  );
}
