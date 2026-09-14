// QA (item A4, criterion 1): shopHandle/shopifyEndpoint must normalize every shape an operator
// might type to the same Admin GraphQL endpoint. Independent of engineer's own tests/fixtures.
import { describe, expect, it } from 'vitest'
import { shopHandle, shopifyEndpoint } from '../worker/src/connectors/shopify-url.js'

const EXPECTED = 'https://foo.myshopify.com/admin/api/2026-07/graphql.json'

describe('shopHandle / shopifyEndpoint normalization', () => {
  it('accepts a bare handle, a bare domain, and a full https URL identically', () => {
    expect(shopifyEndpoint('foo')).toBe(EXPECTED)
    expect(shopifyEndpoint('foo.myshopify.com')).toBe(EXPECTED)
    expect(shopifyEndpoint('https://foo.myshopify.com/')).toBe(EXPECTED)
  })

  it('strips a trailing slash with no protocol', () => {
    expect(shopifyEndpoint('foo.myshopify.com/')).toBe(EXPECTED)
  })

  it('strips surrounding whitespace', () => {
    expect(shopifyEndpoint('  foo.myshopify.com  ')).toBe(EXPECTED)
    expect(shopHandle('  foo  ')).toBe('foo')
  })

  it('strips a path segment after the domain', () => {
    expect(shopifyEndpoint('foo.myshopify.com/admin/settings')).toBe(EXPECTED)
    expect(shopifyEndpoint('https://foo.myshopify.com/admin/settings')).toBe(EXPECTED)
  })

  it('an uppercase handle is still a valid (case-insensitive host) endpoint, even though the code does not lowercase it', () => {
    // FINDING: shopHandle does not call .toLowerCase(); host casing is preserved verbatim.
    // DNS/HTTP hosts are case-insensitive so this does not break the real request, but the
    // built string is not byte-identical to the lowercase form -- flagged in the QA report.
    const url = shopifyEndpoint('FOO.MYSHOPIFY.COM')
    expect(url.toLowerCase()).toBe(EXPECTED)
  })

  it('mutation guard: a shopHandle that returns its input unchanged breaks the bare-handle and https cases', () => {
    // This assertion is the one the (a) mutation check targets: if shopHandle degrades to
    // `(shop) => String(shop)`, these two must diverge from the https-normalized form.
    expect(shopifyEndpoint('foo')).toBe(shopifyEndpoint('https://foo.myshopify.com/'))
  })
})
