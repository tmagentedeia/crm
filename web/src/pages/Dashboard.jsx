import React, { useEffect, useState } from 'react';
import { Nome } from '../menu.jsx';

// cor dos gráficos vem do tema atual (variável --chart)
function useChartColor() {
  const read = () => getComputedStyle(document.documentElement).getPropertyValue('--chart').trim() || '#3b82f6';
  const [c, setC] = useState(read);
  useEffect(() => {
    const mo = new MutationObserver(() => setC(read()));
    mo.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
    return () => mo.disconnect();
  }, []);
  return c;
}

import { BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid } from 'recharts';
import { api, money, WEEKDAYS } from '../api.js';
import { moduleOn } from '../modules.js';

function Chart({ title, data, x, layout, vazio, nome }) {
  const color = useChartColor();
  const horizontal = layout === 'vertical';
  return (
    <div className="card">
      <h2>{title}</h2>
      <div style={{ height: 260, color: 'var(--muted)' }}>
        {data.length ? (
          <ResponsiveContainer>
            <BarChart data={data} layout={layout} margin={{ left: horizontal ? 30 : 0, right: 10 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="currentColor" opacity={0.25} />
              {horizontal ? (
                <>
                  <XAxis type="number" allowDecimals={false} tick={{ fill: 'currentColor', fontSize: 12 }} />
                  <YAxis type="category" dataKey={x} width={110} tick={{ fill: 'currentColor', fontSize: 12 }} />
                </>
              ) : (
                <>
                  <XAxis dataKey={x} tick={{ fill: 'currentColor', fontSize: 12 }} />
                  <YAxis allowDecimals={false} tick={{ fill: 'currentColor', fontSize: 12 }} />
                </>
              )}
              <Tooltip cursor={{ opacity: 0.15 }} contentStyle={{ borderRadius: 8, background: 'var(--card)', border: '1px solid var(--line)', color: 'var(--text)' }} labelStyle={{ color: 'var(--text)' }} itemStyle={{ color: 'var(--text)' }} />
              <Bar dataKey="total" name={nome || 'Agendamentos'} fill={color} radius={4} />
            </BarChart>
          </ResponsiveContainer>
        ) : <p className="muted">{vazio || 'Sem agendamentos concluídos no período.'}</p>}
      </div>
    </div>
  );
}

export default function Dashboard({ company }) {
  const [days, setDays] = useState(30);
  const [d, setD] = useState(null);
  useEffect(() => { api('/dashboard?days=' + days).then(setD); }, [days]);
  if (!d) return <p className="muted">Carregando…</p>;

  const week = WEEKDAYS.map((n, i) => ({ dia: n.slice(0, 3), total: d.por_dia_semana.find((x) => x.weekday === i)?.total || 0 }));
  const cli = Object.fromEntries(d.clientes.map((c) => [c.status, c.total]));
  const ticket = d.atendimentos ? d.faturamento / d.atendimentos : 0;
  const mods = company?.modules;
  const agenda = moduleOn(mods, 'agenda'), pedidos = moduleOn(mods, 'pedidos'), financeiro = moduleOn(mods, 'financeiro'), shows = moduleOn(mods, 'casa_de_shows');

  return (
    <>
      <div className="row" style={{ justifyContent: 'space-between', marginBottom: 16 }}>
        <div><h1><Nome id="dashboard">Dashboard</Nome></h1><p className="muted">Visão geral do negócio</p></div>
        <select style={{ width: 'auto' }} value={days} onChange={(e) => setDays(Number(e.target.value))}>
          <option value={7}>Últimos 7 dias</option><option value={30}>Últimos 30 dias</option>
          <option value={90}>Últimos 90 dias</option><option value={365}>Último ano</option>
        </select>
      </div>
      <div className="grid cols-4" style={{ marginBottom: 16 }}>
        <div className="card stat"><span className="muted">Atendimentos</span><div className="v">{d.conversas?.total ?? '—'}</div><span className="muted">{d.conversas?.total != null ? 'pessoas que conversaram com o agente' : 'a contagem começa quando o agente for ligado ao painel'}</span></div>
        {agenda && <div className="card stat"><span className="muted">Agendamentos realizados</span><div className="v">{d.atendimentos}</div></div>}
        {agenda && <div className="card stat"><span className="muted">Faturamento da agenda</span><div className="v">{money(d.faturamento)}</div></div>}
        {agenda && <div className="card stat"><span className="muted">Ticket médio</span><div className="v">{money(ticket)}</div></div>}
        {pedidos && <div className="card stat"><span className="muted">Pedidos de música</span><div className="v">{d.pedidos.total}</div><span className="muted">{d.pedidos.atendidos} atendido(s)</span></div>}
        {financeiro && <div className="card stat"><span className="muted">Recebido</span><div className="v">{money(d.recebido.total)}</div><span className="muted">{d.recebido.aceitos} pagamento(s)</span></div>}
        {shows && <div className="card stat"><span className="muted">Ingressos vendidos</span><div className="v">{d.ingressos.pessoas}</div><span className="muted">{d.ingressos.vendas} venda(s)</span></div>}
        {shows && <div className="card stat"><span className="muted">Receita de ingressos</span><div className="v">{money(d.ingressos.total)}</div></div>}
        <div className="card stat"><span className="muted">Clientes / Leads</span><div className="v">{cli.client || 0} / {cli.lead || 0}</div></div>
      </div>
      <div className="grid cols-2">
        {agenda && <Chart title="Dias com mais agendamentos" data={week} x="dia" />}
        {agenda && <Chart title="Serviços mais procurados" data={d.servicos} x="service" layout="vertical" />}
        {agenda && <Chart title="Profissionais mais requisitados" data={d.profissionais} x="professional" layout="vertical" />}
        {pedidos && <Chart title="Músicas mais pedidas" data={d.musicas} x="song" layout="vertical" nome="Pedidos" vazio="Sem pedidos no período." />}
      </div>
    </>
  );
}
