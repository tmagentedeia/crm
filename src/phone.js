// Telefone no padrão do WhatsApp/UAZAPI: só dígitos; número brasileiro = 55 + DDD + número (celular SEM o 9 extra).
// Só completa o 55 quando o número "tem cara" de brasileiro; com "+" na frente ou outro formato, não mexe.
export function normPhone(s) {
  const raw = String(s ?? '').trim();
  const d = raw.replace(/\D/g, '');
  const comMais = raw.startsWith('+');
  const ddd = Number(d.slice(0, 2));
  const dddOk = ddd >= 11 && ddd <= 99;
  if (!comMais && d.length === 11 && dddOk && d[2] === '9') return '55' + d.slice(0, 2) + d.slice(3); // celular com 9
  if (!comMais && d.length === 10 && dddOk) return '55' + d; // fixo, ou celular sem o 9
  if (d.length === 13 && d.startsWith('55') && d[4] === '9') return d.slice(0, 4) + d.slice(5); // 55 + celular com 9
  return d;
}

// Mesma regra no banco: número brasileiro sempre SEM o 9 extra (55 + DDD + 8 dígitos), não importa por onde ele entrou.
// A trava vale para todo cadastro de cliente novo ou alterado; os que já estavam com o 9 são acertados uma vez, se não houver outro igual.
export const TELEFONE_SQL = `
CREATE OR REPLACE FUNCTION norm_phone_br(p text) RETURNS text LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE WHEN regexp_replace(p, '\\D', '', 'g') ~ '^55[1-9][0-9]9[0-9]{8}$'
              THEN substr(regexp_replace(p, '\\D', '', 'g'), 1, 4) || substr(regexp_replace(p, '\\D', '', 'g'), 6)
              ELSE p END
$$;
CREATE OR REPLACE FUNCTION customers_norm_phone() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  -- (a regra está escrita aqui por inteiro para o gatilho funcionar de qualquer conexão, sem depender do caminho de busca do banco)
  IF NEW.phone IS NOT NULL AND regexp_replace(NEW.phone, '\\D', '', 'g') ~ '^55[1-9][0-9]9[0-9]{8}$' THEN
    NEW.phone := substr(regexp_replace(NEW.phone, '\\D', '', 'g'), 1, 4) || substr(regexp_replace(NEW.phone, '\\D', '', 'g'), 6);
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS trg_customers_norm_phone ON customers;
CREATE TRIGGER trg_customers_norm_phone BEFORE INSERT OR UPDATE OF phone ON customers
  FOR EACH ROW EXECUTE FUNCTION customers_norm_phone();`;

// Acerto único dos cadastros antigos (só onde não existe outro cliente com o número já sem o 9)
export const TELEFONE_ACERTO_SQL = `
DO $$
DECLARE tb text;
BEGIN
  UPDATE customers c SET phone = norm_phone_br(c.phone)
   WHERE c.phone IS NOT NULL AND norm_phone_br(c.phone) <> c.phone
     AND NOT EXISTS (SELECT 1 FROM customers o WHERE o.phone = norm_phone_br(c.phone));
  FOREACH tb IN ARRAY ARRAY['campaign_exclusions','campaign_recipients','shows_sales','shows_attendees','dlv_orders','appointment_reminders','pix_keys_sent'] LOOP
    IF to_regclass(tb) IS NOT NULL THEN
      BEGIN
        EXECUTE format('UPDATE %I SET phone = norm_phone_br(phone) WHERE phone IS NOT NULL AND norm_phone_br(phone) <> phone', tb);
      EXCEPTION WHEN unique_violation THEN NULL;
      END;
    END IF;
  END LOOP;
END $$;`;
