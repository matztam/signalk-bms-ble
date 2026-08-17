'use strict'

// JK-BMS JK02 family. Service 0xFFE0, single characteristic 0xFFE1
// (write + notify, UART passthrough). Ported from the Python
// implementation in ble_worker.py (JkProtocol) - see that file's history
// and diag/findings/PROTOCOL_NOTES.md for the byte-offset verification
// this is based on.

const SERVICE_UUID = '0000ffe0-0000-1000-8000-00805f9b34fb'
const NOTIFY_CHAR = '0000ffe1-0000-1000-8000-00805f9b34fb'

const RSP_HEADER = Buffer.from([0x55, 0xaa, 0xeb, 0x90])
const INFO_FRAME_LEN = 300
// Verified against JK-B2A8S20P hardware: pack voltage / current / SOC live
// 32 bytes further into the frame than the "32S" layout published by
// syssi/esphome-jk-bms. Other JK firmware/board generations may use a
// different offset (0 or 16) - see diag/findings/PROTOCOL_NOTES.md.
const FIELD_OFFSET = 32

function sum8 (buf) {
  let s = 0
  for (const b of buf) s = (s + b) & 0xff
  return s
}

function command (cmd) {
  const frame = Buffer.concat([Buffer.from([0xaa, 0x55, 0x90, 0xeb, cmd, 0x00]), Buffer.alloc(13)])
  return Buffer.concat([frame, Buffer.from([sum8(frame)])])
}

// esphome-jk-bms calls this field "full_charge_capacity" (its sensor name)
// despite the JK02 field being labeled Nominal_Capacity in most protocol
// notes - it's the BMS's own current calibrated full-charge capacity
// (drifts with cell aging/calibration), not a fixed factory nameplate
// value. Cross-checked against the 0x01 settings frame's "Nominal battery
// capacity" field (offset 130, unshifted) - both agree on real hardware.

class JkFrameAssembler {
  constructor () {
    this._buf = Buffer.alloc(0)
  }

  // Feed one notification's raw bytes. Returns a parsed reading object
  // once a complete, checksum-valid cell-info frame has been assembled,
  // else null.
  feed (chunk) {
    this._buf = Buffer.concat([this._buf, chunk])
    const idx = this._buf.indexOf(RSP_HEADER)
    if (idx === -1) return null
    if (idx > 0) this._buf = this._buf.subarray(idx)
    if (this._buf.length < INFO_FRAME_LEN) return null

    const frame = this._buf.subarray(0, INFO_FRAME_LEN)
    this._buf = this._buf.subarray(INFO_FRAME_LEN)

    if (frame[4] !== 0x02) return null // settings/device-info frame, keep waiting for cell-info

    const expected = frame[INFO_FRAME_LEN - 1]
    const actual = sum8(frame.subarray(0, INFO_FRAME_LEN - 1))
    if (expected !== actual) return null

    return parse(frame)
  }
}

// Temperature fields, unverified against real hardware (no device
// available to test against - see the CHANGELOG/issue this was added
// for). Positions taken from the documented JK02_32S cell-info layout
// (https://github.com/syssi/esphome-jk-bms/blob/main/docs/protocol-design-ble.md):
// "Power tube temperature" at 144-145 and "Temperature Sensor 1"/"2" at
// 162-163/164-165, each int16 x0.1 degC. Shifted by the same
// FIELD_OFFSET(32) already verified live for packVoltage/current/soc/
// fullChargeCapacityAh above - all four of those land exactly on the
// documented standard-layout field at standardOffset+32, which is why
// the same shift is applied here rather than assuming these three specific
// fields were separately confirmed.
function readTempC (frame, standardOffset) {
  const raw = frame.readInt16LE(standardOffset + FIELD_OFFSET)
  // 0x7fff/-0x8000-ish sentinel or a disconnected-sensor reading of
  // exactly 0 both happen on JK hardware per the esphome-jk-bms issue
  // tracker; sanity.js's PACK/CELL-style range check isn't reused here
  // since implausibleReadingReason() operates on the whole reading, but
  // an absurd raw value (sensor genuinely absent) is still worth hiding
  // rather than publishing e.g. -273.1 degC.
  const tempC = raw / 10
  return tempC > -60 && tempC < 150 ? tempC : undefined
}

function parse (frame) {
  const off = FIELD_OFFSET
  const cellVoltages = []
  for (let i = 0; i < 32; i++) {
    const pos = 6 + i * 2
    const mv = frame.readUInt16LE(pos)
    if (mv !== 0) cellVoltages.push(mv / 1000)
  }

  const reading = {
    cellVoltages,
    packVoltage: frame.readUInt32LE(118 + off) / 1000,
    current: frame.readInt32LE(126 + off) / 1000,
    soc: frame.readUInt8(141 + off),
    fullChargeCapacityAh: frame.readUInt32LE(146 + off) / 1000
  }

  const mosTempC = readTempC(frame, 144)
  if (mosTempC !== undefined) reading.mosTemperatureC = mosTempC
  const temp1C = readTempC(frame, 162)
  if (temp1C !== undefined) reading.batteryTemperatureC = temp1C
  // Temperature Sensor 2 (164-165 in the documented layout) exists on
  // some JK boards but not others (see "Temperature sensor absent
  // bitmask" in the protocol doc) - only published when it looks sane,
  // same as sensor 1.
  const temp2C = readTempC(frame, 164)
  if (temp2C !== undefined) reading.batteryTemperature2C = temp2C

  return reading
}

module.exports = {
  SERVICE_UUID,
  NOTIFY_CHAR,
  RSP_HEADER,
  JkFrameAssembler,
  // 0x96 alone only yields settings/device-info frames on the hardware
  // this was verified against; the 0x97 (device-info) request is what
  // actually makes the device start pushing 0x02 cell-info frames.
  // Sending both as init writes (in order) reproduces ble_worker.py's
  // request()+extra_requests() sequence without needing the "wait 1.5s,
  // then nudge again" logic that existed only to avoid sending 0x97
  // when 0x96 alone had already worked - the server-managed connection
  // has no equivalent hook to skip a later init write, and sending an
  // unnecessary second request is harmless (JK ignores extra 0x97s
  // once it's already streaming).
  initWrites: [command(0x96), command(0x97)]
}
