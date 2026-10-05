import React, { useEffect, useState } from 'react';
import { api } from '../api.js';

const vazio = { benefit_text: '', discount_percent: '', companions: '0' };
const corpo = (f) => ({ benefit_text: f.benefit_text, discount_percent: f.discount_percent === '' ? null : f.discount_percent, companions: f.companions === '' ? 0 : Number(f.companions) });

// Parcerias entre programas: um benefício que uma empresa dá aos assinantes do programa de outra
export default function Parcerias({ nomePrograma }) {
  const [lista, setLista] = useState(null);
  const [programas, setProgramas] = useState([]);
  const [err, setErr] = useState('');
  const [msg, setMsg] = useState('');
  const [form, setForm] = useState(null);   // { tipo: 'propor'|'aceitar'|'oferta', alvo, f }
  const carregar = async () => {
    try { const [l, p] = await Promise.all([api('/club/partnerships'), api('/club/partnerships/programs')]); setLista(l); setProgramas(p); setErr(''); } catch (e) { setErr(e.message); }
  };
  useEffect(() => { carregar(); }, []);
  const acao = async (fn, ok) => { setErr(''); setMsg(''); try { await fn(); if (ok) setMsg(ok); setForm(null); await carregar(); } catch (e) { setErr(e.message); } };

  async function enviar(e) {
    e.preventDefault();
    const { tipo, alvo, f } = form;
    if (tipo === 'propor') await acao(() => api('/club/partnerships', { method: 'POST', body: { partner_id: alvo.company_id, ...corpo(f) } }), 'Proposta enviada.');
    if (tipo === 'aceitar') await acao(() => api(`/club/partnerships/${alvo.id}/respond`, { method: 'POST', body: { accept: true, ...(f.benefit_text.trim() ? corpo(f) : {}) } }), 'Parceria aceita.');
    if (tipo === 'oferta') await acao(() => api(`/club/partnerships/${alvo.id}/offer`, { method: 'PUT', body: corpo(f) }), 'Benefício salvo.');
  }

  if (!lista) return <p className="muted">{err || 'Carregando…'}</p>;
  const recebidas = lista.filter((p) => p.incoming);
  const enviadas = lista.filter((p) => p.outgoing);
  const ativas = lista.filter((p) => p.status === 'active');
  const livres = programas.filter((p) => !p.partnership);
  const detalhe = (o) => o && <>{o.benefit_text}{o.discount_percent ? <span className="muted"> · {String(o.discount_percent).replace('.', ',')}% de desconto{o.companions ? ` + ${o.companions} acompanhante(s)` : ''}</span> : null}</>;

  return (
    <>
      <p className="muted" style={{ marginBottom: 14 }}>Parcerias com programas de outras empresas: você oferece um benefício aos assinantes deles, e eles podem oferecer um aos seus. O benefício só vale depois que o outro lado aceita, e qualquer um dos dois pode encerrar quando quiser.</p>
      {err && <div className="error">{err}</div>}
      {msg && <p className="muted" style={{ marginBottom: 8 }}>{msg}</p>}

      {recebidas.length > 0 && (
        <div className="card" style={{ marginBottom: 16 }}>
          <h2>Propostas recebidas</h2>
          {recebidas.map((p) => (
            <div key={p.id} style={{ padding: '10px 0', borderBottom: '1px solid var(--border, #ddd)' }}>
              <strong>{p.partner_name}</strong> <span className="muted">· {p.program_name}</span>
              <div style={{ margin: '4px 0 8px' }}>Oferece aos seus assinantes: {detalhe(p.their_offer)}</div>
              <div className="row">
                <button className="btn primary" onClick={() => setForm({ tipo: 'aceitar', alvo: p, f: { ...vazio } })}>Aceitar</button>
                <button className="btn bad" onClick={() => confirm(`Recusar a proposta de ${p.partner_name}?`) && acao(() => api(`/club/partnerships/${p.id}/respond`, { method: 'POST', body: { accept: false } }), 'Proposta recusada.')}>Recusar</button>
              </div>
            </div>
          ))}
        </div>
      )}

      <div className="card" style={{ marginBottom: 16 }}>
        <h2>Parcerias ativas</h2>
        {!ativas.length && <p className="muted">Nenhuma parceria ativa ainda.</p>}
        {ativas.map((p) => (
          <div key={p.id} style={{ padding: '10px 0', borderBottom: '1px solid var(--border, #ddd)' }}>
            <strong>{p.partner_name}</strong> <span className="muted">· {p.program_name}</span>
            <div style={{ marginTop: 6 }}><span className="muted">Eles oferecem aos seus assinantes: </span>{p.their_offer ? detalhe(p.their_offer) : <span className="muted">nada por enquanto</span>}</div>
            <div style={{ marginTop: 4 }}><span className="muted">Você oferece aos assinantes deles: </span>{p.my_offer ? detalhe(p.my_offer) : <span className="muted">nada por enquanto</span>}</div>
            <div className="row" style={{ marginTop: 8 }}>
              <button className="btn" onClick={() => setForm({ tipo: 'oferta', alvo: p, f: p.my_offer ? { benefit_text: p.my_offer.benefit_text, discount_percent: p.my_offer.discount_percent ?? '', companions: String(p.my_offer.companions) } : { ...vazio } })}>{p.my_offer ? 'Mudar meu benefício' : 'Oferecer um benefício'}</button>
              <button className="btn bad" onClick={() => confirm(`Encerrar a parceria com ${p.partner_name}? Os benefícios dos dois lados deixam de valer agora.`) && acao(() => api(`/club/partnerships/${p.id}/end`, { method: 'POST' }), 'Parceria encerrada.')}>Encerrar</button>
            </div>
          </div>
        ))}
      </div>

      {enviadas.length > 0 && (
        <div className="card" style={{ marginBottom: 16 }}>
          <h2>Propostas enviadas</h2>
          {enviadas.map((p) => (
            <div key={p.id} style={{ padding: '10px 0', borderBottom: '1px solid var(--border, #ddd)' }}>
              <strong>{p.partner_name}</strong> <span className="muted">· {p.program_name} · aguardando resposta</span>
              <div style={{ margin: '4px 0 8px' }}>Você propôs: {detalhe(p.my_offer)}</div>
              <button className="btn bad" onClick={() => acao(() => api(`/club/partnerships/${p.id}/end`, { method: 'POST' }), 'Proposta cancelada.')}>Cancelar proposta</button>
            </div>
          ))}
        </div>
      )}

      <div className="card table-wrap">
        <h2>Propor parceria</h2>
        <table>
          <thead><tr><th>Programa</th><th>Empresa</th><th></th></tr></thead>
          <tbody>
            {livres.map((p) => (
              <tr key={p.company_id}>
                <td>{p.program_name}</td><td>{p.company_name}</td>
                <td><button className="btn" onClick={() => setForm({ tipo: 'propor', alvo: p, f: { ...vazio } })}>Propor parceria</button></td>
              </tr>
            ))}
            {!livres.length && <tr><td colSpan="3" className="muted">Nenhum outro programa disponível para propor parceria.</td></tr>}
          </tbody>
        </table>
      </div>

      {form && (
        <div className="modal-bg" onClick={() => setForm(null)}>
          <form className="modal" style={{ maxWidth: 520 }} onClick={(e) => e.stopPropagation()} onSubmit={enviar}>
            <h2>{form.tipo === 'propor' ? `Propor parceria a ${form.alvo.company_name}` : form.tipo === 'aceitar' ? `Aceitar a proposta de ${form.alvo.partner_name}` : 'Meu benefício'}</h2>
            {form.tipo === 'aceitar' && <p className="muted">Você pode aceitar sem oferecer nada em troca. Se quiser retribuir com um benefício aos assinantes deles, escreva abaixo.</p>}
            <div className="field">
              <label>{form.tipo === 'aceitar' ? 'Benefício que você oferece em troca (opcional)' : `Benefício que você oferece aos assinantes de ${form.alvo.program_name || form.alvo.company_name}`}</label>
              <textarea rows="3" required={form.tipo !== 'aceitar'} maxLength={500} placeholder="Escreva aqui o benefício que você propõe disponibilizar" value={form.f.benefit_text} onChange={(e) => setForm({ ...form, f: { ...form.f, benefit_text: e.target.value } })} />
            </div>
            <div className="row" style={{ gap: 12 }}>
              <div className="field" style={{ flex: 1 }}><label>Desconto em % (opcional)</label><input inputMode="decimal" value={form.f.discount_percent} onChange={(e) => setForm({ ...form, f: { ...form.f, discount_percent: e.target.value } })} /></div>
              <div className="field" style={{ flex: 1 }}><label>Acompanhantes com o benefício</label><input inputMode="numeric" value={form.f.companions} onChange={(e) => setForm({ ...form, f: { ...form.f, companions: e.target.value } })} /></div>
            </div>
            <p className="muted" style={{ fontSize: 13 }}>Com o desconto em %, o painel aplica sozinho nas vendas de ingresso. Sem ele, o benefício é só uma informação para o atendimento.</p>
            <div className="row" style={{ marginTop: 12, justifyContent: 'flex-end' }}>
              <button type="button" className="btn" onClick={() => setForm(null)}>Cancelar</button>
              <button className="btn primary">{form.tipo === 'propor' ? 'Enviar proposta' : form.tipo === 'aceitar' ? 'Aceitar' : 'Salvar'}</button>
            </div>
          </form>
        </div>
      )}
    </>
  );
}
