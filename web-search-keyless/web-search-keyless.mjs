/**
 * web-search-keyless -- a `web_search` provider for DSH that needs no paid key by default.
 *
 * Registers a search provider (`keyless-http`) into `ctx.web`. Engines (config `engines`, tried in this order):
 *   duckduckgo  (default)  the Instant Answer API (JSON, a public endpoint) and the DuckDuckGo HTML results page
 *   bing        (opt-in)   the Bing HTML results page. It scrapes a page whose terms restrict automated access:
 *                          read Microsoft's terms before turning it on, and keep it to personal low-volume use.
 *   brave       (opt-in)   the Brave Search API, an official API with a key (env var `braveApiKeyEnv`,
 *                          default BRAVE_SEARCH_API_KEY; the key is never read from the config text).
 * An unknown engine, or `brave` without its key, throws at load so a typo is seen at start-up.
 *
 * To add another provider, add its name to ENGINES, a method that returns [{url, title, snippet}], and an entry in `byName`
 * inside `search()`; keep a keyed one opt-in and read its key from the environment.
 *
 * Public result pages sometimes serve a bot challenge instead of results, so the page engines are best-effort and the
 * results phase is retried once after a short pause when it comes back empty.
 *
 * Select it in the profile patch: `web.searchProvider: keyless-http`. Loaded through the patch file's `insert` list with a
 * relative `name`. NAMED EXPORTS ONLY (the loader does `exports.default ?? exports`, so a default export would hide `inject`).
 * Self-contained: no package imports, only global fetch. Honours AbortSignal.
 */

export const name = 'web-search-keyless'

export const inject = ['web']

const PROVIDER_ID = 'keyless-http'
// A realistic browser UA keeps automation-friendly SERPs (DDG html, Bing) from
// bottling the request; bare machine UAs get throttled quickly.
const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36'
const REQUEST_TIMEOUT_MS = 8000
const MAX_SNIPPET = 320
const MAX_QUERIED = 12
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308])
const RETRY_BEAT_MS = 400
const MAX_BODY_CHARS = 2_000_000 // a results page is a few hundred KB; anything past this is cut, not parsed

/** The engines this plugin knows. `duckduckgo` and `bing` read public pages (no key); `brave` calls Brave's search API with your key. */
export const ENGINES = ['duckduckgo', 'bing', 'brave']
const DEFAULT_ENGINES = ['duckduckgo'] // Bing and Brave are opt-in: Bing scrapes a page its terms restrict, Brave needs a key
const DEFAULT_BRAVE_KEY_ENV = 'BRAVE_SEARCH_API_KEY'

/**
 * Validate the plugin config and read the API key from the environment (never from the config text).
 * Throws on a value it cannot use, so a typo is seen at start-up and not as silently missing results.
 * @param {object|undefined} config `engines` (array of ENGINES, tried in order), `braveApiKeyEnv` (name of the env var holding the key)
 * @param {Record<string, string|undefined>} env usually process.env
 */
export function parseOptions(config, env) {
  const cfg = config !== null && typeof config === 'object' && !Array.isArray(config) ? config : {}
  const engines = cfg.engines === undefined ? DEFAULT_ENGINES : cfg.engines
  if (!Array.isArray(engines) || engines.length === 0 || engines.some((e) => !ENGINES.includes(e))) {
    throw new Error('web-search-keyless: engines must be a non-empty list of ' + ENGINES.join(', ') + ', got ' + JSON.stringify(engines))
  }
  const braveApiKeyEnv = typeof cfg.braveApiKeyEnv === 'string' && cfg.braveApiKeyEnv.length > 0 ? cfg.braveApiKeyEnv : DEFAULT_BRAVE_KEY_ENV
  const braveKey = env[braveApiKeyEnv] ?? ''
  if (engines.includes('brave') && braveKey.length === 0) {
    throw new Error('web-search-keyless: the brave engine needs an API key in the environment variable ' + braveApiKeyEnv)
  }
  const cap = cfg.braveMonthlyCap
  if (cap !== undefined && (!Number.isInteger(cap) || cap < 1)) {
    throw new Error('web-search-keyless: braveMonthlyCap must be a whole number >= 1, got ' + JSON.stringify(cap))
  }
  return { engines: [...new Set(engines)], braveKey, braveMonthlyCap: cap }
}

export class KeylessSearchProvider {
  id = PROVIDER_ID

  /** @param {{engines: string[], braveKey: string}} [options] from parseOptions; the default is DuckDuckGo only */
  constructor(options = { engines: DEFAULT_ENGINES, braveKey: '' }) {
    this.options = options
  }

  /** The engines need no login here (a missing key is refused at load), so it is always usable. */
  available() {
    return true
  }

  async search(request, signal) {
    if (signal?.aborted) throw searchAborted()
    const query = String(request.query ?? '').trim()
    if (query.length === 0) return { sources: [], truncated: false }
    const limit = Number.isInteger(request.maxResults) && request.maxResults > 0
      ? request.maxResults
      : 10

    const sources = []
    const content = []

    // DuckDuckGo Instant Answer API (entities / instant answers), when the duckduckgo engine is on.
    if (this.options.engines.includes('duckduckgo')) {
      try {
        const ia = await this.#instantAnswer(query, signal)
        if (ia !== null) {
          if (ia.text !== undefined) content.push(ia.text)
          for (const source of ia.sources) pushSource(sources, source)
        }
      } catch {
        // Non-fatal behind more capable result lists; nothing to surface.
      }
    }

    // The list engines in the configured order, best-effort, retried once when a challenge wiped them.
    const byName = {
      duckduckgo: (q, s) => this.#duckDuckGoHtml(q, s),
      bing: (q, s) => this.#bingHtml(q, s),
      brave: (q, s) => this.#braveApi(q, s, limit),
    }
    const notices = []
    const runEngines = async (names) => {
      for (const name of names) {
        if (sources.length >= limit) break
        try {
          for (const source of await byName[name](query, signal)) pushSource(sources, source)
        } catch (error) {
          if (error instanceof SearchNotice) notices.push(error.message) // a keyed engine says why it gave nothing
          else if (signal?.aborted) throw searchAborted()
          // any other failure of one engine is non-fatal
        }
      }
    }
    await runEngines(this.options.engines)
    // Page engines sometimes serve a challenge instead of results: one more try after a short pause, only when nothing came back.
    // Brave is not retried here (its errors are not random, and a repeat call would spend quota and hit the 1-per-second limit).
    if (sources.length === 0 && signal?.aborted !== true) {
      await sleep(RETRY_BEAT_MS)
      await runEngines(this.options.engines.filter((name) => name !== 'brave'))
    }
    if (sources.length === 0 && notices.length > 0) content.push('Search note: ' + [...new Set(notices)].join(' '))

    const out = sources.slice(0, limit)
    return {
      content: content.length > 0 ? content.join('\n') : undefined,
      sources: out,
      truncated: sources.length > limit,
    }
  }

  async #instantAnswer(query, signal) {
    const url = 'https://api.duckduckgo.com/?q=' + encodeURIComponent(query)
      + '&format=json&no_html=1&no_redirect=1&skip_disambig=1'
    const body = await httpGet(url, signal)
    if (body.status !== 200) return null
    let data
    try { data = JSON.parse(body.text) } catch { return null }

    const sources = []
    const collectTopic = (topic) => {
      if (topic !== null && typeof topic === 'object' && typeof topic.FirstURL === 'string' && typeof topic.Text === 'string') {
        sources.push({ url: topic.FirstURL, title: topic.Text.slice(0, 240) })
      }
    }
    if (typeof data.AbstractURL === 'string') {
      sources.push({
        url: data.AbstractURL,
        title: data.Heading || data.AbstractURL,
        snippet: typeof data.AbstractText === 'string' ? data.AbstractText.slice(0, MAX_SNIPPET) : undefined,
      })
    }
    for (const topic of data.RelatedTopics ?? []) {
      if (topic !== null && typeof topic === 'object' && Array.isArray(topic.Topics)) {
        for (const nested of topic.Topics) collectTopic(nested)
      } else {
        collectTopic(topic)
      }
    }

    let answer
    if (typeof data.Answer === 'string' && data.Answer.length > 0) {
      answer = 'Instant answer: ' + data.Answer
    } else if (typeof data.AbstractText === 'string' && data.AbstractText.length > 0) {
      answer = data.AbstractText.slice(0, 600)
    }
    return sources.length > 0 || answer !== undefined ? { text: answer, sources } : null
  }

  async #duckDuckGoHtml(query, signal) {
    const url = 'https://html.duckduckgo.com/html/?q=' + encodeURIComponent(query)
    const body = await httpGet(url, signal)
    if (body.status !== 200 || /anomaly|captcha|blocked|unusual traffic/i.test(body.text) || !body.text.includes('result__a')) {
      return []
    }
    const sources = []
    for (let cursor = 0; cursor < body.text.length && sources.length < MAX_QUERIED;) {
      const start = body.text.indexOf('result__a', cursor)
      if (start < 0) break
      const openAt = body.text.lastIndexOf('<a', start)
      const closeAt = body.text.indexOf('</a>', start)
      if (openAt < 0 || closeAt < 0) break
      const block = body.text.slice(openAt, closeAt + 4)
      const href = block.match(/href="([^"]*)"[\s\S]*?class="[^"]*result__a/) ?? block.match(/class="[^"]*result__a[\s\S]*?href="([^"]*)"/)
      const urlDecoded = href !== null ? decodeResultUrl(href[1]) : ''
      const title = cleanText(block)
      if (urlDecoded.length === 0 || title.length === 0) { cursor = start + 10; continue }
      const snippetAt = body.text.indexOf('result__snippet', closeAt)
      let snippet = ''
      if (snippetAt >= 0) {
        const snippetBlock = body.text.slice(body.text.lastIndexOf('<', snippetAt), body.text.indexOf('</a>', snippetAt) + 4)
        snippet = cleanText(snippetBlock)
        cursor = snippetAt + 10
      } else {
        cursor = closeAt + 4
      }
      sources.push({
        url: urlDecoded,
        title,
        snippet: snippet.length > 0 ? snippet.slice(0, MAX_SNIPPET) : undefined,
      })
    }
    return sources
  }

  /** Brave Search API (needs a key, sent in a header; a free tier exists). Official JSON, no page scraping. */
  async #braveApi(query, signal, limit) {
    const cap = this.options.braveMonthlyCap
    if (cap !== undefined && this.quota !== undefined && Date.now() < this.quota.resetAt && this.quota.used >= cap) {
      throw new SearchNotice('Brave is paused: this month\'s cap of ' + cap + ' searches is used up (it resumes when the quota window resets).')
    }
    const url = 'https://api.search.brave.com/res/v1/web/search?q=' + encodeURIComponent(query)
      + '&count=' + Math.min(Math.max(limit, 1), BRAVE_MAX_COUNT)
    const headers = { 'user-agent': 'dsh-web-search-keyless', 'accept': 'application/json', 'x-subscription-token': this.options.braveKey }
    let body = await httpGet(url, signal, headers)
    if (body.status === 429) { // the 1-per-second limit is the usual cause: wait a moment and try once more
      await sleep(BRAVE_RETRY_MS)
      body = await httpGet(url, signal, headers)
    }
    this.#rememberQuota(body.headers)
    if (body.status === 401 || body.status === 403 || body.status === 422) {
      throw new SearchNotice('Brave rejected the request (HTTP ' + body.status + '): check the API key and that the plan allows web search.')
    }
    if (body.status === 429) throw new SearchNotice('Brave rate limit or monthly quota reached (HTTP 429); try again later.')
    if (body.status !== 200) throw new SearchNotice('Brave answered HTTP ' + body.status + ' and gave no results.')
    let data
    try { data = JSON.parse(body.text) } catch { return [] }
    return parseBraveResults(data)
  }

  /** Keep the monthly usage Brave reports, so the cap can be enforced without a counter file (a restart just re-learns it from the next reply). */
  #rememberQuota(headers) {
    const quota = parseQuota(headers)
    if (quota !== null) this.quota = { used: quota.used, resetAt: Date.now() + quota.resetSeconds * 1000 }
  }

  async #bingHtml(query, signal) {
    const url = 'https://www.bing.com/search?q=' + encodeURIComponent(query) + '&setlang=en-US'
    const body = await httpGet(url, signal)
    if (body.status !== 200 || !body.text.includes('b_algo')) return []
    const sources = []
    const blockRe = /<li class="b_algo"[\s\S]*?<\/li>/g
    let block
    while ((block = blockRe.exec(body.text)) !== null) {
      const anchor = block[0].match(/<h2[^>]*>\s*<a[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/)
      if (anchor === null) continue
      const urlDecoded = decodeBingUrl(anchor[1])
      const title = cleanText(anchor[2])
      if (urlDecoded.length === 0 || title.length === 0) continue
      const caption = block[0].match(/<p[^>]*>([\s\S]*?)<\/p>/)
      const snippet = caption !== null ? cleanText(caption[1]) : ''
      sources.push({
        url: urlDecoded,
        title,
        snippet: snippet.length > 0 ? snippet.slice(0, MAX_SNIPPET) : undefined,
      })
      if (sources.length >= MAX_QUERIED) break
    }
    return sources
  }
}

/** Register the provider with the web seam. `config` is this plugin's block in the patch file (see parseOptions). */
export function apply(ctx, config) {
  ctx.web.registerSearchProvider(new KeylessSearchProvider(parseOptions(config, process.env)))
}

const BRAVE_MAX_COUNT = 20
const BRAVE_RETRY_MS = 1100

/** A message meant for the model or the user (a keyed engine saying why it gave nothing), as opposed to a quiet failure of a page scraper. */
class SearchNotice extends Error {}

/**
 * The monthly usage from Brave's rate-limit headers. They carry two values each, "per-second, per-month" (for example
 * `x-ratelimit-limit: 1, 2000`); this reads the second. Returns null when the headers are missing or not in that shape,
 * in which case no cap is enforced (the plan's own limit still applies). Brave's count can lag by a request.
 */
export function parseQuota(headers) {
  const pair = (name) => String(headers?.get?.(name) ?? '').split(',').map((v) => Number.parseInt(v.trim(), 10))
  const [limit, remaining, reset] = ['x-ratelimit-limit', 'x-ratelimit-remaining', 'x-ratelimit-reset'].map(pair)
  if (limit.length !== 2 || remaining.length !== 2 || reset.length !== 2) return null
  const values = [limit[1], remaining[1], reset[1]]
  if (values.some((v) => !Number.isInteger(v) || v < 0) || remaining[1] > limit[1]) return null
  return { used: limit[1] - remaining[1], resetSeconds: reset[1] }
}

/** Brave's `web.results` as sources (title, url, snippet); items without an http(s) URL or a title are dropped. */
export function parseBraveResults(data) {
  const results = data?.web?.results
  if (!Array.isArray(results)) return []
  const sources = []
  for (const item of results) {
    if (item === null || typeof item !== 'object' || typeof item.url !== 'string' || !/^https?:\/\//i.test(item.url)) continue
    const title = cleanText(item.title)
    if (title.length === 0) continue
    const snippet = cleanText(item.description)
    sources.push({ url: item.url, title, snippet: snippet.length > 0 ? snippet.slice(0, MAX_SNIPPET) : undefined })
    if (sources.length >= MAX_QUERIED) break
  }
  return sources
}

// --- shared HTTP + parsing helpers ------------------------------------------

/** GET one URL with a timeout; follows redirects; honours `signal`. `extraHeaders` (lower-case names) are added to, and win over, the page-reading defaults. */
async function httpGet(url, signal, extraHeaders = {}) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(new Error('request timed out')), REQUEST_TIMEOUT_MS)
  const onOuterAbort = () => controller.abort(new Error('request aborted'))
  signal?.addEventListener('abort', onOuterAbort, { once: true })
  try {
    const response = await fetch(url, {
      redirect: 'follow',
      headers: { 'user-agent': USER_AGENT, 'accept': 'text/html,application/xhtml+xml,application/json', ...extraHeaders },
      signal: controller.signal,
    })
    if (signal?.aborted) throw searchAborted()
    if (REDIRECT_STATUSES.has(response.status)) return { status: response.status, text: '', headers: response.headers }
    const text = (await response.text()).slice(0, MAX_BODY_CHARS)
    return { status: response.status, text, headers: response.headers }
  } catch (error) {
    if (signal?.aborted || (controller.signal.aborted && !signal?.aborted)) throw searchAborted()
    if (error?.name === 'AbortError') throw searchAborted()
    throw new Error('keyless search request failed: ' + String(error))
  } finally {
    clearTimeout(timer)
    signal?.removeEventListener('abort', onOuterAbort)
  }
}

/** A stable cancellation error the tool layer can render. */
function searchAborted() {
  return new Error('web search aborted')
}

/** Simple async delay that respects cancellation. */
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/** A protocol-relative or absolute http(s) URL, else ''. */
function solidUrl(href) {
  if (typeof href !== 'string') return ''
  if (href.startsWith('//')) return 'https:' + href
  if (/^https?:\/\//.test(href)) return href
  return ''
}

/** Decode a base64url payload to a plain string. */
function decodeBase64Url(encoded) {
  const padded = encoded.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(encoded.length / 4) * 4, '=')
  return atob(padded)
}

/** DuckDuckGo anchors point at /l/?uddg=<base64url>; decode to the real URL. */
export function decodeResultUrl(href) {
  try {
    const resolved = new URL(href.replace(/&amp;/g, '&'), 'https://duckduckgo.com')
    if (resolved.pathname === '/l/') {
      const encoded = resolved.searchParams.get('uddg')
      if (encoded) return solidUrl(decodeBase64Url(encoded))
    }
    return solidUrl(resolved.toString())
  } catch {
    return ''
  }
}

/** Bing wraps real URLs in /ck/a?!...&u=<marker><base64url>; decode to the real URL. */
export function decodeBingUrl(href) {
  try {
    const unescaped = href.replace(/&amp;/g, '&')
    const resolved = new URL(unescaped, 'https://www.bing.com')
    if (resolved.pathname === '/ck/a') {
      const raw = resolved.searchParams.get('u')
      if (raw) {
        // Bing prefixes the base64url payload with a short marker (currently
        // "a1"); a full-string decode is therefore misaligned and yields junk.
        // Try as-is, then with the marker stripped, and take the first payload
        // that decodes to a real http(s) URL. Works whether or not the marker
        // is present on any given day.
        for (const candidate of [raw, raw.replace(/^a1/, '')]) {
          const url = solidUrl(decodeBase64Url(candidate))
          if (url.length > 0) return url
        }
      }
    }
    return ''
  } catch {
    return ''
  }
}

/** Deduplicate a source by URL before appending. */
function pushSource(arr, source) {
  if (source === null || typeof source.url !== 'string' || source.url.length === 0) return
  if (arr.some((existing) => existing.url === source.url)) return
  arr.push(source)
}

/** One numeric character reference (`65`, `x41`, `X41`) as text; a value that is not a valid code point becomes a space. */
export function numericEntity(digits) {
  const hex = digits[0] === 'x' || digits[0] === 'X'
  const code = Number.parseInt(hex ? digits.slice(1) : digits, hex ? 16 : 10)
  return Number.isInteger(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : ' '
}

/** Drop tags and entities, collapse whitespace. */
export function cleanText(html) {
  return String(html ?? '')
    .replace(/<[^>]*>/g, ' ')
    .replace(/&#(x[0-9a-fA-F]{1,6}|[0-9]{1,7});?/g, (_, digits) => numericEntity(digits))
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ')
    .trim()
}
