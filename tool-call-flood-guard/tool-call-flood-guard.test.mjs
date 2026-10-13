// Tests for tool-call-flood-guard.mjs. Run: node --test tool-call-flood-guard.test.mjs
// Not loaded by DSH (cordis.patch.yml lists its plugins explicitly).
import test from 'node:test'
import assert from 'node:assert/strict'
import {
  apply, budgetReason, callKey, judge, judgeAcrossSteps, newState, newTurnState,
} from './tool-call-flood-guard.mjs'

const limits = { maxCallsPerStep: 64, maxIdenticalPerStep: 1, maxIdenticalAcrossSteps: 4, window: 12, maxStepsPerTurn: 60 }
const glob = callKey('glob', { pattern: '*.py' })

test('per-reply limits are unchanged: a duplicate in one reply is denied', () => {
  const state = newState()
  assert.equal(judge(state, glob, limits), undefined)
  assert.match(judge(state, glob, limits), /identical to an earlier call/)
})

test('the same call may run four times across steps; the fifth is denied', () => {
  const turn = newTurnState(1)
  for (let i = 0; i < 4; i++) assert.equal(judgeAcrossSteps(turn, glob, limits), undefined, `run ${i + 1}`)
  assert.match(judgeAcrossSteps(turn, glob, limits), /already run this exact call 4 times/)
})

test('different arguments are different calls', () => {
  const turn = newTurnState(1)
  for (let i = 0; i < 20; i++) assert.equal(judgeAcrossSteps(turn, callKey('glob', { pattern: `*.${i}` }), limits), undefined)
})

test('a denied call is not remembered, and old copies age out of the window', () => {
  const turn = newTurnState(1)
  const small = { ...limits, window: 5 }
  for (let i = 0; i < 4; i++) judgeAcrossSteps(turn, glob, small)
  assert.ok(judgeAcrossSteps(turn, glob, small), 'denied while four copies are in the window')
  for (let i = 0; i < 5; i++) judgeAcrossSteps(turn, callKey('read', { path: `f${i}` }), small)
  assert.equal(judgeAcrossSteps(turn, glob, small), undefined, 'allowed again once the copies slid out')
})

test('the step budget: within it nothing, past it a wrap-up message, 0 turns it off', () => {
  const turn = newTurnState(1)
  turn.steps = 60
  assert.equal(budgetReason(turn, limits), undefined)
  turn.steps = 61
  assert.match(budgetReason(turn, limits), /used its budget of 60 steps/)
  assert.equal(budgetReason(turn, { ...limits, maxStepsPerTurn: 0 }), undefined)
})

/** A fake cordis context that remembers listeners so a test can fire events in order. */
function fakeContext() {
  const listeners = {}
  const ctx = { on: (event, fn) => { listeners[event] = fn } }
  const agent = {}
  return {
    ctx,
    step: (turn) => listeners['agent/pre-step']({ agent, turn }, async () => 'next'),
    call: async (name, args) => {
      const out = await listeners['tools/pre-execute']({ agent, name, arguments: args }, async () => 'ran')
      return out === 'ran' ? 'ran' : out.reason
    },
  }
}

test('wired up: a repeat across steps is stopped on the fifth, and a new turn starts clean', async () => {
  const f = fakeContext()
  apply(f.ctx, {})
  for (let step = 1; step <= 4; step++) {
    await f.step(1)
    assert.equal(await f.call('glob', { pattern: '*.py' }), 'ran', `step ${step}`)
  }
  await f.step(1)
  assert.match(await f.call('glob', { pattern: '*.py' }), /exact call 4 times/)
  await f.step(2)
  assert.equal(await f.call('glob', { pattern: '*.py' }), 'ran', 'the next turn forgets the history')
})

test('wired up: after the step budget every tool call is denied with a wrap-up message', async () => {
  const f = fakeContext()
  apply(f.ctx, { maxStepsPerTurn: 3 })
  for (let step = 1; step <= 3; step++) {
    await f.step(1)
    assert.equal(await f.call('read', { path: `f${step}` }), 'ran')
  }
  await f.step(1)
  assert.match(await f.call('read', { path: 'f4' }), /budget of 3 steps/)
  await f.step(2)
  assert.equal(await f.call('read', { path: 'f5' }), 'ran', 'a new turn has a fresh budget')
})

test('bad config fails loud', () => {
  const f = fakeContext()
  assert.throws(() => apply(f.ctx, { window: 0 }), /window must be an integer >= 1/)
  assert.throws(() => apply(f.ctx, { maxStepsPerTurn: -1 }), /maxStepsPerTurn must be an integer >= 0/)
  assert.doesNotThrow(() => apply(f.ctx, { maxStepsPerTurn: 0 }))
})
