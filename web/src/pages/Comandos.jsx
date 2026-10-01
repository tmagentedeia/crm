import React from 'react';
import { Nome } from '../menu.jsx';
import ComandosAgente from './ComandosAgente.jsx';

export default function Comandos() {
  return (
    <>
      <h1><Nome id="comandos">Comandos</Nome></h1>
      <p className="muted" style={{ marginBottom: 18 }}>Controle do atendente pelo WhatsApp</p>
      <ComandosAgente />
    </>
  );
}
