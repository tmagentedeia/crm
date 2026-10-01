import React, { useEffect, useState } from 'react';
import { api, fmtPhone } from '../api.js';

const LABEL = { waiting: 'Aguardando', notified: 'Avisado', cancelled: 'Removido' };
const fmt = (d) => new Date(d).toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' });

export default function Fila() {
  const [list, setList] = useState([]);
  const load = () => api('/waitlist').then(setList);
  useEffect(() => { load(); }, []);
  const remove = async (w) => { await api('/waitlist/' + w.id, { method: 'DELETE' }); load(); };
  return (
    <>
      <div style={{ marginBottom: 16 }}>
        <h1>Fila de espera</h1>
        <p className="muted">Clientes que queriam um horário ocupado. Se o horário abrir por cancelamento, o primeiro da fila é avisado no WhatsApp.</p>
      </div>
      <div className="card table-wrap">
        <table>
          <thead><tr><th>Cliente</th><th>Telefone</th><th>Profissional</th><th>Horário desejado</th><th>Status</th><th></th></tr></thead>
          <tbody>
            {list.map((w) => (
              <tr key={w.id} style={{ opacity: w.status === 'waiting' ? 1 : 0.55 }}>
                <td>{w.customer_name || '—'}</td><td>{fmtPhone(w.customer_phone)}</td>
                <td>{w.professional_name || 'Qualquer um'}</td><td>{fmt(w.desired_at)}</td>
                <td>{LABEL[w.status]}</td>
                <td style={{ textAlign: 'right' }}>{w.status === 'waiting' && <button className="btn sm" onClick={() => remove(w)}>Remover</button>}</td>
              </tr>
            ))}
            {!list.length && <tr><td colSpan="6" className="muted">Ninguém na fila.</td></tr>}
          </tbody>
        </table>
      </div>
    </>
  );
}
