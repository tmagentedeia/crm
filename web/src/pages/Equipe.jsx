import React, { useEffect, useState } from 'react';
import { api } from '../api.js';

// Equipe e acessos: o administrador da empresa cria funções (conjuntos de telas) e dá uma a cada pessoa.
export default function Equipe({ menu = [] }) {
  const [d, setD] = useState(null);
  const [aba, setAba] = useState('pessoas');
  const [erro, setErro] = useState('');
  const carregar = () => api('/equipe').then(setD).catch((e) => setErro(e.message));
  useEffect(() => { carregar(); }, []);
  const NIVEIS = { lista_evento: 'Lista do evento · só consulta', lista_evento_comentarista: 'Lista do evento · comentarista (marca entrada e comenta)', lista_evento_editor: 'Lista do evento · editor (edita tudo)', lista_evento_telefone: 'Lista do evento · pode ver os telefones' };
  const rotulo = (id) => NIVEIS[id] || menu.find((m) => m.id === id)?.label || id;
  // só entram telas dos módulos que a empresa tem ligados (os três níveis da lista seguem a tela "Lista do evento")
  const disponiveis = d ? d.telas.filter((t) => menu.some((m) => m.id === t) || (NIVEIS[t] && menu.some((m) => m.id === 'lista_evento'))) : [];
  if (erro && !d) return <p className="muted">{erro}</p>;
  if (!d) return <p className="muted">Carregando…</p>;
  return (
    <>
      <div style={{ marginBottom: 12 }}>
        <h1>Equipe e acessos</h1>
        <p className="muted">Crie as funções da sua equipe (por exemplo, caixa ou garçom) e escolha o que cada uma pode abrir. Cada pessoa entra com o próprio e-mail e senha.</p>
      </div>
      <div className="row" style={{ gap: 6, marginBottom: 12 }}>
        <button className={'btn sm' + (aba === 'pessoas' ? ' primary' : '')} onClick={() => setAba('pessoas')}>Pessoas</button>
        <button className={'btn sm' + (aba === 'funcoes' ? ' primary' : '')} onClick={() => setAba('funcoes')}>Funções</button>
      </div>
      {erro && <p className="error">{erro}</p>}
      {aba === 'pessoas' && <Pessoas d={d} recarregar={carregar} setErro={setErro} disponiveis={disponiveis} rotulo={rotulo} />}
      {aba === 'funcoes' && <Funcoes d={d} recarregar={carregar} setErro={setErro} disponiveis={disponiveis} rotulo={rotulo} />}
    </>
  );
}

function Telas({ valor, onChange, disponiveis, rotulo }) {
  const alterna = (t) => onChange(valor.includes(t) ? valor.filter((x) => x !== t) : [...valor, t]);
  return (
    <div style={{ display: 'flex', flexWrap: 'wrap', gap: '6px 16px' }}>
      {disponiveis.map((t) => (
        <label key={t} style={{ display: 'flex', alignItems: 'center', gap: 6, fontWeight: 400 }}>
          <input type="checkbox" style={{ width: 'auto' }} checked={valor.includes(t)} onChange={() => alterna(t)} /> {rotulo(t)}
        </label>
      ))}
    </div>
  );
}

function Pessoas({ d, recarregar, setErro, disponiveis, rotulo }) {
  const vazio = { name: '', email: '', password: '', funcao_id: d.funcoes[0]?.id || '' };
  const [novo, setNovo] = useState(null);
  const [edit, setEdit] = useState(null);
  const run = async (fn) => { setErro(''); try { await fn(); await recarregar(); return true; } catch (e) { setErro(e.message); return false; } };
  const nomeFuncao = (id) => d.funcoes.find((f) => String(f.id) === String(id))?.name || 'Sem função';
  return (
    <>
      <div style={{ marginBottom: 12 }}>
        <button className="btn primary sm" onClick={() => setNovo(novo ? null : vazio)}>{novo ? 'Cancelar' : '+ Nova pessoa'}</button>
      </div>
      {novo && (
        <form className="card" style={{ marginBottom: 12 }} onSubmit={async (e) => { e.preventDefault(); if (await run(() => api('/equipe/usuarios', { method: 'POST', body: novo }))) setNovo(null); }}>
          <div className="grid2">
            <label>Nome<input value={novo.name} onChange={(e) => setNovo({ ...novo, name: e.target.value })} required /></label>
            <label>E-mail<input type="email" value={novo.email} onChange={(e) => setNovo({ ...novo, email: e.target.value })} required /></label>
            <label>Senha (8 ou mais caracteres)<input type="password" value={novo.password} onChange={(e) => setNovo({ ...novo, password: e.target.value })} minLength={8} required autoComplete="new-password" /></label>
            <label>Função
              <select value={novo.funcao_id} onChange={(e) => setNovo({ ...novo, funcao_id: e.target.value })}>
                {d.funcoes.map((f) => <option key={f.id} value={f.id}>{f.name}</option>)}
              </select>
            </label>
          </div>
          <button className="btn primary" style={{ marginTop: 10 }}>Criar acesso</button>
        </form>
      )}
      <div className="card">
        {d.usuarios.map((u) => (
          <div key={u.id} style={{ padding: '10px 0', borderBottom: '1px solid var(--border)' }}>
            <div className="row" style={{ justifyContent: 'space-between', gap: 8, flexWrap: 'wrap' }}>
              <div>
                <strong>{u.name}</strong> <span className="muted">· {u.email}</span>
                <div className="muted" style={{ fontSize: 13 }}>
                  {u.role === 'owner' ? 'Administrador da empresa (acesso total)' : nomeFuncao(u.funcao_id) + (u.telas_proprias ? ' · acesso personalizado' : '') + (u.active ? '' : ' · desativado')}
                </div>
              </div>
              {u.role !== 'owner' && (
                <div className="row" style={{ gap: 6 }}>
                  <button className="btn sm" onClick={() => setEdit(edit?.id === u.id ? null : { ...u, password: '', personalizar: !!u.telas_proprias, telas: u.telas_proprias || d.funcoes.find((f) => f.id === u.funcao_id)?.telas || [] })}>Editar</button>
                  <button className="btn sm" onClick={() => run(() => api('/equipe/usuarios/' + u.id, { method: 'PUT', body: { active: !u.active } }))}>{u.active ? 'Desativar' : 'Reativar'}</button>
                </div>
              )}
            </div>
            {edit?.id === u.id && (
              <div style={{ marginTop: 10 }}>
                <div className="grid2">
                  <label>Nome<input value={edit.name} onChange={(e) => setEdit({ ...edit, name: e.target.value })} /></label>
                  <label>E-mail<input value={edit.email} onChange={(e) => setEdit({ ...edit, email: e.target.value })} /></label>
                  <label>Função
                    <select value={edit.funcao_id || ''} onChange={(e) => setEdit({ ...edit, funcao_id: e.target.value })}>
                      {d.funcoes.map((f) => <option key={f.id} value={f.id}>{f.name}</option>)}
                    </select>
                  </label>
                  <label>Nova senha (deixe vazio para manter)<input type="password" value={edit.password} onChange={(e) => setEdit({ ...edit, password: e.target.value })} autoComplete="new-password" /></label>
                </div>
                <label style={{ display: 'flex', alignItems: 'center', gap: 6, margin: '10px 0 6px', fontWeight: 400 }}>
                  <input type="checkbox" style={{ width: 'auto' }} checked={edit.personalizar} onChange={(e) => setEdit({ ...edit, personalizar: e.target.checked })} />
                  Escolher as telas só para esta pessoa (em vez de usar as da função)
                </label>
                {edit.personalizar && <Telas valor={edit.telas} onChange={(telas) => setEdit({ ...edit, telas })} disponiveis={disponiveis} rotulo={rotulo} />}
                <div className="row" style={{ gap: 6, marginTop: 10 }}>
                  <button className="btn primary sm" onClick={async () => {
                    const body = { name: edit.name, email: edit.email, funcao_id: edit.funcao_id || null, telas_proprias: edit.personalizar ? edit.telas : null };
                    if (edit.password) body.password = edit.password;
                    if (await run(() => api('/equipe/usuarios/' + u.id, { method: 'PUT', body }))) setEdit(null);
                  }}>Salvar</button>
                  <button className="btn sm danger" onClick={async () => { if (confirm('Apagar o acesso de ' + u.name + '?') && await run(() => api('/equipe/usuarios/' + u.id, { method: 'DELETE' }))) setEdit(null); }}>Apagar acesso</button>
                </div>
              </div>
            )}
          </div>
        ))}
      </div>
    </>
  );
}

function Funcoes({ d, recarregar, setErro, disponiveis, rotulo }) {
  const [f, setF] = useState(null);
  const run = async (fn) => { setErro(''); try { await fn(); await recarregar(); return true; } catch (e) { setErro(e.message); return false; } };
  const salvar = async () => {
    const body = { name: f.name, telas: f.telas, inicio: f.inicio || null };
    if (await run(() => f.id ? api('/equipe/funcoes/' + f.id, { method: 'PUT', body }) : api('/equipe/funcoes', { method: 'POST', body }))) setF(null);
  };
  return (
    <>
      <div style={{ marginBottom: 12 }}><button className="btn primary sm" onClick={() => setF(f ? null : { name: '', telas: [], inicio: '' })}>{f ? 'Cancelar' : '+ Nova função'}</button></div>
      {f && (
        <div className="card" style={{ marginBottom: 12 }}>
          <label>Nome da função<input value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} maxLength={40} /></label>
          <p className="muted" style={{ margin: '10px 0 6px' }}>Telas que esta função pode abrir</p>
          <Telas valor={f.telas} onChange={(telas) => setF({ ...f, telas, inicio: telas.includes(f.inicio) ? f.inicio : '' })} disponiveis={disponiveis} rotulo={rotulo} />
          <label style={{ marginTop: 10 }}>Tela que abre ao entrar
            <select value={f.inicio || ''} onChange={(e) => setF({ ...f, inicio: e.target.value })}>
              <option value="">A primeira da lista</option>
              {f.telas.map((t) => <option key={t} value={t}>{rotulo(t)}</option>)}
            </select>
          </label>
          <button className="btn primary" style={{ marginTop: 10 }} onClick={salvar}>Salvar função</button>
        </div>
      )}
      <div className="card">
        {d.funcoes.map((x) => (
          <div key={x.id} className="row" style={{ justifyContent: 'space-between', gap: 8, padding: '10px 0', borderBottom: '1px solid var(--border)', flexWrap: 'wrap' }}>
            <div>
              <strong>{x.name}</strong>
              <div className="muted" style={{ fontSize: 13 }}>{x.telas.length ? x.telas.map(rotulo).join(', ') : 'Nenhuma tela'}</div>
            </div>
            <div className="row" style={{ gap: 6 }}>
              <button className="btn sm" onClick={() => setF({ ...x })}>Editar</button>
              <button className="btn sm danger" onClick={() => confirm('Apagar a função ' + x.name + '?') && run(() => api('/equipe/funcoes/' + x.id, { method: 'DELETE' }))}>Apagar</button>
            </div>
          </div>
        ))}
      </div>
    </>
  );
}
