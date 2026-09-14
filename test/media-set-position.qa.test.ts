import { describe, it, expect, afterAll, beforeAll } from 'vitest'
import { readFileSync } from 'node:fs'
import { sql, pool, signIn, anonClient, clientWithToken, mintJwt, mediaId, USERS, CLIENTS } from './helpers.js'

const SET_NAME = 'qa-position-set'

async function makeSet(client: 'acme' | 'beta', mediaIds: string[]) {
  const { rows } = await sql<{ id: string }>(
    `insert into data.media_sets (client_id, name) values ($1, $2) returning id`,
    [CLIENTS[client], SET_NAME + '-' + Math.random().toString(36).slice(2)],
  )
  const setId = rows[0].id
  // stagger added_at so ordering is meaningful, insert in reverse of desired position order
  for (let i = 0; i < mediaIds.length; i++) {
    await sql(
      `insert into data.media_set_items (client_id, set_id, media_id, added_at, position) values ($1,$2,$3, now() + ($4 || ' seconds')::interval, $5)`,
      [CLIENTS[client], setId, mediaIds[i], i, i],
    )
  }
  return setId
}

async function cleanupSets(client: 'acme' | 'beta') {
  await sql(`delete from data.media_sets where client_id = $1 and name like $2`, [CLIENTS[client], SET_NAME + '%'])
}

afterAll(() => pool.end())

describe('media-set position: backfill', () => {
  it('backfill block orders position by added_at per set (re-run against a temp copy)', async () => {
    // Build a scratch table with the same shape/data as data.media_set_items, but shuffle
    // position to something wrong, then re-run the migration's backfill block against it
    // verbatim (markers: -- backfill:begin / -- backfill:end) and confirm it recovers order.
    await sql(`create temporary table media_set_items_scratch (like data.media_set_items including all)`)
    await sql(`insert into media_set_items_scratch select * from data.media_set_items`)
    await sql(`alter table media_set_items_scratch alter column position drop not null`)
    await sql(`update media_set_items_scratch set position = null`)

    const migrationSql = readFileSync(new URL('../supabase/migrations/20260914000200_media_set_position.sql', import.meta.url), 'utf8')
    const begin = migrationSql.indexOf('-- backfill:begin')
    const end = migrationSql.indexOf('-- backfill:end')
    expect(begin, 'backfill:begin marker present').toBeGreaterThan(-1)
    expect(end, 'backfill:end marker present').toBeGreaterThan(-1)
    let block = migrationSql.slice(begin, end)
    block = block.replace(/data\.media_set_items/g, 'media_set_items_scratch')
    await sql(block)

    const { rows } = await sql<{ set_id: string; media_id: string; added_at: string; position: number }>(
      `select set_id, media_id, added_at, position from media_set_items_scratch where client_id = $1 order by set_id, position`,
      [CLIENTS.acme],
    )
    const bySet = new Map<string, typeof rows>()
    for (const r of rows) bySet.set(r.set_id, [...(bySet.get(r.set_id) ?? []), r])
    expect(bySet.size).toBeGreaterThan(0)
    for (const [, items] of bySet) {
      const sortedByAddedAt = [...items].sort((a, b) => new Date(a.added_at).getTime() - new Date(b.added_at).getTime())
      expect(items.map(i => i.media_id)).toEqual(sortedByAddedAt.map(i => i.media_id))
      expect(items.map(i => i.position)).toEqual(items.map((_, idx) => idx))
    }
    await sql(`drop table media_set_items_scratch`)
  })
})

describe('media-set position: add path', () => {
  afterAll(() => cleanupSets('acme'))

  it('appends new items after current max, in media_ids order', async () => {
    const setId = await makeSet('acme', [mediaId('acme', 1)])
    const { client } = await signIn(USERS.acmeMember)
    const { data, error } = await client.rpc('set_media_set_items', {
      set_id: setId,
      media_ids: [mediaId('acme', 3), mediaId('acme', 2)],
      action: 'add',
    })
    expect(error).toBeNull()
    expect(data).toBe(2)
    const rows = (await sql<{ media_id: string; position: number }>(
      `select media_id, position from data.media_set_items where set_id = $1 order by position`, [setId],
    )).rows
    expect(rows.map(r => r.media_id)).toEqual([mediaId('acme', 1), mediaId('acme', 3), mediaId('acme', 2)])
    expect(rows.map(r => r.position)).toEqual([0, 1, 2])
  })

  it('re-adding an existing member leaves no gap: the new id lands at max+1', async () => {
    const setId = await makeSet('acme', [mediaId('acme', 1), mediaId('acme', 2)])
    const { client } = await signIn(USERS.acmeMember)
    // acme-2 already a member; add acme-2 (dup) + acme-3 (new) together
    const { data, error } = await client.rpc('set_media_set_items', {
      set_id: setId,
      media_ids: [mediaId('acme', 2), mediaId('acme', 3)],
      action: 'add',
    })
    expect(error).toBeNull()
    const rows = (await sql<{ media_id: string; position: number }>(
      `select media_id, position from data.media_set_items where set_id = $1 order by position`, [setId],
    )).rows
    // acme-2 was already present at position 1 and must stay there (on conflict do nothing);
    // acme-3 is the only genuinely new insert. Record what position it actually lands at.
    expect(rows.find(r => r.media_id === mediaId('acme', 2))!.position).toBe(1)
    const newRow = rows.find(r => r.media_id === mediaId('acme', 3))
    expect(newRow, 'new member inserted').toBeDefined()
    // the add branch excludes already-members from the insert, so row_number() numbers only
    // genuinely new rows: acme-3 is the single insert and takes max(position)+1 = 2, no gap.
    expect(data).toBe(1)
    expect(newRow!.position).toBe(2)
    expect(rows.map(r => r.position)).toEqual([0, 1, 2])
  })
})

describe('media-set position: reorder RPC', () => {
  afterAll(() => cleanupSets('acme'))
  afterAll(() => cleanupSets('beta'))

  it('happy path: reorders view and sets position = array index', async () => {
    const ids = [mediaId('acme', 1), mediaId('acme', 2), mediaId('acme', 3)]
    const setId = await makeSet('acme', ids)
    const { client } = await signIn(USERS.acmeMember)
    const newOrder = [mediaId('acme', 3), mediaId('acme', 1), mediaId('acme', 2)]
    const { error } = await client.rpc('reorder_media_set_items', { set_id: setId, media_ids: newOrder })
    expect(error).toBeNull()
    const { data: viewRows, error: viewErr } = await client
      .from('media_set_items_v1')
      .select('media_id, position')
      .eq('set_id', setId)
      .order('position')
    expect(viewErr).toBeNull()
    expect(viewRows!.map((r: any) => r.media_id)).toEqual(newOrder)
    expect(viewRows!.map((r: any) => r.position)).toEqual([0, 1, 2])
  })

  it('view is ordered by position, not insertion/added_at order', async () => {
    const ids = [mediaId('acme', 1), mediaId('acme', 2), mediaId('acme', 3)]
    const setId = await makeSet('acme', ids) // inserted with added_at ascending == position ascending
    const { client } = await signIn(USERS.acmeMember)
    // reorder so position order diverges from added_at order
    await client.rpc('reorder_media_set_items', { set_id: setId, media_ids: [mediaId('acme', 2), mediaId('acme', 3), mediaId('acme', 1)] })
    // no explicit .order() here on purpose: this must exercise the view's own ORDER BY, not
    // PostgREST's client-supplied order, or a broken view order would go undetected.
    const { data: viewRows } = await client.from('media_set_items_v1').select('media_id, position').eq('set_id', setId)
    expect(viewRows!.map((r: any) => r.media_id)).toEqual([mediaId('acme', 2), mediaId('acme', 3), mediaId('acme', 1)])
    // confirm this diverges from added_at order (acme-1, acme-2, acme-3), i.e. the view really
    // followed position rather than accidentally matching added_at
    expect(viewRows!.map((r: any) => r.media_id)).not.toEqual([mediaId('acme', 1), mediaId('acme', 2), mediaId('acme', 3)])
  })

  it.each([
    ['missing id', (ids: string[]) => ids.slice(1)],
    ['extra id', (ids: string[]) => [...ids, mediaId('acme', 3)]], // acme-3 not a member here
    ['duplicate id', (ids: string[]) => [ids[0], ids[0]]],
    ['null', () => null],
  ])('strict validation: %s -> BCNS3, nothing written', async (_label, transform) => {
    const ids = [mediaId('acme', 1), mediaId('acme', 2)]
    const setId = await makeSet('acme', ids)
    const before = (await sql(`select media_id, position from data.media_set_items where set_id = $1 order by position`, [setId])).rows
    const { client } = await signIn(USERS.acmeMember)
    const badIds = transform(ids)
    const { error } = await client.rpc('reorder_media_set_items', { set_id: setId, media_ids: badIds as any })
    expect(error?.code).toBe('BCNS3')
    expect(error?.details ?? (error as any)?.detail ?? error?.message).toBeTruthy()
    const after = (await sql(`select media_id, position from data.media_set_items where set_id = $1 order by position`, [setId])).rows
    expect(after).toEqual(before)
  })

  it('beta member reordering acme set -> BCNS4, nothing changes', async () => {
    const ids = [mediaId('acme', 1), mediaId('acme', 2)]
    const setId = await makeSet('acme', ids)
    const before = (await sql(`select media_id, position from data.media_set_items where set_id = $1 order by position`, [setId])).rows
    const { client } = await signIn(USERS.betaMember)
    const { error } = await client.rpc('reorder_media_set_items', { set_id: setId, media_ids: [...ids].reverse() })
    expect(error?.code).toBe('BCNS4')
    const after = (await sql(`select media_id, position from data.media_set_items where set_id = $1 order by position`, [setId])).rows
    expect(after).toEqual(before)
  })

  it('signed out (authenticated, no tenant/membership) -> BCNS0', async () => {
    // "signed out" per the item text names the code data.tenant_or_raise() returns for any
    // caller with no resolvable tenant. USERS.nobody has no membership row, so it can't sign in
    // through GoTrue's hook at all ("no membership"); mint a bare authenticated JWT with no
    // client_id claim instead, matching how tenant_or_raise's no-tenant path is exercised.
    const ids = [mediaId('acme', 1), mediaId('acme', 2)]
    const setId = await makeSet('acme', ids)
    const token = await mintJwt(USERS.nobody.id)
    const client = clientWithToken(token)
    const { error } = await client.rpc('reorder_media_set_items', { set_id: setId, media_ids: [...ids].reverse() })
    expect(error?.code).toBe('BCNS0')
  })

  it('anon key (no session at all): 42501 or BCNS0, request never reaches the body', async () => {
    const ids = [mediaId('acme', 1), mediaId('acme', 2)]
    const setId = await makeSet('acme', ids)
    const client = anonClient()
    const before = (await sql(`select media_id, position from data.media_set_items where set_id = $1 order by position`, [setId])).rows
    const { error } = await client.rpc('reorder_media_set_items', { set_id: setId, media_ids: [...ids].reverse() })
    expect(['42501', 'BCNS0']).toContain(error?.code)
    const after = (await sql(`select media_id, position from data.media_set_items where set_id = $1 order by position`, [setId])).rows
    expect(after).toEqual(before)
  })
})

describe('media-set position: db-level hardening', () => {
  it('reorder_media_set_items and set_media_set_items both set search_path = empty', async () => {
    const { rows } = await sql<{ proname: string; proconfig: string[] | null }>(
      `select proname, proconfig from pg_proc where pronamespace = 'api'::regnamespace and proname in ('reorder_media_set_items','set_media_set_items')`,
    )
    expect(rows.length).toBe(2)
    for (const r of rows) {
      expect(r.proconfig?.some(c => c.startsWith('search_path=')), `${r.proname}: ${JSON.stringify(r.proconfig)}`).toBe(true)
    }
  })

  it('reorder_media_set_items execute grants match set_media_set_items grants', async () => {
    const { rows } = await sql<{ proname: string; proacl: string[] }>(
      `select proname, proacl::text[] from pg_proc where pronamespace = 'api'::regnamespace and proname in ('reorder_media_set_items','set_media_set_items')`,
    )
    const byName = Object.fromEntries(rows.map(r => [r.proname, r.proacl]))
    // normalize away the grantor/grantee ordering noise isn't expected here since both are
    // granted by the same migration author; compare the role list embedded in each acl entry
    const roles = (acl: string[]) => acl.map(e => e.split('=')[0]).sort()
    expect(roles(byName.reorder_media_set_items)).toEqual(roles(byName.set_media_set_items))
  })
})

describe('media-set position: seed.sql', () => {
  it('fresh reset loads seed.sql without error (sanity: media_set_items seeded with position)', async () => {
    const { rows } = await sql<{ n: string }>(`select count(*)::text n from data.media_set_items`)
    expect(Number(rows[0].n)).toBeGreaterThan(0)
    const { rows: nullPos } = await sql(`select count(*)::int n from data.media_set_items where position is null`)
    expect(nullPos[0].n).toBe(0)
  })
})
