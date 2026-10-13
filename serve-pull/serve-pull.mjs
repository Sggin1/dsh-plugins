/**
 * serve-pull — models Serve is running show up in DSH by themselves.
 *
 * Every POLL_MS this asks Serve (GET <serveUrl>/api/harness/dsh) which servers are up and makes the `llm-pi-ai`
 * providers whose key starts with `serve-` match: new ones are added, changed ones updated, ones that are no longer
 * running removed. Nothing else in the providers list is touched (openrouter, hand-made entries, ...), and
 * if Serve does not answer nothing is changed at all. Writes go through DSH's own settings API (`settings.mutate`), the
 * same one live-model-refresh uses, so DSH's writer keeps the file's comments and there is no second writer.
 * live-model-refresh then adds the [up] / [down] marker and keeps the model list fresh, as it does for every provider;
 * this plugin never fights it: displayName is compared without the marker and an existing provider only gets the
 * fields that differ.
 *
 * Config (in cordis.patch.yml): serveUrl (default http://127.0.0.1:7070), apiKeyEnv (the env var DSH requires on a
 * provider; the value can be anything for a local server), pollMs (default 10000).
 *
 * NAMED EXPORTS ONLY — no `default` (see live-model-refresh.mjs). The pure functions are exported for the tests.
 */

export const name = 'serve-pull'

export const inject = ['settings', 'timer']

const NS = 'llm-pi-ai'
const PREFIX = 'serve-'
const MARKER = /\s*\[(?:up|down)\]\s*$/

const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v)

/** The model: id, name, limits, and (when Serve says the model thinks) the thinking switch and its format. */
function modelFor(entry) {
  const model = { id: entry.modelId, name: entry.displayName, contextWindow: entry.contextWindow, maxTokens: entry.maxTokens }
  if (isObject(entry.reasoningEfforts)) model.reasoningEfforts = entry.reasoningEfforts
  if (typeof entry.thinkingFormat === 'string') model.compat = { thinkingFormat: entry.thinkingFormat }
  return model
}

/** The provider as DSH wants it, from one of Serve's entries. */
export function providerFor(entry, apiKeyEnv) {
  const provider = {
    displayName: entry.displayName,
    api: 'openai-completions',
    baseURL: entry.baseURL,
    transport: 'sse',
    defaultInput: Array.isArray(entry.input) && entry.input.length > 0 ? entry.input : ['text'],
    defaultContextWindow: entry.contextWindow,
    defaultMaxTokens: entry.maxTokens,
    models: [modelFor(entry)],
  }
  if (apiKeyEnv) provider.apiKeyEnv = apiKeyEnv
  return provider
}

const plainName = (displayName) => (typeof displayName === 'string' ? displayName.replace(MARKER, '') : '')

const sameThinking = (found, model) => JSON.stringify(found.reasoningEfforts ?? null) === JSON.stringify(model.reasoningEfforts ?? null)
  && (found.compat?.thinkingFormat ?? null) === (model.compat?.thinkingFormat ?? null)

/** True when an existing provider already says what Serve says (the [up] / [down] marker and extra model fields ignored). */
export function sameProvider(have, want) {
  if (!isObject(have)) return false
  const scalar = ['baseURL', 'api', 'defaultContextWindow', 'defaultMaxTokens', 'apiKeyEnv']
  if (scalar.some((k) => want[k] !== undefined && have[k] !== want[k])) return false
  if (plainName(have.displayName) !== want.displayName) return false
  const model = want.models[0]
  const found = Array.isArray(have.models) ? have.models.find((m) => isObject(m) && m.id === model.id) : undefined
  return found !== undefined && found.contextWindow === model.contextWindow && found.maxTokens === model.maxTokens
    && have.models.length === 1 && sameThinking(found, model)
}

/**
 * The settings operations that make the `serve-` providers match Serve's list.
 * @param {Record<string, unknown>} providers the current llm-pi-ai providers
 * @param {Array<object>} entries Serve's list (key, displayName, baseURL, modelId, contextWindow, maxTokens)
 */
export function diffOps(providers, entries, apiKeyEnv) {
  const ops = []
  const wanted = new Set()
  for (const entry of entries) {
    const key = entry.key
    if (typeof key !== 'string' || !key.startsWith(PREFIX)) continue
    wanted.add(key)
    const want = providerFor(entry, apiKeyEnv)
    const have = providers[key]
    if (sameProvider(have, want)) continue
    if (!isObject(have)) { ops.push({ op: 'set', path: ['providers', key], value: want }); continue }
    for (const [field, value] of Object.entries(want)) {
      if (field === 'displayName' && plainName(have.displayName) === value) continue
      ops.push({ op: 'set', path: ['providers', key, field], value })
    }
  }
  for (const key of Object.keys(providers)) {
    if (key.startsWith(PREFIX) && !wanted.has(key)) ops.push({ op: 'unset', path: ['providers', key] })
  }
  return ops
}

export function apply(ctx, config) {
  const cfg = isObject(config) ? config : {}
  const serveUrl = String(cfg.serveUrl || 'http://127.0.0.1:7070').replace(/\/$/, '')
  const apiKeyEnv = typeof cfg.apiKeyEnv === 'string' ? cfg.apiKeyEnv : ''
  const POLL_MS = Number(cfg.pollMs) > 0 ? Number(cfg.pollMs) : 10000
  let polling = false
  let wasDown = false

  const readProviders = () => {
    const descriptor = ctx.settings.describe().find((d) => d.ns === NS)
    const section = descriptor === undefined ? undefined : descriptor.value
    return isObject(section) && isObject(section.providers) ? section.providers : undefined
  }

  // Serve's list, or undefined when Serve is not answering (then nothing changes: a restart of Serve must not empty DSH).
  const fetchEntries = async () => {
    try {
      const response = await fetch(serveUrl + '/api/harness/dsh', { signal: AbortSignal.timeout(4000) })
      if (!response.ok) return undefined
      const body = await response.json()
      return Array.isArray(body.entries) ? body.entries : undefined
    } catch (error) {
      if (!wasDown) console.log('serve-pull: Serve not answering (' + (error && error.message) + '); leaving providers as they are')
      wasDown = true
      return undefined
    }
  }

  const pollOnce = async () => {
    if (polling) return
    polling = true
    try {
      const entries = await fetchEntries()
      if (entries === undefined) return
      wasDown = false
      const providers = readProviders()
      if (providers === undefined) return
      const ops = diffOps(providers, entries, apiKeyEnv)
      if (ops.length === 0) return
      await ctx.settings.mutate(NS, ops)
      console.log('serve-pull: ' + ops.map((o) => o.op + ' ' + o.path.slice(1).join('.')).join(', '))
    } catch (error) {
      console.error('serve-pull: ' + (error && error.message))
    } finally {
      polling = false
    }
  }

  ctx.effect(() => {
    void pollOnce()
    const stop = ctx.interval(() => { void pollOnce() }, POLL_MS)
    return () => { stop() }
  })
  console.log('serve-pull active (poll ' + POLL_MS + 'ms, ' + serveUrl + ')')
}
