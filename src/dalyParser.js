'use strict'

// Daly Smart BMS BLE (D2 dialect, Modbus-RTU-style framing).
// Reference: syssi/esphome-daly-bms docs/protocol-register-map.md,
// verified against two real BMS-ST103-303E units (own hardware).
//
// BLE: service 0xFFF0, notify 0xFFF1, write 0xFFF2.
// Request frame: D2 03 <reg_addr:u16 BE> <reg_count:u16 BE> <crc16/modbus LE>
// Response frame: D2 03 <byte_count> <byte_count bytes of u16 BE registers> <crc16/modbus LE>
// Arrives as a single BLE notification (129 bytes for a 62-register read),
// no reassembly needed in practice, but callers should still buffer by CRC
// validity in case an adapter fragments it.

const REQUEST_ADDR = 0xd2
const FUNCTION_READ = 0x03
const REG_COUNT = 0x3e // 62 registers: covers cells + voltage/current/SOC block

const REG = {
  cellVoltageStart: 0x00, // registers 0x00..0x1F, up to 32 cells
  cellCount: 0x31,
  packVoltage: 0x28,
  current: 0x29,
  soc: 0x2a,
  maxCellVoltage: 0x2b
}

const CURRENT_OFFSET = 30000

function crc16Modbus(buf) {
  let crc = 0xffff
  for (const b of buf) {
    crc ^= b
    for (let i = 0; i < 8; i++) {
      crc = crc & 1 ? (crc >> 1) ^ 0xa001 : crc >> 1
    }
  }
  return crc & 0xffff
}

function buildStatusRequest() {
  const frame = Buffer.from([REQUEST_ADDR, FUNCTION_READ, 0x00, 0x00, 0x00, REG_COUNT])
  const crc = crc16Modbus(frame)
  return Buffer.concat([frame, Buffer.from([crc & 0xff, (crc >> 8) & 0xff])])
}

// Validates header/function/byte-count/CRC and returns the raw register
// data payload (byte_count bytes), or null if the frame isn't a valid,
// complete D2 status response yet (caller should keep buffering).
function extractPayload(frame) {
  if (frame.length < 5) return null
  if (frame[0] !== REQUEST_ADDR || frame[1] !== FUNCTION_READ) return null
  const byteCount = frame[2]
  const total = 3 + byteCount + 2
  if (frame.length < total) return null

  const payload = frame.slice(3, 3 + byteCount)
  const crcExpected = frame.readUInt16LE(3 + byteCount)
  const crcActual = crc16Modbus(frame.slice(0, 3 + byteCount))
  if (crcExpected !== crcActual) return null

  return payload
}

function readReg(payload, regIndex) {
  const pos = regIndex * 2
  return payload.readUInt16BE(pos)
}

// Parses a validated D2 status payload (as returned by extractPayload) into
// a plain object with SI units: volts, amps, percent.
function parseStatus(payload) {
  const cellCount = readReg(payload, REG.cellCount)

  const cellVoltages = []
  for (let i = 0; i < cellCount; i++) {
    cellVoltages.push(readReg(payload, REG.cellVoltageStart + i) / 1000)
  }

  return {
    cellVoltages,
    packVoltage: readReg(payload, REG.packVoltage) / 10,
    // Signed: positive = charging, negative = discharging.
    current: (readReg(payload, REG.current) - CURRENT_OFFSET) / 10,
    soc: readReg(payload, REG.soc) / 10,
    maxCellVoltage: readReg(payload, REG.maxCellVoltage) / 1000
  }
}

module.exports = {
  SERVICE_UUID: 'fff0',
  NOTIFY_CHARACTERISTIC_UUID: 'fff1',
  WRITE_CHARACTERISTIC_UUID: 'fff2',
  buildStatusRequest,
  extractPayload,
  parseStatus,
  // exported for testing
  crc16Modbus,
  REG,
  CURRENT_OFFSET
}
