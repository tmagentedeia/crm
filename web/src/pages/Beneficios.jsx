import React, { useEffect, useState } from 'react';
import { api } from '../api.js';
import { nomeDoMenu } from '../menu.jsx';
import { Indicacoes, AvisosDesconto } from './AdminIndicacoes.jsx';

const brData = (iso) => new Date(iso + 'T12:00:00').toLocaleDateString('pt-BR');
const nomeMes = (iso) => new Date(iso + 'T12:00:00').toLocaleDateString('pt-BR', { month: 'long', year: 'numeric' });

// Saldo do programa de benefícios por indicação (somente leitura; quem marca as indicações é o administrador)
export default function Beneficios({ company }) {
  const [padrao, setPadrao] = useState('Programa de benefícios M2');
  useEffect(() => { api('/benefits/name').then((r) => r?.name && setPadrao(r.name)).catch(() => {}); }, []);
  const titulo = nomeDoMenu(company?.menu_custom || {}, 'beneficios', padrao);
  const [eu, setEu] = useState(null);
  useEffect(() => { api('/me').then(setEu).catch(() => setEu({})); }, []);
  if (!eu) return <p className="muted">Carregando…</p>;
  return eu.admin && !eu.impersonating ? <Parceiros titulo={titulo} /> : <MeuSaldo titulo={titulo} />;
}

// Controle do programa de parceiros da M2: todas as empresas clientes, indicações e vencimentos (só o administrador vê)
function Parceiros({ titulo }) {
  const [v, setV] = useState(null);
  const [err, setErr] = useState('');
  const [ind, setInd] = useState(null);
  const carregar = () => api('/admin/benefits/overview').then(setV).catch((e) => setErr(e.message));
  useEffect(() => { carregar(); }, []);
  if (err) return <div className="error">{err}</div>;
  if (!v) return <p className="muted">Carregando…</p>;
  return (
    <>
      <div style={{ marginBottom: 12 }}>
        <h1>{titulo}</h1>
        <p className="muted">Cada indicação de uma empresa que fechou contrato vale {v.rules.pct_each}% de desconto na mensalidade dela, até {v.rules.max_per_month} por mês. O que passar disso vale nos meses seguintes.</p>
      </div>
      <AvisosDesconto />
      <div className="card table-wrap">
        <table>
          <thead><tr><th>Empresa</th><th>Vencimento</th><th>Indicações</th><th>Próxima mensalidade</th><th></th></tr></thead>
          <tbody>{v.companies.map((c) => (
            <tr key={c.id}>
              <td><strong>{c.name}</strong></td>
              <td>{c.billing_exempt ? <span className="muted">Isenta</span> : c.billing_due_day ? `dia ${c.billing_due_day}` : <span className="muted">—</span>}</td>
              <td>{c.total}</td>
              <td>{c.next ? <>{brData(c.next.due_on)}: <strong>{c.next.pct}%</strong></> : <span className="muted">—</span>}</td>
              <td style={{ textAlign: 'right' }}><button className="btn sm" onClick={() => setInd(c)}>Indicações e vencimento</button></td>
            </tr>
          ))}</tbody>
        </table>
      </div>
      {ind && <Indicacoes s={ind} fechar={() => { setInd(null); carregar(); }} />}
    </>
  );
}

function MeuSaldo({ titulo }) {
  const [v, setV] = useState(null);
  const [err, setErr] = useState('');
  const [msg, setMsg] = useState('');
  const [nota, setNota] = useState('');
  useEffect(() => { api('/benefits').then(setV).catch((e) => setErr(e.message)); }, []);
  async function pedir() {
    setErr(''); setMsg('');
    try { await api('/benefits/request', { method: 'POST', body: { message: nota } }); setMsg('Pedido enviado. Você receberá a atualização em breve.'); setNota(''); }
    catch (e) { setErr(e.message); }
  }
  if (!v) return err ? <div className="error">{err}</div> : <p className="muted">Carregando…</p>;
  return (
    <>
      <div style={{ marginBottom: 12 }}>
        <h1>{titulo}</h1>
        <p className="muted">Indicou um cliente que fechou contrato? Cada indicação vale {v.rules.pct_each}% de desconto na mensalidade, até {v.rules.max_per_month} por mês. O que passar disso fica acumulado e vale nos meses seguintes.</p>
      </div>
      {v.company.billing_exempt ? (
        <div className="card"><p>Sua empresa é isenta de mensalidade, então não há desconto a aplicar.</p></div>
      ) : (
        <>
          <div className="card" style={{ marginBottom: 12 }}>
            {v.next
              ? <p style={{ fontSize: 18 }}>Próxima mensalidade ({brData(v.next.due_on)}): <strong>{v.next.pct}% de desconto</strong></p>
              : <p>Nenhum desconto previsto no momento.</p>}
            <p className="muted">{v.total} indicação(ões) registrada(s) no total.</p>
          </div>
          {v.schedule.length > 0 && (
            <div className="card table-wrap" style={{ marginBottom: 12 }}>
              <table>
                <thead><tr><th>Mês</th><th>Vencimento</th><th>Desconto</th><th>Situação</th><th>Indicações</th></tr></thead>
                <tbody>{v.schedule.map((e) => (
                  <tr key={e.month}><td>{nomeMes(e.month)}</td><td>{brData(e.due_on)}</td><td><strong>{e.pct}%</strong></td>
                    <td>{e.status === 'aplicado' ? 'Aplicado' : 'Programado'}</td><td className="muted">{e.referrals.join(', ')}</td></tr>
                ))}</tbody>
              </table>
            </div>
          )}
        </>
      )}
      {v.referrals.length > 0 && (
        <div className="card table-wrap" style={{ marginBottom: 12 }}>
          <table>
            <thead><tr><th>Data</th><th>Indicado</th></tr></thead>
            <tbody>{v.referrals.map((r) => <tr key={r.id}><td>{brData(r.closed_on)}</td><td>{r.referred_name}</td></tr>)}</tbody>
          </table>
        </div>
      )}
      <Indicar />
      <div className="card">
        <h3>Algo não confere?</h3>
        <p className="muted">Se uma indicação sua não aparece ou o desconto não foi lançado, peça uma conferência.</p>
        {err && <div className="error">{err}</div>}
        {msg && <p>{msg}</p>}
        <div className="row" style={{ alignItems: 'flex-end' }}>
          <div className="field" style={{ flex: 1 }}><label>Mensagem (opcional)</label><input value={nota} maxLength={300} onChange={(e) => setNota(e.target.value)} placeholder="Ex.: indiquei o Fulano em março" /></div>
          <button className="btn primary" onClick={pedir}>Pedir conferência</button>
        </div>
      </div>
    </>
  );
}

// Indicar um contato: o painel monta a mensagem com o link e abre o WhatsApp do próprio cliente (ele aperta enviar)
function Indicar() {
  const [info, setInfo] = useState(null);
  const [busca, setBusca] = useState('');
  const [achados, setAchados] = useState([]);
  const [fone, setFone] = useState('');
  const [copiado, setCopiado] = useState(false);
  useEffect(() => { api('/benefits/invite').then(setInfo).catch(() => setInfo({ available: false })); }, []);
  useEffect(() => {
    if (busca.trim().length < 2) { setAchados([]); return; }
    const t = setTimeout(() => api('/customers?search=' + encodeURIComponent(busca.trim())).then((r) => setAchados(r.slice(0, 6))).catch(() => {}), 300);
    return () => clearTimeout(t);
  }, [busca]);
  if (!info?.available) return null;
  const digitos = String(fone).replace(/\D/g, '');
  const destino = digitos.length >= 10 ? (digitos.length <= 11 ? '55' + digitos : digitos) : '';
  const abrir = () => window.open(`https://wa.me/${destino}?text=${encodeURIComponent(info.texto)}`, '_blank', 'noopener');
  async function copiar() { try { await navigator.clipboard.writeText(info.texto); setCopiado(true); setTimeout(() => setCopiado(false), 2000); } catch { /* sem permissão */ } }
  return (
    <div className="card" style={{ marginBottom: 12 }}>
      <h3>Indicar alguém</h3>
      <p>Seu código: <strong>{info.codigo}</strong></p>
      <p className="muted">Escolha um contato seu e o WhatsApp abre com a mensagem pronta. A pessoa precisa informar o seu código ao contratar para ter o desconto; assim, o desconto da sua indicação é lançado para você.</p>
      <div className="field"><label>Procurar entre seus clientes</label><input value={busca} onChange={(e) => setBusca(e.target.value)} placeholder="Nome ou telefone" /></div>
      {achados.length > 0 && (
        <div className="row" style={{ gap: 6, flexWrap: 'wrap', marginBottom: 8 }}>
          {achados.map((c) => <button key={c.id} className="btn sm" onClick={() => { setFone(c.phone || ''); setBusca(''); setAchados([]); }}>{c.name || c.phone}</button>)}
        </div>
      )}
      <div className="row" style={{ alignItems: 'flex-end' }}>
        <div className="field"><label>WhatsApp (DDD + número)</label><input value={fone} onChange={(e) => setFone(e.target.value)} placeholder="32 99999-9999" /></div>
        <button className="btn primary" disabled={!destino} onClick={abrir}>Abrir no WhatsApp</button>
        <button className="btn" onClick={copiar}>{copiado ? 'Copiada!' : 'Copiar mensagem'}</button>
      </div>
    </div>
  );
}
