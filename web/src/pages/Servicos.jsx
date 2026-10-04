import ImportarAqui from '../ImportarAqui.jsx';
import React, { useEffect, useState } from 'react';
import { Nome } from '../menu.jsx';
import { api, money } from '../api.js';
import VendasProdutos from './VendasProdutos.jsx';
import { useSelecao, CelulaTodos, CelulaLinha, ApagarSelecionados, resumoApagado } from '../selecao.jsx';

// Catálogo e vendas de produtos na mesma tela. A aba de vendas só aparece quando há produto cadastrado ou venda feita.
export default function Servicos() {
  const [aba, setAba] = useState('catalogo');
  const [tem, setTem] = useState(false);
  const checa = () => Promise.all([api('/services?kind=product'), api('/product-sales')]).then(([p, v]) => setTem(p.length > 0 || v.rows.length > 0)).catch(() => {});
  useEffect(() => { checa(); }, []);
  const abas = tem ? (
    <div className="row" style={{ marginBottom: 12 }}>
      {[['catalogo', 'Catálogo'], ['vendas', 'Vendas de produtos']].map(([v, l]) => (
        <button key={v} className={'btn' + (aba === v ? ' primary' : '')} onClick={() => setAba(v)}>{l}</button>
      ))}
    </div>
  ) : null;
  if (aba === 'vendas' && tem) {
    return (
      <>
        <div style={{ marginBottom: 16 }}><h1><Nome id="servicos">Produtos e Serviços</Nome></h1><p className="muted">Vendas de produtos: base da comissão dos profissionais.</p></div>
        {abas}
        <VendasProdutos onMudou={checa} />
      </>
    );
  }
  return <Catalogo abas={abas} onMudou={checa} />;
}

function Catalogo({ abas, onMudou }) {
  const [list, setList] = useState([]);
  const [edit, setEdit] = useState(null);
  const [err, setErr] = useState('');
  const [cats, setCats] = useState([]);
  const [catEdit, setCatEdit] = useState(null);
    const [aviso, setAviso] = useState('');
  const [filtro, setFiltro] = useState('all');
  const vistos = list.filter((x) => filtro === 'all' || x.kind === filtro);
  const sel = useSelecao(vistos);
  const load = () => Promise.all([api('/services?kind=all'), api('/categories')]).then(([sv, c]) => { setList(sv); setCats(c); onMudou?.(); });
  useEffect(() => { load(); }, []);

  async function save(e) {
    e.preventDefault(); setErr('');
    try {
      const produto = edit.kind === 'product';
      const body = { name: edit.name, price: Number(edit.price), duration_min: produto ? 30 : Number(edit.duration_min), category_id: !produto && edit.category_id ? Number(edit.category_id) : null };
      if (!edit.id) body.kind = edit.kind || 'service';
      if (edit.id) await api('/services/' + edit.id, { method: 'PUT', body });
      else await api('/services', { method: 'POST', body });
      setEdit(null); load();
    } catch (e2) { setErr(e2.message); }
  }
  async function saveCat(e) {
    e.preventDefault(); setErr('');
    try {
      if (catEdit.id) await api('/categories/' + catEdit.id, { method: 'PUT', body: { name: catEdit.name } });
      else await api('/categories', { method: 'POST', body: { name: catEdit.name } });
      setCatEdit(null); load();
    } catch (e2) { setErr(e2.message); }
  }
  async function delCat(c) {
    if (!confirm(`Apagar a categoria "${c.name}"? Os serviços dela ficam sem categoria.`)) return;
    await api('/categories/' + c.id, { method: 'DELETE' }); load();
  }
  const excluir = async (s) => {
    if (!confirm(`Excluir ${s.kind === 'product' ? 'o produto' : 'o serviço'} "${s.name}" de vez? Não dá para desfazer.`)) return;
    try { await api('/services/' + s.id + '/permanent', { method: 'DELETE' }); load(); } catch (e) {
      if (!e.data?.tem_historico) return alert(e.message);
      if (!confirm(`"${s.name}" tem agendamentos no histórico.\n\nExcluir mesmo assim APAGA também todos esses agendamentos, de forma definitiva.\n\nQuer apagar o serviço e o histórico dele?`)) return;
      try { await api('/services/' + s.id + '/permanent?com_historico=1', { method: 'DELETE' }); load(); } catch (e2) { alert(e2.message); }
    }
  };
  const toggle = (s) => api('/services/' + s.id, { method: 'PUT', body: { active: !s.active } }).then(load);

  return (
    <>
      <div className="row" style={{ justifyContent: 'space-between', marginBottom: 16 }}>
        <div><h1><Nome id="servicos">Produtos e Serviços</Nome></h1><p className="muted">Alterações valem na hora para o agente de IA. A agenda oferece só os serviços; os produtos servem para as vendas.</p></div>
        <div className="row">
          <ImportarAqui tipo="services" onFeito={load} />
          <button className="btn" onClick={() => { setErr(''); setCatEdit({ name: '' }); }}>+ Nova categoria</button>
          <button className="btn" onClick={() => { setErr(''); setEdit({ kind: 'product', name: '', price: '', duration_min: 30, category_id: '' }); }}>+ Novo produto</button>
          <button className="btn primary" onClick={() => { setErr(''); setEdit({ kind: 'service', name: '', price: '', duration_min: 30, category_id: '' }); }}>+ Novo serviço</button>
        </div>
      </div>
      {abas}
      <div className="card" style={{ marginBottom: 16 }}>
        <strong>Categorias</strong>
        <div className="row" style={{ flexWrap: 'wrap', gap: 8, marginTop: 8 }}>
          {cats.map((c) => (
            <span key={c.id} className="row" style={{ gap: 6, border: '1px solid var(--border, #ddd)', borderRadius: 999, padding: '4px 10px' }}>
              {c.name}
              <button className="btn sm" onClick={() => { setErr(''); setCatEdit(c); }}>Editar</button>
              <button className="btn sm" onClick={() => delCat(c)}>Apagar</button>
            </span>
          ))}
          {!cats.length && <span className="muted">Nenhuma categoria. Crie uma (ex.: Cabelo, Manicure) para organizar os serviços.</span>}
        </div>
      </div>
      <div className="row" style={{ marginBottom: 8 }}>
        {[['all', 'Todos'], ['service', 'Serviços'], ['product', 'Produtos']].map(([v, l]) => (
          <button key={v} className={'btn sm' + (filtro === v ? ' primary' : '')} onClick={() => setFiltro(v)}>{l}</button>
        ))}
      </div>
      {aviso && <p className="muted" style={{ marginBottom: 8 }}>{aviso}</p>}
      <ApagarSelecionados s={sel} total={vistos.length} rotulo="item(ns)" rota="/services/bulk-delete" onDone={(r) => { setAviso(resumoApagado(r, 'item(ns)')); load(); }}
        descreve={(i) => i.com_historico > 0 ? <p>{i.com_historico} deles têm {i.agendamentos} agendamento(s) no histórico. Sem marcar a opção abaixo, esses serviços são mantidos.</p> : <p>Nenhum deles tem agendamentos no histórico.</p>}
        opcao={{ chave: 'com_historico', texto: 'Apagar também os agendamentos desses serviços (definitivo)', mostrarSe: (i) => i.com_historico > 0 }} />
      <div className="card table-wrap">
        <table>
          <thead><tr><CelulaTodos s={sel} /><th>Nome</th><th>Tipo</th><th>Categoria</th><th>Preço</th><th>Duração</th><th>Status</th><th></th></tr></thead>
          <tbody>
            {vistos.map((s) => (
              <tr key={s.id} style={{ opacity: s.active ? 1 : 0.5 }}>
                <CelulaLinha s={sel} id={s.id} />
                <td>{s.name}</td><td>{s.kind === 'product' ? 'Produto' : 'Serviço'}</td><td>{s.category || <span className="muted">—</span>}</td><td>{money(s.price)}</td><td>{s.kind === 'product' ? <span className="muted">—</span> : s.duration_min + ' min'}</td>
                <td>{s.active ? 'Ativo' : 'Inativo'}</td>
                <td style={{ textAlign: 'right' }}>
                  <button className="btn sm" onClick={() => setEdit(s)}>Editar</button>{' '}
                  <button className="btn sm" onClick={() => toggle(s)}>{s.active ? 'Desativar' : 'Ativar'}</button>{' '}
                  <button className="btn sm" onClick={() => excluir(s)}>Excluir</button>
                </td>
              </tr>
            ))}
            {!vistos.length && <tr><td colSpan="8" className="muted">Nada cadastrado aqui ainda.</td></tr>}
          </tbody>
        </table>
      </div>
      {catEdit && (
        <div className="modal-bg" onClick={() => setCatEdit(null)}>
          <form className="modal" onClick={(e) => e.stopPropagation()} onSubmit={saveCat}>
            <h2>{catEdit.id ? 'Editar categoria' : 'Nova categoria'}</h2>
            {err && <div className="error">{err}</div>}
            <div className="field"><label>Nome</label><input value={catEdit.name} onChange={(e) => setCatEdit({ ...catEdit, name: e.target.value })} placeholder="ex.: Cabelo, Manicure, Barba" required autoFocus /></div>
            <div className="row"><button className="btn primary">Salvar</button><button type="button" className="btn" onClick={() => setCatEdit(null)}>Cancelar</button></div>
          </form>
        </div>
      )}
      {edit && (
        <div className="modal-bg" onClick={() => setEdit(null)}>
          <form className="modal" onClick={(e) => e.stopPropagation()} onSubmit={save}>
            <h2>{edit.id ? (edit.kind === 'product' ? 'Editar produto' : 'Editar serviço') : (edit.kind === 'product' ? 'Novo produto' : 'Novo serviço')}</h2>
            {err && <div className="error">{err}</div>}
            <div className="field"><label>Nome</label><input value={edit.name} onChange={(e) => setEdit({ ...edit, name: e.target.value })} required /></div>
            {edit.kind !== 'product' && <div className="field"><label>Categoria (opcional)</label>
              <select value={edit.category_id || ''} onChange={(e) => setEdit({ ...edit, category_id: e.target.value })}>
                <option value="">Sem categoria</option>
                {cats.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
              </select></div>}
            <div className="row">
              <div className="field"><label>Preço (R$)</label><input type="number" step="0.01" min="0" value={edit.price} onChange={(e) => setEdit({ ...edit, price: e.target.value })} required /></div>
              {edit.kind !== 'product' && <div className="field"><label>Duração (min)</label><input type="number" min="5" step="5" value={edit.duration_min} onChange={(e) => setEdit({ ...edit, duration_min: e.target.value })} required /></div>}
            </div>
            <div className="row"><button className="btn primary">Salvar</button><button type="button" className="btn" onClick={() => setEdit(null)}>Cancelar</button></div>
          </form>
        </div>
      )}
    </>
  );
}
