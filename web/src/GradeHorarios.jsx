import React, { useState } from 'react';
import { WEEKDAYS } from './api.js';

// Grade de horários da semana (segunda a domingo). Na segunda-feira, "aplicar a todos" copia o horário dela para os outros dias; cada dia continua editável.
// grade: [{ weekday, on, start_time, end_time, break_start, break_end }] indexada por dia da semana (0 = domingo).
const ORDEM = [1, 2, 3, 4, 5, 6, 0];
const CAMPOS = ['start_time', 'end_time', 'break_start', 'break_end'];

export default function GradeHorarios({ grade, setGrade }) {
  const [seguir, setSeguir] = useState(false);
  const copiaDaSegunda = (g) => g.map((s) => (s.weekday === 1 ? s : { ...s, ...Object.fromEntries(CAMPOS.map((c) => [c, g[1][c]])) }));
  // Marcado: mexer na segunda leva os outros dias junto. Mexer num horário de outro dia desmarca (o que foi preenchido fica) e vale ao salvar.
  const set = (w, k, v) => {
    const g = grade.map((s) => (s.weekday === w ? { ...s, [k]: v } : s));
    if (seguir && k !== 'on' && w !== 1) setSeguir(false);
    setGrade(seguir && w === 1 && k !== 'on' ? copiaDaSegunda(g) : g);
  };
  const alternaSeguir = (on) => { setSeguir(on); if (on) setGrade(copiaDaSegunda(grade)); };
  return (
    <>
      <div className="sched-row muted"><span>Dia</span><span>Entrada</span><span>Saída</span><span>Pausa de</span><span>até</span></div>
      {ORDEM.map((w) => {
        const s = grade[w];
        return (
          <React.Fragment key={w}>
            <div className="sched-row" style={{ opacity: s.on ? 1 : 0.55 }}>
              <label style={{ margin: 0, color: 'var(--text)' }}>
                <input type="checkbox" checked={s.on} onChange={(e) => set(w, 'on', e.target.checked)} style={{ width: 'auto', marginRight: 6 }} />
                {WEEKDAYS[w].slice(0, 3)}
              </label>
              {CAMPOS.map((c) => <input key={c} type="time" disabled={!s.on} value={s[c]} onChange={(e) => set(w, c, e.target.value)} />)}
            </div>
            {w === 1 && (
              <label className="muted" style={{ margin: '0 0 6px 22px', fontWeight: 400 }}>
                <input type="checkbox" style={{ width: 'auto', marginRight: 6 }} checked={seguir} onChange={(e) => alternaSeguir(e.target.checked)} />
                (aplicar a todos)
              </label>
            )}
          </React.Fragment>
        );
      })}
    </>
  );
}
