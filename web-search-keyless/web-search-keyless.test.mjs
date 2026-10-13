// Tests for the pure helpers of web-search-keyless.mjs. Run: node --test web-search-keyless.test.mjs
// (No network: the search itself is not exercised here.)
import test from 'node:test'
import assert from 'node:assert/strict'
import { cleanText, numericEntity, parseOptions, parseBraveResults, KeylessSearchProvider } from './web-search-keyless.mjs'

test('numeric character references decode in decimal and hex, either case of x', () => {
  assert.equal(numericEntity('65'), 'A')
  assert.equal(numericEntity('x41'), 'A')
  assert.equal(numericEntity('X41'), 'A')
  assert.equal(numericEntity('x1F600'), String.fromCodePoint(0x1f600))
})

test('a reference that is not a valid code point becomes a space instead of throwing', () => {
  assert.equal(numericEntity('xFFFFFF'), ' ')
  assert.equal(numericEntity('99999999'), ' ')
  assert.equal(numericEntity('0'), ' ')
})

test('cleanText drops tags, decodes entities (including odd ones) and collapses whitespace', () => {
  assert.equal(cleanText('<b>Tom</b> &amp; Jerry &#65; &#x42; &#xFFFFFF; end'), 'Tom & Jerry A B end')
  assert.equal(cleanText(null), '')
})

test('the default config uses DuckDuckGo only; bing and brave are opt-in', () => {
  assert.deepEqual(parseOptions(undefined, {}).engines, ['duckduckgo'])
  assert.deepEqual(parseOptions({}, {}).engines, ['duckduckgo'])
  assert.deepEqual(parseOptions({ engines: ['duckduckgo', 'bing'] }, {}).engines, ['duckduckgo', 'bing'])
})

test('a bad engine list throws at load (a typo is seen at start-up)', () => {
  for (const engines of [[], 'bing', ['google'], ['bing', 5]]) {
    assert.throws(() => parseOptions({ engines }, {}), /engines must be/)
  }
})

test('the brave engine needs its key in the environment, never in the config text', () => {
  assert.throws(() => parseOptions({ engines: ['brave'] }, {}), /BRAVE_SEARCH_API_KEY/)
  assert.throws(() => parseOptions({ engines: ['brave'], braveApiKey: 'abc' }, {}), /BRAVE_SEARCH_API_KEY/)
  assert.equal(parseOptions({ engines: ['brave'] }, { BRAVE_SEARCH_API_KEY: 'k1' }).braveKey, 'k1')
  assert.equal(parseOptions({ engines: ['brave'], braveApiKeyEnv: 'MY_KEY' }, { MY_KEY: 'k2' }).braveKey, 'k2')
})

test('brave results become sources; items without an http(s) URL or a title are dropped', () => {
  const data = { web: { results: [
    { title: 'A &amp; B', url: 'https://a.example/x', description: '<strong>desc</strong>' },
    { title: 'bad scheme', url: 'javascript:alert(1)' }, { title: '', url: 'https://c.example' }, null, { url: 5 },
  ] } }
  assert.deepEqual(parseBraveResults(data), [{ url: 'https://a.example/x', title: 'A & B', snippet: 'desc' }])
  assert.deepEqual(parseBraveResults({}), [])
  assert.deepEqual(parseBraveResults(null), [])
})

/** Run one search with fetch stubbed; returns the URLs and headers requested. */
async function searchWith(options, query = 'q') {
  const calls = []
  const realFetch = globalThis.fetch
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), headers: init?.headers ?? {} })
    const json = String(url).includes('brave') ? { web: { results: [{ title: 'T', url: 'https://t.example', description: 'd' }] } } : {}
    return new Response(JSON.stringify(json), { status: 200 })
  }
  try {
    const result = await new KeylessSearchProvider(options).search({ query }, undefined)
    return { calls, result }
  } finally {
    globalThis.fetch = realFetch
  }
}

test('with the default options the plugin never contacts bing or brave', async () => {
  const { calls } = await searchWith({ engines: ['duckduckgo'], braveKey: '' })
  assert.ok(calls.length > 0)
  assert.ok(calls.every((c) => /duckduckgo\.com/.test(c.url)), calls.map((c) => c.url).join(' '))
})

test('bing is contacted only when it is in engines', async () => {
  const off = await searchWith({ engines: ['duckduckgo'], braveKey: '' })
  assert.ok(!off.calls.some((c) => c.url.includes('bing.com')))
  const on = await searchWith({ engines: ['bing'], braveKey: '' })
  assert.ok(on.calls.some((c) => c.url.includes('bing.com')))
  assert.ok(!on.calls.some((c) => c.url.includes('duckduckgo.com')))
})

test('brave is called with the key in a header (not in the URL) and an honest user agent', async () => {
  const { calls, result } = await searchWith({ engines: ['brave'], braveKey: 'SECRET-KEY' })
  const call = calls.find((c) => c.url.includes('api.search.brave.com'))
  assert.ok(call)
  assert.equal(call.headers['x-subscription-token'], 'SECRET-KEY')
  assert.equal(call.headers['user-agent'], 'dsh-web-search-keyless')
  assert.ok(!call.url.includes('SECRET-KEY'))
  assert.equal(result.sources[0].url, 'https://t.example')
})
