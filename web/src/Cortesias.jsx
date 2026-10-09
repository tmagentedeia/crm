import React, { useEffect, useState } from 'react';
import { api, fmtPhone } from './api.js';

// Saldo de cortesias por cliente: cada uma vale um pedido de música (Pedidos) ou um lugar de ingresso (Casa de Shows).
export default function Cortesias({ item, items, franquia, onErro }) {
  const [lista, setLista] = useState([]);
  const [novo, setNovo] = useState(false);
  const [aviso, setAviso] = useState('');
  const carrega = () => api('/courtesies').then(setLista).catch((e) => onErro?.(e.message));
  useEffect(() => { carrega(); }, []);
  const ajusta = async (c, qty) => {
    try { await api('/courtesies', { method: 'POST', body: { customer_id: c.customer_id, qty } }); setAviso(''); carrega(); } catch (e) { setAviso(c.customer_id + '|' + e.message); }
  };
  const zerar = async (c) => {
    if (!confirm('Tirar todas as cortesias deste cliente?')) return;
    try { await api('/courtesies/' + c.customer_id, { method: 'DELETE' }); carrega(); } catch (e) { onErro?.(e.message); }
  };
  return (
    <>
      <div className="card" style={{ marginBottom: 12 }}>
        <p className="muted">
          Cortesia é {item} grátis dado antecipadamente a um cliente.{franquia ? ' Ela só é usada depois que a franquia do mês acaba.' : ''} Não vence, e volta ao saldo se o {item} for apagado ou cancelado.
        </p>
        <div className="row" style={{ marginTop: 8 }}><button className="btn primary" onClick={() => setNovo(true)}>+ Dar cortesias</button></div>
      </div>
      <div className="card table-wrap">
        <table>
          <thead><tr><th>Cliente</th><th>Concedidas</th><th>Usadas</th><th>Restam</th><th></th></tr></thead>
          <tbody>
            {lista.map((c) => (
              <tr key={c.customer_id}>
                <td>{[c.name, c.last_name].filter(Boolean).join(' ') || fmtPhone(c.phone)}</td>
                <td>{c.granted}</td><td>{c.used}</td><td><strong>{c.remaining}</strong></td>
                <td className="row">
                  <button className="btn" onClick={() => ajusta(c, 1)}>+ 1</button>
                  <button className="btn" onClick={() => ajusta(c, -1)}>− 1</button>
                  <button className="btn bad" onClick={() => zerar(c)}>Tirar tudo</button>
                  {aviso.startsWith(c.customer_id + '|') && <span className="error">{aviso.split('|')[1]}</span>}
                </td>
              </tr>
            ))}
            {!lista.length && <tr><td colSpan="5" className="muted">Nenhum cliente com cortesias.</td></tr>}
          </tbody>
        </table>
      </div>
      {novo && <NovaCortesia items={items} onClose={() => setNovo(false)} onSaved={() => { setNovo(false); carrega(); }} />}
    </>
  );
}

function NovaCortesia({ items, onClose, onSaved }) {
  const [busca, setBusca] = useState('');
  const [achados, setAchados] = useState([]);
  const [cli, setCli] = useState(null);
  const [f, setF] = useState({ qty: '1', note: '' });
  const [err, setErr] = useState('');
  const set = (k) => (e) => setF({ ...f, [k]: e.target.value });
  const nomeCli = (c) => [c.name, c.last_name].filter(Boolean).join(' ') || fmtPhone(c.phone);
  useEffect(() => {
    if (cli || busca.trim().length < 2) { setAchados([]); return undefined; }
    const t = setTimeout(() => api('/customers?search=' + encodeURIComponent(busca.trim())).then((r) => setAchados(r.slice(0, 8))).catch(() => {}), 250);
    return () => clearTimeout(t);
  }, [busca, cli]);
  async function save(e) {
    e.preventDefault(); setErr('');
    if (!cli) { setErr('Escolha o cliente na lista'); return; }
    try { await api('/courtesies', { method: 'POST', body: { customer_id: cli.id, qty: Number(f.qty), note: f.note } }); onSaved(); } catch (e2) { setErr(e2.message); }
  }
  return (
    <div className="modal-bg" onClick={onClose}>
      <form className="modal" onClick={(e) => e.stopPropagation()} onSubmit={save}>
        <h2>Dar cortesias</h2>
        {err && <div className="error">{err}</div>}
        {cli ? (
          <div className="field"><label>Cliente</label>
            <div className="row" style={{ gap: 8, alignItems: 'center' }}>
              <strong>{nomeCli(cli)}</strong>{cli.name && cli.phone && <span className="muted">{fmtPhone(cli.phone)}</span>}
              <button type="button" className="btn sm" onClick={() => { setCli(null); setBusca(''); }}>Trocar</button>
            </div></div>
        ) : (
          <div className="field"><label>Procurar cliente *</label>
            <input autoFocus value={busca} onChange={(e) => setBusca(e.target.value)} placeholder="Digite parte do nome ou do telefone" />
            {achados.length > 0 && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 4, marginTop: 6 }}>
                {achados.map((c) => (
                  <button type="button" key={c.id} className="btn" style={{ textAlign: 'left' }} onClick={() => setCli(c)}>
                    {nomeCli(c)}{c.name && c.phone ? <span className="muted"> · {fmtPhone(c.phone)}</span> : null}
                  </button>
                ))}
              </div>
            )}
            {busca.trim().length >= 2 && !achados.length && <span className="muted">Ninguém encontrado com esse nome ou telefone.</span>}
          </div>
        )}
        <div className="field"><label>Quantidade de {items} *</label><input type="number" min="1" max="100" value={f.qty} onChange={set('qty')} required /></div>
        <div className="field"><label>Observação (opcional)</label><input value={f.note} onChange={set('note')} maxLength={200} /></div>
        <div className="row"><button className="btn primary" disabled={!cli}>Dar cortesias</button><button type="button" className="btn" onClick={onClose}>Fechar</button></div>
      </form>
    </div>
  );
}
