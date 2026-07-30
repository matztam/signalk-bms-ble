'use strict'

// JK-BMS BLE (JK02 protocol family). Reference: syssi/esphome-jk-bms,
// cross-checked against patman15/aiobmsble (jikong_bms.py).
//
// BLE: service 0xFFE0, single characteristic 0xFFE1 (write + notify).
// Request frame: AA 55 90 EB <cmd> <len> <13 zero/value bytes> <sum8>
// Response frame: 55 AA EB 90 <type> ... <sum8>, fixed 300 bytes for the
// cell-info dump (type 0x02), arrives fragmented across several notify
// packets and must be reassembled by the caller.

const CMD_HEADER = Buffer.from([0xaa, 0x55, 0x90, 0xeb])
const RSP_HEADER = Buffer.from([0x55, 0xaa, 0xeb, 0x90])
const INFO_FRAME_LEN = 300

const CMD_CELL_INFO = 0x96
const CMD_DEVICE_INFO = 0x97

function sum8(buf) {
  let s = 0
  for (const b of buf) s = (s + b) & 0xff
  return s
}

function buildCommand(cmd, value = Buffer.alloc(0)) {
  const padded = Buffer.concat([value, Buffer.alloc(13 - value.length)])
  const frame = Buffer.concat([CMD_HEADER, Buffer.from([cmd, value.length]), padded])
  return Buffer.concat([frame, Buffer.from([sum8(frame)])])
}

function requestCellInfo() {
  return buildCommand(CMD_CELL_INFO)
}

function requestDeviceInfo() {
  return buildCommand(CMD_DEVICE_INFO)
}

// Strips stray "AT\r\n" bytes that some BLE-UART bridge chips inject.
const BT_MODULE_MSG = Buffer.from('AT\r\n')

function stripBridgeNoise(buf) {
  const idx = buf.indexOf(BT_MODULE_MSG)
  if (idx === -1) return buf
  return Buffer.concat([buf.slice(0, idx), buf.slice(idx + BT_MODULE_MSG.length)])
}

// Accumulates fragmented BLE notify packets into complete JK frames.
// Feed each notify() Buffer to push(); complete frames come out of
// drain() once RSP_HEADER + INFO_FRAME_LEN bytes have accumulated.
class FrameAssembler {
  constructor() {
    this.buf = Buffer.alloc(0)
  }

  push(chunk) {
    this.buf = stripBridgeNoise(Buffer.concat([this.buf, chunk]))
  }

  // Returns an array of complete, checksum-valid frames and discards
  // consumed bytes (and any leading junk before a recognized header).
  drain() {
    const frames = []
    for (;;) {
      const headerIdx = this.buf.indexOf(RSP_HEADER)
      if (headerIdx === -1) {
        if (this.buf.length > INFO_FRAME_LEN * 2) {
          // No valid header in a suspiciously large backlog: drop it.
          this.buf = Buffer.alloc(0)
        }
        break
      }
      if (headerIdx > 0) this.buf = this.buf.slice(headerIdx)
      if (this.buf.length < INFO_FRAME_LEN) break

      const frame = this.buf.slice(0, INFO_FRAME_LEN)
      this.buf = this.buf.slice(INFO_FRAME_LEN)

      const expected = frame[INFO_FRAME_LEN - 1]
      const actual = sum8(frame.slice(0, INFO_FRAME_LEN - 1))
      if (expected === actual) {
        frames.push(frame)
      }
      // else: checksum mismatch, drop this frame and keep scanning
    }
    return frames
  }
}

// sw_version >= 11 uses the "32S" layout (offset 0 below); older firmware
// (sw_version 6.0-10.x) uses "24S" layout, all offsets shifted by -32.
// Device-info response (cmd 0x97) carries the version string around byte
// 30-38; caller is expected to parse that separately and pass the
// resulting generation in here once known. Defaults to the current/32S
// layout, which JK-B2A8S20P units on recent firmware report.
function offsetsFor(generation = '32S') {
  const base = generation === '24S' ? -32 : 0
  return {
    cellVoltagesStart: 6, // unaffected by the -32 shift
    packVoltage: 150 + base,
    current: 158 + base,
    balanceCurrent: 170 + base,
    soc: 173 + base,
    remainingCapacity: 174 + base,
    designCapacity: 178 + base,
    cycleCount: 182 + base,
    chargeMosfet: 198 + base,
    dischargeMosfet: 199 + base
  }
}

// Parses one validated 300-byte cell-info (type 0x02) frame into a plain
// object with SI units: volts, amps, percent, amp-hours.
function parseCellInfo(frame, generation = '32S') {
  if (frame.length !== INFO_FRAME_LEN) {
    throw new Error(`expected ${INFO_FRAME_LEN}-byte frame, got ${frame.length}`)
  }
  const off = offsetsFor(generation)

  const cellVoltages = []
  // Up to 32 cell slots @ 2 bytes each; zero entries mean "not present".
  // Callers typically only care about the first N (N = actual series count).
  for (let i = 0; i < 32; i++) {
    const pos = off.cellVoltagesStart + i * 2
    if (pos + 2 > frame.length) break
    const mv = frame.readUInt16LE(pos)
    if (mv === 0) continue
    cellVoltages.push(mv / 1000)
  }

  return {
    cellVoltages,
    packVoltage: frame.readUInt32LE(off.packVoltage) / 1000,
    // Signed: positive = charging, negative = discharging.
    current: frame.readInt32LE(off.current) / 1000,
    soc: frame.readUInt8(off.soc),
    remainingCapacityAh: frame.readUInt32LE(off.remainingCapacity) / 1000,
    designCapacityAh: frame.readUInt32LE(off.designCapacity) / 1000,
    cycleCount: frame.readUInt32LE(off.cycleCount),
    chargeMosfetOn: frame.readUInt8(off.chargeMosfet) !== 0,
    dischargeMosfetOn: frame.readUInt8(off.dischargeMosfet) !== 0
  }
}

module.exports = {
  SERVICE_UUID: 'ffe0',
  CHARACTERISTIC_UUID: 'ffe1',
  requestCellInfo,
  requestDeviceInfo,
  FrameAssembler,
  parseCellInfo,
  offsetsFor,
  // exported for testing
  sum8,
  buildCommand,
  INFO_FRAME_LEN
}
