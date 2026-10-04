import React, { useEffect, useState } from 'react';
import { api, money } from '../api.js';

const PERIODOS = { weekly: 'Semanal', biweekly: 'Quinzenal', monthly: 'Mensal' };
const dia = (iso) => new Date(iso + 'T12:00:00').toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit' });
const quando = (d) => new Date(d).toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' });
const pc = (n) => String(n).replace('.', ',') + '%';

export default function Comissoes() {
  const [aba, setAba] = useState('fechamento');
  return (
    <>
      <div style={{ marginBottom: 12 }}><h1>Comissões</h1><p className="muted">Quanto cada profissional ganha sobre os serviços atendidos e os produtos vendidos.</p></div>
      <div className="row" style={{ marginBottom: 12 }}>
        {[['fechamento', 'Fechamento'], ['percentuais', 'Percentuais'], ['ajustes', 'Ajustes']].map(([v, l]) => (
          <button key={v} className={'btn' + (aba === v ? ' primary' : '')} onClick={() => setAba(v)}>{l}</button>
        ))}
      </div>
      {aba === 'fechamento' && <Fechamento />}
      {aba === 'percentuais' && <Percentuais />}
      {aba === 'ajustes' && <Ajustes />}
    </>
  );
}

function Fechamento() {
  const [ref, setRef] = useState('');
  const [d, setD] = useState(null);
  const [aberto, setAberto] = useState(null);
  const [err, setErr] = useState('');
  useEffect(() => { api('/commissions' + (ref ? '?date=' + ref : '')).then(setD).catch((e) => setErr(e.message)); }, [ref]);
  if (err) return <div className="error">{err}</div>;
  if (!d) return <p className="muted">Carregando…</p>;
  const linhas = d.professionals;
  return (
    <>
      <div className="row" style={{ justifyContent: 'space-between', marginBottom: 12 }}>
        <div className="row">
          <button className="btn" onClick={() => setRef(d.prev_date)} aria-label="Período anterior">‹</button>
          <strong>{dia(d.from)} a {dia(d.to)}</strong>
          <button className="btn" onClick={() => setRef(d.next_date)} aria-label="Próximo período">›</button>
          <span className="muted">{PERIODOS[d.period]}{d.deduction_pct ? ` · desconto de ${pc(d.deduction_pct)} antes de calcular` : ''}</span>
        </div>
        <strong>Total a pagar: {money(d.total_commission)}</strong>
      </div>
      <div className="card table-wrap">
        <table>
          <thead><tr><th>Profissional</th><th>Serviços atendidos</th><th>Comissão</th><th>Produtos vendidos</th><th>Comissão</th><th>Total</th></tr></thead>
          <tbody>
            {linhas.map((p) => (
              <React.Fragment key={p.professional_id}>
                <tr className="click" onClick={() => setAberto(aberto === p.professional_id ? null : p.professional_id)}>
                  <td>{p.name}{!p.active && <span className="muted"> (inativo)</span>}</td>
                  <td>{money(p.services_total)}</td><td>{money(p.services_commission)}</td>
                  <td>{money(p.products_total)}</td><td>{money(p.products_commission)}</td>
                  <td><strong>{money(p.commission_total)}</strong></td>
                </tr>
                {aberto === p.professional_id && (
                  <tr><td colSpan="6" style={{ background: 'var(--bg)' }}>
                    {!p.services.length && !p.products.length && <span className="muted">Nada neste período.</span>}
                    {p.services.length > 0 && (
                      <>
                        <strong>Serviços</strong>
                        <table><tbody>
                          {p.services.map((x) => (
                            <tr key={'s' + x.id}><td>{quando(x.when)}</td><td>{x.name}{x.customer ? ' · ' + x.customer : ''}</td><td>{money(x.value)}</td><td>{pc(x.pct)}{x.custom_rate ? ' (próprio)' : ''}</td><td>{money(x.commission)}</td></tr>
                          ))}
                        </tbody></table>
                      </>
                    )}
                    {p.products.length > 0 && (
                      <>
                        <strong>Produtos</strong>
                        <table><tbody>
                          {p.products.map((x) => (
                            <tr key={'p' + x.id}><td>{quando(x.when)}</td><td>{x.quantity}× {x.name}{x.customer ? ' · ' + x.customer : ''}</td><td>{money(x.value)}</td><td>{pc(x.pct)}</td><td>{money(x.commission)}</td></tr>
                          ))}
                        </tbody></table>
                      </>
                    )}
                  </td></tr>
                )}
              </React.Fragment>
            ))}
            {!linhas.length && <tr><td colSpan="6" className="muted">Nenhum profissional cadastrado.</td></tr>}
          </tbody>
        </table>
      </div>
      <p className="muted" style={{ marginTop: 8 }}>
        Contam os atendimentos marcados como atendidos e as vendas de produto com profissional escolhido. Toque no nome para ver o detalhe.
        {d.unassigned_sales.count > 0 && ` Há ${d.unassigned_sales.count} venda(s) de produto sem profissional (${money(d.unassigned_sales.total)}), que não geram comissão.`}
      </p>
    </>
  );
}

function Percentuais() {
  const [lista, setLista] = useState([]);
  const [servicos, setServicos] = useState([]);
  const [edit, setEdit] = useState(null);
  const [err, setErr] = useState('');
  const [msg, setMsg] = useState('');
  const load = () => api('/commissions/rates').then(setLista).catch((e) => setErr(e.message));
  useEffect(() => { load(); api('/services').then((l) => setServicos(l.filter((x) => x.active))).catch(() => {}); }, []);
  const abrir = (p) => {
    setErr(''); setMsg('');
    const mapa = Object.fromEntries(p.overrides.map((o) => [o.service_id, String(o.pct).replace('.', ',')]));
    setEdit({ id: p.professional_id, name: p.name, service_pct: String(p.service_pct).replace('.', ','), product_pct: String(p.product_pct).replace('.', ','), mapa });
  };
  async function salvar(e) {
    e.preventDefault(); setErr('');
    const overrides = Object.entries(edit.mapa).filter(([, v]) => String(v).trim() !== '').map(([service_id, v]) => ({ service_id, pct: v }));
    try {
      await api('/commissions/rates/' + edit.id, { method: 'PUT', body: { service_pct: edit.service_pct, product_pct: edit.product_pct, overrides } });
      setEdit(null); setMsg('Percentuais salvos'); load();
    } catch (e2) { setErr(e2.message); }
  }
  return (
    <>
      {msg && <p className="muted" style={{ marginBottom: 8 }}>{msg}</p>}
      {err && !edit && <div className="error">{err}</div>}
      <div className="card table-wrap">
        <table>
          <thead><tr><th>Profissional</th><th>Serviços</th><th>Produtos</th><th>Exceções por serviço</th><th></th></tr></thead>
          <tbody>
            {lista.map((p) => (
              <tr key={p.professional_id}>
                <td>{p.name}</td><td>{pc(p.service_pct)}</td><td>{pc(p.product_pct)}</td>
                <td>{p.overrides.length ? p.overrides.map((o) => `${o.service_name} ${pc(o.pct)}`).join(', ') : <span className="muted">—</span>}</td>
                <td style={{ textAlign: 'right' }}><button className="btn sm" onClick={() => abrir(p)}>Editar</button></td>
              </tr>
            ))}
            {!lista.length && <tr><td colSpan="5" className="muted">Cadastre os profissionais primeiro.</td></tr>}
          </tbody>
        </table>
      </div>
      {edit && (
        <div className="modal-bg" onClick={() => setEdit(null)}>
          <form className="modal" onClick={(e) => e.stopPropagation()} onSubmit={salvar}>
            <h2>Comissão de {edit.name}</h2>
            {err && <div className="error">{err}</div>}
            <div className="row">
              <div className="field"><label>Sobre serviços (%)</label><input value={edit.service_pct} onChange={(e) => setEdit({ ...edit, service_pct: e.target.value })} required /></div>
              <div className="field"><label>Sobre produtos (%)</label><input value={edit.product_pct} onChange={(e) => setEdit({ ...edit, product_pct: e.target.value })} required /></div>
            </div>
            {servicos.length > 0 && (
              <>
                <label>Percentual próprio por serviço (deixe em branco para usar o percentual de serviços)</label>
                {servicos.map((s) => (
                  <div key={s.id} className="row" style={{ marginBottom: 6, justifyContent: 'space-between' }}>
                    <span>{s.name}</span>
                    <input style={{ maxWidth: 90 }} placeholder="%" value={edit.mapa[s.id] ?? ''} onChange={(e) => setEdit({ ...edit, mapa: { ...edit.mapa, [s.id]: e.target.value } })} />
                  </div>
                ))}
              </>
            )}
            <div className="row" style={{ marginTop: 12 }}><button className="btn primary">Salvar</button><button type="button" className="btn" onClick={() => setEdit(null)}>Cancelar</button></div>
          </form>
        </div>
      )}
    </>
  );
}

function Ajustes() {
  const [f, setF] = useState(null);
  const [msg, setMsg] = useState('');
  const [err, setErr] = useState('');
  useEffect(() => { api('/commissions/settings').then((s) => setF({ period: s.period, deduction_pct: String(s.deduction_pct).replace('.', ',') })).catch((e) => setErr(e.message)); }, []);
  if (!f) return err ? <div className="error">{err}</div> : <p className="muted">Carregando…</p>;
  async function salvar() {
    setErr(''); setMsg('');
    try { await api('/commissions/settings', { method: 'PUT', body: f }); setMsg('Ajustes salvos'); } catch (e) { setErr(e.message); }
  }
  return (
    <div className="card" style={{ maxWidth: 520 }}>
      {err && <div className="error">{err}</div>}
      <div className="field"><label>Fechamento</label>
        <select value={f.period} onChange={(e) => setF({ ...f, period: e.target.value })}>
          {Object.entries(PERIODOS).map(([v, l]) => <option key={v} value={v}>{l}</option>)}
        </select>
        <p className="muted">Semanal vai de segunda a domingo; quinzenal, do dia 1 ao 15 e do 16 ao fim do mês.</p></div>
      <div className="field"><label>Desconto antes de calcular (%)</label>
        <input value={f.deduction_pct} onChange={(e) => setF({ ...f, deduction_pct: e.target.value })} />
        <p className="muted">Por exemplo, a taxa da maquininha. Deixe 0 para calcular sobre o valor cheio.</p></div>
      <button className="btn primary" onClick={salvar}>Salvar</button>
      {msg && <span className="muted" style={{ marginLeft: 10 }}>{msg}</span>}
    </div>
  );
}
