import React from 'react';
import { createRoot } from 'react-dom/client';
import App from './App.jsx';
import './styles.css';
import { iniciarVoltarFecha } from './voltarFecha.js';

iniciarVoltarFecha();

createRoot(document.getElementById('root')).render(<App />);
