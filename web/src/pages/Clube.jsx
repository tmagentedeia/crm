import React, { useEffect, useState } from 'react';
import { api } from '../api.js';

// Programa de assinaturas da empresa (Clube, Premium, VIP…): nome do programa e níveis com os benefícios de cada mês.
export default function Clube() {
  const [d, setD] = useState(null);
  const [nome, setNome] = useState('');
  const [novo, setNovo] = useState({ name: '', benefit_qty: 0 });
  const [edit, setEdit] = useState(null);
  const [msg, setMsg] = useState('');
  const [err, setErr] = useState('');
  const load = () => api('/club').then((x) => { setD(x); setNome(x.program_name); });
  useEffect(() => { load(); }, []);
  const run = async (fn, ok) => {
    setErr(''); setMsg('');
    try { await fn(); if (ok) setMsg(ok); await load(); } catch (e) { setErr(e.message); }
  };
  if (!d) return <p className="muted">Carregando…</p>;
  return (
    <>
      <h1>{d.program_name}</h1>
      <p className="muted" style={{ marginBottom: 16 }}>Marque seus clientes como membros de um programa com níveis e benefícios. Aqui você dá nome ao programa e define os níveis e os benefícios de cada um.</p>
      {err && <div className="error">{err}</div>}
      {msg && <p className="muted" style={{ marginBottom: 8 }}>{msg}</p>}

      <div className="card" style={{ marginBottom: 16 }}>
        <h2>Nome do programa</h2>
        <div className="row">
          <input value={nome} maxLength={30} onChange={(e) => setNome(e.target.value)} style={{ maxWidth: 260 }} />
          <button className="btn primary" onClick={() => run(() => api('/club', { method: 'PUT', body: { program_name: nome } }), 'Nome salvo.')}>Salvar</button>
        </div>
        <p className="muted" style={{ marginTop: 8 }}>
          {d.counts.member} membro(s) · {d.counts.former} ex-membro(s) · {d.counts.supporter} contribuinte(s)
        </p>
      </div>

      <div className="card table-wrap">
        <h2>Níveis</h2>
        <table>
          <thead><tr><th>Nível</th><th>Benefícios por mês</th><th>Membros</th><th></th></tr></thead>
          <tbody>
            {d.levels.map((l) => (
              <tr key={l.id}>
                {edit?.id === l.id ? (
                  <>
                    <td><input value={edit.name} maxLength={40} onChange={(e) => setEdit({ ...edit, name: e.target.value })} /></td>
                    <td><input type="number" min="0" max="999" value={edit.benefit_qty} onChange={(e) => setEdit({ ...edit, benefit_qty: e.target.value })} style={{ maxWidth: 90 }} /></td>
                    <td>{l.members}</td>
                    <td className="row">
                      <button className="btn primary" onClick={() => run(async () => { await api('/club/levels/' + l.id, { method: 'PUT', body: { name: edit.name, benefit_qty: Number(edit.benefit_qty) } }); setEdit(null); }, 'Nível salvo.')}>Salvar</button>
                      <button className="btn" onClick={() => setEdit(null)}>Cancelar</button>
                    </td>
                  </>
                ) : (
                  <>
                    <td>{l.name}</td><td>{l.benefit_qty}</td><td>{l.members}</td>
                    <td className="row">
                      <button className="btn" onClick={() => setEdit({ id: l.id, name: l.name, benefit_qty: l.benefit_qty })}>Editar</button>
                      <button className="btn bad" onClick={() => confirm(`Excluir o nível "${l.name}"?`) && run(() => api('/club/levels/' + l.id, { method: 'DELETE' }), 'Nível excluído.')}>Excluir</button>
                    </td>
                  </>
                )}
              </tr>
            ))}
            {!d.levels.length && <tr><td colSpan="4" className="muted">Nenhum nível ainda. Crie o primeiro abaixo.</td></tr>}
          </tbody>
        </table>
        <form className="row" style={{ marginTop: 12 }} onSubmit={(e) => { e.preventDefault(); run(async () => { await api('/club/levels', { method: 'POST', body: { name: novo.name, benefit_qty: Number(novo.benefit_qty) } }); setNovo({ name: '', benefit_qty: 0 }); }, 'Nível criado.'); }}>
          <input placeholder="Nome do nível (ex.: Nível 1)" value={novo.name} maxLength={40} onChange={(e) => setNovo({ ...novo, name: e.target.value })} required style={{ maxWidth: 240 }} />
          <input type="number" min="0" max="999" title="Benefícios por mês" value={novo.benefit_qty} onChange={(e) => setNovo({ ...novo, benefit_qty: e.target.value })} style={{ maxWidth: 110 }} />
          <button className="btn primary">+ Adicionar nível</button>
        </form>
      </div>
    </>
  );
}
