import React, { useEffect, useState } from 'react';
import { api } from '../api.js';

const brData = (iso) => new Date(iso + 'T12:00:00').toLocaleDateString('pt-BR');
const nomeMes = (iso) => new Date(iso + 'T12:00:00').toLocaleDateString('pt-BR', { month: 'long', year: 'numeric' });

export function Indicacoes({ s, fechar }) {
  const [v, setV] = useState(null);
  const [nome, setNome] = useState('');
  const [data, setData] = useState('');
  const [err, setErr] = useState('');
  const [dia, setDia] = useState(s.billing_due_day ?? '');
  const [isenta, setIsenta] = useState(!!s.billing_exempt);
  const [sujo, setSujo] = useState(false);
  const recarregar = () => api(`/admin/companies/${s.id}/referrals`).then(setV).catch((e) => setErr(e.message));
  useEffect(() => { recarregar(); }, [s.id]);
  async function salvarVenc() {
    setErr('');
    try { await api(`/admin/companies/${s.id}/billing`, { method: 'PUT', body: { billing_due_day: dia === '' ? null : Number(dia), billing_exempt: isenta } }); setSujo(false); await recarregar(); }
    catch (e) { setErr(e.message); }
  }
  async function add(e) {
    e.preventDefault(); setErr('');
    try { setV(await api(`/admin/companies/${s.id}/referrals`, { method: 'POST', body: { referred_name: nome, closed_on: data || undefined } })); setNome(''); setData(''); }
    catch (e2) { setErr(e2.message); }
  }
  async function apagar(r) {
    if (!window.confirm(`Apagar a indicação de ${r.referred_name}?`)) return;
    try { setV(await api(`/admin/referrals/${r.id}`, { method: 'DELETE' })); } catch (e2) { setErr(e2.message); }
  }
  return (
    <div className="modal-bg" onClick={fechar}>
      <div className="modal" onClick={(e) => e.stopPropagation()} style={{ maxWidth: 640 }}>
        <h2>Indicações de {s.name}</h2>
        {err && <div className="error">{err}</div>}
        <div className="row" style={{ alignItems: 'flex-end', marginBottom: 10 }}>
          <div className="field" style={{ margin: 0 }}><label>Vencimento da mensalidade (dia)</label>
            <input type="number" min="1" max="31" style={{ width: 80 }} disabled={isenta} value={isenta ? '' : dia} onChange={(e) => { setDia(e.target.value); setSujo(true); }} /></div>
          <label style={{ display: 'flex', gap: 6, alignItems: 'center', margin: 0 }}>
            <input type="checkbox" checked={isenta} onChange={(e) => { setIsenta(e.target.checked); setSujo(true); }} /> Isenta
          </label>
          {sujo && <button className="btn sm primary" onClick={salvarVenc}>Salvar</button>}
        </div>
        {!v ? <p className="muted">Carregando…</p> : (
          <>
            {v.company.billing_exempt && <p className="muted">Esta empresa é isenta: as indicações ficam registradas, mas não geram desconto nem lembrete.</p>}
            {!v.company.billing_exempt && !v.company.billing_due_day && <p className="muted">Informe o dia do vencimento da mensalidade para calcular os descontos e agendar os lembretes.</p>}
            {v.next && <p><strong>Próxima mensalidade ({brData(v.next.due_on)}): {v.next.pct}% de desconto</strong></p>}
            {!v.reminders && <p className="muted">O envio de lembretes ainda não está ligado neste servidor.</p>}
            <form className="row" onSubmit={add} style={{ alignItems: 'flex-end', marginBottom: 10 }}>
              <div className="field" style={{ flex: 1 }}><label>Quem foi indicado e fechou contrato</label><input value={nome} onChange={(e) => setNome(e.target.value)} required /></div>
              <div className="field"><label>Data (hoje, se vazio)</label><input type="date" value={data} onChange={(e) => setData(e.target.value)} /></div>
              <button className="btn primary">Marcar indicação</button>
            </form>
            {v.referrals.length > 0 && (
              <table><tbody>{v.referrals.map((r) => (
                <tr key={r.id}><td>{brData(r.closed_on)}</td><td>{r.referred_name}</td><td style={{ textAlign: 'right' }}><button className="btn sm" onClick={() => apagar(r)}>Apagar</button></td></tr>
              ))}</tbody></table>
            )}
            {v.schedule.length > 0 && (
              <>
                <h3 style={{ marginTop: 14 }}>Descontos mês a mês</h3>
                <table><tbody>{v.schedule.map((e) => (
                  <tr key={e.month}><td>{nomeMes(e.month)}</td><td>vence {brData(e.due_on)}</td><td><strong>{e.pct}%</strong></td><td className="muted">{e.referrals.join(', ')}</td></tr>
                ))}</tbody></table>
              </>
            )}
            <p className="muted" style={{ marginTop: 10 }}>Cada indicação vale {v.rules.pct_each}% na mensalidade, até {v.rules.max_per_month} por mês. O que passar disso vale nos meses seguintes. Indicação marcada depois do vencimento vale a partir da próxima mensalidade.</p>
          </>
        )}
        <div className="row" style={{ marginTop: 10 }}><button className="btn" onClick={fechar}>Fechar</button></div>
      </div>
    </div>
  );
}

// Para quem os lembretes de desconto são enviados
export function AvisosDesconto() {
  const [f, setF] = useState(null);
  const [msg, setMsg] = useState('');
  const [err, setErr] = useState('');
  useEffect(() => { api('/admin/benefits').then(setF).catch((e) => setErr(e.message)); }, []);
  if (!f) return null;
  async function salvar() {
    setErr(''); setMsg('');
    try { setF(await api('/admin/benefits', { method: 'PUT', body: { notice_phone: f.notice_phone, notice_instance: f.notice_instance } })); setMsg('Salvo'); }
    catch (e) { setErr(e.message); }
  }
  return (
    <div className="card" style={{ marginBottom: 12 }}>
      <h3>Avisos de desconto por indicação</h3>
      <p className="muted">Na véspera do vencimento, você recebe no WhatsApp um lembrete para aplicar o desconto da empresa.</p>
      {err && <div className="error">{err}</div>}
      <div className="row" style={{ alignItems: 'flex-end' }}>
        <div className="field"><label>Seu WhatsApp (DDD + número)</label><input value={f.notice_phone} onChange={(e) => setF({ ...f, notice_phone: e.target.value })} /></div>
        <div className="field"><label>Enviar por qual atendente (instância)</label><input value={f.notice_instance} onChange={(e) => setF({ ...f, notice_instance: e.target.value })} /></div>
        <button className="btn primary" onClick={salvar}>Salvar</button>
        {msg && <span className="muted">{msg}</span>}
      </div>
      {!f.reminders && <p className="muted">O envio de lembretes ainda não está ligado neste servidor.</p>}
    </div>
  );
}
