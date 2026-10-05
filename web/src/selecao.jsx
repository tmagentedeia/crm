import React, { useEffect, useState } from 'react';
import { api } from './api.js';

// Seleção de itens numa lista + exclusão em massa com confirmação forte (é preciso digitar X).

export function useSelecao(rows) {
  const [sel, setSel] = useState(() => new Set());
  // se a lista mudar, esquece o que não existe mais
  useEffect(() => {
    const ids = new Set(rows.map((r) => r.id));
    setSel((prev) => { const n = new Set([...prev].filter((i) => ids.has(i))); return n.size === prev.size ? prev : n; });
  }, [rows]);
  return {
    count: sel.size,
    ids: [...sel],
    has: (id) => sel.has(id),
    toggle: (id) => setSel((p) => { const n = new Set(p); n.has(id) ? n.delete(id) : n.add(id); return n; }),
    todos: rows.length > 0 && rows.every((r) => sel.has(r.id)),
    alternarTodos: () => setSel((p) => (rows.length > 0 && rows.every((r) => p.has(r.id)) ? new Set() : new Set(rows.map((r) => r.id)))),
    limpar: () => setSel(new Set()),
  };
}

const caixa = { width: 'auto', margin: 0, cursor: 'pointer' };
// cabeçalho da coluna de caixinhas: marca/desmarca todos
export const CelulaTodos = ({ s }) => (
  <th style={{ width: 34 }}><input type="checkbox" style={caixa} checked={s.todos} onChange={s.alternarTodos} title="Selecionar todos" aria-label="Selecionar todos" /></th>
);
export const CelulaLinha = ({ s, id }) => (
  <td style={{ width: 34 }} onClick={(e) => e.stopPropagation()}>
    <input type="checkbox" style={caixa} checked={s.has(id)} onChange={() => s.toggle(id)} aria-label="Selecionar" />
  </td>
);

// Barra que aparece quando há itens selecionados + janela de confirmação.
//  rota: endereço da exclusão em massa (aceita { ids, dry_run } e devolve o que seria afetado)
//  descreve(info): texto sobre o que vai ser apagado junto
//  opcao: { chave, texto, mostrarSe(info) } caixinha extra (ex.: apagar também o histórico)
//  onDone(resultado): chamado depois de apagar
export function ApagarSelecionados({ s, total, rotulo, rota, descreve, opcao, onDone }) {
  const [info, setInfo] = useState(null);
  const [txt, setTxt] = useState('');
  const [extra, setExtra] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  if (s.count === 0) return null;

  const abrir = async () => {
    setErr(''); setTxt(''); setExtra(false);
    try { setInfo(await api(rota, { method: 'POST', body: { ids: s.ids, dry_run: true } })); } catch (e) { setErr(e.message); }
  };
  const apagar = async () => {
    setBusy(true); setErr('');
    try {
      const r = await api(rota, { method: 'POST', body: { ids: s.ids, ...(opcao ? { [opcao.chave]: extra } : {}) } });
      setInfo(null); s.limpar(); onDone?.(r);
    } catch (e) { setErr(e.message); }
    setBusy(false);
  };
  const pronto = txt.trim().toUpperCase() === 'X';
  return (
    <>
      <div className="card row" style={{ marginBottom: 8, gap: 12, flexWrap: 'wrap', alignItems: 'center' }}>
        <strong>{s.count} de {total} {rotulo} selecionado(s)</strong>
        <button className="btn bad" onClick={abrir}>Apagar selecionados</button>
        <button className="btn" onClick={s.limpar}>Limpar seleção</button>
        {err && !info && <span className="error" style={{ margin: 0 }}>{err}</span>}
      </div>
      {info && (
        <div className="modal-bg" onClick={() => !busy && setInfo(null)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <h2>Apagar {s.count} {rotulo}?</h2>
            {descreve && <div style={{ marginBottom: 10 }}>{descreve(info)}</div>}
            {opcao && opcao.mostrarSe(info) && (
              <label className="row" style={{ gap: 8, marginBottom: 10, alignItems: 'flex-start' }}>
                <input type="checkbox" style={{ ...caixa, marginTop: 3 }} checked={extra} onChange={(e) => setExtra(e.target.checked)} />
                <span>{opcao.texto}</span>
              </label>
            )}
            <p><strong>Isso é definitivo e não dá para desfazer.</strong> Para confirmar, digite <strong>X</strong> abaixo:</p>
            <input value={txt} onChange={(e) => setTxt(e.target.value)} autoFocus placeholder="X" style={{ marginBottom: 10 }} />
            {err && <div className="error">{err}</div>}
            <div className="row">
              <button className="btn bad" disabled={!pronto || busy} onClick={apagar}>{busy ? 'Apagando…' : `Apagar ${s.count} definitivamente`}</button>
              <button className="btn" disabled={busy} onClick={() => setInfo(null)}>Cancelar</button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}

// resumo curto do resultado de uma exclusão em massa, para mostrar na tela
export function resumoApagado(r, rotulo) {
  if (!r) return '';
  const n = r.deleted ?? 0;
  const pulados = r.skipped?.length || 0;
  return `${n} ${rotulo} apagado(s).` + (pulados ? ` ${pulados} não ${pulados === 1 ? 'foi apagado' : 'foram apagados'}: ${r.skipped.slice(0, 5).map((x) => `${x.name || x.id} (${x.motivo})`).join(', ')}${pulados > 5 ? '…' : ''}.` : '');
}
