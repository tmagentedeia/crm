import React, { useEffect, useState } from 'react';
import { api } from '../api.js';
import { Nome } from '../menu.jsx';

// 553291135799 -> (32) 9113-5799 (mostra como o número aparece no WhatsApp, sem o 9 extra)
const fmtTel = (id) => (/^55\d{10}$/.test(id) ? `(${id.slice(2, 4)}) ${id.slice(4, 8)}-${id.slice(8)}` : id);
const fmtResta = (s) => {
  if (s == null) return '';
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60);
  return h > 0 ? `${h} h ${m} min` : `${Math.max(m, 1)} min`;
};
const MOTIVO = {
  manual: 'Bloqueado por você',
  pausa: 'Atendimento pausado (você assumiu a conversa)',
  automatico: 'Bloqueado automaticamente (conversa repetitiva com outro robô)',
};

export default function Bloqueios() {
  const [itens, setItens] = useState(null);
  const [erro, setErro] = useState('');
  const [msg, setMsg] = useState('');
  const [tel, setTel] = useState('');
  const [duracao, setDuracao] = useState('forever');
  const [ocupado, setOcupado] = useState(false);

  const carregar = () => api('/blocks').then((l) => { setItens(l); setErro(''); }).catch((e) => { setItens([]); setErro(e.message); });
  useEffect(() => { carregar(); }, []);

  const bloquear = async (e) => {
    e.preventDefault();
    setErro(''); setMsg(''); setOcupado(true);
    try {
      await api('/blocks', { method: 'POST', body: { phone: tel, duration: duracao } });
      setTel(''); setMsg('Atendimento bloqueado.');
      await carregar();
    } catch (e2) { setErro(e2.message); }
    setOcupado(false);
  };
  const liberar = async (i) => {
    if (!window.confirm(`Liberar o atendimento de ${i.nome || fmtTel(i.id)}?`)) return;
    setErro(''); setMsg('');
    try { await api('/blocks/' + encodeURIComponent(i.id), { method: 'DELETE' }); setMsg('Atendimento liberado.'); await carregar(); }
    catch (e) { setErro(e.message); }
  };

  const sempre = (itens || []).filter((i) => i.permanente);
  const temp = (itens || []).filter((i) => !i.permanente);
  const tabela = (lista, vazio) => (
    <table>
      <thead><tr><th>Contato</th><th>Motivo</th><th>Tempo restante</th><th></th></tr></thead>
      <tbody>
        {lista.map((i) => (
          <tr key={i.id}>
            <td>{i.nome ? <><strong>{i.nome}</strong> <span className="muted">{fmtTel(i.id)}</span></> : fmtTel(i.id)}</td>
            <td>{MOTIVO[i.motivo]}</td>
            <td>{i.permanente ? <span className="muted">Para sempre</span> : fmtResta(i.segundos)}</td>
            <td style={{ textAlign: 'right' }}><button className="btn sm" onClick={() => liberar(i)}>Liberar</button></td>
          </tr>
        ))}
        {!lista.length && <tr><td colSpan="4" className="muted">{vazio}</td></tr>}
      </tbody>
    </table>
  );

  return (
    <>
      <h1><Nome id="bloqueios">Atendimentos bloqueados</Nome></h1>
      <p className="muted" style={{ marginBottom: 18 }}>
        Contatos que o atendente não responde. As mudanças valem na hora, sem precisar enviar nenhum comando pelo WhatsApp.
      </p>
      {msg && <div style={{ color: 'var(--ok)', marginBottom: 8 }}>{msg}</div>}
      {erro && <div className="error">{erro}</div>}

      <div className="card">
        <h2>Bloquear um contato</h2>
        <form onSubmit={bloquear} className="row" style={{ alignItems: 'flex-end', flexWrap: 'wrap' }}>
          <div className="field" style={{ flex: 1, margin: 0, minWidth: 200 }}>
            <label>Telefone (com DDD)</label>
            <input value={tel} onChange={(e) => setTel(e.target.value)} placeholder="(32) 99999-9999" required />
          </div>
          <div className="field" style={{ margin: 0, minWidth: 180 }}>
            <label>Por quanto tempo</label>
            <select value={duracao} onChange={(e) => setDuracao(e.target.value)}>
              <option value="forever">Para sempre</option>
              <option value="24h">Por 24 horas</option>
            </select>
          </div>
          <button className="btn primary" disabled={ocupado || !tel.trim()}>Bloquear</button>
        </form>
      </div>

      {itens && (
        <>
          <div className="card">
            <h2>Bloqueados para sempre</h2>
            {tabela(sempre, 'Nenhum contato bloqueado para sempre.')}
          </div>
          <div className="card">
            <h2>Bloqueados por 24 horas</h2>
            {tabela(temp, 'Nenhum contato bloqueado por 24 horas.')}
          </div>
        </>
      )}
    </>
  );
}
