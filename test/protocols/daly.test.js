'use strict'

const { test } = require('node:test')
const assert = require('node:assert/strict')
const daly = require('../../lib/protocols/daly')

const CURRENT_OFFSET = 30000

function crc16Modbus (data) {
  let crc = 0xffff
  for (const b of data) {
    crc ^= b
    for (let i = 0; i < 8; i++) {
      crc = crc & 1 ? (crc >> 1) ^ 0xa001 : crc >> 1
    }
  }
  return crc & 0xffff
}

// Builds a synthetic, CRC-valid D2 0x03 response frame. `registers` maps
// register index -> uint16 value; unset registers default to 0. Mirrors
// daly.js's own register layout (see PROTOCOL_NOTES.md for the source
// verification against real hardware).
function buildResponseFrame (registers, regCount = 0x3e) {
  const payload = Buffer.alloc(regCount * 2)
  for (const [i, value] of Object.entries(registers)) {
    payload.writeUInt16BE(value, Number(i) * 2)
  }
  const header = Buffer.from([0xd2, 0x03, payload.length])
  const withoutCrc = Buffer.concat([header, payload])
  const crc = crc16Modbus(withoutCrc)
  return Buffer.concat([withoutCrc, Buffer.from([crc & 0xff, (crc >> 8) & 0xff])])
}

test('parses a valid response frame into SI-unit reading fields', () => {
  const frame = buildResponseFrame({
    0x00: 3355, // cell 1, mV
    0x01: 3363,
    0x02: 3356,
    0x03: 3362,
    0x28: 134, // pack voltage, x0.1V -> 13.4V
    0x29: CURRENT_OFFSET + 189, // current, x0.1A with offset -> +18.9A
    0x2a: 561, // SOC, x0.1% -> 56.1%
    0x30: 2800, // full-charge capacity, x0.1Ah -> 280.0Ah
    0x31: 4 // cell count
  })

  const reading = daly.parseNotification(frame)

  assert.ok(reading)
  assert.deepEqual(reading.cellVoltages, [3.355, 3.363, 3.356, 3.362])
  assert.equal(reading.packVoltage, 13.4)
  assert.equal(reading.current, 18.9)
  assert.equal(reading.soc, 56.1)
  assert.equal(reading.fullChargeCapacityAh, 280)
})

test('negative current (discharge) decodes correctly around the offset', () => {
  const frame = buildResponseFrame({
    0x28: 132,
    0x29: CURRENT_OFFSET - 124, // -12.4A
    0x2a: 780,
    0x30: 1050,
    0x31: 0
  })

  const reading = daly.parseNotification(frame)
  assert.equal(reading.current, -12.4)
})

test('rejects a frame with an invalid CRC', () => {
  const frame = buildResponseFrame({ 0x28: 134, 0x31: 0 })
  frame[frame.length - 1] ^= 0xff // corrupt the low CRC byte

  assert.equal(daly.parseNotification(frame), null)
})

test('rejects a frame with the wrong function code', () => {
  const frame = buildResponseFrame({ 0x28: 134, 0x31: 0 })
  frame[1] = 0x04 // not the 0x03 (read) response code

  assert.equal(daly.parseNotification(frame), null)
})

test('rejects a truncated frame shorter than its declared byte count', () => {
  const frame = buildResponseFrame({ 0x28: 134, 0x31: 0 })
  assert.equal(daly.parseNotification(frame.subarray(0, frame.length - 5)), null)
})

test('buildRequest() produces a CRC-valid read-62-registers-from-0 command', () => {
  const request = daly.buildRequest()
  assert.deepEqual([...request.subarray(0, 6)], [0xd2, 0x03, 0x00, 0x00, 0x00, 0x3e])
  const crc = crc16Modbus(request.subarray(0, 6))
  assert.equal(request[6], crc & 0xff)
  assert.equal(request[7], (crc >> 8) & 0xff)
})
