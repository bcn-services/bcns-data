// add-member --slug --email [--owner] | add-member --slug --agent  (DESIGN.md §5.10, §8)
//
// NOTES: DESIGN says "invite email via Auth admin API" (auth.admin.inviteUserByEmail). That needs a
// working mail sender; this local stack's inbucket is stopped so the invite 500s and creates no
// user. Tries inviteUserByEmail first (the real path once mail is configured); on failure falls
// back to admin.createUser with a printed one-time password.
//
// --agent mints a platform agent user instead: no invite (no mailbox to receive one), always a
// fresh password, role always member, is_smoke always false. Re-running rotates the password
// (admin.updateUserById on an existing user) the same way rotate-smoke rotates the smoke user.
import { parseArgs } from 'node:util'
import { randomBytes } from 'node:crypto'
import { die, pgClient, serviceClient, clientIdForSlug, isMain, runMain } from './_lib.js'

export async function main(argv: string[]): Promise<void> {
  const { values } = parseArgs({
    args: argv,
    options: {
      slug: { type: 'string' },
      email: { type: 'string' },
      owner: { type: 'boolean' },
      agent: { type: 'boolean' },
    },
  })
  const { slug, agent } = values
  if (!slug) die('usage: add-member --slug <slug> --email <email> [--owner] | add-member --slug <slug> --agent')
  if (agent && (values.email || values.owner)) die('usage: --agent cannot be combined with --email or --owner')
  if (!agent && !values.email) die('usage: add-member --slug <slug> --email <email> [--owner]')

  const email = agent ? `agent+${slug}@bcn-services.com` : (values.email as string)
  const role = agent ? 'member' : values.owner ? 'owner' : 'member'

  const db = pgClient()
  try {
    const clientId = await clientIdForSlug(db, slug)
    const admin = serviceClient()

    let userId: string
    if (agent) {
      const password = randomBytes(18).toString('base64url')
      const created = await admin.auth.admin.createUser({ email, password, email_confirm: true })
      if (created.data.user) {
        userId = created.data.user.id
      } else {
        const existing = await db.query<{ id: string }>('select id from auth.users where email = $1', [email])
        if (existing.rowCount === 0) die(`create user: ${created.error?.message}`)
        userId = existing.rows[0].id
        const { error } = await admin.auth.admin.updateUserById(userId, { password })
        if (error) die(`rotate password: ${error.message}`)
      }
      console.log(`agent user: ${email}`)
      console.log(`agent password (save now, shown once): ${password}`)
    } else {
      const invite = await admin.auth.admin.inviteUserByEmail(email)
      if (invite.data.user) {
        userId = invite.data.user.id
        console.log(`invited ${email}`)
      } else {
        const password = randomBytes(18).toString('base64url')
        const { data, error } = await admin.auth.admin.createUser({ email, password, email_confirm: true })
        if (error || !data.user) die(`create user: ${error?.message ?? invite.error?.message}`)
        userId = data.user.id
        console.log(`invite email unavailable (${invite.error?.message}); created ${email} directly`)
        console.log(`temporary password (save now, shown once): ${password}`)
      }
    }

    await db.query(
      `insert into data.memberships (user_id, client_id, role, is_smoke) values ($1, $2, $3, false)
       on conflict (user_id) do update set client_id = excluded.client_id, role = excluded.role, is_smoke = false`,
      [userId, clientId, role],
    )
    console.log(`added ${email} to ${slug} as ${role}`)
  } finally {
    await db.end()
  }
}

if (isMain(import.meta.url)) runMain(main)
