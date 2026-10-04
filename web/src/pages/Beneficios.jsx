import React, { useEffect, useState } from 'react';
import { api } from '../api.js';

const brData = (iso) => new Date(iso + 'T12:00:00').toLocaleDateString('pt-BR');
const nomeMes = (iso) => new Date(iso + 'T12:00:00').toLocaleDateString('pt-BR', { month: 'long', year: 'numeric' });

// Saldo do programa de benefícios por indicação (somente leitura; quem marca as indicações é o administrador)
export default function Beneficios() {
  const [v, setV] = useState(null);
  const [err, setErr] = useState('');
  useEffect(() => { api('/benefits').then(setV).catch((e) => setErr(e.message)); }, []);
  if (err) return <div className="error">{err}</div>;
  if (!v) return <p className="muted">Carregando…</p>;
  return (
    <>
      <div style={{ marginBottom: 12 }}>
        <h1>Programa de benefícios</h1>
        <p className="muted">Indicou um cliente que fechou contrato? Cada indicação vale {v.rules.pct_each}% de desconto na mensalidade, até {v.rules.max_per_month} por mês. O que passar disso vale nos meses seguintes.</p>
      </div>
      {v.company.billing_exempt ? (
        <div className="card"><p>Sua empresa é isenta de mensalidade, então não há desconto a aplicar.</p></div>
      ) : (
        <>
          <div className="card" style={{ marginBottom: 12 }}>
            {v.next
              ? <p style={{ fontSize: 18 }}>Próxima mensalidade ({brData(v.next.due_on)}): <strong>{v.next.pct}% de desconto</strong></p>
              : <p>Nenhum desconto previsto no momento.</p>}
            <p className="muted">{v.total} indicação(ões) fechada(s) no total.</p>
          </div>
          {v.schedule.length > 0 && (
            <div className="card table-wrap" style={{ marginBottom: 12 }}>
              <table>
                <thead><tr><th>Mês</th><th>Vencimento</th><th>Desconto</th><th>Indicações</th></tr></thead>
                <tbody>{v.schedule.map((e) => (
                  <tr key={e.month}><td>{nomeMes(e.month)}</td><td>{brData(e.due_on)}</td><td><strong>{e.pct}%</strong></td><td className="muted">{e.referrals.join(', ')}</td></tr>
                ))}</tbody>
              </table>
            </div>
          )}
        </>
      )}
      {v.referrals.length > 0 && (
        <div className="card table-wrap">
          <table>
            <thead><tr><th>Data</th><th>Indicado</th></tr></thead>
            <tbody>{v.referrals.map((r) => <tr key={r.id}><td>{brData(r.closed_on)}</td><td>{r.referred_name}</td></tr>)}</tbody>
          </table>
        </div>
      )}
    </>
  );
}
