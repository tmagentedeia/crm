import React, { useEffect, useState } from 'react';
import { Nome } from '../menu.jsx';
import { api, fmtPhone } from '../api.js';
import { useSelecao, CelulaTodos, CelulaLinha, ApagarSelecionados, resumoApagado } from '../selecao.jsx';

const LABEL = { waiting: 'Aguardando', notified: 'Avisado', cancelled: 'Removido' };
const fmt = (d) => new Date(d).toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' });

export default function Fila() {
  const [list, setList] = useState([]);
  const sel = useSelecao(list);
  const [aviso, setAviso] = useState('');
  const load = () => api('/waitlist').then(setList);
  useEffect(() => { load(); }, []);
  const remove = async (w) => { await api('/waitlist/' + w.id, { method: 'DELETE' }); load(); };
  const excluir = async (w) => {
    if (!window.confirm(`Excluir ${w.customer_name || 'este registro'} da fila? Isso apaga o registro de vez.`)) return;
    await api('/waitlist/' + w.id + '/permanent', { method: 'DELETE' }); load();
  };
  return (
    <>
      <div style={{ marginBottom: 16 }}>
        <h1><Nome id="fila">Fila de espera</Nome></h1>
        <p className="muted">Clientes que queriam um horário ocupado. Se o horário abrir por cancelamento, o primeiro da fila é avisado no WhatsApp.</p>
      </div>
      {aviso && <p className="muted" style={{ marginBottom: 8 }}>{aviso}</p>}
      <ApagarSelecionados s={sel} total={list.length} rotulo="registro(s) da fila" rota="/waitlist/bulk-delete" onDone={(r) => { setAviso(resumoApagado(r, 'registro(s)')); load(); }} />
      <div className="card table-wrap">
        <table>
          <thead><tr><CelulaTodos s={sel} /><th>Cliente</th><th>Telefone</th><th>Profissional</th><th>Horário desejado</th><th>Status</th><th></th></tr></thead>
          <tbody>
            {list.map((w) => (
              <tr key={w.id} style={{ opacity: w.status === 'waiting' ? 1 : 0.55 }}>
                <CelulaLinha s={sel} id={w.id} />
                <td>{w.customer_name || '—'}</td><td>{fmtPhone(w.customer_phone)}</td>
                <td>{w.professional_name || 'Qualquer um'}</td><td>{fmt(w.desired_at)}</td>
                <td>{LABEL[w.status]}</td>
                <td style={{ textAlign: 'right', whiteSpace: 'nowrap' }}>
                  {w.status === 'waiting' && <button className="btn sm" onClick={() => remove(w)}>Remover</button>}{' '}
                  <button className="btn sm bad" onClick={() => excluir(w)}>Excluir</button>
                </td>
              </tr>
            ))}
            {!list.length && <tr><td colSpan="7" className="muted">Ninguém na fila.</td></tr>}
          </tbody>
        </table>
      </div>
    </>
  );
}
