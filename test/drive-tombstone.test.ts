// §4.6/§4.1 Drive tombstone end-to-end: a file missing from a later complete listing is soft-deleted
// (deleted_at set, purge_after scheduled) and undeleted when it reappears; unchanged rows are not rewritten.
// Also: a thumbnail copy that fails is retried next run (knownMedia = row with bytes or thumb) and then never again.
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { randomUUID } from 'node:crypto'
import { localKeys, pool, serviceClient, sql, SUPABASE_URL } from './helpers.js'
import { closePool, type Tick } from '../worker/src/db.js'
import { runOne, type ScheduleRow } from '../worker/src/run.js'

const made: string[] = []

// putObject (thumbnail copy) talks to local Storage; same env the worker reads.
beforeAll(() => {
  process.env.SUPABASE_URL = SUPABASE_URL
  process.env.SUPABASE_SERVICE_ROLE_KEY = localKeys().service
})

async function mkClient(): Promise<string> {
  const id = randomUUID()
  made.push(id)
  await sql(`insert into data.clients (id, slug, name, timezone) values ($1, $2, 'Drive Tombstone Fixture', 'America/New_York')`,
    [id, `dr-${id.slice(0, 8)}`])
  await sql(`insert into data.connector_schedule (client_id, source, interval, backfill_from, config, next_run_at)
             values ($1, 'drive', '1 hour', current_date - 7, $2::jsonb, now() + interval '1 day')`,
    [id, JSON.stringify({ folder_id: 'f1' })])
  await sql(`insert into data.source_tokens (client_id, source, kind, secret) values ($1, 'drive', 'google_oauth_refresh', 'test-token')`, [id])
  return id
}

afterAll(async () => {
  if (made.length) {
    // Row deletes don't touch Storage: drop every object under each fixture client's prefix first,
    // or the thumbnail copies outlive the client row (hard-delete does the same for a real client).
    const objs = await sql<{ name: string }>(
      `select name from storage.objects where bucket_id = 'media' and split_part(name, '/', 1) = any($1::text[])`, [made])
    if (objs.rows.length) {
      const { error } = await serviceClient().storage.from('media').remove(objs.rows.map(o => o.name))
      if (error) throw new Error(`storage cleanup: ${error.message}`)
    }
    const left = await sql(`select name from storage.objects where bucket_id = 'media' and split_part(name, '/', 1) = any($1::text[])`, [made])
    if (left.rows.length) throw new Error(`storage cleanup left ${left.rows.length} object(s): ${left.rows.map((r: any) => r.name).join(', ')}`)
    for (const t of ['media', 'raw', 'raw_latest']) await sql(`delete from data.${t} where client_id = any($1::uuid[])`, [made])
    await sql(`delete from data.clients where id = any($1::uuid[])`, [made])
  }
  await Promise.all([pool.end(), closePool()])
})

const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } })

// Only f1 has a thumbnailLink; the per-file thumbnail branches are covered by drive_thumb_once in test/connectors.test.ts.
const file = (id: string, name: string, extra: Record<string, string> = {}) => ({
  id, name, mimeType: 'application/pdf', size: '1024', modifiedTime: '2026-09-10T12:00:00.000Z',
  webViewLink: `https://drive.example.test/file/${id}/view`, ...extra,
})
const FILES = [file('f1', 'One', { thumbnailLink: 'https://lh3.example.test/t/f1=s220' }), file('f2', 'Two'), file('f3', 'Three')]

/** Never makes a real Google call: the Drive list endpoint gets a fixed set of files, thumbnail links get `thumbStatus`, everything else an empty 200. */
function serveFiles(files: typeof FILES, thumbStatus = 500, thumbs: string[] = []): typeof globalThis.fetch {
  return (async (url: unknown) => {
    const u = String(url)
    if (u.includes('/drive/v3/files')) return json({ files })
    if (u.includes('lh3.example.test')) { thumbs.push(u); return new Response(new Uint8Array([1, 2, 3]), { status: thumbStatus, headers: { 'content-type': 'image/jpeg' } }) }
    return json({})
  }) as unknown as typeof globalThis.fetch
}

function mkTick(fetch: typeof globalThis.fetch): Tick {
  return {
    taskIndex: 0, taskCount: 1, owner: `test-${randomUUID().slice(0, 8)}`, fetch, stubbed: true,
    now: () => new Date(), log: () => {}, budgetMs: 60_000, claimLimit: 4,
  }
}

const scheduleRow = async (clientId: string): Promise<ScheduleRow> =>
  (await sql<ScheduleRow>(`select * from data.connector_schedule where client_id = $1 and source = 'drive'`, [clientId])).rows[0]

interface MediaRow { external_id: string; deleted_at: string | null; purge_after: string | null; storage_path: string | null; thumb_path: string | null; updated_at: string }
const mediaRows = async (clientId: string): Promise<MediaRow[]> =>
  (await sql<MediaRow>(
    `select external_id, deleted_at::text, purge_after::text, storage_path, thumb_path, updated_at::text
     from data.media where client_id = $1 and source = 'drive' order by external_id`,
    [clientId])).rows

describe('drive tombstone', () => {
  it('soft-deletes a file missing from a later complete listing and undeletes it when it reappears', async () => {
    const c = await mkClient()

    // run 1: three files land; bytes stay in Drive (storage_path null), nothing deleted; f1's thumbnail copy fails (500).
    const thumbs1: string[] = []
    await runOne(mkTick(serveFiles(FILES, 500, thumbs1)), await scheduleRow(c))
    let rows = await mediaRows(c)
    expect(rows.map(r => r.external_id)).toEqual(['f1', 'f2', 'f3'])
    expect(rows.every(r => r.deleted_at === null)).toBe(true)
    expect(rows.every(r => r.storage_path === null)).toBe(true)
    expect(thumbs1.length).toBe(1)
    expect(rows[0].thumb_path).toBeNull()
    const t1 = Object.fromEntries(rows.map(r => [r.external_id, r.updated_at]))

    // run 2: f3 missing from the listing -> tombstoned (deleted_at set, purge_after scheduled like a dashboard delete);
    // f1's thumbnail is retried and lands; f2 untouched, including its updated_at (no rewrite of unchanged rows).
    const thumbs2: string[] = []
    await runOne(mkTick(serveFiles(FILES.filter(f => f.id !== 'f3'), 200, thumbs2)), await scheduleRow(c))
    rows = await mediaRows(c)
    let byId = Object.fromEntries(rows.map(r => [r.external_id, r]))
    expect(byId.f3.deleted_at).not.toBeNull()
    expect(byId.f3.purge_after).not.toBeNull()
    expect(byId.f1.deleted_at).toBeNull()
    expect(byId.f2.deleted_at).toBeNull()
    expect(thumbs2.length).toBe(1)
    expect(byId.f1.thumb_path).toBe(`${c}/thumb/f1.jpg`)
    expect(byId.f2.updated_at).toBe(t1.f2)

    // run 3: f3 reappears -> un-deleted and un-scheduled (Drive is the source of truth, §4.6); f1's thumb is known now, no refetch.
    const thumbs3: string[] = []
    await runOne(mkTick(serveFiles(FILES, 200, thumbs3)), await scheduleRow(c))
    rows = await mediaRows(c)
    byId = Object.fromEntries(rows.map(r => [r.external_id, r]))
    expect(byId.f3.deleted_at).toBeNull()
    expect(byId.f3.purge_after).toBeNull()
    expect(thumbs3.length).toBe(0)
    expect(byId.f1.thumb_path).toBe(`${c}/thumb/f1.jpg`)
    expect(byId.f1.deleted_at).toBeNull()
    expect(byId.f2.deleted_at).toBeNull()
  })
})
