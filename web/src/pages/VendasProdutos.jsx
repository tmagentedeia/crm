import React, { useEffect, useState } from 'react';
import { api, fmtPhone, money } from '../api.js';

const mesAtual = () => { const d = new Date(); return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0'); };
const quando = (d) => new Date(d).toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' });
const paraInput = (d) => { const x = d ? new Date(d) : new Date(); x.setMinutes(x.getMinutes() - x.getTimezoneOffset()); return x.toISOString().slice(0, 16); };

export default function VendasProdutos({ onMudou }) {
  const [mes, setMes] = useState(mesAtual());
  const [dados, setDados] = useState({ rows: [], total: 0 });
  const [produtos, setProdutos] = useState([]);
  const [profs, setProfs] = useState([]);
  const [edit, setEdit] = useState(null);
  const [err, setErr] = useState('');
  const [busca, setBusca] = useState('');
  const [achados, setAchados] = useState([]);
  const load = () => api('/product-sales?month=' + mes).then(setDados).catch((e) => setErr(e.message));
  useEffect(() => { load(); }, [mes]);
  useEffect(() => {
    api('/services?kind=product').then((l) => setProdutos(l.filter((x) => x.active))).catch(() => {});
    api('/professionals').then((l) => setProfs(l.filter((x) => x.active))).catch(() => {});
  }, []);
  useEffect(() => {
    if (!edit || busca.trim().length < 2) { setAchados([]); return undefined; }
    const id = setTimeout(() => api('/customers?search=' + encodeURIComponent(busca.trim())).then((l) => setAchados(l.slice(0, 6))).catch(() => {}), 250);
    return () => clearTimeout(id);
  }, [busca, edit]);

  const novo = () => { setErr(''); setBusca(''); setEdit({ service_id: '', product_name: '', quantity: 1, unit_price: '', professional_id: '', customer_id: '', customer_label: '', sold_at: paraInput(), note: '' }); };
  const editar = (s) => { setErr(''); setBusca(''); setEdit({ id: s.id, service_id: s.service_id || '', product_name: s.product_name, quantity: s.quantity, unit_price: String(s.unit_price).replace('.', ','), professional_id: s.professional_id || '', customer_id: s.customer_id || '', customer_label: s.customer_name || (s.customer_phone ? fmtPhone(s.customer_phone) : ''), sold_at: paraInput(s.sold_at), note: s.note || '' }); };
  const escolheProduto = (id) => {
    const p = produtos.find((x) => String(x.id) === String(id));
    setEdit({ ...edit, service_id: id, product_name: p ? p.name : edit.product_name, unit_price: p ? String(p.price).replace('.', ',') : edit.unit_price });
  };
  async function salvar(e) {
    e.preventDefault(); setErr('');
    const body = {
      service_id: edit.service_id || null, product_name: edit.service_id ? undefined : edit.product_name,
      quantity: Number(edit.quantity), unit_price: edit.unit_price, professional_id: edit.professional_id || null,
      customer_id: edit.customer_id || null, sold_at: new Date(edit.sold_at).toISOString(), note: edit.note,
    };
    try {
      if (edit.id) await api('/product-sales/' + edit.id, { method: 'PUT', body });
      else await api('/product-sales', { method: 'POST', body });
      setEdit(null); load(); onMudou?.();
    } catch (e2) { setErr(e2.message); }
  }
  const apagar = async (s) => {
    if (!confirm(`Apagar a venda de "${s.product_name}"? Não dá para desfazer.`)) return;
    try { await api('/product-sales/' + s.id, { method: 'DELETE' }); load(); onMudou?.(); } catch (e) { setErr(e.message); }
  };

  return (
    <>
      <div className="row" style={{ justifyContent: 'space-between', marginBottom: 12 }}>
        <div className="row">
          <input type="month" value={mes} onChange={(e) => setMes(e.target.value || mesAtual())} style={{ maxWidth: 190 }} />
          <span className="muted">{dados.rows.length} venda(s) · total {money(dados.total)}</span>
        </div>
        <button className="btn primary" onClick={novo}>+ Registrar venda</button>
      </div>
      {err && !edit && <div className="error">{err}</div>}
      <div className="card table-wrap">
        <table>
          <thead><tr><th>Data</th><th>Produto</th><th>Qtd</th><th>Valor</th><th>Total</th><th>Profissional</th><th>Cliente</th><th></th></tr></thead>
          <tbody>
            {dados.rows.map((s) => (
              <tr key={s.id}>
                <td>{quando(s.sold_at)}</td><td>{s.product_name}</td><td>{s.quantity}</td><td>{money(s.unit_price)}</td><td>{money(s.total)}</td>
                <td>{s.professional_name || <span className="muted">—</span>}</td>
                <td>{s.customer_name || (s.customer_phone ? fmtPhone(s.customer_phone) : <span className="muted">—</span>)}</td>
                <td style={{ textAlign: 'right' }}>
                  <button className="btn sm" onClick={() => editar(s)}>Editar</button>{' '}
                  <button className="btn sm" onClick={() => apagar(s)}>Apagar</button>
                </td>
              </tr>
            ))}
            {!dados.rows.length && <tr><td colSpan="8" className="muted">Nenhuma venda neste mês.</td></tr>}
          </tbody>
        </table>
      </div>
      {edit && (
        <div className="modal-bg" onClick={() => setEdit(null)}>
          <form className="modal" onClick={(e) => e.stopPropagation()} onSubmit={salvar}>
            <h2>{edit.id ? 'Editar venda' : 'Registrar venda de produto'}</h2>
            {err && <div className="error">{err}</div>}
            <div className="field"><label>Produto do catálogo</label>
              <select value={edit.service_id} onChange={(e) => escolheProduto(e.target.value)}>
                <option value="">Outro (digitar o nome)</option>
                {produtos.map((p) => <option key={p.id} value={p.id}>{p.name} — {money(p.price)}</option>)}
              </select></div>
            {!edit.service_id && <div className="field"><label>Nome do produto *</label><input value={edit.product_name} maxLength={120} onChange={(e) => setEdit({ ...edit, product_name: e.target.value })} required /></div>}
            <div className="row">
              <div className="field"><label>Quantidade</label><input type="number" min="1" max="9999" value={edit.quantity} onChange={(e) => setEdit({ ...edit, quantity: e.target.value })} required /></div>
              <div className="field"><label>Valor de cada (R$)</label><input value={edit.unit_price} onChange={(e) => setEdit({ ...edit, unit_price: e.target.value })} required /></div>
            </div>
            <div className="field"><label>Profissional que vendeu</label>
              <select value={edit.professional_id} onChange={(e) => setEdit({ ...edit, professional_id: e.target.value })}>
                <option value="">Ninguém (sem comissão)</option>
                {profs.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
              </select></div>
            <div className="field"><label>Cliente (opcional)</label>
              {edit.customer_id ? (
                <div className="row"><span>{edit.customer_label || 'Cliente escolhido'}</span><button type="button" className="btn sm" onClick={() => { setEdit({ ...edit, customer_id: '', customer_label: '' }); setBusca(''); }}>Trocar</button></div>
              ) : (
                <>
                  <input value={busca} onChange={(e) => setBusca(e.target.value)} placeholder="Digite o nome ou o telefone para procurar" />
                  {achados.map((c) => (
                    <button type="button" key={c.id} className="btn sm" style={{ display: 'block', marginTop: 4 }}
                      onClick={() => { setEdit({ ...edit, customer_id: c.id, customer_label: c.name || fmtPhone(c.phone) }); setBusca(''); }}>
                      {c.name || 'Sem nome'}{c.phone ? ' · ' + fmtPhone(c.phone) : ''}
                    </button>
                  ))}
                </>
              )}
            </div>
            <div className="row">
              <div className="field"><label>Data e hora</label><input type="datetime-local" value={edit.sold_at} onChange={(e) => setEdit({ ...edit, sold_at: e.target.value })} required /></div>
            </div>
            <div className="field"><label>Anotação (opcional)</label><input value={edit.note} maxLength={300} onChange={(e) => setEdit({ ...edit, note: e.target.value })} /></div>
            <div className="row"><button className="btn primary">Salvar</button><button type="button" className="btn" onClick={() => setEdit(null)}>Cancelar</button></div>
          </form>
        </div>
      )}
    </>
  );
}
