-- bcns-data: pin search_path on the nine data.* functions the hosted advisor flags under
-- lint 0011 function_search_path_mutable. Every api.* RPC and the four RLS helpers already
-- carry `set search_path = ''` (§2.2, §3.3); these nine were the stragglers.
--
-- `create or replace` keeps the OID, so the triggers, grants and views that reference them are
-- untouched. Signature, language, volatility and security (all invoker here) are reproduced
-- verbatim from 20260912000100_schema.sql / _000200_access.sql / _000500_api_rpcs.sql; only the
-- `set search_path = ''` clause is new. Every body was audited against an empty search_path:
-- all non-pg_catalog names (data.clients, data.connector_schedule, data.raw, data.member_role)
-- were already schema-qualified, and no body touches an extension function, type or operator —
-- btree_gin/pgcrypto/uuid-ossp/pg_net live in `extensions` and are referenced only from column
-- defaults and index definitions, which resolve at DDL time and not through a function's path.

-- ---------------------------------------------------------------- §1 schema triggers
create or replace function data.touch_updated_at() returns trigger language plpgsql
set search_path = '' as $$
begin new.updated_at := now(); return new; end $$;

create or replace function data.clients_timezone_valid() returns trigger language plpgsql
set search_path = '' as $$
begin
  begin
    perform now() at time zone new.timezone;
  exception when others then
    raise exception using errcode = 'BCNS3', message = 'validation', detail = 'timezone';
  end;
  return new;
end $$;

create or replace function data.clients_status_changed() returns trigger language plpgsql
set search_path = '' as $$
begin
  if new.status = 'churned' and old.status is distinct from 'churned' then new.churned_at := now(); end if;
  return new;
end $$;

create or replace function data.clients_timezone_changed() returns trigger language plpgsql
set search_path = '' as $$
begin
  if new.timezone is distinct from old.timezone then
    update data.connector_schedule set renormalize_requested_at = now() where client_id = new.id;
  end if;
  return null;
end $$;

-- ---------------------------------------------------------------- §1.5 partitions and helpers
create or replace function data.ensure_raw_partitions() returns void language plpgsql
set search_path = '' as $$
declare m date; p text;
begin
  perform pg_advisory_xact_lock(hashtext('raw_partitions'));
  for i in 0..2 loop
    m := (date_trunc('month', now()) + make_interval(months => i))::date;
    p := 'raw_' || to_char(m, 'YYYY_MM');
    execute format('create table if not exists data.%I partition of data.raw for values from (%L) to (%L)',
                   p, m, m + interval '1 month');
    execute format('alter table data.%I enable row level security', p);
    execute format('alter table data.%I force row level security', p);
    execute format('revoke all on data.%I from anon, authenticated', p);
  end loop;
end $$;

create or replace function data.local_day(ts timestamptz, client uuid) returns date language sql stable
set search_path = '' as $$
  select (ts at time zone (select timezone from data.clients where id = client))::date $$;

-- ---------------------------------------------------------------- §2.2 jwt claim readers
create or replace function data.jwt_client_id() returns uuid language sql stable
set search_path = '' as $$
  select nullif(current_setting('request.jwt.claims', true)::jsonb->>'client_id', '')::uuid $$;

create or replace function data.jwt_client_role() returns data.member_role language sql stable
set search_path = '' as $$
  select nullif(current_setting('request.jwt.claims', true)::jsonb->>'client_role', '')::data.member_role $$;

-- ---------------------------------------------------------------- §3.3 tag validation
create or replace function data.clean_tags(tags text[]) returns text[] language plpgsql immutable
set search_path = '' as $$
declare out text[]; t text;
begin
  if tags is null then return null; end if;
  if array_length(tags, 1) > 50 then raise exception using errcode = 'BCNS3', message = 'validation', detail = 'tags'; end if;
  foreach t in array tags loop
    t := lower(trim(t));
    if t !~ '^[a-z0-9 _-]{1,40}$' then raise exception using errcode = 'BCNS3', message = 'validation', detail = 'tags'; end if;
    if not (t = any(coalesce(out, '{}'))) then out := array_append(out, t); end if;
  end loop;
  return coalesce(out, '{}');
end $$;
