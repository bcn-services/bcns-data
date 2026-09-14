-- bcns-data: explicit ordering for media-set members (DESIGN.md §3.2/§3.3).
-- Adds data.media_set_items.position, backfills it from added_at, exposes it on
-- api.media_set_items_v1, makes api.set_media_set_items append, and adds
-- api.reorder_media_set_items. Positions are 0-based and dense per set; only a concurrent
-- add racing another can leave a gap, which the deferrable unique or a reorder resolves.

alter table data.media_set_items add column position integer;

-- test/media-set-position.test.ts re-runs the block between these markers verbatim.
-- backfill:begin
update data.media_set_items i
   set position = r.rn
  from (select client_id, set_id, media_id,
               (row_number() over (partition by client_id, set_id order by added_at, media_id) - 1)::int as rn
          from data.media_set_items) r
 where i.client_id = r.client_id and i.set_id = r.set_id and i.media_id = r.media_id;
-- backfill:end

alter table data.media_set_items alter column position set not null;
-- deferred: api.reorder_media_set_items renumbers every row of a set in one update,
-- which transiently collides with itself.
alter table data.media_set_items
  add constraint media_set_items_set_id_position_key unique (set_id, position)
  deferrable initially deferred;

create or replace view api.media_set_items_v1 with (security_invoker = true) as
  select client_id, 'upload'::data.source as source, set_id, media_id, added_at, added_at as updated_at, position
  from data.media_set_items
  order by client_id, set_id, position;

-- replaced: the add path now appends at max(position) + 1, in media_ids order.
create or replace function api.set_media_set_items(set_id uuid, media_ids uuid[], action text) returns int
language plpgsql security definer set search_path = '' as $$
declare tenant uuid := data.tenant_or_raise(); n int;
begin
  perform data.require_w();
  if action not in ('add','remove') then raise exception using errcode = 'BCNS3', message = 'validation', detail = 'action'; end if;
  if array_length(media_ids, 1) > 500 then raise exception using errcode = 'BCNS3', message = 'validation', detail = 'media_ids'; end if;
  if not exists (select 1 from data.media_sets where id = set_id and client_id = tenant) then
    raise exception using errcode = 'BCNS4', message = 'not_found', detail = 'set_id';
  end if;
  if action = 'add' then
    insert into data.media_set_items (client_id, set_id, media_id, position)
    select tenant, set_media_set_items.set_id, m.id,
           tail.next + (row_number() over (order by array_position(media_ids, m.id)) - 1)::int
      from data.media m
      cross join (select coalesce(max(i.position) + 1, 0) as next from data.media_set_items i
                   where i.set_id = set_media_set_items.set_id and i.client_id = tenant) tail
     where m.id = any(media_ids) and m.client_id = tenant
       -- already-members are excluded here, not left to ON CONFLICT, so row_number()
       -- numbers only genuinely new rows and positions stay contiguous after max.
       and not exists (select 1 from data.media_set_items i
                        where i.set_id = set_media_set_items.set_id and i.client_id = tenant
                          and i.media_id = m.id)
    -- still needed for the concurrent case (two adds past the not-exists at once). Named
    -- arbiter: the bare form would try the deferrable unique as an arbiter too, and a
    -- column-list arbiter re-parses set_id as an expression, colliding with the parameter.
    on conflict on constraint media_set_items_pkey do nothing;
  else
    delete from data.media_set_items i
     using data.media m
     where i.set_id = set_media_set_items.set_id and i.client_id = tenant and i.media_id = m.id
       and m.id = any(media_ids) and m.client_id = tenant;
  end if;
  get diagnostics n = row_count;
  return n;
end $$;

-- media_ids must be exactly the set's current members: same length, no duplicates,
-- same ids. Anything else is BCNS3 'validation' detail 'media_ids' (nothing written).
create function api.reorder_media_set_items(set_id uuid, media_ids uuid[]) returns void
language plpgsql security definer set search_path = '' as $$
declare tenant uuid := data.tenant_or_raise(); members int;
begin
  perform data.require_w();
  if not exists (select 1 from data.media_sets s where s.id = set_id and s.client_id = tenant) then
    raise exception using errcode = 'BCNS4', message = 'not_found', detail = 'set_id';
  end if;
  select count(*) into members from data.media_set_items i
   where i.set_id = reorder_media_set_items.set_id and i.client_id = tenant;
  if media_ids is null
     or coalesce(array_length(media_ids, 1), 0) <> members
     or exists (select 1 from unnest(media_ids) x group by x having count(*) > 1)
     or exists (select 1 from data.media_set_items i
                 where i.set_id = reorder_media_set_items.set_id and i.client_id = tenant
                   and not (i.media_id = any(media_ids)))
  then
    raise exception using errcode = 'BCNS3', message = 'validation', detail = 'media_ids';
  end if;
  update data.media_set_items i
     set position = array_position(media_ids, i.media_id) - 1
   where i.set_id = reorder_media_set_items.set_id and i.client_id = tenant;
end $$;

-- strip the default PUBLIC EXECUTE, then the same allow-list the sibling RPCs carry
revoke all on function api.reorder_media_set_items(uuid, uuid[]) from public, anon, authenticated, service_role;
grant execute on function api.reorder_media_set_items(uuid, uuid[]) to authenticated, service_role;
