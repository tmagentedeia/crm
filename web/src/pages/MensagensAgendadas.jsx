import React, { useEffect, useMemo, useState } from 'react';
import { api, fmtPhone } from '../api.js';
import { useSelecao, CelulaTodos, CelulaLinha } from '../selecao.jsx';

// Mensagens que ainda vão sair (agendadas pelo assistente ou pedidas por clientes): ver, editar e cancelar.
// O resultado de cada ação aparece na própria linha; a barra de seleção mostra o resumo do cancelamento em massa.

const TIPOS = { pessoal: 'Lembrete pessoal', contato: 'Mensagem a um contato', cliente: 'Lembrete de cliente' };
const etiqueta = { display: 'inline-block', padding: '1px 8px', borderRadius: 999, fontSize: 12, border: '1px solid var(--line)', color: 'var(--muted)', whiteSpace: 'nowrap' };

const quando = (iso, tz) => new Date(iso).toLocaleString('pt-BR', { timeZone: tz, day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' });
// "aaaa-mm-ddThh:mm" no horário da empresa, para o campo de data e hora
const paraCampo = (iso, tz) => {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
    .formatToParts(new Date(iso)).map((x) => [x.type, x.value]));
  return `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}`;
};

export default function MensagensAgendadas() {
  const [d, setD] = useState(null);
  const [erro, setErro] = useState('');
  const [fb, setFb] = useState({});                 // retorno por linha: { [id]: { ok, texto } }
  const [cancelados, setCancelados] = useState(() => new Set());
  const [edit, setEdit] = useState(null);           // { id, send_at, text }
  const [confirmaId, setConfirmaId] = useState(null);
  const [ocupado, setOcupado] = useState(false);
  const [massa, setMassa] = useState(null);         // null | { txt }
  const [resumo, setResumo] = useState('');
  const [erroMassa, setErroMassa] = useState('');

  const carregar = () => api('/scheduled-messages')
    .then((r) => { setD(r); setErro(''); setCancelados(new Set()); setFb({}); })
    .catch((e) => { setD({ items: [], tz: 'America/Sao_Paulo', max: 4000 }); setErro(e.message); });
  useEffect(() => { carregar(); }, []);

  const itens = d?.items || [];
  const ativos = useMemo(() => itens.filter((x) => !cancelados.has(x.id)), [itens, cancelados]);
  const s = useSelecao(ativos);
  const tz = d?.tz || 'America/Sao_Paulo';

  const marca = (id, ok, texto) => setFb((f) => ({ ...f, [id]: { ok, texto } }));

  const salvar = async () => {
    if (!edit) return;
    const orig = itens.find((x) => x.id === edit.id);
    const corpo = {};
    if (edit.send_at && edit.send_at !== paraCampo(orig.send_at, tz)) corpo.send_at = edit.send_at;
    if (edit.text !== orig.text) corpo.text = edit.text;
    if (!Object.keys(corpo).length) { marca(edit.id, true, 'Nada foi alterado.'); setEdit(null); return; }
    setOcupado(true);
    try {
      const r = await api('/scheduled-messages/' + edit.id, { method: 'PUT', body: corpo });
      setD((x) => ({ ...x, items: x.items.map((i) => (i.id === edit.id ? { ...i, send_at: r.send_at, text: r.text } : i)).sort((a, b) => new Date(a.send_at) - new Date(b.send_at)) }));
      marca(edit.id, true, 'Alterações salvas.'); setEdit(null);
    } catch (e) { marca(edit.id, false, e.message); }
    setOcupado(false);
  };

  const cancelar = async (id) => {
    setOcupado(true);
    try {
      await api(`/scheduled-messages/${id}/cancel`, { method: 'POST' });
      setCancelados((c) => new Set(c).add(id)); marca(id, true, 'Cancelado. Esta mensagem não será enviada.');
      if (edit?.id === id) setEdit(null);
    } catch (e) { marca(id, false, e.message); }
    setConfirmaId(null); setOcupado(false);
  };

  const cancelarMassa = async () => {
    setOcupado(true); setErroMassa('');
    const ids = s.ids;
    try {
      const r = await api('/scheduled-messages/bulk-cancel', { method: 'POST', body: { ids } });
      const feitos = new Set(r.ids || []);
      setCancelados((c) => new Set([...c, ...feitos]));
      setFb((f) => { const n = { ...f }; for (const id of ids) n[id] = feitos.has(id) ? { ok: true, texto: 'Cancelado. Esta mensagem não será enviada.' } : { ok: false, texto: 'Não foi cancelado: já foi enviado ou cancelado.' }; return n; });
      setResumo(`${r.cancelled} ${r.cancelled === 1 ? 'agendamento cancelado' : 'agendamentos cancelados'}` + (r.cancelled < ids.length ? `; ${ids.length - r.cancelled} já não estavam mais pendentes.` : '.'));
      s.limpar(); setMassa(null); if (edit && feitos.has(edit.id)) setEdit(null);
    } catch (e) { setErroMassa(e.message); }
    setOcupado(false);
  };

  return (
    <>
      <div className="row" style={{ justifyContent: 'space-between', alignItems: 'center', gap: 12, flexWrap: 'wrap', marginBottom: 8 }}>
        <p className="muted" style={{ margin: 0, flex: 1, minWidth: 240 }}>
          Mensagens que ainda vão ser enviadas: as que o assistente agendou e os lembretes pedidos por clientes. Você pode mudar a data e hora, o texto, ou cancelar.
        </p>
        <button className="btn sm" onClick={() => { setResumo(''); setMassa(null); setEdit(null); s.limpar(); carregar(); }}>Atualizar</button>
      </div>

      {erro && <div className="error">{erro}</div>}

      {s.count > 0 && (
        <div className="card row" style={{ marginBottom: 8, gap: 12, flexWrap: 'wrap', alignItems: 'center' }}>
          <strong>{s.count} de {ativos.length} selecionado(s)</strong>
          <button className="btn bad" onClick={() => { setErroMassa(''); setMassa({ txt: '' }); }}>Cancelar selecionados</button>
          <button className="btn" onClick={s.limpar}>Limpar seleção</button>
        </div>
      )}
      {resumo && s.count === 0 && <p style={{ color: 'var(--ok)', margin: '0 0 8px' }}>{resumo}</p>}

      <div className="card table-wrap">
        {!d ? <p className="muted" style={{ margin: 0 }}>Carregando…</p> : (
          <table>
            <thead>
              <tr><CelulaTodos s={s} /><th>Envio</th><th>Tipo</th><th>Para</th><th>Mensagem</th><th></th></tr>
            </thead>
            <tbody>
              {itens.map((x) => {
                const cancelado = cancelados.has(x.id), f = fb[x.id], editando = edit?.id === x.id;
                return (
                  <React.Fragment key={x.id}>
                    <tr style={cancelado ? { opacity: .55 } : undefined}>
                      {cancelado ? <td style={{ width: 34 }} /> : <CelulaLinha s={s} id={x.id} />}
                      <td style={{ whiteSpace: 'nowrap', textDecoration: cancelado ? 'line-through' : 'none' }}>{quando(x.send_at, tz)}</td>
                      <td><span style={etiqueta}>{TIPOS[x.tipo]}</span></td>
                      <td>{x.nome ? <><strong>{x.nome}</strong>{x.phone && <div className="muted">{fmtPhone(x.phone)}</div>}</> : (x.phone ? fmtPhone(x.phone) : <span className="muted">—</span>)}</td>
                      <td style={{ maxWidth: 380, whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>{x.text}</td>
                      <td style={{ whiteSpace: 'nowrap', textAlign: 'right' }}>
                        {!cancelado && (confirmaId === x.id ? (
                          <>
                            <span className="muted" style={{ marginRight: 6 }}>Cancelar este envio?</span>
                            <button className="btn sm bad" disabled={ocupado} onClick={() => cancelar(x.id)}>Sim, cancelar</button>{' '}
                            <button className="btn sm" disabled={ocupado} onClick={() => setConfirmaId(null)}>Voltar</button>
                          </>
                        ) : (
                          <>
                            <button className="btn sm" disabled={ocupado} onClick={() => { setConfirmaId(null); setEdit(editando ? null : { id: x.id, send_at: paraCampo(x.send_at, tz), text: x.text }); }}>{editando ? 'Fechar' : 'Editar'}</button>{' '}
                            <button className="btn sm" disabled={ocupado} onClick={() => { setEdit(null); setConfirmaId(x.id); }}>Cancelar envio</button>
                          </>
                        ))}
                      </td>
                    </tr>
                    {editando && (
                      <tr>
                        <td colSpan="6" style={{ background: 'var(--bg)' }}>
                          <div className="row" style={{ gap: 12, flexWrap: 'wrap', alignItems: 'flex-start' }}>
                            <div className="field" style={{ margin: 0, minWidth: 210, flex: '0 0 auto' }}>
                              <label>Data e hora do envio</label>
                              <input type="datetime-local" value={edit.send_at} onChange={(e) => setEdit({ ...edit, send_at: e.target.value })} />
                            </div>
                            <div className="field" style={{ margin: 0, minWidth: 260 }}>
                              <label>Mensagem <span className="muted">({edit.text.length}/{d.max})</span></label>
                              <textarea rows="4" maxLength={d.max} value={edit.text} onChange={(e) => setEdit({ ...edit, text: e.target.value })} />
                            </div>
                          </div>
                          <div className="row" style={{ gap: 8, marginTop: 8, alignItems: 'center', flexWrap: 'wrap' }}>
                            <button className="btn primary sm" disabled={ocupado || !edit.send_at || !edit.text.trim()} onClick={salvar}>{ocupado ? 'Salvando…' : 'Salvar'}</button>
                            <button className="btn sm" disabled={ocupado} onClick={() => setEdit(null)}>Fechar sem salvar</button>
                            {f && !f.ok && <span className="error" style={{ margin: 0 }}>{f.texto}</span>}
                          </div>
                        </td>
                      </tr>
                    )}
                    {f && !editando && (
                      <tr>
                        <td colSpan="6" style={{ paddingTop: 0, borderTop: 'none' }}>
                          {f.ok ? <span style={{ color: 'var(--ok)', fontSize: 13 }}>{f.texto}</span> : <span className="error" style={{ margin: 0, display: 'inline-block' }}>{f.texto}</span>}
                        </td>
                      </tr>
                    )}
                  </React.Fragment>
                );
              })}
              {!itens.length && <tr><td colSpan="6" className="muted">{erro ? 'Não foi possível carregar a lista agora.' : 'Nenhuma mensagem agendada no momento.'}</td></tr>}
            </tbody>
          </table>
        )}
      </div>

      {massa && (
        <div className="modal-bg" onClick={() => !ocupado && setMassa(null)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <h2>Cancelar {s.count} {s.count === 1 ? 'agendamento' : 'agendamentos'}?</h2>
            <p>As mensagens selecionadas não serão enviadas. Para confirmar, digite <strong>X</strong> abaixo:</p>
            <input value={massa.txt} onChange={(e) => setMassa({ txt: e.target.value })} autoFocus placeholder="X" style={{ marginBottom: 10 }} />
            {erroMassa && <div className="error">{erroMassa}</div>}
            <div className="row">
              <button className="btn bad" disabled={massa.txt.trim().toUpperCase() !== 'X' || ocupado} onClick={cancelarMassa}>{ocupado ? 'Cancelando…' : `Cancelar ${s.count}`}</button>
              <button className="btn" disabled={ocupado} onClick={() => setMassa(null)}>Voltar</button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
