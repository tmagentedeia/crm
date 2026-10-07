import React, { useEffect, useState } from 'react';
import { api } from './api.js';
import { useSelecao, CelulaTodos, CelulaLinha, ApagarSelecionados, resumoApagado } from './selecao.jsx';

const quando = (iso) => new Date(iso).toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
const SITUACAO = { sent: 'Enviado', failed: 'Não enviado', cancelled: 'Cancelado', skipped: 'Não enviado' };

// Lembretes de agendamento: o que vai sair (editável, um a um) e o que já saiu. Recolhido por padrão.
export default function LembretesAgenda() {
  const [aberto, setAberto] = useState(false);
  const [aba, setAba] = useState('agendados');
  const [d, setD] = useState(null);
  const [msg, setMsg] = useState(''); const [err, setErr] = useState('');
  const [edit, setEdit] = useState(null);       // { id, text }
  const [confirma, setConfirma] = useState(false);
  const [busy, setBusy] = useState(false);
  const [marcados, setMarcados] = useState([]);
  const historico = d?.history || [];
  const selH = useSelecao(historico);

  const carregar = () => api('/reminders').then(setD).catch((e) => setErr(e.message));
  useEffect(() => { if (aberto) carregar(); }, [aberto]);
  useEffect(() => { setMarcados((m) => m.filter((id) => (d?.scheduled || []).some((x) => x.id === id))); }, [d]);

  const agir = async (fn, ok) => {
    setMsg(''); setErr(''); setBusy(true);
    try { await fn(); setMsg(ok); await carregar(); } catch (e) { setErr(e.message); await carregar().catch(() => {}); }
    setBusy(false);
  };
  const ag = d?.scheduled || [];
  const todos = ag.length > 0 && ag.every((x) => marcados.includes(x.id));
  const alterna = (id) => setMarcados((m) => (m.includes(id) ? m.filter((x) => x !== id) : [...m, id]));

  return (
    <div className="card">
      <div className="row" style={{ justifyContent: 'space-between', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
        <div>
          <h2 style={{ margin: 0 }}>Lembretes aos clientes</h2>
          {!aberto && <span className="muted">Veja o que vai ser enviado, o que já foi e edite um a um.</span>}
        </div>
        <button className="btn sm" onClick={() => setAberto(!aberto)}>{aberto ? 'Recolher' : 'Ver lembretes'}</button>
      </div>
      {aberto && (
        <div style={{ marginTop: 12 }}>
          {msg && <p style={{ color: 'var(--ok)', marginBottom: 8 }}>{msg}</p>}
          {err && <div className="error">{err}</div>}
          {d && !d.enabled && <p className="muted" style={{ marginBottom: 8 }}>O lembrete está desligado. Para ligar, escolha a antecedência em Configurações.</p>}
          {d && d.enabled && !d.connected && <p className="muted" style={{ marginBottom: 8 }}>O WhatsApp para avisos ainda não está ligado nesta empresa: os lembretes ficam na lista, mas não saem.</p>}
          <div className="row" style={{ gap: 8, marginBottom: 12 }}>
            <button className={'btn sm' + (aba === 'agendados' ? ' primary' : '')} onClick={() => setAba('agendados')}>Agendados{d ? ` (${ag.length})` : ''}</button>
            <button className={'btn sm' + (aba === 'enviados' ? ' primary' : '')} onClick={() => setAba('enviados')}>Enviados e outros{d ? ` (${historico.length})` : ''}</button>
          </div>

          {aba === 'agendados' && (
            <>
              {marcados.length > 0 && (
                <div className="row" style={{ gap: 12, alignItems: 'center', marginBottom: 8, flexWrap: 'wrap' }}>
                  <strong>{marcados.length} selecionado(s)</strong>
                  {!confirma
                    ? <button className="btn sm" onClick={() => setConfirma(true)}>Cancelar avisos selecionados</button>
                    : <>
                        <span>Cancelar o aviso de {marcados.length} cliente(s)? Os agendamentos continuam.</span>
                        <button className="btn primary sm" disabled={busy} onClick={() => agir(async () => { await api('/reminders/bulk-cancel', { method: 'POST', body: { ids: marcados } }); setMarcados([]); setConfirma(false); }, 'Avisos cancelados.')}>Sim, cancelar</button>
                        <button className="btn sm" onClick={() => setConfirma(false)}>Voltar</button>
                      </>}
                </div>
              )}
              <table>
                <thead><tr>
                  <th style={{ width: 34 }}><input type="checkbox" style={{ width: 'auto', margin: 0 }} title="Selecionar todos" disabled={!ag.length} checked={todos} onChange={() => { setConfirma(false); setMarcados(todos ? [] : ag.map((x) => x.id)); }} /></th>
                  <th>Cliente</th><th>Horário marcado</th><th>Sai em</th><th>Mensagem</th><th></th>
                </tr></thead>
                <tbody>
                  {ag.map((x) => (
                    <React.Fragment key={x.id}>
                      <tr>
                        <td><input type="checkbox" style={{ width: 'auto', margin: 0 }} checked={marcados.includes(x.id)} onChange={() => { setConfirma(false); alterna(x.id); }} /></td>
                        <td><strong>{x.customer_name}</strong>{x.phone && <div className="muted">{x.phone}</div>}</td>
                        <td>{quando(x.starts_at)}</td>
                        <td>{x.status === 'sending' ? 'enviando…' : quando(x.send_at)}</td>
                        <td style={{ maxWidth: 320 }}>{x.preview}{x.custom && <span className="muted"> (texto só deste cliente)</span>}</td>
                        <td style={{ textAlign: 'right', whiteSpace: 'nowrap' }}>
                          <button className="btn sm" disabled={busy} onClick={() => setEdit({ id: x.id, text: x.custom ? x.text : x.preview })}>Editar</button>{' '}
                          <button className="btn sm" disabled={busy || !d.connected} onClick={() => window.confirm(`Enviar agora o lembrete para ${x.customer_name}?`) && agir(() => api(`/reminders/${x.id}/send`, { method: 'POST' }), 'Lembrete enviado.')}>Enviar agora</button>{' '}
                          <button className="btn sm" disabled={busy} onClick={() => window.confirm(`Cancelar o aviso de ${x.customer_name}? O agendamento continua.`) && agir(() => api(`/reminders/${x.id}/cancel`, { method: 'POST' }), 'Aviso cancelado.')}>Cancelar aviso</button>
                        </td>
                      </tr>
                      {edit?.id === x.id && (
                        <tr><td colSpan="6">
                          <textarea rows={3} maxLength={d.max} value={edit.text} onChange={(e) => setEdit({ ...edit, text: e.target.value })} />
                          <p className="muted" style={{ margin: '4px 0 8px' }}>Vale só para este cliente. Pode usar {'{nome}'}, {'{servico}'}, {'{dia}'}, {'{hora}'}, {'{profissional}'} e {'{empresa}'}. Em branco, volta à mensagem da empresa.</p>
                          <div className="row" style={{ gap: 8 }}>
                            <button className="btn primary sm" disabled={busy} onClick={() => agir(async () => { await api(`/reminders/${x.id}`, { method: 'PUT', body: { text: edit.text } }); setEdit(null); }, 'Mensagem salva.')}>Salvar mensagem</button>
                            <button className="btn sm" onClick={() => setEdit(null)}>Fechar</button>
                          </div>
                        </td></tr>
                      )}
                    </React.Fragment>
                  ))}
                  {d && !ag.length && <tr><td colSpan="6" className="muted">Nenhum lembrete agendado no momento. Eles aparecem aqui quando um agendamento se aproxima (até 7 dias).</td></tr>}
                </tbody>
              </table>
            </>
          )}

          {aba === 'enviados' && (
            <>
              <ApagarSelecionados s={selH} total={historico.length} rotulo="registro(s) de lembrete" rota="/reminders/bulk-delete"
                descreve={() => <p>Só some do histórico. Os agendamentos e o que o cliente recebeu não mudam.</p>}
                onDone={(r) => { setMsg(resumoApagado(r, 'registro(s)')); carregar(); }} />
              <p className="muted" style={{ marginBottom: 8 }}>O histórico fica guardado por 30 dias depois do horário do agendamento.</p>
              <table>
                <thead><tr><CelulaTodos s={selH} /><th>Cliente</th><th>Horário marcado</th><th>Situação</th><th>Mensagem</th><th></th></tr></thead>
                <tbody>
                  {historico.map((x) => (
                    <tr key={x.id}>
                      <CelulaLinha s={selH} id={x.id} />
                      <td><strong>{x.customer_name}</strong>{x.phone && <div className="muted">{x.phone}</div>}</td>
                      <td>{quando(x.starts_at)}</td>
                      <td>{SITUACAO[x.status]}{x.sent_at && <div className="muted">{quando(x.sent_at)}</div>}{x.note && <div className="muted">{x.note}</div>}</td>
                      <td style={{ maxWidth: 340 }}>{x.sent_text || ''}</td>
                      <td style={{ textAlign: 'right' }}>{x.status === 'failed' && <button className="btn sm" disabled={busy || !d.connected} onClick={() => agir(() => api(`/reminders/${x.id}/send`, { method: 'POST' }), 'Lembrete enviado.')}>Reenviar</button>}</td>
                    </tr>
                  ))}
                  {d && !historico.length && <tr><td colSpan="6" className="muted">Nenhum lembrete enviado ainda.</td></tr>}
                </tbody>
              </table>
            </>
          )}
        </div>
      )}
    </div>
  );
}
