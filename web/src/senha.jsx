import React, { useState } from 'react';

// Campo de senha com o botão de mostrar/ocultar o que foi digitado
export default function CampoSenha(props) {
  const [ver, setVer] = useState(false);
  return (
    <div className="senha-wrap">
      <input {...props} type={ver ? 'text' : 'password'} />
      <button type="button" className="senha-olho" onClick={() => setVer(!ver)}
        aria-label={ver ? 'Ocultar senha' : 'Mostrar senha'} title={ver ? 'Ocultar senha' : 'Mostrar senha'}>
        {ver ? '🙈' : '👁️'}
      </button>
    </div>
  );
}
