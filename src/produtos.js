// Catálogo de produtos e serviços: o mesmo cadastro guarda os dois. A Agenda e o atendente só oferecem serviços;
// produtos servem para vendas e comissão. Idempotente: roda na criação de empresas novas e como passo 20 nas existentes.
export const PRODUTOS_SQL = `
  ALTER TABLE services ADD COLUMN IF NOT EXISTS kind TEXT NOT NULL DEFAULT 'service';
  DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'services_kind_check' AND conrelid = 'services'::regclass) THEN
      ALTER TABLE services ADD CONSTRAINT services_kind_check CHECK (kind IN ('service', 'product'));
    END IF;
  END $$;
`;
export const TIPOS_ITEM = ['service', 'product'];
