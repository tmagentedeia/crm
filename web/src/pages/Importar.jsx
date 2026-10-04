import React, { useState } from 'react';
import { Nome } from '../menu.jsx';
import * as XLSX from 'xlsx';
import { api } from '../api.js';

const TYPES = { services: 'Serviços', professionals: 'Profissionais', customers: 'Clientes' };
const SAMPLE = {
  Serviços: [
    { Serviço: 'Corte feminino', Tipo: 'Serviço', Categoria: 'Cabelo', Preço: 80, 'Duração (min)': 45 },
    { Serviço: 'Escova', Tipo: 'Serviço', Categoria: 'Cabelo', Preço: 50, 'Duração (min)': 40 },
    { Serviço: 'Shampoo hidratante', Tipo: 'Produto', Categoria: '', Preço: 45, 'Duração (min)': '' },
  ],
  Profissionais: [
    { Nome: 'Mariana', Telefone: '(32) 99999-0000', Categorias: 'Cabelo, Manicure', Serviços: 'Corte feminino, Escova, Esmaltação', Dias: 'Seg-Sáb', Horário: '09:00-18:00', Pausa: '12:00-13:00', 'ID Google Agenda': '' },
    { Nome: 'Ian', Telefone: '', Categorias: 'Cabelo', Serviços: 'Corte masculino', Dias: 'Ter, Qui, Sex', Horário: '10:00-19:00', Pausa: '', 'ID Google Agenda': '' },
  ],
  Clientes: [{ Nome: 'Ana', Sobrenome: 'Souza', Telefone: '(32) 98888-7777', Tipo: '', Plano: '', 'Data de nascimento': '25/09/1990', Cidade: 'Juiz de Fora - MG', 'Data do cadastro': '11/09/2026' }],
};

const kindOf = (name) => {
  const n = name.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
  if (n.includes('servic')) return 'services';
  if (n.includes('profission') || n.includes('barbeir') || n.includes('equipe')) return 'professionals';
  if (n.includes('client')) return 'customers';
  return null;
};
const toRows = (ws) => XLSX.utils.sheet_to_json(ws, { defval: '', raw: false });
// Descobre o que a tabela é pelos nomes das colunas (telefone = clientes; preço/duração = serviços; dias/horário = profissionais)
const chaveCol = (k) => String(k).normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/\(.*?\)/g, '').replace(/[^a-z0-9 ]/g, '').trim();
const descobrir = (rows) => {
  const cols = new Set(Object.keys(rows[0] || {}).map(chaveCol));
  const tem = (...n) => n.some((x) => cols.has(x));
  if (tem('dias', 'horario', 'expediente', 'categorias')) return 'professionals';
  if (tem('telefone', 'celular', 'whatsapp')) return 'customers';
  if (tem('preco', 'duracao', 'servico')) return 'services';
  return null;
};

export default function Importar() {
  const [data, setData] = useState({});
  const [pasteType, setPasteType] = useState('auto');
  const [csvType, setCsvType] = useState('auto');
  const [paste, setPaste] = useState('');
  const [rep, setRep] = useState(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');

  const downloadModel = () => {
    const wb = XLSX.utils.book_new();
    for (const [name, rows] of Object.entries(SAMPLE)) XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(rows), name);
    XLSX.writeFile(wb, 'modelo-importacao.xlsx');
  };

  async function onFile(e) {
    const f = e.target.files[0]; e.target.value = '';
    if (!f) return;
    setErr(''); setRep(null);
    try {
      const wb = XLSX.read(await f.arrayBuffer(), { type: 'array' });
      const next = {};
      if (/\.csv$/i.test(f.name) || wb.SheetNames.length === 1 && !kindOf(wb.SheetNames[0])) {
        const rows = toRows(wb.Sheets[wb.SheetNames[0]]);
        const k = csvType === 'auto' ? descobrir(rows) : csvType;
        if (!k) throw new Error('Não consegui descobrir se o arquivo é de serviços, profissionais ou clientes. Escolha ao lado.');
        next[k] = rows;
      } else {
        for (const sn of wb.SheetNames) { const k = kindOf(sn); if (k) next[k] = toRows(wb.Sheets[sn]); }
      }
      if (!Object.keys(next).length) throw new Error('Não achei abas chamadas Serviços, Profissionais ou Clientes. Use o modelo.');
      setData((d) => ({ ...d, ...next }));
    } catch (e2) { setErr(e2.message); }
  }

  function usePaste() {
    setErr(''); setRep(null);
    try {
      const wb = XLSX.read(paste.trim(), { type: 'string', FS: paste.includes('\t') ? '\t' : undefined });
      const rows = toRows(wb.Sheets[wb.SheetNames[0]]);
      if (!rows.length) throw new Error('Cole também a linha de cabeçalho (nomes das colunas) e ao menos uma linha de dados.');
      const achou = descobrir(rows);
      const k = pasteType === 'auto' ? achou : pasteType;
      if (!k) throw new Error('Não consegui descobrir se isso é de serviços, profissionais ou clientes. Escolha em "O que é isso".');
      if (achou && achou !== k) throw new Error(`Você escolheu "${TYPES[k]}", mas as colunas parecem de "${TYPES[achou]}". Troque a escolha para "Descobrir sozinho" ou para "${TYPES[achou]}".`);
      setData((d) => ({ ...d, [k]: rows })); setPaste('');
    } catch (e2) { setErr(e2.message); }
  }

  async function run(dry) {
    setBusy(true); setErr('');
    try {
      const r = await api('/import', { method: 'POST', body: { ...data, dry_run: dry } });
      setRep(r);
      if (!dry) setData({});
    } catch (e2) { setErr(e2.message); }
    setBusy(false);
  }

  const total = Object.values(data).reduce((n, a) => n + (a?.length || 0), 0);
  return (
    <>
      <div style={{ marginBottom: 16 }}>
        <h1><Nome id="importar">Importar planilha</Nome></h1>
        <p className="muted">Cadastre serviços, profissionais e clientes de uma vez. Categorias (obrigatório, ao menos uma) e serviços do profissional separados por vírgula, dias como "Seg-Sáb".</p>
      </div>

      <div className="card" style={{ marginBottom: 16 }}>
        <strong>1. Baixe o modelo e preencha</strong>
        <p className="muted">Três abas: Serviços, Profissionais e Clientes. Pode preencher só as que precisar. Reimportar atualiza quem já existe, sem duplicar.</p>
        <button className="btn" onClick={downloadModel}>Baixar modelo (.xlsx)</button>
      </div>

      <div className="card" style={{ marginBottom: 16 }}>
        <strong>2. Envie o arquivo ou cole os dados</strong>
        <div className="row" style={{ marginTop: 8, flexWrap: 'wrap', gap: 12 }}>
          <input type="file" accept=".xlsx,.xls,.csv" onChange={onFile} />
          <span className="muted">Se for .csv, o arquivo é de:</span>
          <select value={csvType} onChange={(e) => setCsvType(e.target.value)} style={{ width: 'auto' }}>
            <option value="auto">Descobrir sozinho</option>
            {Object.entries(TYPES).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
          </select>
        </div>
        <div className="field" style={{ marginTop: 12 }}>
          <label>Ou cole aqui (copie da planilha, com a linha de cabeçalho)</label>
          <textarea rows="5" value={paste} onChange={(e) => setPaste(e.target.value)} placeholder={'Nome\tTelefone\tServiços\tDias\tHorário\nMariana\t32999990000\tCorte, Escova\tSeg-Sáb\t09:00-18:00'} />
          <div className="row" style={{ marginTop: 6 }}>
            <span className="muted">O que é isso:</span>
            <select value={pasteType} onChange={(e) => setPasteType(e.target.value)} style={{ width: 'auto' }}>
              <option value="auto">Descobrir sozinho</option>
              {Object.entries(TYPES).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
            </select>
            <button className="btn" onClick={usePaste} disabled={!paste.trim()}>Adicionar</button>
          </div>
        </div>
        {err && <div className="error">{err}</div>}
        {total > 0 && (
          <p style={{ marginTop: 10 }}>
            Prontos para importar: {Object.entries(data).filter(([, a]) => a?.length).map(([k, a]) => `${a.length} ${TYPES[k].toLowerCase()}`).join(' · ')}{' '}
            <button className="btn sm" onClick={() => { setData({}); setRep(null); }}>Limpar</button>
          </p>
        )}
      </div>

      <div className="card">
        <strong>3. Conferir e importar</strong>
        <div className="row" style={{ marginTop: 8 }}>
          <button className="btn" disabled={!total || busy} onClick={() => run(true)}>Conferir (simulação, não grava)</button>
          <button className="btn primary" disabled={!total || busy || !rep?.dry_run} onClick={() => run(false)}>Importar de verdade</button>
        </div>
        {rep && (
          <div style={{ marginTop: 12 }}>
            <p><strong>{rep.dry_run ? 'Simulação — nada foi gravado ainda' : 'Importação concluída'}</strong></p>
            <ul>
              <li>Serviços: {rep.services.created} novos, {rep.services.updated} atualizados{rep.categories.created ? ` · ${rep.categories.created} categorias novas` : ''}</li>
              <li>Profissionais: {rep.professionals.created} novos, {rep.professionals.updated} atualizados</li>
              <li>Clientes: {rep.customers.created} novos, {rep.customers.updated} atualizados</li>
            </ul>
            {rep.ignored_columns?.length > 0 && <p className="muted">Colunas não usadas (não fazem parte do cadastro): {rep.ignored_columns.join(', ')}.</p>}
            {rep.errors.length > 0 && <div className="error"><strong>Linhas ignoradas ({rep.errors.length}):</strong><ul>{rep.errors.map((x, i) => <li key={i}>{x}</li>)}</ul></div>}
            {rep.warnings.length > 0 && <div className="muted"><strong>Avisos:</strong><ul>{rep.warnings.map((x, i) => <li key={i}>{x}</li>)}</ul></div>}
          </div>
        )}
      </div>
    </>
  );
}
