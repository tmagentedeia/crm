// Cria uma empresa de demonstração com dados de exemplo. Login: demo@demo.com / demo1234
//   node src/seed_demo.js
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { pool, tx } from './db.js';
import { createCompany } from './companies.js';

const dir = path.dirname(fileURLToPath(import.meta.url));
const data = fs.readFileSync(path.join(dir, '..', 'db', 'seed_demo.sql'), 'utf8');
try {
  const { company } = await createCompany({ name: 'Barbearia Demo', ownerName: 'Dono Demo', email: 'demo@demo.com', password: 'demo1234' });
  await tx(company.id, (query) => query(data));
  console.log(`Empresa de demonstração criada (id ${company.id}). Login: demo@demo.com / demo1234`);
} catch (e) {
  console.error('Erro ao criar a demonstração:', e.message);
  process.exitCode = 1;
} finally {
  await pool.end();
}
