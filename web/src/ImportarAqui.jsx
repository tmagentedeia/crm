import React, { useState } from 'react';
import * as XLSX from 'xlsx';
import { api } from './api.js';

// Importar planilha dentro de cada área (clientes, serviços, profissionais, cardápio). Reimportar atualiza quem já existe, sem duplicar.
const TIPOS = {
  customers: {
    nome: 'clientes', arquivo: 'modelo-clientes.xlsx', aviso: 'Telefone com DDD. Quem já existe (mesmo telefone) é atualizado.',
    exemplo: [{ Nome: 'Ana', Sobrenome: 'Souza', Telefone: '(32) 98888-7777', 'Data de nascimento': '25/09/1990', Cidade: 'Juiz de Fora - MG', Observações: '' }],
  },
  services: {
    nome: 'produtos e serviços', arquivo: 'modelo-servicos.xlsx', aviso: 'Tipo é Serviço ou Produto. A duração só vale para serviço.',
    exemplo: [
      { Serviço: 'Corte feminino', Tipo: 'Serviço', Categoria: 'Cabelo', Preço: 80, 'Duração (min)': 45 },
      { Serviço: 'Shampoo hidratante', Tipo: 'Produto', Categoria: '', Preço: 45, 'Duração (min)': '' },
    ],
  },
  professionals: {
    nome: 'profissionais', arquivo: 'modelo-profissionais.xlsx', aviso: 'Categorias e serviços separados por vírgula; dias como "Seg-Sáb".',
    exemplo: [{ Nome: 'Mariana', Telefone: '(32) 99999-0000', Categorias: 'Cabelo, Manicure', Serviços: 'Corte feminino, Escova', Dias: 'Seg-Sáb', Horário: '09:00-18:00', Pausa: '12:00-13:00', 'ID Google Agenda': '' }],
  },
  menu: {
    nome: 'itens do cardápio', arquivo: 'modelo-cardapio.xlsx', aviso: 'Local de preparo: Cozinha, Bar ou Sai direto. Categorias novas são criadas sozinhas.',
    exemplo: [
      { Categoria: 'Pratos', Item: 'Filé com fritas', Descrição: 'Acompanha arroz', Preço: 48.9, 'Local de preparo': 'Cozinha', Esgotado: '' },
      { Categoria: 'Bebidas', Item: 'Refrigerante lata', Descrição: '', Preço: 7, 'Local de preparo': 'Bar', Esgotado: '' },
    ],
  },
  shows_sectors: {
    nome: 'setores', arquivo: 'modelo-setores.xlsx', chave: 'sectors', aviso: 'Informe a capacidade em pessoas, ou então quantas mesas e quantos lugares por mesa (a capacidade sai da conta). O setor aceita todas as mesas.',
    exemplo: [{ Setor: 'Setor 1', Capacidade: 24, Observações: '' }, { Setor: 'Setor 2', Mesas: 6, 'Lugares por mesa': 4, Observações: 'Perto do palco' }],
  },
  shows_tables: {
    nome: 'mesas', arquivo: 'modelo-mesas.xlsx', chave: 'tables', aviso: 'Cada lugar ocupa um ponto do setor. A coluna Pontos é opcional: vazia, vale o número de lugares.',
    exemplo: [{ Mesa: 'Mesa de 2', Lugares: 2, Pontos: '' }, { Mesa: 'Mesa de 4', Lugares: 4, Pontos: '' }, { Mesa: 'Mesa de 10', Lugares: 10, Pontos: '' }],
  },
};
const toRows = (ws) => XLSX.utils.sheet_to_json(ws, { defval: '', raw: false });

export default function ImportarAqui({ tipo, onFeito }) {
  const T = TIPOS[tipo];
  const [aberto, setAberto] = useState(false);
  const [rows, setRows] = useState([]);
  const [paste, setPaste] = useState('');
  const [rep, setRep] = useState(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const fechar = () => { setAberto(false); setRows([]); setPaste(''); setRep(null); setErr(''); };

  const modelo = () => {
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(T.exemplo), 'Modelo');
    XLSX.writeFile(wb, T.arquivo);
  };
  async function aoEscolher(e) {
    const f = e.target.files[0]; e.target.value = '';
    if (!f) return;
    setErr(''); setRep(null);
    try {
      const wb = XLSX.read(await f.arrayBuffer(), { type: 'array' });
      const r = toRows(wb.Sheets[wb.SheetNames[0]]);
      if (!r.length) throw new Error('O arquivo está vazio.');
      setRows(r);
    } catch (e2) { setErr(e2.message); }
  }
  function usarColado() {
    setErr(''); setRep(null);
    try {
      const wb = XLSX.read(paste.trim(), { type: 'string', FS: paste.includes('\t') ? '\t' : undefined });
      const r = toRows(wb.Sheets[wb.SheetNames[0]]);
      if (!r.length) throw new Error('Cole também a linha com os nomes das colunas e ao menos uma linha de dados.');
      setRows(r); setPaste('');
    } catch (e2) { setErr(e2.message); }
  }
  async function rodar(dry) {
    setBusy(true); setErr('');
    try {
      const r = T.chave
        ? await api('/casa-de-shows/import', { method: 'POST', body: { [T.chave]: rows, dry_run: dry } })
        : tipo === 'menu'
        ? await api('/delivery/import', { method: 'POST', body: { rows, dry_run: dry } })
        : await api('/import', { method: 'POST', body: { [tipo]: rows, dry_run: dry } });
      setRep(r);
      if (!dry) { setRows([]); onFeito?.(); }
    } catch (e2) { setErr(e2.message); }
    setBusy(false);
  }
  const resumo = rep && (T.chave
    ? `${rep[T.chave].created} novos, ${rep[T.chave].updated} atualizados`
    : tipo === 'menu'
    ? `${rep.items.created} novos, ${rep.items.updated} atualizados${rep.categories.created ? ` · ${rep.categories.created} categorias novas` : ''}`
    : `${rep[tipo].created} novos, ${rep[tipo].updated} atualizados${tipo === 'services' && rep.categories?.created ? ` · ${rep.categories.created} categorias novas` : ''}`);

  return (
    <>
      <button className="btn" onClick={() => setAberto(true)}>Importar planilha</button>
      {aberto && (
        <div className="modal-bg" onClick={fechar}>
          <div className="modal" onClick={(e) => e.stopPropagation()} style={{ maxWidth: 560, maxHeight: '92vh', overflow: 'auto' }}>
            <div className="row" style={{ justifyContent: 'space-between' }}><h3 style={{ margin: 0 }}>Importar {T.nome}</h3><button className="btn sm" onClick={fechar}>Fechar</button></div>
            <p className="muted">{T.aviso} Reimportar não duplica.</p>
            <p><button className="btn sm" onClick={modelo}>Baixar modelo (.xlsx)</button></p>
            <div className="field"><label>Envie o arquivo (.xlsx, .xls ou .csv)</label><input type="file" accept=".xlsx,.xls,.csv" onChange={aoEscolher} /></div>
            <div className="field">
              <label>Ou cole aqui (copie da planilha, com a linha de cabeçalho)</label>
              <textarea rows="4" value={paste} onChange={(e) => setPaste(e.target.value)} />
              <button className="btn sm" style={{ marginTop: 6 }} onClick={usarColado} disabled={!paste.trim()}>Usar o que colei</button>
            </div>
            {err && <div className="error">{err}</div>}
            {rows.length > 0 && <p><strong>{rows.length}</strong> linha(s) prontas. <button className="btn sm" onClick={() => { setRows([]); setRep(null); }}>Limpar</button></p>}
            <div className="row" style={{ gap: 8 }}>
              <button className="btn" disabled={!rows.length || busy} onClick={() => rodar(true)}>Conferir (não grava)</button>
              <button className="btn primary" disabled={!rows.length || busy || !rep?.dry_run} onClick={() => rodar(false)}>Importar de verdade</button>
            </div>
            {rep && (
              <div style={{ marginTop: 12 }}>
                <p><strong>{rep.dry_run ? 'Simulação — nada foi gravado ainda' : 'Importação concluída'}</strong>: {resumo}</p>
                {rep.ignored_columns?.length > 0 && <p className="muted">Colunas não usadas: {rep.ignored_columns.join(', ')}.</p>}
                {rep.errors?.length > 0 && <div className="error"><strong>Linhas ignoradas ({rep.errors.length}):</strong><ul>{rep.errors.map((x, i) => <li key={i}>{x}</li>)}</ul></div>}
                {rep.warnings?.length > 0 && <div className="muted"><strong>Avisos:</strong><ul>{rep.warnings.map((x, i) => <li key={i}>{x}</li>)}</ul></div>}
              </div>
            )}
          </div>
        </div>
      )}
    </>
  );
}
