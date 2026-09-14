// QA (item A4): connectors/index.ts <-> shopify.ts is an import cycle that only tolerates index.ts
// as the entry point. scripts/checklist.ts and worker/src/tokens.ts need the Shopify URL helpers
// without the registry, so those live in the import-free leaf shopify-url.ts. Each probe spawns a
// fresh process so the module cache is empty (an in-process import would reuse whatever loaded first).
import { describe, expect, it } from 'vitest'
import { execFileSync } from 'node:child_process'
import { writeFileSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

function importsInFreshProcess(...specifiers: string[]): { ok: boolean; error: string } {
  const dir = mkdtempSync(join(tmpdir(), 'qa-import-cycle-'))
  const script = join(dir, 'probe.mjs')
  const chain = specifiers.map(s => `import('${join(process.cwd(), s)}')`).join('.then(() => ') + ')'.repeat(specifiers.length - 1)
  writeFileSync(script, `${chain}.then(
      () => { console.log('OK'); process.exit(0) },
      (e) => { console.error('CRASH:' + e.message); process.exit(1) },
    )`)
  try {
    const out = execFileSync(join(process.cwd(), 'node_modules/.bin/tsx'), [script], { cwd: process.cwd(), encoding: 'utf8', stdio: 'pipe', timeout: 20_000 })
    return { ok: out.includes('OK'), error: '' }
  } catch (e: any) {
    return { ok: false, error: String(e.stdout ?? '') + String(e.stderr ?? '') }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

describe('cold-import ordering around the connectors registry', () => {
  it('scripts/checklist.ts imports cleanly as the first module (no registry edge)', () => {
    expect(importsInFreshProcess('scripts/checklist.ts')).toEqual({ ok: true, error: '' })
  }, 25_000)

  it('the URL helper leaf imports cleanly on its own', () => {
    expect(importsInFreshProcess('worker/src/connectors/shopify-url.ts')).toEqual({ ok: true, error: '' })
  }, 25_000)

  it('index.ts first, then checklist.ts, still works (the order every worker caller uses)', () => {
    expect(importsInFreshProcess('worker/src/connectors/index.ts', 'scripts/checklist.ts')).toEqual({ ok: true, error: '' })
  }, 25_000)
})
