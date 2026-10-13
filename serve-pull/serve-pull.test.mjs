// Tests for serve-pull.mjs. Run: node --test serve-pull.test.mjs
// Not loaded by DSH (cordis.patch.yml lists its plugins explicitly).
import test from 'node:test'
import assert from 'node:assert/strict'
import { diffOps, providerFor, sameProvider, validEntry } from './serve-pull.mjs'

const entry = (over = {}) => ({
  key: 'serve-a-default', displayName: 'Qwen A', baseURL: 'http://127.0.0.1:8091/v1', modelId: 'models/q.gguf',
  contextWindow: 32768, maxTokens: 16384, ...over,
})

test('a new server becomes one set of the whole provider, with the key env', () => {
  const ops = diffOps({}, [entry()], 'LOCAL_KEY')
  assert.equal(ops.length, 1)
  assert.deepEqual(ops[0].path, ['providers', 'serve-a-default'])
  assert.equal(ops[0].value.apiKeyEnv, 'LOCAL_KEY')
  assert.equal(ops[0].value.models[0].id, 'models/q.gguf')
})

test('an unchanged provider (the [up] marker and extra model fields aside) needs nothing', () => {
  const have = { ...providerFor(entry(), 'K'), displayName: 'Qwen A  [up]' }
  have.models[0].input = ['text']
  assert.equal(sameProvider(have, providerFor(entry(), 'K')), true)
  assert.deepEqual(diffOps({ 'serve-a-default': have }, [entry()], 'K'), [])
})

test('a changed port updates only the differing fields and keeps the marker', () => {
  const have = { ...providerFor(entry(), 'K'), displayName: 'Qwen A  [up]' }
  const ops = diffOps({ 'serve-a-default': have }, [entry({ baseURL: 'http://127.0.0.1:8095/v1' })], 'K')
  assert.ok(ops.some((o) => o.path.join('.') === 'providers.serve-a-default.baseURL'))
  assert.ok(!ops.some((o) => o.path.at(-1) === 'displayName'))
})

test('a server that stopped is removed; providers that are not serve- are never touched', () => {
  const providers = { 'serve-old': providerFor(entry({ key: 'serve-old' }), ''), 'my-local': { baseURL: 'http://x' }, openrouter: {} }
  const ops = diffOps(providers, [], '')
  assert.deepEqual(ops, [{ op: 'unset', path: ['providers', 'serve-old'] }])
})

test('an entry whose key is not serve- is ignored (Serve cannot make DSH overwrite a hand-made provider)', () => {
  assert.deepEqual(diffOps({}, [entry({ key: 'my-local' })], ''), [])
})

test('a thinking model carries the switch and format; turning it on later updates the existing provider', () => {
  const think = entry({ reasoningEfforts: { off: null, low: 'low', high: 'high' }, thinkingFormat: 'qwen-chat-template', input: ['text', 'image'] })
  const want = providerFor(think, 'K')
  assert.deepEqual(want.models[0].reasoningEfforts, { off: null, low: 'low', high: 'high' })
  assert.equal(want.models[0].compat.thinkingFormat, 'qwen-chat-template')
  assert.deepEqual(want.defaultInput, ['text', 'image'])
  const old = { ...providerFor(entry(), 'K'), displayName: 'Qwen A  [up]' }
  assert.equal(sameProvider(old, want), false)
  assert.ok(diffOps({ 'serve-a-default': old }, [think], 'K').length > 0)
})

test('an entry with a bad base URL, missing model id or non-positive limits is not written', () => {
  const bad = [
    entry({ baseURL: 'file:///etc/passwd' }), entry({ baseURL: 'javascript:alert(1)' }), entry({ modelId: '' }),
    entry({ contextWindow: 0 }), entry({ maxTokens: -5 }), entry({ contextWindow: '32768' }), entry({ displayName: undefined }),
  ]
  for (const e of bad) {
    assert.equal(validEntry(e), false)
    assert.deepEqual(diffOps({}, [e], ''), [])
  }
  assert.equal(validEntry(entry()), true)
})

test('an invalid entry for a server that already has a provider leaves that provider in place (it is not removed)', () => {
  const providers = { 'serve-a-default': providerFor(entry(), '') }
  assert.deepEqual(diffOps(providers, [entry({ baseURL: 'ftp://nope' })], ''), [])
})

test('an empty list removes every serve- provider and nothing else', () => {
  const providers = { 'serve-a-default': providerFor(entry(), ''), openrouter: {} }
  assert.deepEqual(diffOps(providers, [], ''), [{ op: 'unset', path: ['providers', 'serve-a-default'] }])
})

test('non-object items in the list are skipped without throwing', () => {
  assert.deepEqual(diffOps({}, [null, 5, 'x', entry()], '').length, 1)
})
