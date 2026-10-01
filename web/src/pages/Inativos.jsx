import React, { useEffect, useState } from 'react';
import { api, fmtDate, fmtPhone } from '../api.js';

export default function Inativos() {
  const [days, setDays] = useState(30);
  const [list, setList] = useState([]);

  // começa pelo valor configurado na empresa
  useEffect(() => { api('/company').then((s) => setDays(s.inactive_days)); }, []);
  useEffect(() => {
    const t = setTimeout(() => api('/customers-inactive?days=' + (days || 30)).then(setList), 300);
    return () => clearTimeout(t);
  }, [days]);

  return (
    <>
      <div className="row" style={{ justifyContent: 'space-between', marginBottom: 16 }}>
        <div><h1>Retorno de inativos</h1><p className="muted">Clientes que não voltam há um tempo e não têm nada agendado</p></div>
        <div className="row"><span className="muted">Ausentes há</span>
          <input type="number" min="1" value={days} onChange={(e) => setDays(Number(e.target.value))} style={{ width: 90 }} />
          <span className="muted">dias</span></div>
      </div>
      <div className="card table-wrap">
        <table>
          <thead><tr><th>Cliente</th><th>Telefone</th><th>Última visita</th><th>Ausente há</th><th></th></tr></thead>
          <tbody>
            {list.map((c) => (
              <tr key={c.id}>
                <td>{c.name || 'Sem nome'}</td><td>{fmtPhone(c.phone)}</td><td>{fmtDate(c.last_visit_at)}</td>
                <td>{c.days_absent} dias</td>
                <td style={{ textAlign: 'right' }}>
                  <a className="btn sm" href={'https://wa.me/' + c.phone} target="_blank" rel="noreferrer">Chamar no WhatsApp</a>
                </td>
              </tr>
            ))}
            {!list.length && <tr><td colSpan="5" className="muted">Nenhum cliente inativo com esse critério. 🎉</td></tr>}
          </tbody>
        </table>
      </div>
    </>
  );
}
