import React, { useState, useEffect, useRef } from 'react';
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
    nome: 'setores', arquivo: 'modelo-setores.xlsx', chave: 'sectors', aviso: 'Informe a capacidade em pessoas, ou então quantas mesas e quantos lugares por mesa (a capacidade sai da conta). Em Mesas aceitas, escreva as mesas separadas por ponto e vírgula, com o máximo depois de dois-pontos (Mesa de 2:4). Vazio = aceita todas. Visão (nota de 0 a 10), Som, Características, Grupo ideal de/até e Só se não houver outro (sim) são opcionais.',
    exemplo: [{ Setor: 'Setor 1', Capacidade: 24, 'Mesas aceitas': '', Visão: 8, Som: '7 e 8', Características: 'Leve elevação, longe das janelas', 'Grupo ideal de': 5, 'Grupo ideal até': '', 'Só se não houver outro': '', Observações: '' }, { Setor: 'Setor 2', Mesas: 6, 'Lugares por mesa': 4, 'Mesas aceitas': 'Mesa de 4:6', Visão: 9, Som: 8, Características: 'Bom pra conversar', 'Grupo ideal de': 1, 'Grupo ideal até': 2, 'Só se não houver outro': '', Observações: 'Perto do palco' }],
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
  const [sel, setSel] = useState({}); // colunas marcadas para importar
  const [vinculada, setVinculada] = useState(false);
  useEffect(() => { if (aberto && tipo === 'customers') api('/customers/sheet/info').then((x) => setVinculada(!!x.linked)).catch(() => {}); }, [aberto, tipo]);
  const colunas = rows.length ? [...new Set(rows.flatMap((r) => Object.keys(r)))] : [];
  useEffect(() => { setSel(Object.fromEntries(colunas.map((c) => [c, true]))); }, [rows]); // eslint-disable-line
  const ehTelefone = (c) => /^(telefone|celular|whatsapp|fone)\b/i.test(String(c).normalize('NFD').replace(/[\u0300-\u036f]/g, '').trim());
  const rowsSel = () => rows.map((r) => Object.fromEntries(Object.entries(r).filter(([k]) => sel[k] !== false)));
  async function daPlanilha() {
    setErr(''); setRep(null); setBusy(true);
    try {
      const { csv } = await api('/customers/sheet');
      const wb = XLSX.read(csv, { type: 'string' });
      const r = toRows(wb.Sheets[wb.SheetNames[0]]);
      if (!r.length) throw new Error('A planilha está vazia.');
      setRows(r);
    } catch (e2) { setErr(e2.message); }
    setBusy(false);
  }
  const fechar = () => { setAberto(false); setRows([]); setPaste(''); setRep(null); setErr(''); };

  const modelo = () => {
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(T.exemplo), 'Modelo');
    XLSX.writeFile(wb, T.arquivo);
  };
  // CSV: o Excel brasileiro salva em ANSI (Windows-1252) e outros programas em UTF-8; sem decidir isso, os acentos saem trocados.
  // Tenta UTF-8 (rígido); se o arquivo não for, lê como Windows-1252.
  async function lerArquivo(f) {
    const buf = await f.arrayBuffer();
    if (/\.(csv|txt)$/i.test(f.name)) {
      let texto;
      try { texto = new TextDecoder('utf-8', { fatal: true }).decode(buf); }
      catch { texto = new TextDecoder('windows-1252').decode(buf); }
      return XLSX.read(texto.replace(/^\uFEFF/, ''), { type: 'string' });
    }
    return XLSX.read(buf, { type: 'array' });
  }
  async function aoEscolher(e) {
    const f = e.target.files[0]; e.target.value = '';
    if (!f) return;
    setErr(''); setRep(null);
    try {
      const wb = await lerArquivo(f);
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
  const [prog, setProg] = useState('');
  const fim = useRef(null);
  useEffect(() => { if (rep || err) fim.current?.scrollIntoView({ behavior: 'smooth', block: 'nearest' }); }, [rep, err]);
  async function rodar(dry) {
    setBusy(true); setErr(''); setProg('');
    try {
      const todas = rowsSel();
      let r;
      if (tipo === 'customers' && todas.length > 200) {
        // planilhas grandes vão em lotes, mostrando o andamento
        const tiposCol = [...new Set(todas.map((x) => { const k = Object.keys(x).find((c) => /^(tipo|situacao|situação|programa)$/i.test(c.trim())); return k ? String(x[k]) : ''; }))];
        const LOTE = 200;
        r = { dry_run: dry, customers: { created: 0, updated: 0 }, errors: [], warnings: [], extra_columns: [], ignored_columns: [] };
        const avisos = new Set(), cols = new Set();
        for (let i = 0; i < todas.length; i += LOTE) {
          setProg(`${dry ? 'Conferindo' : 'Importando'}… ${Math.min(i + LOTE, todas.length)} de ${todas.length}`);
          const p = await api('/import', { method: 'POST', body: { customers: todas.slice(i, i + LOTE), dry_run: dry, offset: i, tipos: tiposCol } });
          r.customers.created += p.customers.created; r.customers.updated += p.customers.updated;
          r.errors.push(...p.errors); p.warnings.forEach((w) => avisos.add(w)); (p.extra_columns || []).forEach((c) => cols.add(c));
        }
        r.warnings = [...avisos]; r.extra_columns = [...cols];
      } else {
        r = T.chave
          ? await api('/casa-de-shows/import', { method: 'POST', body: { [T.chave]: todas, dry_run: dry } })
          : tipo === 'menu'
          ? await api('/delivery/import', { method: 'POST', body: { rows: todas, dry_run: dry } })
          : await api('/import', { method: 'POST', body: { [tipo]: todas, dry_run: dry } });
      }
      setRep(r);
      if (!dry) { setRows([]); onFeito?.(); }
    } catch (e2) { setErr(e2.message); }
    setProg(''); setBusy(false);
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
            <p><button className="btn sm" onClick={modelo}>Baixar modelo (.xlsx)</button>{vinculada && <button className="btn sm primary" style={{ marginLeft: 8 }} onClick={daPlanilha} disabled={busy}>Buscar da planilha vinculada</button>}</p>
            <div className="field"><label>Envie o arquivo (.xlsx, .xls ou .csv)</label><input type="file" accept=".xlsx,.xls,.csv" onChange={aoEscolher} /></div>
            <div className="field">
              <label>Ou cole aqui (copie da planilha, com a linha de cabeçalho)</label>
              <textarea rows="4" value={paste} onChange={(e) => setPaste(e.target.value)} />
              <button className="btn sm" style={{ marginTop: 6 }} onClick={usarColado} disabled={!paste.trim()}>Usar o que colei</button>
            </div>
            {err && <div className="error" ref={fim}>{err}</div>}
            {rows.length > 0 && <p><strong>{rows.length}</strong> linha(s) prontas. <button className="btn sm" onClick={() => { setRows([]); setRep(null); }}>Limpar</button></p>}
            {colunas.length > 0 && (
              <div className="field">
                <label>Quais colunas você quer importar?</label>
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: '4px 16px' }}>
                  {colunas.map((c) => (
                    <label key={c} className="row" style={{ gap: 6 }} title={ehTelefone(c) ? 'O telefone é obrigatório' : ''}>
                      <input type="checkbox" checked={sel[c] !== false} disabled={ehTelefone(c)} onChange={(e) => { setSel({ ...sel, [c]: e.target.checked }); setRep(null); }} /> {c}
                    </label>
                  ))}
                </div>
              </div>
            )}
            <div className="row" style={{ gap: 8 }}>
              <button className="btn" disabled={!rows.length || busy} onClick={() => rodar(true)}>1. Conferir (só simula, não grava)</button>
              <button className="btn primary" disabled={!rows.length || busy || !rep?.dry_run} onClick={() => rodar(false)}>2. Importar de verdade</button>
            </div>
            {prog && <p><strong>{prog}</strong> <span className="muted">Não feche esta janela.</span></p>}
            {rep && (
              <div style={{ marginTop: 12 }} ref={fim}>
                <p><strong>{rep.dry_run ? 'SIMULAÇÃO — nada foi gravado ainda. Se estiver certo, clique em "2. Importar de verdade".' : 'Importação concluída (gravado)'}</strong>: {resumo}</p>
                {rep.extra_columns?.length > 0 && <p className="muted">Campos personalizados (vão para a ficha do contato): {rep.extra_columns.join(', ')}.</p>}
                {rep.ignored_columns?.length > 0 && <p className="muted">Colunas não usadas: {rep.ignored_columns.join(', ')}.</p>}
                {rep.errors?.length > 0 && <div className="error"><strong>Linhas ignoradas ({rep.errors.length}):</strong><ul>{rep.errors.slice(0, 15).map((x, i) => <li key={i}>{x}</li>)}{rep.errors.length > 15 && <li>… e mais {rep.errors.length - 15} linha(s) com o mesmo tipo de problema.</li>}</ul></div>}
                {rep.warnings?.length > 0 && <div className="muted"><strong>Avisos:</strong><ul>{rep.warnings.slice(0, 15).map((x, i) => <li key={i}>{x}</li>)}{rep.warnings.length > 15 && <li>… e mais {rep.warnings.length - 15} aviso(s).</li>}</ul></div>}
              </div>
            )}
          </div>
        </div>
      )}
    </>
  );
}
