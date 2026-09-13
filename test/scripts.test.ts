// Exercises the bcns-run operator scripts (DESIGN.md §5.10) end to end against the local stack.
// Uses a throwaway client (never acme/beta/gamma) created by onboard and removed by hard-delete.
import { afterAll, describe, expect, it, vi } from 'vitest'
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { localKeys, sql, pool, SUPABASE_URL, PNG_1x1 } from './helpers.js'
import { main as onboard } from '../scripts/onboard.js'
import { main as setQuota } from '../scripts/set-quota.js'
import { main as importMedia } from '../scripts/import-media.js'
import { main as addMember, upsertMembership } from '../scripts/add-member.js'
import { main as churn } from '../scripts/churn.js'
import { main as hardDelete } from '../scripts/hard-delete.js'
import { main as exportClient } from '../scripts/export.js'
import { checklist } from '../scripts/checklist.js'
import { signIn } from '../packages/data-client/src/index.js'

const SLUG = 'zz-script-test'
const SLUG2 = 'zz-script-test2'
let clientId: string

const archiveDir = mkdtempSync(join(tmpdir(), 'bcns-archive-'))
process.env.EXPORT_ARCHIVE_DIR = archiveDir

afterAll(async () => {
  // Best-effort: remove the throwaway client even if an earlier assertion failed mid-suite.
  try {
    // Two statements: the churn trigger stamps churned_at = now() whenever status flips, so back-dating must come after.
    await sql(`update data.clients set status = 'churned' where slug = $1`, [SLUG])
    await sql(`update data.clients set churned_at = now() - interval '91 days' where slug = $1`, [SLUG])
    await hardDelete(['--slug', SLUG, '--confirm', SLUG])
  } catch (e) {
    console.error('cleanup', SLUG, String(e)) // already gone or never created
  }
  try {
    await sql(`update data.clients set status = 'churned' where slug = $1`, [SLUG2])
    await sql(`update data.clients set churned_at = now() - interval '91 days' where slug = $1`, [SLUG2])
    await hardDelete(['--slug', SLUG2, '--confirm', SLUG2])
  } catch (e) { console.error('cleanup', SLUG2, String(e)) }
  rmSync(archiveDir, { recursive: true, force: true })
})

describe('scripts', () => {
  it('onboard creates the client, its owning membership, and a smoke user', async () => {
    await onboard(['--slug', SLUG, '--name', 'ZZ Script Test', '--timezone', 'America/New_York'])

    const client = await sql<{ id: string; status: string }>('select id, status from data.clients where slug = $1', [SLUG])
    expect(client.rowCount).toBe(1)
    expect(client.rows[0].status).toBe('active')
    clientId = client.rows[0].id

    const smoke = await sql(
      'select is_smoke from data.memberships where client_id = $1 and is_smoke = true',
      [clientId],
    )
    expect(smoke.rowCount).toBe(1)

    const user = await sql('select id from auth.users where email = $1', [`smoke+${SLUG}@bcn-services.com`])
    expect(user.rowCount).toBe(1)
  })

  it('onboard --sources writes source_tokens + connector_schedule from the connector defaults', async () => {
    const real = globalThis.fetch
    vi.stubGlobal('fetch', (url: RequestInfo | URL, init?: RequestInit) => String(url).includes('api.monday.com')
      ? Promise.resolve(new Response(JSON.stringify({ data: { boards: [{ columns: [{ id: 'status', title: 'Status', type: 'status' }, { id: 'date4', title: 'Due', type: 'date' }] }] } })))
      : real(url, init))
    try {
      await onboard(['--slug', SLUG2, '--name', 'ZZ2', '--timezone', 'UTC', '--sources', 'monday'],
        async (q) => (q.includes('board_id') ? '123' : q.includes('board_url') ? 'https://m.example' : 'tok'))
    } finally {
      vi.unstubAllGlobals()
    }
    const sched = await sql<any>(`select interval::text, backfill_from::text, config from data.connector_schedule s join data.clients c on c.id = s.client_id where c.slug = $1`, [SLUG2])
    expect(sched.rows[0].interval).toBe('01:00:00')
    expect(sched.rows[0].backfill_from).toBe(new Date().toISOString().slice(0, 10))
    expect(sched.rows[0].config).toEqual({ board_id: '123', board_url: 'https://m.example', columns: { status: 'status', due: 'date4' } })
    const tok = await sql<any>(`select kind, secret from data.source_tokens t join data.clients c on c.id = t.client_id where c.slug = $1`, [SLUG2])
    expect(tok.rows[0]).toEqual({ kind: 'monday_personal', secret: 'tok' })
  })

  it('set-quota updates egress_quota_bytes', async () => {
    await setQuota(['--slug', SLUG, '--gb', '5'])
    const r = await sql<{ egress_quota_bytes: string }>('select egress_quota_bytes from data.clients where slug = $1', [SLUG])
    expect(Number(r.rows[0].egress_quota_bytes)).toBe(5 * 1024 ** 3)
  })

  it('import-media uploads a file and registers it via data.register_media', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'bcns-import-'))
    try {
      writeFileSync(join(dir, 'pixel.png'), PNG_1x1)
      await importMedia(['--slug', SLUG, '--dir', dir, '--tags', 'a,b'])

      const r = await sql<{ bytes: string; tags: string[]; storage_path: string }>(
        `select bytes, tags, storage_path from data.media where client_id = $1 and filename = 'pixel.png'`,
        [clientId],
      )
      expect(r.rowCount).toBe(1)
      expect(Number(r.rows[0].bytes)).toBe(PNG_1x1.length)
      expect(r.rows[0].tags.sort()).toEqual(['a', 'b'])
      expect(r.rows[0].storage_path).toMatch(new RegExp(`^${clientId}/orig/[0-9a-f-]{36}\\.png$`))
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('add-member --agent creates a non-smoke member whose password signs in with the client_id claim, and re-run rotates it', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    try {
      await addMember(['--slug', SLUG, '--agent'])

      const email = `agent+${SLUG}@bcn-services.com`
      const membership = await sql<{ role: string; is_smoke: boolean }>(
        `select mem.role, mem.is_smoke from data.memberships mem join auth.users u on u.id = mem.user_id
         where u.email = $1 and mem.client_id = $2`,
        [email, clientId],
      )
      expect(membership.rowCount).toBe(1)
      expect(membership.rows[0]).toEqual({ role: 'member', is_smoke: false })

      const printed = log.mock.calls.map((c) => c.join(' ')).join('\n')
      expect(printed).toContain(`agent user: ${email}`)
      const passwordLine = log.mock.calls.map((c) => c.join(' ')).find((l) => l.startsWith('agent password'))!
      const password1 = passwordLine.split(': ').slice(1).join(': ')

      const dc1 = await signIn({ supabaseUrl: SUPABASE_URL, anonKey: localKeys().anon, email, password: password1 })
      const claims = JSON.parse(Buffer.from((await dc1.accessToken()).split('.')[1], 'base64url').toString())
      expect(claims.client_id).toBe(clientId)

      log.mockClear()
      await addMember(['--slug', SLUG, '--agent'])
      const passwordLine2 = log.mock.calls.map((c) => c.join(' ')).find((l) => l.startsWith('agent password'))!
      const password2 = passwordLine2.split(': ').slice(1).join(': ')
      expect(password2).not.toBe(password1)

      await expect(
        signIn({ supabaseUrl: SUPABASE_URL, anonKey: localKeys().anon, email, password: password1 }),
      ).rejects.toThrow(/sign-in failed/)
      const dc2 = await signIn({ supabaseUrl: SUPABASE_URL, anonKey: localKeys().anon, email, password: password2 })
      expect(await dc2.accessToken()).toBeTruthy()
    } finally {
      log.mockRestore()
    }
  })

  it('add-member --agent rejects --email or --owner', async () => {
    await expect(addMember(['--slug', SLUG, '--agent', '--email', 'x@example.com'])).rejects.toThrow(/usage/)
    await expect(addMember(['--slug', SLUG, '--agent', '--owner'])).rejects.toThrow(/usage/)
  })

  it('add-member --agent refuses to rotate a user that already owns the agent+ address but was not minted by --agent', async () => {
    const email = `agent+${SLUG2}@bcn-services.com`
    await addMember(['--slug', SLUG2, '--email', email, '--owner'])

    const before = await sql<{ encrypted_password: string }>(
      'select encrypted_password from auth.users where email = $1',
      [email],
    )
    expect(before.rowCount).toBe(1)

    await expect(addMember(['--slug', SLUG2, '--agent'])).rejects.toThrow(/refusing to rotate/)

    const after = await sql<{ encrypted_password: string }>(
      'select encrypted_password from auth.users where email = $1',
      [email],
    )
    expect(after.rows[0].encrypted_password).toBe(before.rows[0].encrypted_password)

    const membership = await sql<{ role: string }>(
      `select mem.role from data.memberships mem join auth.users u on u.id = mem.user_id where u.email = $1`,
      [email],
    )
    expect(membership.rows[0].role).toBe('owner')
  })

  it('upsertMembership leaves is_smoke unchanged on the plain (non-agent) path, only forces it false for --agent', async () => {
    const smokeEmail = `smoke+${SLUG}@bcn-services.com`
    const user = await sql<{ id: string }>('select id from auth.users where email = $1', [smokeEmail])
    const userId = user.rows[0].id
    await sql('update data.memberships set is_smoke = true where user_id = $1', [userId])

    // Plain path re-add (role change), same user_id -> hits the ON CONFLICT branch.
    await upsertMembership(pool, userId, clientId, 'owner', { agent: false })
    const afterPlain = await sql<{ is_smoke: boolean; role: string }>(
      'select is_smoke, role from data.memberships where user_id = $1',
      [userId],
    )
    expect(afterPlain.rows[0]).toEqual({ is_smoke: true, role: 'owner' })

    // --agent path always forces is_smoke back to false.
    await upsertMembership(pool, userId, clientId, 'member', { agent: true })
    const afterAgent = await sql<{ is_smoke: boolean; role: string }>(
      'select is_smoke, role from data.memberships where user_id = $1',
      [userId],
    )
    expect(afterAgent.rows[0]).toEqual({ is_smoke: false, role: 'member' })

    // restore, so the smoke-user invariant holds for later assertions/cleanup
    await sql('update data.memberships set is_smoke = true, role = $2 where user_id = $1', [userId, 'owner'])
  })

  it('churn sets status = churned and stamps churned_at', async () => {
    await churn(['--slug', SLUG])
    const r = await sql<{ status: string; churned_at: string | null }>(
      'select status, churned_at from data.clients where slug = $1',
      [SLUG],
    )
    expect(r.rows[0].status).toBe('churned')
    expect(r.rows[0].churned_at).not.toBeNull()
  })

  it('export writes CSV per canonical table, raw.jsonl and files/', async () => {
    await sql(`insert into data.raw (client_id, source, entity, external_id, payload_hash, payload) values ($1, 'shopify', 'order', 'x1', 'h', '{"a":1}')`, [clientId])
    const out = mkdtempSync(join(tmpdir(), 'bcns-export-'))
    try {
      await exportClient(['--slug', SLUG, '--out', out])
      const names = readdirSync(out)
      for (const t of ['customers', 'money', 'media', 'records']) expect(names).toContain(`${t}.csv`)
      expect(readFileSync(join(out, 'media.csv'), 'utf8').split('\n')[0]).toContain('storage_path')
      expect(readFileSync(join(out, 'raw.jsonl'), 'utf8').trim().split('\n')).toHaveLength(1)
      expect(readdirSync(join(out, 'files'))).toHaveLength(1)
    } finally {
      rmSync(out, { recursive: true, force: true })
    }
  })

  it('hard-delete refuses within 90 days of churn', async () => {
    await expect(hardDelete(['--slug', SLUG, '--confirm', SLUG])).rejects.toThrow(/90 days/)
    expect((await sql('select 1 from data.clients where slug = $1', [SLUG])).rowCount).toBe(1)
  })

  it('hard-delete archives the export, then removes the client, its rows, and its storage objects', async () => {
    await sql(`update data.clients set churned_at = now() - interval '91 days' where slug = $1`, [SLUG])
    await hardDelete(['--slug', SLUG, '--confirm', SLUG])
    expect(existsSync(join(archiveDir, SLUG))).toBe(true)
    expect(readdirSync(join(archiveDir, SLUG))[0]).toMatch(/\.tar\.gz$/)
    expect((await sql('select 1 from data.raw where client_id = $1', [clientId])).rowCount).toBe(0)
    expect((await sql('select 1 from auth.users where email = $1', [`smoke+${SLUG}@bcn-services.com`])).rowCount).toBe(0)

    const client = await sql('select 1 from data.clients where slug = $1', [SLUG])
    expect(client.rowCount).toBe(0)

    const media = await sql('select 1 from data.media where client_id = $1', [clientId])
    expect(media.rowCount).toBe(0)

    const objects = await sql('select 1 from storage.objects where name like $1', [`${clientId}/%`])
    expect(objects.rowCount).toBe(0)
  })

  it('§9 checklist refuses a Meta USER token and a bcns Google client, accepts a system user', async () => {
    const json = (body: unknown) => async () => new Response(JSON.stringify(body), { status: 200 })
    await expect(checklist('meta', 'America/New_York', { secret: 't', config: { act_id: 'act_1' } }, json({ data: { type: 'USER' } })))
      .rejects.toThrow(/M1/)
    const calls: string[] = []
    const metaOk = async (url: string | URL | Request) => {
      calls.push(String(url))
      return new Response(JSON.stringify(String(url).includes('debug_token')
        ? { data: { type: 'SYSTEM_USER' } } : { timezone_name: 'America/Los_Angeles', currency: 'USD' }))
    }
    const v = await checklist('meta', 'America/New_York', { secret: 't', config: { act_id: 'act_1' } }, metaOk as typeof fetch)
    expect(v.config).toEqual({ account_timezone: 'America/Los_Angeles', currency: 'USD' })
    expect(v.warnings[0]).toMatch(/^M3/)
    process.env.BCNS_OAUTH_CLIENT_ID = 'bcns-app'
    await expect(checklist('meet', 'UTC', { secret: '', refresh_secret: 'r', config: { oauth_client_id: 'bcns-app', folder_id: 'f' } }, json({})))
      .rejects.toThrow(/G1/)
    await expect(checklist('drive', 'UTC', { secret: '', refresh_secret: 'r', config: { oauth_client_id: 'bcns-app', folder_id: 'f' } }, json({})))
      .rejects.toThrow(/G1/)
    await expect(checklist('shopify', 'UTC', { secret: 'nope', config: { shop: 's' } }, json({}))).rejects.toThrow(/S1/)
    await expect(checklist('monday', 'UTC', { secret: 't', config: { board_id: '1' } }, json({ data: { boards: [{ columns: [{ id: 'c', title: 'Name', type: 'name' }] }] } })))
      .rejects.toThrow(/D1/)
  })
})
