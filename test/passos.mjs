// Os passos de atualização das empresas: números em sequência e SQL de verdade (um erro aqui some no deploy).
import { TENANT_STEPS } from '../src/tenant.js';
let fail = 0;
TENANT_STEPS.forEach((s, i) => {
  const esperado = i + 2;
  if (s.version !== esperado || typeof s.sql !== 'string' || !s.sql.trim() || Object.keys(s).length !== 2) { fail++; console.log('FALHOU: passo', i, JSON.stringify(Object.keys(s)), s.version); }
});
console.log(`passos: ${TENANT_STEPS.length} passos, ${fail} falhas`);
process.exit(fail ? 1 : 0);
