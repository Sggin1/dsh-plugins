/**
 * web-search-keyless — a $0 keyless `web_search` provider for DSH.
 *
 * The base bundle ships `web-search-deepseek`, which calls the DeepSeek hosted
 * API for every search (needs DEEPSEEK_API_KEY). This plugin registers a second
 * search provider into `ctx.web` that never touches a paid API: it reads public
 * search endpoints directly with plain fetch.
 *
 *   engines, in order of preference:
 *     1. DuckDuckGo Instant Answer API — entities / instant answers (JSON, no
 *        auth, stable — the dependable core of this provider).
 *     2. DuckDuckGo HTML results page  — result lists (html.duckduckgo.com).
 *     3. Bing HTML results page        — result lists (www.bing.com/search).
 *
 * Public SERP engines occasionally serve bot challenges (a 200/202/429 page
 * with no result markup) in place of results, so list engines are best-effort
 * and the whole results phase is retried once after a short beat when it comes
 * back empty. Instant answers never depend on that luck.
 *
 * Selection: `web.searchProvider` is pinned to `keyless-http` in the profile
 * patch layer (cordis.patch.yml here), overriding the base bundle's
 * `deepseek-official`. To go back to the paid DeepSeek search, flip that pin.
 *
 * Same insertion contract as live-model-refresh.mjs: loaded via the patch
 * file's `insert` list with a relative `name`, imported as a file:// URL.
 * NAMED EXPORTS ONLY — no `default` (the loader's `unwrapExports` does
 * `exports.default ?? exports`, so a default export would hide `inject`).
 *
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

export class KeylessSearchProvider {
  id = PROVIDER_ID

  /** No credentials to check — always usable. */
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

    // 1) DuckDuckGo Instant Answer API (entities / instant answers).
    try {
      const ia = await this.#instantAnswer(query, signal)
      if (ia !== null) {
        if (ia.text !== undefined) content.push(ia.text)
        for (const source of ia.sources) pushSource(sources, source)
      }
    } catch {
      // Non-fatal behind more capable result lists; nothing to surface.
    }

    // 2 + 3) List engines, best-effort, retried once when a challenge wiped them.
    const listEngines = [
      (q, s) => this.#duckDuckGoHtml(q, s),
      (q, s) => this.#bingHtml(q, s),
    ]
    for (let attempt = 0; attempt < 2 && sources.length < limit; attempt++) {
      for (const engine of listEngines) {
        if (sources.length >= limit) break
        try {
          for (const source of await engine(query, signal)) pushSource(sources, source)
        } catch {
          // Non-fatal per engine.
        }
      }
      if (attempt === 0 && sources.length === 0 && signal?.aborted !== true) await sleep(RETRY_BEAT_MS)
    }

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

/** Register the provider with the web seam. */
export function apply(ctx) {
  ctx.web.registerSearchProvider(new KeylessSearchProvider())
}

// --- shared HTTP + parsing helpers ------------------------------------------

/** GET one public URL with a timeout; follows redirects; honours `signal`. */
async function httpGet(url, signal) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(new Error('request timed out')), REQUEST_TIMEOUT_MS)
  const onOuterAbort = () => controller.abort(new Error('request aborted'))
  signal?.addEventListener('abort', onOuterAbort, { once: true })
  try {
    const response = await fetch(url, {
      redirect: 'follow',
      headers: { 'user-agent': USER_AGENT, 'accept': 'text/html,application/xhtml+xml,application/json' },
      signal: controller.signal,
    })
    if (signal?.aborted) throw searchAborted()
    if (REDIRECT_STATUSES.has(response.status)) return { status: response.status, text: '' }
    const text = await response.text()
    return { status: response.status, text }
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

/** Drop tags and entities, collapse whitespace. */
export function cleanText(html) {
  return String(html ?? '')
    .replace(/<[^>]*>/g, ' ')
    .replace(/&#(x?[0-9a-fA-F]{1,6});?/g, (_, digits) => String.fromCodePoint(Number.parseInt(digits, digits[0].toLowerCase() === 'x' ? 16 : 10)))
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ')
    .trim()
}
