/**
 * live-model-refresh -- keeps each provider's model list fresh and shows whether its endpoint answers.
 *
 * Every 30 s, for each `llm-pi-ai` provider with a `baseURL` and an OpenAI- or Anthropic-style `api`, it:
 *   - asks DSH to discover the models the endpoint serves and merges new ones into the provider's `models` (existing entries are kept);
 *   - sets a "  [up]" / "  [down]" marker on the provider's `displayName` (only when it already has one, and only when the state flips);
 *   - sets `transport: sse` on providers that have no transport yet (once).
 * Writes go through DSH's own settings API (`settings.mutate`).
 *
 * Loaded via the patch file's `insert` list. NAMED EXPORTS ONLY (no `default`): the loader does `exports.default ?? exports`,
 * so a default export would hide `inject`.
 */

export const name = 'live-model-refresh'

export const inject = ['settings', 'llm', 'timer']

export function apply(ctx) {
  const NS = 'llm-pi-ai'
  const POLL_MS = 30000
  const LISTABLE = ['openai-completions', 'openai-responses', 'anthropic-messages']

  // DSH 0.1.7 removed `settings.get()`: settings are now each profile entry's
  // live Config, read through `describe()` (one descriptor per entry id).
  // `mutate(ns, ops)` below is unchanged.
  const readProviders = () => {
    const descriptor = ctx.settings.describe().find((d) => d.ns === NS)
    const section = descriptor === undefined ? undefined : descriptor.value
    if (section === null || typeof section !== 'object') return undefined
    const providers = section.providers
    if (providers === null || typeof providers !== 'object') return undefined
    return providers
  }

  const probeTargets = (providers) => Object.entries(providers)
    .filter(([, p]) => p !== null && typeof p === 'object')
    .filter(([, p]) => typeof p.baseURL === 'string' && p.baseURL.length > 0)

  const ensureSseTransport = async () => {
    const providers = readProviders()
    if (providers === undefined) return
    const ops = []
    for (const [key, p] of probeTargets(providers)) {
      if (p.transport !== undefined) continue
      ops.push({ op: 'set', path: ['providers', key, 'transport'], value: 'sse' })
    }
    if (ops.length === 0) return
    try {
      await ctx.settings.mutate(NS, ops)
      console.log('transport sse set on: ' + ops.map((o) => o.path[1]).join(', '))
    } catch (error) {
      console.error('transport write refused: ' + (error && error.message))
    }
  }

  const mergeModels = (stored, discovered) => {
    const byId = new Map()
    if (Array.isArray(stored)) {
      for (const entry of stored) {
        if (entry !== null && typeof entry === 'object' && typeof entry.id === 'string') byId.set(entry.id, entry)
      }
    }
    const merged = []
    for (const model of discovered) {
      const kept = byId.get(model.id)
      if (kept !== undefined) {
        merged.push(kept)
        continue
      }
      const entry = {
        id: model.id,
        name: typeof model.name === 'string' && model.name.length > 0 ? model.name : model.id,
      }
      if (typeof model.contextWindow === 'number' && model.contextWindow > 0) entry.contextWindow = model.contextWindow
      merged.push(entry)
    }
    return merged
  }

  // Reachability marker on displayName. DSH's own green dot means "route
  // registered", not "endpoint answering" (ui-settings-models store.ts builds
  // it from llm/listProviders), so a server that is off still reads green.
  // This probe already has the current state every cycle; surface it in the one
  // field the settings list shows. Rewritten only when the state flips.
  const MARKER = /\s*\[(?:up|down)\]\s*$/
  const statusMarkerOp = (key, p, reachable) => {
    // Never invent a displayName: a provider without one shows its id, and
    // creating one here would silently rename it.
    if (typeof p.displayName !== 'string' || p.displayName.length === 0) return undefined
    const desired = p.displayName.replace(MARKER, '') + (reachable ? '  [up]' : '  [down]')
    if (p.displayName === desired) return undefined
    return { op: 'set', path: ['providers', key, 'displayName'], value: desired }
  }

  const downLogged = new Map()
  let polling = false

  const pollOnce = async () => {
    if (polling) return
    polling = true
    try {
      const providers = readProviders()
      if (providers === undefined) return
      const statusOps = []
      for (const [key, p] of probeTargets(providers)) {
        if (!LISTABLE.includes(p.api)) continue
        let discovered
        let reachable = true
        try {
          discovered = await ctx.llm.discoverModels(NS, { provider: key, baseURL: p.baseURL, api: p.api })
        } catch (error) {
          reachable = false
          if (downLogged.get(key) !== true) {
            downLogged.set(key, true)
            console.log('probe ' + key + ' unreachable: ' + (error && error.message))
          }
        }
        const markerOp = statusMarkerOp(key, p, reachable)
        if (markerOp !== undefined) statusOps.push(markerOp)
        if (!reachable) continue
        downLogged.set(key, false)
        if (!Array.isArray(discovered) || discovered.length === 0) continue
        const merged = mergeModels(p.models, discovered)
        const before = JSON.stringify(Array.isArray(p.models) ? p.models : [])
        if (before === JSON.stringify(merged)) continue
        try {
          await ctx.settings.mutate(NS, [{ op: 'set', path: ['providers', key, 'models'], value: merged }])
          console.log('refreshed ' + key + ' models: ' + merged.map((m) => m.id).join(', '))
        } catch (error) {
          console.error('model write refused for ' + key + ': ' + (error && error.message))
        }
      }
      if (statusOps.length > 0) {
        try {
          await ctx.settings.mutate(NS, statusOps)
          console.log('status: ' + statusOps.map((o) => o.value).join(' | '))
        } catch (error) {
          console.error('status marker write refused: ' + (error && error.message))
        }
      }
    } catch (error) {
      console.error('poll cycle failed: ' + (error && error.message))
    } finally {
      polling = false
    }
  }

  ctx.effect(() => {
    const kick = async () => {
      await ensureSseTransport()
      await pollOnce()
    }
    void kick()
    const stopInterval = ctx.interval(() => { void pollOnce() }, POLL_MS)
    return () => { stopInterval() }
  })

  console.log('live model refresh active (poll ' + POLL_MS + 'ms)')
}
