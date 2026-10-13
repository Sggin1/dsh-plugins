// Tests for the pure helpers of web-search-keyless.mjs. Run: node --test web-search-keyless.test.mjs
// (No network: the search itself is not exercised here.)
import test from 'node:test'
import assert from 'node:assert/strict'
import { cleanText, numericEntity, parseOptions, parseBraveResults, parseQuota, KeylessSearchProvider } from './web-search-keyless.mjs'

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

// --- Brave: errors the model can see, one retry on 429, and the monthly cap ---

const braveBody = { web: { results: [{ title: 'T', url: 'https://t.example', description: 'd' }] } }
const quotaHeaders = (used, resetSeconds = 100, limit = 2000) => ({
  'x-ratelimit-limit': '1, ' + limit, 'x-ratelimit-remaining': '1, ' + (limit - used), 'x-ratelimit-reset': '1, ' + resetSeconds,
})

/** Search with a scripted fetch: `replies` is a list of [status, body, headers] used in order for brave calls; others get {}. */
async function braveSearch(options, replies, searches = 1, query = 'q') {
  const queue = [...replies]
  const braveCalls = []
  const realFetch = globalThis.fetch
  globalThis.fetch = async (url) => {
    if (!String(url).includes('api.search.brave.com')) return new Response('{}', { status: 200 })
    braveCalls.push(String(url))
    const [status, body, headers] = queue.length > 1 ? queue.shift() : queue[0]
    return new Response(JSON.stringify(body), { status, headers })
  }
  try {
    const provider = new KeylessSearchProvider({ braveKey: 'K', ...options })
    let result
    for (let i = 0; i < searches; i++) result = await provider.search({ query, maxResults: 10 }, undefined)
    return { result, braveCalls }
  } finally {
    globalThis.fetch = realFetch
  }
}

test('parseQuota reads the monthly numbers from the two-value headers and refuses anything else', () => {
  const headers = (o) => new Headers(o)
  assert.deepEqual(parseQuota(headers(quotaHeaders(250, 1637172))), { used: 250, resetSeconds: 1637172 })
  assert.equal(parseQuota(headers({})), null)
  assert.equal(parseQuota(headers({ 'x-ratelimit-limit': '2000', 'x-ratelimit-remaining': '1999', 'x-ratelimit-reset': '5' })), null)
  assert.equal(parseQuota(headers({ ...quotaHeaders(0), 'x-ratelimit-remaining': '1, 99999' })), null)
  assert.equal(parseQuota(undefined), null)
})

test('braveMonthlyCap must be a whole number of at least 1', () => {
  assert.equal(parseOptions({ engines: ['brave'], braveMonthlyCap: 250 }, { BRAVE_SEARCH_API_KEY: 'k' }).braveMonthlyCap, 250)
  assert.equal(parseOptions({}, {}).braveMonthlyCap, undefined)
  for (const bad of [0, -1, 2.5, '250', null]) assert.throws(() => parseOptions({ braveMonthlyCap: bad }, {}), /braveMonthlyCap/)
})

test('a rejected key gives no results and a note the model can read', async () => {
  const { result } = await braveSearch({ engines: ['brave'] }, [[401, {}, {}]])
  assert.equal(result.sources.length, 0)
  assert.match(result.content, /Search note: Brave rejected the request \(HTTP 401\)/)
})

test('a 429 is retried once, and a second 429 is reported (not silent)', async () => {
  const ok = await braveSearch({ engines: ['brave'] }, [[429, {}, {}], [200, braveBody, {}]])
  assert.equal(ok.braveCalls.length, 2)
  assert.equal(ok.result.sources.length, 1)
  const failed = await braveSearch({ engines: ['brave'] }, [[429, {}, {}]])
  assert.equal(failed.braveCalls.length, 2)
  assert.match(failed.result.content, /rate limit or monthly quota/)
})

test('brave returning fewer results than asked for is not called a second time', async () => {
  const { braveCalls } = await braveSearch({ engines: ['brave'] }, [[200, braveBody, {}]])
  assert.equal(braveCalls.length, 1)
})

test('the monthly cap pauses brave once the reported usage reaches it, and says so when nothing else answers', async () => {
  const first = await braveSearch({ engines: ['brave'], braveMonthlyCap: 250 }, [[200, braveBody, quotaHeaders(250)]], 2)
  assert.equal(first.braveCalls.length, 1, 'the second search must not call brave')
  assert.match(first.result.content, /this month's cap of 250/)
  const under = await braveSearch({ engines: ['brave'], braveMonthlyCap: 250 }, [[200, braveBody, quotaHeaders(100)]], 2)
  assert.equal(under.braveCalls.length, 2)
})

test('with the cap reached, the next engine in the list still answers and no cap note is shown', async () => {
  const realFetch = globalThis.fetch
  const braveCalls = []
  globalThis.fetch = async (url) => {
    const u = String(url)
    if (u.includes('api.search.brave.com')) {
      braveCalls.push(u)
      return new Response(JSON.stringify(braveBody), { status: 200, headers: quotaHeaders(5) })
    }
    if (u.includes('api.duckduckgo.com')) {
      return new Response(JSON.stringify({ AbstractURL: 'https://d.example/page', Heading: 'D page', AbstractText: 'about d' }), { status: 200 })
    }
    return new Response('', { status: 200 })
  }
  try {
    const provider = new KeylessSearchProvider({ engines: ['brave', 'duckduckgo'], braveKey: 'K', braveMonthlyCap: 1 })
    await provider.search({ query: 'q', maxResults: 10 }, undefined) // learns the usage (5 >= cap 1)
    const second = await provider.search({ query: 'q2', maxResults: 10 }, undefined)
    assert.equal(braveCalls.length, 1, 'brave must not be called again once the cap is reached')
    assert.ok(second.sources.some((x) => x.url === 'https://d.example/page'), 'duckduckgo should have answered')
    assert.ok(!/cap of 1/.test(second.content ?? ''), 'no cap note when another engine produced results')
  } finally {
    globalThis.fetch = realFetch
  }
})

// --- hardening from the second review ---

test('Instant Answer links that are not http(s) are dropped, and an empty AbstractURL makes no source', async () => {
  const realFetch = globalThis.fetch
  globalThis.fetch = async (url) => {
    if (String(url).includes('api.duckduckgo.com')) {
      return new Response(JSON.stringify({
        AbstractURL: 'javascript:alert(1)', Heading: 'bad',
        RelatedTopics: [{ FirstURL: 'file:///etc/passwd', Text: 'bad' }, { FirstURL: 'https://ok.example/a', Text: 'good' }],
      }), { status: 200 })
    }
    return new Response('', { status: 200 })
  }
  try {
    const result = await new KeylessSearchProvider({ engines: ['duckduckgo'], braveKey: '' }).search({ query: 'q', maxResults: 10 }, undefined)
    assert.deepEqual(result.sources.map((s) => s.url), ['https://ok.example/a'])
  } finally {
    globalThis.fetch = realFetch
  }
})

test('an API key with spaces or control characters is refused at load, and the message does not show it', () => {
  for (const bad of ['abc def', 'abc\ndef', 'abc\u0007def', 'café']) {
    let message = ''
    try { parseOptions({ engines: ['brave'] }, { BRAVE_SEARCH_API_KEY: bad }) } catch (error) { message = error.message }
    assert.match(message, /cannot be in an API key/)
    assert.ok(!message.includes(bad), 'the key must not appear in the message')
  }
  assert.equal(parseOptions({ engines: ['brave'] }, { BRAVE_SEARCH_API_KEY: '  good-key_123  ' }).braveKey, 'good-key_123')
})

test('the Brave request refuses redirects, so the key header cannot follow one', async () => {
  const realFetch = globalThis.fetch
  let redirectMode
  globalThis.fetch = async (url, init) => {
    if (String(url).includes('api.search.brave.com')) redirectMode = init.redirect
    return new Response(JSON.stringify(braveBody), { status: 200 })
  }
  try {
    await new KeylessSearchProvider({ engines: ['brave'], braveKey: 'K' }).search({ query: 'q', maxResults: 10 }, undefined)
    assert.equal(redirectMode, 'error')
  } finally {
    globalThis.fetch = realFetch
  }
})

test('an aborted signal sends no request at all', async () => {
  const realFetch = globalThis.fetch
  let calls = 0
  globalThis.fetch = async () => { calls += 1; return new Response('{}', { status: 200 }) }
  try {
    const controller = new AbortController()
    controller.abort()
    await assert.rejects(new KeylessSearchProvider({ engines: ['brave', 'duckduckgo'], braveKey: 'K' }).search({ query: 'q' }, controller.signal))
    assert.equal(calls, 0)
  } finally {
    globalThis.fetch = realFetch
  }
})

test('with only brave listed, an empty answer does not wait for a pointless page-engine retry', async () => {
  const started = Date.now()
  await braveSearch({ engines: ['brave'] }, [[401, {}, {}]])
  assert.ok(Date.now() - started < 300, 'took ' + (Date.now() - started) + ' ms')
})

test('parseQuota refuses numbers with trailing text and clamps a huge reset to about a month', () => {
  const headers = (o) => new Headers(o)
  assert.equal(parseQuota(headers({ ...quotaHeaders(0), 'x-ratelimit-remaining': '1, 5abc' })), null)
  assert.equal(parseQuota(headers({ ...quotaHeaders(0), 'x-ratelimit-reset': '1, 99999999' })).resetSeconds, 35 * 24 * 3600)
})

test('cleanText stays fast on a long run of "<" with no closing ">"', () => {
  const started = Date.now()
  cleanText('<'.repeat(200000))
  assert.ok(Date.now() - started < 1000, 'took ' + (Date.now() - started) + ' ms')
})
