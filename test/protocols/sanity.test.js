'use strict'

const { test } = require('node:test')
const assert = require('node:assert/strict')
const { implausibleReadingReason } = require('../../lib/protocols/sanity')

test('a physically plausible reading is accepted', () => {
  assert.equal(implausibleReadingReason({ soc: 78, packVoltage: 13.31, current: -12.4 }), null)
})

test('SOC outside 0-100% is flagged', () => {
  assert.match(implausibleReadingReason({ soc: 150, packVoltage: 13.3, current: 0 }), /soc=150/)
  assert.match(implausibleReadingReason({ soc: -5, packVoltage: 13.3, current: 0 }), /soc=-5/)
})

test('pack voltage outside the sane range is flagged', () => {
  assert.match(implausibleReadingReason({ soc: 50, packVoltage: 0, current: 0 }), /packVoltage=0/)
  assert.match(implausibleReadingReason({ soc: 50, packVoltage: 5000, current: 0 }), /packVoltage=5000/)
})

test('current outside the sane range is flagged', () => {
  assert.match(implausibleReadingReason({ soc: 50, packVoltage: 13.3, current: 9999 }), /current=9999/)
})

test('a missing field is not itself treated as implausible', () => {
  assert.equal(implausibleReadingReason({ soc: 50 }), null)
  assert.equal(implausibleReadingReason({}), null)
})

test('boundary values are accepted (inclusive range)', () => {
  assert.equal(implausibleReadingReason({ soc: 0, packVoltage: 0.5, current: -2000 }), null)
  assert.equal(implausibleReadingReason({ soc: 100, packVoltage: 1000, current: 2000 }), null)
})
