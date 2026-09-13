import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  agentTools, createDataClient, DataClientError, runTool, signIn as dcSignIn, ToolInputError,
} from '../packages/data-client/src/index.js'
import { CLIENTS, decodeJwt, localKeys, mediaId, signIn, sql, SUPABASE_URL, USERS } from './helpers.js'

async function dataClientAs(user: (typeof USERS)[keyof typeof USERS]) {
  const { token } = await signIn(user)
  return createDataClient({ supabaseUrl: SUPABASE_URL, anonKey: localKeys().anon, accessToken: token })
}

describe('@bcn-services/data-client', () => {
  it('a view read returns only the caller tenant\'s rows', async () => {
    const dc = await dataClientAs(USERS.acmeMember)
    const { data, error } = await dc.views.money_v1()
    expect(error).toBeNull()
    expect(data!.length).toBeGreaterThan(0)
    for (const row of data!) expect(row.client_id).toBe(CLIENTS.acme)
  })

  it('rpc.save_record round-trips and rpc.delete_record removes it', async () => {
    const dc = await dataClientAs(USERS.acmeMember)
    const externalId = `dc-test-${Date.now()}`
    const id = await dc.rpc.save_record({ kind: 'note', attributes: { hello: 'world' }, external_id: externalId, title: 'DC test' })
    expect(typeof id).toBe('string')

    const { data: before } = await dc.views.records_v1().eq('id', id)
    expect(before).toHaveLength(1)
    expect(before![0].title).toBe('DC test')

    await dc.rpc.delete_record({ record_id: id })

    const { data: after } = await dc.views.records_v1().eq('id', id)
    expect(after).toHaveLength(0) // records_v1 excludes soft-deleted rows

    const row = await sql('select deleted_at from data.records where id = $1', [id])
    expect(row.rows[0].deleted_at).not.toBeNull()
  })

  it('a cross-tenant download_url throws DataClientError not_found', async () => {
    const dc = await dataClientAs(USERS.acmeMember)
    await expect(dc.rpc.download_url({ media_id: mediaId('beta', 1) })).rejects.toMatchObject({
      code: 'not_found',
      sqlstate: 'BCNS4',
    })
    await expect(dc.rpc.download_url({ media_id: mediaId('beta', 1) })).rejects.toBeInstanceOf(DataClientError)
  })

  it('remove_member as a member throws DataClientError forbidden_role', async () => {
    const dc = await dataClientAs(USERS.acmeMember)
    await expect(dc.rpc.remove_member({ target_user_id: USERS.acmeOwner.id })).rejects.toMatchObject({
      code: 'forbidden_role',
      sqlstate: 'BCNS2',
    })
  })

  it('health() reads client_v1 for the active tenant', async () => {
    const dc = await dataClientAs(USERS.acmeMember)
    const health = await dc.health()
    expect(health).toMatchObject({
      client_id: CLIENTS.acme,
      source: 'platform',
      slug: 'acme',
      status: 'active',
      timezone: 'America/New_York',
    })
    expect(typeof health.egress_quota_bytes).toBe('number')
  })

  it('media.upload stores a file and media.downloadUrl signs it, cleaned up after', async () => {
    const dc = await dataClientAs(USERS.acmeMember)
    const bytes = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64')
    const file = new File([bytes], `dc-test-${Date.now()}.png`, { type: 'image/png' })

    const mediaIdCreated = await dc.media.upload(file, { title: 'DC upload test', tags: ['dc-test'] })
    expect(typeof mediaIdCreated).toBe('string')

    const url = await dc.media.downloadUrl(mediaIdCreated)
    expect(url).toMatch(/^https?:\/\//)

    const n = await dc.rpc.delete_media({ media_ids: [mediaIdCreated] })
    expect(n).toBe(1)
  })
})

describe('signIn', () => {
  afterEach(() => vi.useRealTimers())

  it('returns a client whose health() reads the seeded tenant', async () => {
    const dc = await dcSignIn({ supabaseUrl: SUPABASE_URL, anonKey: localKeys().anon, ...USERS.acmeMember })
    const health = await dc.health()
    expect(health).toMatchObject({ client_id: CLIENTS.acme, slug: 'acme' })
  })

  it('rejects a bad password', async () => {
    await expect(
      dcSignIn({ supabaseUrl: SUPABASE_URL, anonKey: localKeys().anon, email: USERS.acmeMember.email, password: 'wrong' }),
    ).rejects.toThrow(/sign-in failed/)
  })

  // NOTES: spec text expects 'access token has no client_id claim' (decodeClientId, reused here
  // as defense-in-depth) for a no-membership user. Unreachable as written against this schema:
  // custom_access_token_hook (20260912000200_access.sql:12) 403s sign-in at GoTrue *before* any
  // session/token exists, so signInWithPassword itself errors — decodeClientId never runs. The
  // reachable behavior is the generic 'sign-in failed: ...' path with the hook's own message.
  it('USERS.nobody rejects at sign-in (no membership row, blocked by the access-token hook)', async () => {
    await expect(dcSignIn({ supabaseUrl: SUPABASE_URL, anonKey: localKeys().anon, ...USERS.nobody })).rejects.toThrow(
      /sign-in failed:.*no membership/,
    )
  })

  it('refreshes when within 60s of expiry and shares one in-flight refresh across concurrent callers', async () => {
    const dc = await dcSignIn({ supabaseUrl: SUPABASE_URL, anonKey: localKeys().anon, ...USERS.acmeMember })
    const before = await dc.accessToken()
    const { exp } = decodeJwt(before)

    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime((exp - 30) * 1000) // within 60s of expiry

    const [a, b] = await Promise.all([dc.accessToken(), dc.accessToken()])
    expect(a).toBe(b)
    expect(a).not.toBe(before)

    vi.useRealTimers()
    const health = await dc.health()
    expect(health.client_id).toBe(CLIENTS.acme)
  })
})

describe('agentTools / runTool', () => {
  it('default view list excludes customers_v1 and memberships_v1', () => {
    const readView = agentTools().find((t) => t.name === 'read_view')!
    const views = (readView.input_schema.properties as any).view.enum as string[]
    expect(views).not.toContain('customers_v1')
    expect(views).not.toContain('memberships_v1')
    expect(views).toContain('money_v1')
  })

  it('read_view: tenant-scoped rows, date range + eq filter + limit honoured, truncated flag', async () => {
    const dc = await dataClientAs(USERS.acmeMember)
    const result = (await runTool(dc, 'read_view', {
      view: 'money_v1',
      filters: [{ column: 'client_id', value: CLIENTS.acme }],
      date_from: '2000-01-01',
      date_to: '2100-01-01',
      limit: 1,
    })) as { rows: any[]; count: number; truncated: boolean }
    expect(result.rows.length).toBe(1)
    expect(result.count).toBe(1)
    expect(result.truncated).toBe(true)
    for (const row of result.rows) expect(row.client_id).toBe(CLIENTS.acme)
  })

  it('read_view: bad column, unknown view, not-exposed view, and bad date all throw ToolInputError', async () => {
    const dc = await dataClientAs(USERS.acmeMember)
    await expect(runTool(dc, 'read_view', { view: 'money_v1', columns: ['bad col'] })).rejects.toBeInstanceOf(ToolInputError)
    await expect(runTool(dc, 'read_view', { view: 'not_a_real_view' })).rejects.toBeInstanceOf(ToolInputError)
    await expect(runTool(dc, 'read_view', { view: 'customers_v1' })).rejects.toBeInstanceOf(ToolInputError)
    await expect(runTool(dc, 'read_view', { view: 'money_v1', date_from: '01/01/2024' })).rejects.toBeInstanceOf(ToolInputError)
    await expect(runTool(dc, 'read_view', { view: 'client_v1', date_from: '2024-01-01' })).rejects.toBeInstanceOf(ToolInputError)
  })

  it('rpc tools are absent by default; save_record round-trips only when opted in', async () => {
    const dc = await dataClientAs(USERS.acmeMember)
    expect(agentTools().map((t) => t.name)).not.toContain('save_record')

    await expect(
      runTool(dc, 'save_record', { kind: 'note', attributes: {} }),
    ).rejects.toBeInstanceOf(ToolInputError)

    const externalId = `agent-tool-test-${Date.now()}`
    const id = (await runTool(
      dc,
      'save_record',
      { kind: 'note', attributes: { hello: 'agent' }, external_id: externalId, title: 'agent tool test' },
      { rpcs: ['save_record'] },
    )) as string
    expect(typeof id).toBe('string')
    await dc.rpc.delete_record({ record_id: id })
  })

  it('rpc tool inputs are type/shape-validated at the trust boundary before reaching the DB', async () => {
    const dc = await dataClientAs(USERS.acmeMember)
    const uuid = () => '00000000-0000-4000-8000-' + Math.random().toString(16).slice(2).padEnd(12, '0').slice(0, 12)

    // bulk_tag.media_ids: over the documented 500-item cap
    await expect(
      runTool(dc, 'bulk_tag', { media_ids: Array.from({ length: 501 }, uuid) }, { rpcs: ['bulk_tag'] }),
    ).rejects.toBeInstanceOf(ToolInputError)

    // bulk_tag.media_ids: wrong type (string instead of array)
    await expect(
      runTool(dc, 'bulk_tag', { media_ids: 'not-an-array' }, { rpcs: ['bulk_tag'] }),
    ).rejects.toBeInstanceOf(ToolInputError)

    // bulk_tag.media_ids: array of non-uuid-shaped strings
    await expect(
      runTool(dc, 'bulk_tag', { media_ids: ['not-a-uuid'] }, { rpcs: ['bulk_tag'] }),
    ).rejects.toBeInstanceOf(ToolInputError)

    // save_record.attributes: wrong type (array instead of object)
    await expect(
      runTool(dc, 'save_record', { kind: 'note', attributes: [] }, { rpcs: ['save_record'] }),
    ).rejects.toBeInstanceOf(ToolInputError)

    // update_media.tags: over the documented 50-item cap
    await expect(
      runTool(
        dc,
        'update_media',
        { media_id: uuid(), tags: Array.from({ length: 51 }, (_, i) => `t${i}`) },
        { rpcs: ['update_media'] },
      ),
    ).rejects.toBeInstanceOf(ToolInputError)

    // bulk_tag.add: over the 50-item cap
    await expect(
      runTool(dc, 'bulk_tag', { media_ids: [uuid()], add: Array.from({ length: 51 }, (_, i) => `t${i}`) }, { rpcs: ['bulk_tag'] }),
    ).rejects.toBeInstanceOf(ToolInputError)
  })
})
