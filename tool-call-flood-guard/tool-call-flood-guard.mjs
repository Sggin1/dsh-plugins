/**
 * tool-call-flood-guard -- stops one assistant reply from flooding the context
 * with tool calls. Added 2026-09-26.
 *
 * Why: a model can degenerate inside a single reply and emit the same tool call
 * many times until its output cap (observed in the author's setup with one
 * local model; exact counts were not recorded). DSH runs every call, so the
 * results can fill the context window in one step, past compaction's threshold
 * before it can act, and the summary request itself can then overflow. The
 * shipped `repeat-tool-reminder` cannot help: it is advisory by contract and
 * only reminds after a call.
 *
 * What: a `tools/pre-execute` listener. Calls reach it in model order, before
 * dispatch and before any approval prompt. Within one assistant step:
 *   - an identical call (same tool, same arguments ignoring key order) runs
 *     once; later copies are denied with a one-line reason;
 *   - at most `maxCallsPerStep` calls run; the rest are denied.
 * A deny becomes a short error result, so every model call still gets exactly
 * one result and the session log replays normally. State resets at every
 * `agent/pre-step`, so repeating a call across steps is untouched (that is the
 * reminder's job).
 *
 * Added 2026-10-08, two limits that span replies (the per-reply limits above
 * reset at every step, so a slow loop slips through):
 *   - the same call (tool + arguments) is denied once it has run
 *     `maxIdenticalAcrossSteps` times within the agent's last `window` calls
 *     of the current turn; the history resets at each new turn;
 *   - after `maxStepsPerTurn` model steps in one turn every further tool call
 *     is denied with a wrap-up message, so an agent that keeps "diagnosing"
 *     in a long loop (one such session prompted this) has to answer.
 *
 * Config (all optional; bad values throw at load -- fail loud):
 *   maxCallsPerStep: integer >= 1          default 64
 *   maxIdenticalPerStep: integer >= 1      default 1
 *   maxIdenticalAcrossSteps: integer >= 1  default 4
 *   window: integer >= 1                   default 12 (calls remembered per turn)
 *   maxStepsPerTurn: integer >= 0          default 60 (0 turns the step budget off)
 *
 * Loaded by cordis.patch.yml's `insert` list like the other plugins here.
 * NAMED EXPORTS ONLY -- the loader does `exports.default ?? exports`.
 */

export const name = 'tool-call-flood-guard'

const DEFAULTS = { maxCallsPerStep: 64, maxIdenticalPerStep: 1, maxIdenticalAcrossSteps: 4, window: 12, maxStepsPerTurn: 60 }

/** Validate one config field: an integer >= 1, or the default. */
function positiveInt(config, key) {
  const value = config?.[key] ?? DEFAULTS[key]
  if (!Number.isInteger(value) || value < 1) {
    throw new Error(`tool-call-flood-guard: ${key} must be an integer >= 1, got ${value}`)
  }
  return value
}

/** Validate one config field that may also be 0 (off): an integer >= 0, or the default. */
function nonNegativeInt(config, key) {
  const value = config?.[key] ?? DEFAULTS[key]
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(`tool-call-flood-guard: ${key} must be an integer >= 0, got ${value}`)
  }
  return value
}

/** Deep key-sort so argument objects differing only in key order compare equal. */
function sortJson(value) {
  if (Array.isArray(value)) return value.map(sortJson)
  if (value !== null && typeof value === 'object') {
    const sorted = {}
    for (const key of Object.keys(value).sort()) sorted[key] = sortJson(value[key])
    return sorted
  }
  return value
}

/** Identity of one call: tool name plus canonical arguments. */
export function callKey(toolName, args) {
  return JSON.stringify([toolName, JSON.stringify(sortJson(args))])
}

/**
 * The per-step decision, separated from cordis wiring so it can be tested.
 * @returns a deny reason, or undefined to let the call through.
 */
export function judge(state, key, limits) {
  state.calls += 1
  const seen = (state.seen.get(key) ?? 0) + 1
  state.seen.set(key, seen)
  if (seen > limits.maxIdenticalPerStep) {
    state.denied += 1
    return 'Skipped: identical to an earlier call in this same reply, which already ran '
      + '-- its result is above. Do not repeat it; use that result or change the arguments.'
  }
  // Only calls that run count toward the cap: denied duplicates must not
  // crowd out distinct calls later in the same reply.
  if (state.ran >= limits.maxCallsPerStep) {
    state.denied += 1
    return `Skipped: this reply already ran ${limits.maxCallsPerStep} tool calls, the `
      + 'per-reply limit. Review the results so far, then continue in your next reply.'
  }
  state.ran += 1
  return undefined
}

/** Fresh per-turn state for the limits that span replies. */
export function newTurnState(turn) {
  return { turn, steps: 0, recent: [] }
}

/**
 * The cross-reply decision for a call that passed the per-reply limits: has
 * this exact call already run `maxIdenticalAcrossSteps` times among the last
 * `window` calls? A denied call is not remembered, so the block ends once the
 * earlier copies age out of the window.
 * @returns a deny reason, or undefined to let the call through.
 */
export function judgeAcrossSteps(turnState, key, limits) {
  const same = turnState.recent.filter((k) => k === key).length
  if (same >= limits.maxIdenticalAcrossSteps) {
    return `Skipped: you have already run this exact call ${same} times in your recent steps `
      + 'with the same arguments. Repeating it will not give a different answer. '
      + 'Stop, say what you found and what is blocking you, or try a different approach.'
  }
  turnState.recent.push(key)
  if (turnState.recent.length > limits.window) turnState.recent.shift()
  return undefined
}

/** The wrap-up message once a turn has used its step budget, or undefined while within it. */
export function budgetReason(turnState, limits) {
  if (limits.maxStepsPerTurn === 0 || turnState.steps <= limits.maxStepsPerTurn) return undefined
  return `Skipped: this turn has used its budget of ${limits.maxStepsPerTurn} steps. `
    + 'Do not call more tools. Write your answer now with what you have, and say what is unfinished.'
}

/** Fresh per-step state. */
export function newState() {
  return { calls: 0, ran: 0, denied: 0, seen: new Map() }
}

export function apply(ctx, config) {
  const limits = {
    maxCallsPerStep: positiveInt(config, 'maxCallsPerStep'),
    maxIdenticalPerStep: positiveInt(config, 'maxIdenticalPerStep'),
    maxIdenticalAcrossSteps: positiveInt(config, 'maxIdenticalAcrossSteps'),
    window: positiveInt(config, 'window'),
    maxStepsPerTurn: nonNegativeInt(config, 'maxStepsPerTurn'),
  }
  const states = new WeakMap()
  const turns = new WeakMap()
  console.log(`tool-call-flood-guard active (${limits.maxCallsPerStep} calls/reply, identical x${limits.maxIdenticalPerStep}; `
    + `identical x${limits.maxIdenticalAcrossSteps} in the last ${limits.window} calls; ${limits.maxStepsPerTurn || 'no'} step budget)`)

  // Waterfall: allow MUST delegate through next() so later listeners
  // (permissions, approval) still decide; a deny short-circuits on purpose.
  ctx.on('tools/pre-execute', async (exec, next) => {
    // Direct ctx.tools.execute() callers have no agent and no reply to flood.
    if (!exec.agent) return next()
    let state = states.get(exec.agent)
    if (state === undefined) {
      state = newState()
      states.set(exec.agent, state)
    }
    const key = callKey(exec.name, exec.arguments)
    const turnState = turns.get(exec.agent) ?? newTurnState(undefined)
    turns.set(exec.agent, turnState)
    const reason = budgetReason(turnState, limits) ?? judge(state, key, limits) ?? judgeAcrossSteps(turnState, key, limits)
    if (reason === undefined) return next()
    return { kind: 'deny', reason }
  })

  // A new model step is a new reply: reset, and report what the last one did.
  ctx.on('agent/pre-step', ({ agent, turn }, next) => {
    let turnState = turns.get(agent)
    if (turnState === undefined || turnState.turn !== turn) {
      turnState = newTurnState(turn)
      turns.set(agent, turnState)
    }
    turnState.steps += 1
    const state = states.get(agent)
    if (state !== undefined && state.denied > 0) {
      console.log(`tool-call-flood-guard: denied ${state.denied} of ${state.calls} calls in one reply`)
    }
    states.delete(agent)
    return next()
  })
}
