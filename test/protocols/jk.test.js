'use strict'

const { test } = require('node:test')
const assert = require('node:assert/strict')
const { JkFrameAssembler, RSP_HEADER } = require('../../lib/protocols/jk')

const INFO_FRAME_LEN = 300
const FIELD_OFFSET = 32

function sum8 (buf) {
  let s = 0
  for (const b of buf) s = (s + b) & 0xff
  return s
}

// Builds a synthetic, checksum-valid 300-byte JK02 cell-info frame with
// the given field values, at the same byte offsets jk.js reads from
// (verified against real hardware - see diag/findings/PROTOCOL_NOTES.md).
function buildCellInfoFrame ({ cellVoltagesMv, packVoltageMv, currentMa, soc, fullChargeCapacityMah }) {
  const frame = Buffer.alloc(INFO_FRAME_LEN)
  frame.writeUInt8(0x55, 0)
  frame.writeUInt8(0xaa, 1)
  frame.writeUInt8(0xeb, 2)
  frame.writeUInt8(0x90, 3)
  frame.writeUInt8(0x02, 4) // cell-info frame type

  cellVoltagesMv.forEach((mv, i) => frame.writeUInt16LE(mv, 6 + i * 2))

  const off = FIELD_OFFSET
  frame.writeUInt32LE(packVoltageMv >>> 0, 118 + off)
  frame.writeInt32LE(currentMa | 0, 126 + off)
  frame.writeUInt8(soc, 141 + off)
  frame.writeUInt32LE(fullChargeCapacityMah >>> 0, 146 + off)

  frame.writeUInt8(sum8(frame.subarray(0, INFO_FRAME_LEN - 1)), INFO_FRAME_LEN - 1)
  return frame
}

test('parses a complete single-chunk cell-info frame', () => {
  const frame = buildCellInfoFrame({
    cellVoltagesMv: [3325, 3328, 3327, 3330],
    packVoltageMv: 13310,
    currentMa: -12400,
    soc: 78,
    fullChargeCapacityMah: 105000
  })

  const assembler = new JkFrameAssembler()
  const reading = assembler.feed(frame)

  assert.ok(reading)
  assert.deepEqual(reading.cellVoltages, [3.325, 3.328, 3.327, 3.33])
  assert.equal(reading.packVoltage, 13.31)
  assert.equal(reading.current, -12.4)
  assert.equal(reading.soc, 78)
  assert.equal(reading.fullChargeCapacityAh, 105)
})

test('reassembles a frame split across multiple BLE notification chunks', () => {
  const frame = buildCellInfoFrame({
    cellVoltagesMv: [3350, 3355, 3352, 3354],
    packVoltageMv: 13400,
    currentMa: 8600,
    soc: 92,
    fullChargeCapacityMah: 280000
  })

  const assembler = new JkFrameAssembler()
  assert.equal(assembler.feed(frame.subarray(0, 128)), null)
  assert.equal(assembler.feed(frame.subarray(128, 256)), null)
  const reading = assembler.feed(frame.subarray(256))

  assert.ok(reading)
  assert.equal(reading.packVoltage, 13.4)
  assert.equal(reading.current, 8.6)
  assert.equal(reading.soc, 92)
})

test('ignores settings/device-info frames (type != 0x02) and keeps buffering', () => {
  const settingsFrame = Buffer.alloc(INFO_FRAME_LEN)
  settingsFrame.writeUInt8(0x55, 0)
  settingsFrame.writeUInt8(0xaa, 1)
  settingsFrame.writeUInt8(0xeb, 2)
  settingsFrame.writeUInt8(0x90, 3)
  settingsFrame.writeUInt8(0x01, 4) // settings frame, not cell-info
  settingsFrame.writeUInt8(sum8(settingsFrame.subarray(0, INFO_FRAME_LEN - 1)), INFO_FRAME_LEN - 1)

  const cellInfoFrame = buildCellInfoFrame({
    cellVoltagesMv: [3300, 3300, 3300, 3300],
    packVoltageMv: 13200,
    currentMa: 0,
    soc: 50,
    fullChargeCapacityMah: 100000
  })

  const assembler = new JkFrameAssembler()
  assert.equal(assembler.feed(settingsFrame), null)
  const reading = assembler.feed(cellInfoFrame)
  assert.ok(reading)
  assert.equal(reading.soc, 50)
})

test('drops a frame with an invalid checksum', () => {
  const frame = buildCellInfoFrame({
    cellVoltagesMv: [3300, 3300, 3300, 3300],
    packVoltageMv: 13200,
    currentMa: 0,
    soc: 50,
    fullChargeCapacityMah: 100000
  })
  frame[INFO_FRAME_LEN - 1] ^= 0xff // corrupt the checksum byte

  const assembler = new JkFrameAssembler()
  assert.equal(assembler.feed(frame), null)
})

test('skips leading junk bytes before the response header', () => {
  const frame = buildCellInfoFrame({
    cellVoltagesMv: [3300, 3300, 3300, 3300],
    packVoltageMv: 13200,
    currentMa: 0,
    soc: 50,
    fullChargeCapacityMah: 100000
  })
  const withJunk = Buffer.concat([Buffer.from([0x41, 0x54, 0x0d, 0x0a]), frame]) // stray "AT\r\n"

  const assembler = new JkFrameAssembler()
  const reading = assembler.feed(withJunk)
  assert.ok(reading)
  assert.equal(reading.soc, 50)
})

test('zero-value cell slots are treated as unpopulated and excluded', () => {
  const frame = buildCellInfoFrame({
    cellVoltagesMv: [3300, 3310, 0, 0],
    packVoltageMv: 6610,
    currentMa: 0,
    soc: 60,
    fullChargeCapacityMah: 50000
  })

  const assembler = new JkFrameAssembler()
  const reading = assembler.feed(frame)
  assert.deepEqual(reading.cellVoltages, [3.3, 3.31])
})

test('RSP_HEADER matches the documented JK02 response preamble', () => {
  assert.deepEqual([...RSP_HEADER], [0x55, 0xaa, 0xeb, 0x90])
})
