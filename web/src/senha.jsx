import React, { useState } from 'react';
import { IconeOlho } from './icones.jsx';

// Campo de senha com o botão de mostrar/ocultar o que foi digitado
export default function CampoSenha(props) {
  const [ver, setVer] = useState(false);
  return (
    <div className="senha-wrap">
      <input {...props} type={ver ? 'text' : 'password'} />
      <button type="button" className="senha-olho" onClick={() => setVer(!ver)}
        aria-label={ver ? 'Ocultar senha' : 'Mostrar senha'} title={ver ? 'Ocultar senha' : 'Mostrar senha'}>
        <IconeOlho cortado={ver} size={17} />
      </button>
    </div>
  );
}
