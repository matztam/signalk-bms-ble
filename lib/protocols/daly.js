'use strict'

// Daly Smart BMS D2 dialect (Modbus-RTU-style framing over BLE). Service
// 0xFFF0, notify 0xFFF1, write 0xFFF2. Ported from the Python
// implementation in ble_worker.py (DalyProtocol).

const SERVICE_UUID = '0000fff0-0000-1000-8000-00805f9b34fb'
const NOTIFY_CHAR = '0000fff1-0000-1000-8000-00805f9b34fb'
const WRITE_CHAR = '0000fff2-0000-1000-8000-00805f9b34fb'

const CURRENT_OFFSET = 30000
// Confirmed live: Daly answers each 0xD2 0x03 request once and then goes
// quiet - it does not free-run like JK02 does, so it needs re-requesting.
const REQUEST_INTERVAL_MS = 5000

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

// 80 registers (0x0000-0x004F) instead of the 62 (0x3E) used before the
// temperature feature: registers 0x20 (battery temp 1) and 0x2D/0x2E
// (max/min battery temp) already fit within 62, but the MOSFET
// temperature at register 0x42 does not - see
// github.com/syssi/esphome-daly-bms/blob/main/docs/protocol-register-map.md's
// "D2 reads this block in a single frame (62 or 80 registers from
// 0x0000)"/"Real-time Block 2" for both the field positions and
// confirmation that D2 supports the larger read.
const REGISTER_COUNT = 0x50

function buildRequest () {
  const frame = Buffer.from([0xd2, 0x03, 0x00, 0x00, 0x00, REGISTER_COUNT])
  const crc = crc16Modbus(frame)
  return Buffer.concat([frame, Buffer.from([crc & 0xff, (crc >> 8) & 0xff])])
}

// Each BLE notification is a complete frame in practice (no reassembly
// needed - see ble_worker.py's DalyProtocol.feed comment), but callers
// should still validate the CRC before trusting it, which this does.
function parseNotification (frame) {
  if (frame.length < 5 || frame[0] !== 0xd2 || frame[1] !== 0x03) return null
  const byteCount = frame[2]
  const total = 3 + byteCount + 2
  if (frame.length < total) return null

  const payload = frame.subarray(3, 3 + byteCount)
  const crcExpected = frame[3 + byteCount] | (frame[4 + byteCount] << 8)
  const crcActual = crc16Modbus(frame.subarray(0, 3 + byteCount))
  if (crcExpected !== crcActual) return null

  return parse(payload)
}

// Daly encodes temperatures as raw - 40 -> degC (a fixed offset so an
// unsigned register can represent negative temperatures), per the
// documented register map (see REGISTER_COUNT's comment above).
// Unverified against real hardware - no device available to test
// against (see the CHANGELOG/issue this was added for).
const TEMP_ZERO_OFFSET = 40

function readTempC (payload, reg, i) {
  if (payload.length < (i + 1) * 2) return undefined
  const tempC = reg(i) - TEMP_ZERO_OFFSET
  // A disconnected sensor or a register outside what this firmware
  // actually populates reads as 0x0000 (-> -40 degC) or 0xffff (a huge
  // implausible value) on Daly hardware per the esphome-daly-bms issue
  // tracker; hide those rather than publish nonsense.
  return tempC > -40 && tempC < 150 ? tempC : undefined
}

function parse (payload) {
  const reg = (i) => payload.readUInt16BE(i * 2)

  const cellCount = reg(0x31)
  const cellVoltages = []
  for (let i = 0; i < cellCount; i++) cellVoltages.push(reg(i) / 1000)

  const reading = {
    cellVoltages,
    packVoltage: reg(0x28) / 10,
    current: (reg(0x29) - CURRENT_OFFSET) / 10,
    soc: reg(0x2a) / 10,
    // Register 0x30, x0.1 Ah. Confirmed live: reads as the BMS's own
    // current full-charge capacity, not a fixed nameplate constant (two
    // nominally-identical units read slightly differently) - consistent
    // with jk.js's fullChargeCapacityAh.
    fullChargeCapacityAh: reg(0x30) / 10
  }

  // Registers 0x20-0x27 (up to 8 sensors); only sensor 1 is surfaced as
  // "the" battery temperature since that's what most Daly D2 packs
  // actually populate, but all present ones are exposed via
  // batteryTemperaturesC for BMS models with more than one.
  const batteryTemperaturesC = []
  for (let i = 0; i < 8; i++) {
    const t = readTempC(payload, reg, 0x20 + i)
    if (t !== undefined) batteryTemperaturesC.push(t)
  }
  if (batteryTemperaturesC.length > 0) {
    reading.batteryTemperatureC = batteryTemperaturesC[0]
    reading.batteryTemperaturesC = batteryTemperaturesC
  }

  // Register 0x42 - only present when the request read 80 registers (see
  // REGISTER_COUNT); payload.length guards readTempC against a shorter
  // reply from firmware that only honors the smaller 62-register form.
  const mosTempC = readTempC(payload, reg, 0x42)
  if (mosTempC !== undefined) reading.mosTemperatureC = mosTempC

  return reading
}

module.exports = {
  SERVICE_UUID,
  NOTIFY_CHAR,
  WRITE_CHAR,
  REQUEST_INTERVAL_MS,
  buildRequest,
  parseNotification
}
