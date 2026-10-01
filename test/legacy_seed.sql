-- Dados de demonstração (só para visualizar o painel). Login: demo@demo.com / demo1234
DO $$
DECLARE
  sid bigint; cids bigint[]; svids bigint[]; bids bigint[];
  d int; slot time; bidx int; bid bigint; cid bigint; svid bigint;
  dur int; pr numeric; st timestamptz; slots time[] := ARRAY['09:00','10:00','11:00','14:00','15:00','16:00','17:00']::time[];
  sl time; i int;
BEGIN
  INSERT INTO salons (name, slug, phone) VALUES ('Barbearia Demo', 'barbearia-demo', '32999990000') RETURNING id INTO sid;

  INSERT INTO users (salon_id, name, email, password_hash)
  VALUES (sid, 'Dono Demo', 'demo@demo.com', crypt('demo1234', gen_salt('bf', 10)));

  INSERT INTO services (salon_id, name, price, duration_min) VALUES
    (sid, 'Corte masculino', 50, 30),
    (sid, 'Barba', 35, 30),
    (sid, 'Corte + Barba', 80, 60),
    (sid, 'Sobrancelha', 20, 30),
    (sid, 'Pigmentação', 60, 60);
  SELECT array_agg(id ORDER BY id) INTO svids FROM services WHERE salon_id = sid;

  INSERT INTO barbers (salon_id, name, color) VALUES
    (sid, 'Rafael', '#2563eb'), (sid, 'Bruno', '#16a34a'), (sid, 'Diego', '#d97706');
  SELECT array_agg(id ORDER BY id) INTO bids FROM barbers WHERE salon_id = sid;

  FOREACH bid IN ARRAY bids LOOP
    FOR i IN 1..6 LOOP  -- segunda a sábado
      INSERT INTO barber_schedules (barber_id, weekday, start_time, end_time, break_start, break_end)
      VALUES (bid, i, '09:00', '18:00', '12:00', '13:00');
    END LOOP;
  END LOOP;

  FOR i IN 1..15 LOOP
    INSERT INTO customers (salon_id, name, phone, source)
    VALUES (sid, 'Cliente ' || i, '5532999000' || lpad(i::text, 2, '0'), CASE WHEN i % 3 = 0 THEN 'manual' ELSE 'ia' END);
  END LOOP;
  SELECT array_agg(id ORDER BY id) INTO cids FROM customers WHERE salon_id = sid;
  -- clientes 13..15 ficam como leads (nunca compareceram)

  FOR d IN 1..60 LOOP
    IF EXTRACT(DOW FROM current_date - d) = 0 THEN CONTINUE; END IF;
    FOR bidx IN 1..3 LOOP
      bid := bids[bidx];
      FOREACH sl IN ARRAY slots LOOP
        -- Rafael é o mais requisitado, Diego o menos
        IF random() > (CASE bidx WHEN 1 THEN 0.85 WHEN 2 THEN 0.6 ELSE 0.35 END) THEN CONTINUE; END IF;
        -- clientes 9..12 só aparecem em datas antigas (viram "inativos")
        IF d > 45 THEN cid := cids[9 + floor(random() * 4)::int];
        ELSE cid := cids[1 + floor(random() * 8)::int]; END IF;
        svid := svids[1 + floor(random() * 5)::int];
        SELECT duration_min, price INTO dur, pr FROM services WHERE id = svid;
        st := ((current_date - d) + sl)::timestamp AT TIME ZONE 'America/Sao_Paulo';
        INSERT INTO appointments (salon_id, barber_id, customer_id, service_id, starts_at, ends_at, price, status, source)
        VALUES (sid, bid, cid, svid, st, st + make_interval(mins => dur), pr,
                CASE WHEN random() < 0.88 THEN 'attended' ELSE 'no_show' END,
                CASE WHEN random() < 0.6 THEN 'ia' ELSE 'manual' END);
      END LOOP;
    END LOOP;
  END LOOP;

  -- alguns agendamentos futuros
  FOR d IN 0..2 LOOP
    FOR bidx IN 1..3 LOOP
      st := ((current_date + d) + slots[bidx + 2])::timestamp AT TIME ZONE 'America/Sao_Paulo';
      IF st > now() AND EXTRACT(DOW FROM current_date + d) <> 0 THEN
        svid := svids[3];
        INSERT INTO appointments (salon_id, barber_id, customer_id, service_id, starts_at, ends_at, price, status, source)
        VALUES (sid, bids[bidx], cids[bidx], svid, st, st + interval '60 minutes', 80, 'scheduled', 'ia');
      END IF;
    END LOOP;
  END LOOP;
END $$;
