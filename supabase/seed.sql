-- CI / local seed (DESIGN.md §7). Synthetic only. Never run against production.
-- Clients: acme (active, owner+member+smoke), beta (active, member+smoke), gamma (paused, member+smoke).

create or replace function pg_temp.seed_user(uid uuid, email text, pw text) returns void language plpgsql as $$
begin
  insert into auth.users (instance_id, id, aud, role, email, encrypted_password, email_confirmed_at,
    raw_app_meta_data, raw_user_meta_data, created_at, updated_at, confirmation_token, recovery_token,
    email_change, email_change_token_new, is_sso_user)
  values ('00000000-0000-0000-0000-000000000000', uid, 'authenticated', 'authenticated', email,
    extensions.crypt(pw, extensions.gen_salt('bf')), now(),
    '{"provider":"email","providers":["email"]}', '{}', now(), now(), '', '', '', '', false);
  insert into auth.identities (id, user_id, provider_id, identity_data, provider, last_sign_in_at, created_at, updated_at)
  values (gen_random_uuid(), uid, uid::text, jsonb_build_object('sub', uid::text, 'email', email), 'email', now(), now(), now());
end $$;

insert into data.clients (id, slug, name, status, timezone, egress_quota_bytes) values
  ('a0000000-0000-4000-8000-000000000001', 'acme',  'Acme Sauna',  'active', 'America/New_York',    21474836480),
  ('b0000000-0000-4000-8000-000000000001', 'beta',  'Beta Baths',  'active', 'America/Los_Angeles', 21474836480),
  ('c0000000-0000-4000-8000-000000000001', 'gamma', 'Gamma Spa',   'paused', 'America/New_York',    21474836480);

select pg_temp.seed_user('a0000000-0000-4000-8000-0000000000a1', 'acme-member@example.com', 'password-acme');
select pg_temp.seed_user('a0000000-0000-4000-8000-0000000000a2', 'acme-owner@example.com',  'password-acme');
select pg_temp.seed_user('a0000000-0000-4000-8000-0000000000a3', 'acme-smoke@example.com',  'password-acme');
select pg_temp.seed_user('b0000000-0000-4000-8000-0000000000b1', 'beta-member@example.com', 'password-beta');
select pg_temp.seed_user('b0000000-0000-4000-8000-0000000000b3', 'beta-smoke@example.com',  'password-beta');
select pg_temp.seed_user('c0000000-0000-4000-8000-0000000000c1', 'gamma-member@example.com','password-gamma');
select pg_temp.seed_user('c0000000-0000-4000-8000-0000000000c3', 'gamma-smoke@example.com', 'password-gamma');
select pg_temp.seed_user('d0000000-0000-4000-8000-0000000000d1', 'nobody@example.com',      'password-nobody');

insert into data.memberships (user_id, client_id, role, is_smoke) values
  ('a0000000-0000-4000-8000-0000000000a1', 'a0000000-0000-4000-8000-000000000001', 'member', false),
  ('a0000000-0000-4000-8000-0000000000a2', 'a0000000-0000-4000-8000-000000000001', 'owner',  false),
  ('a0000000-0000-4000-8000-0000000000a3', 'a0000000-0000-4000-8000-000000000001', 'member', true),
  ('b0000000-0000-4000-8000-0000000000b1', 'b0000000-0000-4000-8000-000000000001', 'member', false),
  ('b0000000-0000-4000-8000-0000000000b3', 'b0000000-0000-4000-8000-000000000001', 'member', true),
  ('c0000000-0000-4000-8000-0000000000c1', 'c0000000-0000-4000-8000-000000000001', 'member', false),
  ('c0000000-0000-4000-8000-0000000000c3', 'c0000000-0000-4000-8000-000000000001', 'member', true);

-- connectors: schedule + placeholder tokens + never_ran health
insert into data.connector_schedule (client_id, source, interval, backfill_from, config) values
  ('a0000000-0000-4000-8000-000000000001', 'shopify', '15 minutes', current_date - 90, '{"shop":"acme-test.myshopify.com"}'),
  ('a0000000-0000-4000-8000-000000000001', 'meta',    '1 hour',     current_date - 90, '{"act_id":"act_1"}'),
  ('a0000000-0000-4000-8000-000000000001', 'monday',  '15 minutes', current_date - 90, '{"board_id":"1001"}'),
  ('a0000000-0000-4000-8000-000000000001', 'meet',    '1 hour',     current_date - 90, '{"folder_id":"f1"}'),
  ('b0000000-0000-4000-8000-000000000001', 'shopify', '15 minutes', current_date - 90, '{"shop":"beta-test.myshopify.com"}'),
  ('b0000000-0000-4000-8000-000000000001', 'monday',  '15 minutes', current_date - 90, '{"board_id":"2001"}'),
  ('c0000000-0000-4000-8000-000000000001', 'shopify', '15 minutes', current_date - 90, '{"shop":"gamma-test.myshopify.com"}');
insert into data.source_tokens (client_id, source, kind, secret) values
  ('a0000000-0000-4000-8000-000000000001', 'shopify', 'shopify_admin',        'seed-token'),
  ('a0000000-0000-4000-8000-000000000001', 'meta',    'meta_system_user',     'seed-token'),
  ('a0000000-0000-4000-8000-000000000001', 'monday',  'monday_personal',      'seed-token'),
  ('a0000000-0000-4000-8000-000000000001', 'meet',    'google_oauth_refresh', 'seed-token'),
  ('b0000000-0000-4000-8000-000000000001', 'shopify', 'shopify_admin',        'seed-token'),
  ('b0000000-0000-4000-8000-000000000001', 'monday',  'monday_personal',      'seed-token'),
  ('c0000000-0000-4000-8000-000000000001', 'shopify', 'shopify_admin',        'seed-token');
insert into data.connector_health (client_id, source, status, status_since)
  select client_id, source, 'never_ran', now() from data.connector_schedule;

-- ~50 rows per canonical table per client
do $$
declare c record; i int; day0 date := current_date - 49; mid uuid; sid uuid;
begin
  for c in select id, slug, left(id::text,1) as p from data.clients loop
    for i in 0..49 loop
      insert into data.customers (client_id, source, external_id, email, name, first_order_at, orders_count, total_spent_minor, currency, source_updated_at)
      values (c.id, 'shopify', 'cust-'||i, c.slug||'-c'||i||'@example.com', 'Customer '||i, day0 + i, 1 + i % 5, 10000 * (1 + i % 5), 'USD', day0 + i);
      insert into data.products (client_id, source, external_id, title, handle, status, vendor, product_type, price_minor, currency, inventory_quantity, variants_count, url, source_updated_at)
      values (c.id, 'shopify', 'prod-'||i, 'Product '||i, 'product-'||i, 'active', c.slug, 'sauna', 5000 + i * 100, 'USD', i, 1, 'https://'||c.slug||'.example.com/products/'||i, day0 + i);
      insert into data.money (client_id, source, external_id, kind, occurred_at, day, amount_minor, currency, status, order_number, customer_external_id, items_count, url, source_updated_at)
      values (c.id, 'shopify', 'order-'||i, case when i % 10 = 9 then 'refund' when i % 10 = 5 then 'payout' else 'order' end,
              (day0 + i)::timestamptz + interval '12 hours', day0 + i,
              case when i % 10 = 9 then -2500 else 12500 + i * 10 end, 'USD', 'paid', '#'||(1000 + i), 'cust-'||i, 1 + i % 3,
              'https://'||c.slug||'.example.com/orders/'||i, day0 + i);
      insert into data.jobs (client_id, source, external_id, kind, title, status, is_done, priority, group_name, owner, due_on, url, source_updated_at)
      values (c.id, 'monday', 'item-'||i, 'task', 'Task '||i, case when i % 3 = 0 then 'Done' else 'Working on it' end, i % 3 = 0,
              case when i % 2 = 0 then 'High' else 'Low' end, 'Group '||(i % 4), 'Owner '||(i % 3), day0 + i + 7,
              'https://monday.example.com/items/'||i, day0 + i);
      insert into data.messages (client_id, source, external_id, kind, title, body, occurred_at, participants, url, source_updated_at)
      values (c.id, 'meet', 'meet-'||i, 'meeting_notes', 'Meeting '||i, 'Notes for meeting '||i, (day0 + i)::timestamptz + interval '15 hours',
              array['a@example.com','b@example.com'], 'https://docs.example.com/'||i, day0 + i);
      insert into data.records (client_id, source, external_id, kind, title, body, attributes, occurred_at)
      values (c.id, (case when i < 40 then 'dashboard' else 'meta' end)::data.source, case when i < 40 then 'rec-'||i else 'camp-'||(i-40) end,
              case when i < 40 then 'note' else 'campaign' end, case when i < 40 then 'Note '||i else 'Campaign '||(i-40) end,
              'Body '||i, case when i < 40 then '{}'::jsonb else jsonb_build_object('effective_status','ACTIVE','objective','OUTCOME_SALES') end,
              (day0 + i)::timestamptz);
      insert into data.daily_metrics (client_id, source, day, entity_kind, entity_id, metric, value, currency) values
        (c.id, 'shopify', day0 + i, 'store', 'store', 'sessions', 100 + i, null),
        (c.id, 'meta',    day0 + i, 'campaign', 'camp-'||(i % 10), 'spend', 1000 + i, 'USD'),
        (c.id, 'meta',    day0 + i, 'campaign', 'camp-'||(i % 10), 'impressions', 5000 + i, null),
        (c.id, 'meta',    day0 + i, 'campaign', 'camp-'||(i % 10), 'clicks', 50 + i, null),
        (c.id, 'meta',    day0 + i, 'campaign', 'camp-'||(i % 10), 'purchases', 2 + i % 3, null),
        (c.id, 'meta',    day0 + i, 'campaign', 'camp-'||(i % 10), 'purchase_value', 3000 + i, 'USD');
    end loop;
    -- media: 3 originals with thumbs; storage.objects rows (metadata only, no bytes)
    for i in 1..3 loop
      mid := (repeat(c.p, 8) || '-0000-4000-8000-00000000000' || i)::uuid;
      insert into storage.objects (bucket_id, name, owner, metadata, version) values
        ('media', c.id||'/orig/'||mid||'.png', null, jsonb_build_object('size', 1024 * i, 'mimetype', 'image/png', 'eTag', '"seed"'), gen_random_uuid()::text),
        ('media', c.id||'/thumb/'||mid||'.jpg', null, jsonb_build_object('size', 256, 'mimetype', 'image/jpeg', 'eTag', '"seed"'), gen_random_uuid()::text);
      insert into data.media (id, client_id, source, external_id, kind, storage_path, thumb_path, filename, mime, bytes, width, height, title, tags, uploaded_by)
      values (mid, c.id, 'upload', c.id||'/orig/'||mid||'.png', 'image', c.id||'/orig/'||mid||'.png', c.id||'/thumb/'||mid||'.jpg',
              'creative-'||i||'.png', 'image/png', 1024 * i, 800, 600, 'Creative '||i, array['seed', 'set'||i],
              (select user_id from data.memberships where client_id = c.id and not is_smoke order by role limit 1));
    end loop;
    for i in 1..3 loop
      insert into data.media_sets (client_id, name, description) values (c.id, 'Set '||i, 'Seed set '||i) returning id into sid;
      -- distinct added_at so position order is verifiable against insertion order
      insert into data.media_set_items (client_id, set_id, media_id, added_at, position)
        select c.id, sid, m.id, now() + (m.rn * interval '1 second'), (m.rn - 1)::int
          from (select id, row_number() over (order by id) rn from data.media where client_id = c.id) m;
    end loop;
  end loop;
end $$;
