// Dados extras de teste: uma segunda empresa e alguns registros para os testes de isolamento.
// Roda depois de src/seed_demo.js (que cria a empresa 1). Os ids da empresa 2 são fixos e diferentes
// dos da empresa 1, para que um id da empresa 1 nunca exista por coincidência na empresa 2.
import { pool, qg, tx } from '../src/db.js';
import { createCompany } from '../src/companies.js';

const TABELAS = ['categories', 'services', 'professionals', 'customers', 'agent_commands', 'agent_attendants'];
const acertaSequencias = async (query) => {
  for (const t of TABELAS) {
    await query(`SELECT setval(pg_get_serial_sequence('${t}', 'id'), GREATEST((SELECT COALESCE(MAX(id), 1) FROM ${t}), 1), (SELECT MAX(id) IS NOT NULL FROM ${t}))`);
  }
};

try {
  const { company } = await createCompany({ name: 'Empresa Dois', ownerName: 'Dona Dois', email: 'dois@x.com', password: 'senhasenha' });
  if (Number(company.id) !== 2) throw new Error(`Esperava a empresa 2, veio ${company.id}`);
  await qg('UPDATE companies SET phone=$2, adm_name=$3, agent_name=$4, max_professionals=$5 WHERE id=$1',
    [company.id, '329999', 'Maria', 'Ana', 3]);

  await tx(1, async (query) => {
    await query(`
      INSERT INTO categories (id, name) VALUES (1, 'Cabelo');
      INSERT INTO customers (id, name, phone) VALUES (17, 'Cliente Extra', '553299990000');
      INSERT INTO agent_commands (kind, phrase, phrase_norm) VALUES ('pause', 'Will aqui', 'will aqui');
      INSERT INTO agent_attendants (name, name_norm) VALUES ('Claudia', 'claudia');
      INSERT INTO waitlist (customer_id, professional_id, desired_at)
        SELECT id, NULL, now() + interval '3 day' FROM customers ORDER BY id LIMIT 1;`);
    await acertaSequencias(query);
  });

  await tx(2, async (query) => {
    await query(`
      INSERT INTO categories (id, name) VALUES (2, 'Unhas'), (3, 'Cabelo');
      INSERT INTO services (id, name, price, duration_min, category_id) VALUES (6, 'Manicure', 40, 60, 2);
      INSERT INTO professionals (id, name) VALUES (4, 'Joana');
      INSERT INTO professional_schedules (professional_id, weekday, start_time, end_time) VALUES (4, 1, '09:00', '18:00');
      INSERT INTO professional_categories (professional_id, category_id) VALUES (4, 2);
      INSERT INTO customers (id, name, phone) VALUES (16, 'Cliente Dois', '553288887777');
      INSERT INTO agent_commands (kind, phrase, phrase_norm) VALUES ('pause', 'Maria sai', 'maria sai');`);
    await acertaSequencias(query);
  });

  console.log('Dados extras de teste criados (empresa 2 e registros da empresa 1).');
} catch (e) {
  console.error('Erro nos dados extras de teste:', e.message);
  process.exitCode = 1;
} finally {
  await pool.end();
}
