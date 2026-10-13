// Tests for the pure helpers of web-search-keyless.mjs. Run: node --test web-search-keyless.test.mjs
// (No network: the search itself is not exercised here.)
import test from 'node:test'
import assert from 'node:assert/strict'
import { cleanText, numericEntity } from './web-search-keyless.mjs'

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
