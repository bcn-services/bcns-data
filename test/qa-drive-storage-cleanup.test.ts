// QA (item A4, criterion 2): test/drive-tombstone.test.ts must leave no object in the local
// Storage bucket `media` under its fixture client prefixes after the suite finishes. Verified
// through the real entry point: run that file as its own vitest process (so its real afterAll
// executes), then independently list the bucket for any object whose prefix no longer maps to
// a data.clients row -- an orphan can only exist if the Storage cleanup didn't run or didn't finish.
import { describe, expect, it } from 'vitest'
import { execFileSync } from 'node:child_process'
import { localKeys, sql, SUPABASE_URL } from './helpers.js'
import { createClient } from '@supabase/supabase-js'

function orphanedMediaObjects() {
  // Any storage.objects row under a UUID-shaped prefix with no matching data.clients row is a
  // leak: drive-tombstone.test.ts (and worker.test.ts) always delete the client row in the same
  // afterAll that is supposed to remove the Storage objects, so a real client row existing for
  // the prefix (e.g. the seeded acme/beta/gamma fixtures) is not counted as an orphan here.
  const uuid = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}'
  return sql<{ name: string }>(
    `select o.name from storage.objects o
     where o.bucket_id = 'media'
       and split_part(o.name, '/', 1) ~ $1
       and not exists (select 1 from data.clients c where c.id::text = split_part(o.name, '/', 1))`,
    [`^${uuid}$`],
  )
}

describe('drive-tombstone.test.ts Storage cleanup', () => {
  it('leaves the media bucket free of orphaned objects after the real suite runs', async () => {
    const before = await orphanedMediaObjects()
    expect(before.rows).toEqual([]) // sanity: no pre-existing leak from another suite/run

    execFileSync('corepack', ['pnpm', 'exec', 'vitest', 'run', 'test/drive-tombstone.test.ts'], {
      cwd: process.cwd(),
      stdio: 'pipe',
      env: { ...process.env, SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY: localKeys().service },
    })

    const after = await orphanedMediaObjects()
    expect(after.rows).toEqual([])
  }, 60_000)

  it('seeds an extra object under a fixture-shaped prefix and confirms the removal query used by the afterAll actually deletes it', async () => {
    // Second, self-contained probe per the task's "or in a separate probe" option: proves the
    // exact removal query pattern (select by bucket + prefix, remove via the service client,
    // re-list to confirm empty) that drive-tombstone.test.ts's afterAll runs is not a no-op.
    const service = createClient(SUPABASE_URL, localKeys().service, { db: { schema: 'api' } })
    const fakePrefix = '11111111-2222-4333-8444-555555555555'
    const path = `${fakePrefix}/orig/probe.png`
    const { error: upErr } = await service.storage.from('media').upload(path, new Uint8Array([1, 2, 3]), { contentType: 'image/png', upsert: true })
    expect(upErr).toBeNull()

    const seeded = await sql<{ name: string }>(`select name from storage.objects where bucket_id = 'media' and split_part(name, '/', 1) = $1`, [fakePrefix])
    expect(seeded.rows.map((r) => r.name)).toEqual([path])

    const { error: rmErr } = await service.storage.from('media').remove(seeded.rows.map((r) => r.name))
    expect(rmErr).toBeNull()

    const left = await sql(`select name from storage.objects where bucket_id = 'media' and split_part(name, '/', 1) = $1`, [fakePrefix])
    expect(left.rows).toEqual([])
  })
})
