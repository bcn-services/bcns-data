// QA finding (item A4, criterion 3 / engineer's own "Flags for Reviewer" note): scripts/checklist.ts
// now imports worker/src/connectors/shopify.js at runtime (previously type-only), adding a new
// runtime edge into the shopify.ts <-> connectors/index.ts cycle. Reproduces the crash this causes
// when that edge is the first thing to touch the connectors registry in a cold module graph
// (spawns a real subprocess so each run gets a fresh, empty module cache -- unlike an in-process
// dynamic import, which would just reuse whatever this file already loaded).
import { describe, expect, it } from 'vitest'
import { execFileSync } from 'node:child_process'
import { writeFileSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

function importAloneInFreshProcess(specifier: string): { ok: boolean; error: string } {
  const dir = mkdtempSync(join(tmpdir(), 'qa-import-cycle-'))
  const script = join(dir, 'probe.mjs')
  writeFileSync(script, `
    import('${specifier}').then(
      () => { console.log('OK'); process.exit(0) },
      (e) => { console.error('CRASH:' + e.message); process.exit(1) },
    )
  `)
  try {
    const out = execFileSync('corepack', ['pnpm', 'exec', 'tsx', script], { cwd: process.cwd(), encoding: 'utf8', stdio: 'pipe', timeout: 20_000 })
    return { ok: out.includes('OK'), error: '' }
  } catch (e: any) {
    return { ok: false, error: String(e.stdout ?? '') + String(e.stderr ?? '') }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

describe('FINDING: checklist.ts / shopify.ts cold-import ordering', () => {
  it('worker/src/connectors/shopify.ts crashes at import time when it is the first module to touch the registry', () => {
    const r = importAloneInFreshProcess(join(process.cwd(), 'worker/src/connectors/shopify.ts'))
    // This assertion documents the bug rather than requiring it fixed: it currently crashes.
    // If the engineer breaks the cycle, this test should be updated to assert `r.ok === true`.
    // Exact message depends on the runtime's circular-import handling (tsx/node: a TDZ
    // ReferenceError on `shopify`; vitest's esbuild transform: a plain TypeError on `.defaults`)
    // -- both are the same root cause, so match either.
    expect(r.ok).toBe(false)
    expect(r.error).toMatch(/shopify.*before initialization|reading 'defaults'/)
  }, 25_000)

  it('the same crash reproduces through scripts/checklist.ts, the criterion-3 file that added this edge', () => {
    const r = importAloneInFreshProcess(join(process.cwd(), 'scripts/checklist.ts'))
    expect(r.ok).toBe(false)
    expect(r.error).toMatch(/shopify.*before initialization|reading 'defaults'/)
  }, 25_000)

  it('importing connectors/index.ts first avoids the crash (the order every real caller happens to use today)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'qa-import-cycle-safe-'))
    const script = join(dir, 'probe.mjs')
    writeFileSync(script, `
      import('${join(process.cwd(), 'worker/src/connectors/index.ts')}').then(() =>
        import('${join(process.cwd(), 'scripts/checklist.ts')}')
      ).then(
        () => { console.log('OK'); process.exit(0) },
        (e) => { console.error('CRASH:' + e.message); process.exit(1) },
      )
    `)
    try {
      const out = execFileSync('corepack', ['pnpm', 'exec', 'tsx', script], { cwd: process.cwd(), encoding: 'utf8', stdio: 'pipe', timeout: 20_000 })
      expect(out).toContain('OK')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }, 25_000)
})
