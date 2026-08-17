'use strict'

const { test } = require('node:test')
const assert = require('node:assert/strict')
const wattcycle = require('../../lib/protocols/wattcycle')

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

// Builds a synthetic, CRC-valid Analog Quantity (DP 140) response frame
// in the "old protocol" (VER=0x00) wire format documented in
// wattcycle_ble's PROTOCOL.md. `payload` is the already-encoded DATA
// portion (see buildAnalogQuantityPayload below).
function buildResponseFrame (payload) {
  const header = Buffer.from([0x7e, 0x00, 0x01, 0x03, 0x00, 0x8c])
  const dataLen = Buffer.from([(payload.length >> 8) & 0xff, payload.length & 0xff])
  const withoutCrc = Buffer.concat([header, dataLen, payload])
  const crc = crc16Modbus(withoutCrc)
  return Buffer.concat([withoutCrc, Buffer.from([crc & 0xff, (crc >> 8) & 0xff, 0x0d])])
}

// Builds the DATA portion of an Analog Quantity response, matching the
// field order documented in PROTOCOL.md and wattcycle_ble's
// parse_analog_quantity().
function buildAnalogQuantityPayload ({
  cellVoltagesMv,
  mosTempDeciK,
  pcbTempDeciK,
  cellTempsDeciK = [],
  currentByte0,
  currentByte1,
  moduleVoltageCv,
  remainingCapacityDah,
  totalCapacityDah,
  cycleNumber = 0,
  designCapacityDah,
  soc
}) {
  const parts = []
  parts.push(Buffer.from([cellVoltagesMv.length]))
  for (const mv of cellVoltagesMv) {
    const b = Buffer.alloc(2)
    b.writeUInt16BE(mv, 0)
    parts.push(b)
  }
  parts.push(Buffer.from([2 + cellTempsDeciK.length]))
  for (const t of [mosTempDeciK, pcbTempDeciK, ...cellTempsDeciK]) {
    const b = Buffer.alloc(2)
    b.writeUInt16BE(t, 0)
    parts.push(b)
  }
  parts.push(Buffer.from([currentByte0, currentByte1]))
  for (const v of [moduleVoltageCv, remainingCapacityDah, totalCapacityDah, cycleNumber, designCapacityDah, soc]) {
    const b = Buffer.alloc(2)
    b.writeUInt16BE(v, 0)
    parts.push(b)
  }
  return Buffer.concat(parts)
}

test('parses the SOC/voltage/current/capacity/cell-voltage fields from a real-world example (from github.com/matztam/signalk-bms-ble/issues/1)', () => {
  // Reproduces the values silfreed posted from `wattcycle-ble read`
  // against real hardware: SOC 70%, 0.0A, 13.15V, 4 cells ~3.287V,
  // 69.9/100.0/100.0 Ah, MOS 31.1C / PCB 33.6C / Cell1 30.1C.
  const payload = buildAnalogQuantityPayload({
    cellVoltagesMv: [3286, 3288, 3289, 3287],
    mosTempDeciK: 2730 + 311, // 31.1 degC
    pcbTempDeciK: 2730 + 336, // 33.6 degC
    cellTempsDeciK: [2730 + 301], // Cell 1: 30.1 degC
    currentByte0: 0x00, // no sign bit, no decimal flag
    currentByte1: 0x00, // 0.0A
    moduleVoltageCv: 1315, // 13.15V
    remainingCapacityDah: 699, // 69.9 Ah
    totalCapacityDah: 1000, // 100.0 Ah
    designCapacityDah: 1000,
    soc: 70 // SOC is a plain percentage (0-100), unlike Daly's x0.1 SOC register
  })

  const frame = buildResponseFrame(payload)
  const assembler = new wattcycle.WattcycleFrameAssembler()
  const reading = assembler.feed(frame)

  assert.ok(reading)
  assert.deepEqual(reading.cellVoltages, [3.286, 3.288, 3.289, 3.287])
  assert.equal(reading.packVoltage, 13.15)
  assert.equal(reading.current, 0)
  assert.equal(reading.soc, 70)
  assert.equal(reading.fullChargeCapacityAh, 100)
  assert.equal(reading.remainingCapacityAh, 69.9)
  assert.ok(Math.abs(reading.mosTemperatureC - 31.1) < 1e-9)
  assert.ok(Math.abs(reading.batteryTemperatureC - 33.6) < 1e-9)
  assert.equal(reading.batteryTemperaturesC.length, 1)
  assert.ok(Math.abs(reading.batteryTemperaturesC[0] - 30.1) < 1e-9)
})

test('parses positive (charging) current with the decimal flag set', () => {
  const payload = buildAnalogQuantityPayload({
    cellVoltagesMv: [3300, 3300, 3300, 3300],
    mosTempDeciK: 2730 + 250,
    pcbTempDeciK: 2730 + 250,
    // byte0: bit7=0 (positive), bit6=1 (has decimal), bits5-0=0 -> raw=0x005 with byte1
    currentByte0: 0x40,
    currentByte1: 0x7b, // raw = 0x7b = 123 -> 12.3A
    moduleVoltageCv: 1320,
    remainingCapacityDah: 800,
    totalCapacityDah: 1000,
    designCapacityDah: 1000,
    soc: 800
  })

  const frame = buildResponseFrame(payload)
  const reading = new wattcycle.WattcycleFrameAssembler().feed(frame)

  assert.ok(reading)
  assert.equal(reading.current, 12.3)
})

test('parses negative (discharging) current with the sign bit set', () => {
  const payload = buildAnalogQuantityPayload({
    cellVoltagesMv: [3300, 3300, 3300, 3300],
    mosTempDeciK: 2730 + 250,
    pcbTempDeciK: 2730 + 250,
    // bit7=1 (negative), bit6=1 (has decimal)
    currentByte0: 0xc0,
    currentByte1: 0x7b, // raw = 123 -> -12.3A
    moduleVoltageCv: 1320,
    remainingCapacityDah: 800,
    totalCapacityDah: 1000,
    designCapacityDah: 1000,
    soc: 800
  })

  const frame = buildResponseFrame(payload)
  const reading = new wattcycle.WattcycleFrameAssembler().feed(frame)

  assert.ok(reading)
  assert.equal(reading.current, -12.3)
})

test('reassembles a frame split across multiple BLE notification chunks', () => {
  const payload = buildAnalogQuantityPayload({
    cellVoltagesMv: [3300, 3305, 3298, 3301],
    mosTempDeciK: 2730 + 280,
    pcbTempDeciK: 2730 + 290,
    currentByte0: 0x00,
    currentByte1: 0x00,
    moduleVoltageCv: 1330,
    remainingCapacityDah: 900,
    totalCapacityDah: 1000,
    designCapacityDah: 1000,
    soc: 900
  })
  const frame = buildResponseFrame(payload)

  const assembler = new wattcycle.WattcycleFrameAssembler()
  const mid = Math.floor(frame.length / 2)
  assert.equal(assembler.feed(frame.subarray(0, mid)), null)
  const reading = assembler.feed(frame.subarray(mid))

  assert.ok(reading)
  assert.equal(reading.packVoltage, 13.3)
})

test('rejects a frame with an invalid CRC', () => {
  const payload = buildAnalogQuantityPayload({
    cellVoltagesMv: [3300],
    mosTempDeciK: 2730,
    pcbTempDeciK: 2730,
    currentByte0: 0x00,
    currentByte1: 0x00,
    moduleVoltageCv: 1300,
    remainingCapacityDah: 500,
    totalCapacityDah: 1000,
    designCapacityDah: 1000,
    soc: 500
  })
  const frame = buildResponseFrame(payload)
  frame[frame.length - 3] ^= 0xff // corrupt the CRC

  const reading = new wattcycle.WattcycleFrameAssembler().feed(frame)
  assert.equal(reading, null)
})

test('an error response (function code 0x86) is ignored', () => {
  const header = Buffer.from([0x7e, 0x00, 0x01, 0x86, 0x00, 0x8c, 0x00, 0x00])
  const crc = crc16Modbus(header)
  const frame = Buffer.concat([header, Buffer.from([crc & 0xff, (crc >> 8) & 0xff, 0x0d])])

  const reading = new wattcycle.WattcycleFrameAssembler().feed(frame)
  assert.equal(reading, null)
})

test('buildRequest() produces a CRC-valid Analog Quantity read frame', () => {
  const request = wattcycle.buildRequest()
  assert.equal(request[0], 0x7e) // FRAME_HEAD
  assert.equal(request[1], 0x00) // old protocol
  assert.equal(request[2], 0x01) // device address
  assert.equal(request[3], 0x03) // read
  assert.equal(request.readUInt16BE(4), 0x8c) // DP_ANALOG_QUANTITY
  assert.equal(request[request.length - 1], 0x0d) // FRAME_TAIL
  const crc = crc16Modbus(request.subarray(0, request.length - 3))
  assert.equal(request[request.length - 3], crc & 0xff)
  assert.equal(request[request.length - 2], (crc >> 8) & 0xff)
})

test('AUTH_KEY is the literal "HiLink" bytes required before reads work', () => {
  assert.equal(wattcycle.AUTH_KEY.toString('ascii'), 'HiLink')
})
