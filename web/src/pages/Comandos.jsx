import React from 'react';
import ComandosAgente from './ComandosAgente.jsx';

export default function Comandos() {
  return (
    <>
      <h1>Comandos</h1>
      <p className="muted" style={{ marginBottom: 18 }}>Controle do atendente pelo WhatsApp</p>
      <ComandosAgente />
    </>
  );
}
