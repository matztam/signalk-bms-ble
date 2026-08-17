'use strict'

// WattCycle/XDZN BMS (WATT protocol, Modbus-RTU-style framing over BLE).
// Service 0xFFF0, notify 0xFFF1, write 0xFFF2, auth 0xFFFA. Ported from
// github.com/qume/wattcycle_ble (PROTOCOL.md + src/wattcycle_ble/protocol.py),
// a reverse-engineered, independently-authored library the device's own
// Android app's protocol was extracted from - NOT verified against real
// hardware by this project (no WattCycle device available; see
// diag/findings/PROTOCOL_NOTES.md). Requested in
// github.com/matztam/signalk-bms-ble/issues/1.
//
// KNOWN RISK, unlike jk.js/daly.js: wattcycle_ble's own verified-working
// connect sequence enables notifications on FFF1 *before* writing the
// auth key to FFFA, then waits ~0.5s before sending the first read. Our
// GATTSubscriptionDescriptor below can only express "init writes, then
// subscribe notify" (see bleApiWorker.js's descriptor construction) -
// the opposite order, with no way to insert a delay between the auth
// write and the first periodic read. This may still work (many BMS GATT
// stacks tolerate writes before notifications are enabled), but it is
// unverified and is the most likely source of a real device not
// responding even though the frame parsing below is correct.

const SERVICE_UUID = '0000fff0-0000-1000-8000-00805f9b34fb'
const NOTIFY_CHAR = '0000fff1-0000-1000-8000-00805f9b34fb'
const WRITE_CHAR = '0000fff2-0000-1000-8000-00805f9b34fb'
const AUTH_CHAR = '0000fffa-0000-1000-8000-00805f9b34fb'

const AUTH_KEY = Buffer.from('HiLink', 'ascii')

const FRAME_HEAD = 0x7e
const FRAME_TAIL = 0x0d
const FUNC_READ = 0x03
const DEVICE_ADDR = 0x01
const MIN_FRAME_SIZE = 11

const DP_ANALOG_QUANTITY = 0x8c // 140

// wattcycle_ble re-requests Analog Quantity on a fixed interval rather
// than relying on the device to free-run (same pattern as Daly's D2
// dialect - see daly.js's REQUEST_INTERVAL_MS). No documented minimum
// interval; 5s matches Daly's and is conservative for a device that
// otherwise idles.
const REQUEST_INTERVAL_MS = 5000

// Identical algorithm to daly.js's crc16Modbus - confirmed by computing
// both against the same test vectors offline: this is standard Modbus
// CRC16 (init 0xFFFF, poly 0xA001), not a WattCycle-specific variant,
// despite the reference implementation expressing it via lookup tables
// and a byte-swapped hi/lo init (0xFF/0xFF) that looks different at a
// glance.
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

// Old-protocol read frame (version=0x00, no infoData) - matches
// wattcycle_ble's build_read_frame() default. The "new protocol"
// infoData variant exists in the reference implementation but isn't
// needed: the old-protocol frame is accepted by every device the
// reference library documents, and the response parser below already
// handles the new-protocol response *extension* fields regardless of
// which request form was sent.
function buildRequest () {
  const frame = Buffer.from([FRAME_HEAD, 0x00, DEVICE_ADDR, FUNC_READ, 0x00, DP_ANALOG_QUANTITY, 0x00, 0x00])
  const crc = crc16Modbus(frame)
  return Buffer.concat([frame, Buffer.from([crc & 0xff, (crc >> 8) & 0xff]), Buffer.from([FRAME_TAIL])])
}

class WattcycleFrameAssembler {
  constructor () {
    this._buf = Buffer.alloc(0)
  }

  // BLE's ~20-byte default MTU splits WattCycle responses across
  // multiple notifications (unlike Daly, which fits in one on the
  // hardware ble_worker.py was written against) - see
  // wattcycle_ble.protocol.expected_response_length. Total length is
  // only knowable once the first 8 bytes (through DATA_LEN) have
  // arrived.
  feed (chunk) {
    this._buf = Buffer.concat([this._buf, chunk])
    if (this._buf.length < 8) return null
    if (this._buf[0] !== FRAME_HEAD && this._buf[0] !== 0x1e) {
      // Unknown/desynced stream - drop everything and wait for a frame
      // that starts cleanly, same as jk.js's RSP_HEADER resync via
      // indexOf rather than assuming byte 0 is always aligned.
      const idx = this._buf.indexOf(FRAME_HEAD)
      const idxAlt = this._buf.indexOf(0x1e)
      const resync = idx === -1 ? idxAlt : idxAlt === -1 ? idx : Math.min(idx, idxAlt)
      if (resync === -1) {
        this._buf = Buffer.alloc(0)
        return null
      }
      this._buf = this._buf.subarray(resync)
      if (this._buf.length < 8) return null
    }

    const dataLen = this._buf.readUInt16BE(6)
    const total = dataLen + MIN_FRAME_SIZE
    if (this._buf.length < total) return null

    const frame = this._buf.subarray(0, total)
    this._buf = this._buf.subarray(total)

    if (frame[frame.length - 1] !== FRAME_TAIL) return null
    const func = frame[3]
    if (func === 0x86) return null // device-reported error

    const crcExpected = frame.readUInt16LE(total - 3)
    const crcActual = crc16Modbus(frame.subarray(0, total - 3))
    if (crcExpected !== crcActual) return null

    const startAddress = frame.readUInt16BE(4)
    if (startAddress !== DP_ANALOG_QUANTITY) return null // not the frame we're waiting for

    return parseAnalogQuantity(frame.subarray(8, 8 + dataLen))
  }
}

// Bits 7/6 of the first byte: sign and "divide by 10" flag; bits 5-0 of
// the first byte plus all of the second form the magnitude. Used for
// both the main pack current and (in the new-protocol extension) the
// balance current.
function readSignedWattCurrent (data, offset) {
  const b0 = data[offset]
  const b1 = data[offset + 1]
  const isNegative = (b0 & 0x80) !== 0
  const hasDecimal = (b0 & 0x40) !== 0
  const raw = b1 | ((b0 & 0x3f) << 8)
  const current = hasDecimal ? raw / 10 : raw
  return isNegative ? -current : current
}

function parseAnalogQuantity (data) {
  let off = 0
  const readU16 = () => { const v = data.readUInt16BE(off); off += 2; return v }

  const cellCount = data[off++]
  const cellVoltages = []
  for (let i = 0; i < cellCount; i++) cellVoltages.push(readU16() / 1000)

  const temperatureCount = data[off++]
  // (raw - 2730) / 10 -> degC: WattCycle encodes temperature in
  // deciKelvin (0.1 K per count), not the raw-minus-40 degC offset
  // JK/Daly use - see PROTOCOL.md's Analog Quantity table.
  const mosTemperatureC = (readU16() - 2730) / 10
  const pcbTemperatureC = (readU16() - 2730) / 10
  const cellTemperaturesC = []
  for (let i = 0; i < temperatureCount - 2; i++) cellTemperaturesC.push((readU16() - 2730) / 10)

  const current = readSignedWattCurrent(data, off); off += 2
  const packVoltage = readU16() / 100
  const remainingCapacityAh = readU16() / 10
  const fullChargeCapacityAh = readU16() / 10
  off += 2 // cycle count - not currently surfaced
  off += 2 // design (nameplate) capacity - not currently surfaced, see fullChargeCapacityAh
  const soc = readU16()

  const reading = {
    cellVoltages,
    packVoltage,
    current,
    soc,
    fullChargeCapacityAh,
    remainingCapacityAh,
    mosTemperatureC,
    batteryTemperatureC: pcbTemperatureC
  }
  if (cellTemperaturesC.length > 0) reading.batteryTemperaturesC = cellTemperaturesC

  return reading
}

module.exports = {
  SERVICE_UUID,
  NOTIFY_CHAR,
  WRITE_CHAR,
  AUTH_CHAR,
  AUTH_KEY,
  REQUEST_INTERVAL_MS,
  WattcycleFrameAssembler,
  buildRequest
}
