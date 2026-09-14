import { describe, it, expect, afterAll, beforeAll } from 'vitest'
import { readFileSync } from 'node:fs'
import { sql, pool, rest, signIn, anonClient, mintJwt, mediaId, USERS, CLIENTS } from './helpers.js'

const SET_NAME = 'position-test-set'
let setId: string
let acmeMedia: string[]

/** The migration's backfill statement, sliced out of the migration itself so the test
 *  exercises the shipped SQL rather than a copy of it. */
const backfillSql = (() => {
  const file = readFileSync(new URL('../supabase/migrations/20260914000200_media_set_position.sql', import.meta.url), 'utf8')
  const body = file.split('-- backfill:begin')[1]?.split('-- backfill:end')[0]
  if (!body?.includes('row_number()')) throw new Error('backfill block not found in migration')
  return body
})()

const positions = async (id = setId) =>
  (await sql<{ media_id: string; position: number }>(
    `select media_id, position from data.media_set_items where set_id = $1 order by position`, [id])).rows

beforeAll(async () => {
  acmeMedia = ([1, 2, 3] as const).map(n => mediaId('acme', n))
  await sql(`delete from data.media_sets where client_id = $1 and name = $2`, [CLIENTS.acme, SET_NAME])
  setId = (await sql<{ id: string }>(
    `insert into data.media_sets (client_id, name) values ($1, $2) returning id`, [CLIENTS.acme, SET_NAME])).rows[0].id
})

afterAll(async () => {
  await sql(`delete from data.media_sets where client_id = $1 and name = $2`, [CLIENTS.acme, SET_NAME])
  await pool.end()
})

describe('media_set_items.position', () => {
  it('backfill orders by added_at, then media_id, dense from 0 per set', async () => {
    // scramble every position (negation keeps them unique), then re-run the migration's own statement
    await sql(`update data.media_set_items set position = -position - 1`)
    await sql(backfillSql)
    const rows = await sql<{ set_id: string; media_id: string; position: number; rn: number }>(
      `select set_id, media_id, position,
              (row_number() over (partition by client_id, set_id order by added_at, media_id) - 1)::int rn
         from data.media_set_items order by set_id, position`)
    expect(rows.rows.length).toBeGreaterThan(0)
    for (const r of rows.rows) expect(r.position, `${r.set_id}/${r.media_id}`).toBe(r.rn)
    // seeded added_at are distinct, so this is a real ordering assertion, not a tie-break one
    const distinct = await sql<{ n: number }>(
      `select count(distinct added_at)::int n from data.media_set_items where set_id = (select set_id from data.media_set_items limit 1)`)
    expect(distinct.rows[0].n).toBeGreaterThan(1)
  })

  it('the add path appends at the end, in media_ids order', async () => {
    const { client } = await signIn(USERS.acmeMember)
    expect((await client.rpc('set_media_set_items', { set_id: setId, media_ids: [acmeMedia[1]], action: 'add' })).error).toBeNull()
    expect(await positions()).toEqual([{ media_id: acmeMedia[1], position: 0 }])

    // appended after the existing member, honouring the caller's array order
    expect((await client.rpc('set_media_set_items', { set_id: setId, media_ids: [acmeMedia[2], acmeMedia[0]], action: 'add' })).error).toBeNull()
    expect(await positions()).toEqual([
      { media_id: acmeMedia[1], position: 0 },
      { media_id: acmeMedia[2], position: 1 },
      { media_id: acmeMedia[0], position: 2 },
    ])
  })

  it('re-adding an existing id alongside a new one leaves no gap', async () => {
    const { client } = await signIn(USERS.acmeMember)
    // acmeMedia[1] is already a member at 0; only acmeMedia[0]... is already a member too, so
    // drop one first to have a genuinely new id to append.
    expect((await client.rpc('set_media_set_items', { set_id: setId, media_ids: [acmeMedia[0]], action: 'remove' })).error).toBeNull()
    expect((await positions()).map(r => r.media_id)).toEqual([acmeMedia[1], acmeMedia[2]])

    // acmeMedia[2] is already in at position 1; acmeMedia[0] is new and must land at 2, not 3
    const { data, error } = await client.rpc('set_media_set_items', {
      set_id: setId, media_ids: [acmeMedia[2], acmeMedia[0]], action: 'add',
    })
    expect(error).toBeNull()
    expect(data).toBe(1) // only the genuinely new row is inserted
    expect(await positions()).toEqual([
      { media_id: acmeMedia[1], position: 0 },
      { media_id: acmeMedia[2], position: 1 },
      { media_id: acmeMedia[0], position: 2 },
    ])
  })

  it('media_set_items_v1 exposes position and is ordered by it', async () => {
    const { client } = await signIn(USERS.acmeMember)
    const { data, error } = await client.from('media_set_items_v1').select('media_id, position').eq('set_id', setId)
    expect(error).toBeNull()
    expect(data).toEqual([
      { media_id: acmeMedia[1], position: 0 },
      { media_id: acmeMedia[2], position: 1 },
      { media_id: acmeMedia[0], position: 2 },
    ])
  })

  it('reorder_media_set_items renumbers to the array index', async () => {
    const { client } = await signIn(USERS.acmeMember)
    const order = [acmeMedia[0], acmeMedia[1], acmeMedia[2]]
    expect((await client.rpc('reorder_media_set_items', { set_id: setId, media_ids: order })).error).toBeNull()
    expect(await positions()).toEqual(order.map((media_id, position) => ({ media_id, position })))

    const { data } = await client.from('media_set_items_v1').select('media_id').eq('set_id', setId)
    expect(data!.map((r: any) => r.media_id)).toEqual(order)
  })

  it('a media_ids array that is not exactly the members is BCNS3 and writes nothing', async () => {
    const { client } = await signIn(USERS.acmeMember)
    const before = await positions()
    const cases: Record<string, string[]> = {
      missing: [acmeMedia[2], acmeMedia[1]],
      extra: [...acmeMedia, mediaId('beta', 1)],
      duplicate: [acmeMedia[0], acmeMedia[0], acmeMedia[1]],
      substituted: [acmeMedia[0], acmeMedia[1], mediaId('beta', 1)],
      empty: [],
    }
    for (const [name, media_ids] of Object.entries(cases)) {
      const { error } = await client.rpc('reorder_media_set_items', { set_id: setId, media_ids })
      expect(error?.code, name).toBe('BCNS3')
      expect(error?.message, name).toBe('validation')
      expect(await positions(), name).toEqual(before)
    }
  })

  it("beta member reordering acme's set is BCNS4 and changes nothing", async () => {
    const before = await positions()
    const { client } = await signIn(USERS.betaMember)
    const { error } = await client.rpc('reorder_media_set_items', { set_id: setId, media_ids: [...acmeMedia].reverse() })
    expect(error?.code).toBe('BCNS4')
    expect(await positions()).toEqual(before)
  })

  it('a caller with no tenant is BCNS0; the anon key never reaches the body', async () => {
    const before = await positions()
    const args = { set_id: setId, media_ids: [...acmeMedia].reverse() }

    const token = await mintJwt(USERS.nobody.id) // authenticated JWT, no client_id claim
    const { status, body } = await rest('rpc/reorder_media_set_items', token, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(args),
    })
    expect(status).toBeGreaterThanOrEqual(400)
    expect(body.code).toBe('BCNS0')

    const { error } = await anonClient().rpc('reorder_media_set_items', args)
    expect(['42501', 'BCNS0']).toContain(error?.code) // anon holds no execute grant

    expect(await positions()).toEqual(before)
  })
})
