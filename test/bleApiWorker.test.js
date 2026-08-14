'use strict'

const { test, mock } = require('node:test')
const assert = require('node:assert/strict')
const BleApiWorker = require('../lib/bleApiWorker')
const jk = require('../lib/protocols/jk')
const daly = require('../lib/protocols/daly')

function createFakeHandle () {
  const handle = {
    connected: true,
    read: mock.fn(async () => Buffer.alloc(0)),
    write: mock.fn(async () => {}),
    close: mock.fn(async () => {}),
    onDisconnect: mock.fn(),
    onConnect: mock.fn()
  }
  return handle
}

function createApp ({ subscribeGATTImpl } = {}) {
  const notificationCallbacks = new Map() // mac -> callback
  const subscribeGATT = mock.fn(async (descriptor, pluginId, callback) => {
    notificationCallbacks.set(descriptor.mac, callback)
    if (subscribeGATTImpl) return subscribeGATTImpl(descriptor, pluginId, callback)
    return createFakeHandle()
  })

  return {
    app: {
      debug: mock.fn(),
      pluginId: 'signalk-bms-ble',
      bleApi: { subscribeGATT }
    },
    subscribeGATT,
    notificationCallbacks
  }
}

test('subscribes to a JK device with the correct descriptor (service, notify, init writes)', async () => {
  const { app, subscribeGATT } = createApp()
  const worker = new BleApiWorker({ app, devices: [{ id: 'house1', type: 'jk', address: '11:22:33:44:55:66' }], onReading: () => {} })

  worker.start()
  await new Promise((resolve) => setImmediate(resolve))

  assert.equal(subscribeGATT.mock.calls.length, 1)
  const [descriptor, pluginId] = subscribeGATT.mock.calls[0].arguments
  assert.equal(descriptor.mac, '11:22:33:44:55:66')
  assert.equal(descriptor.service, jk.SERVICE_UUID)
  assert.deepEqual(descriptor.notify, [jk.NOTIFY_CHAR])
  assert.equal(descriptor.init.length, 2)
  assert.equal(descriptor.init[0].uuid, jk.NOTIFY_CHAR)
  assert.equal(pluginId, 'signalk-bms-ble')
})

test('subscribes to a Daly device with a periodic write descriptor', async () => {
  const { app, subscribeGATT } = createApp()
  const worker = new BleApiWorker({ app, devices: [{ id: 'daly1', type: 'daly', address: '11:22:33:44:55:67' }], onReading: () => {} })

  worker.start()
  await new Promise((resolve) => setImmediate(resolve))

  const [descriptor] = subscribeGATT.mock.calls[0].arguments
  assert.equal(descriptor.service, daly.SERVICE_UUID)
  assert.deepEqual(descriptor.notify, [daly.NOTIFY_CHAR])
  assert.equal(descriptor.periodicWrite.length, 1)
  assert.equal(descriptor.periodicWrite[0].uuid, daly.WRITE_CHAR)
  assert.equal(descriptor.periodicWrite[0].intervalMs, daly.REQUEST_INTERVAL_MS)
})

test('a JK notification chunk is parsed and forwards a reading via onReading', async () => {
  const { app, notificationCallbacks } = createApp()
  const readings = []
  const worker = new BleApiWorker({ app, devices: [{ id: 'house1', type: 'jk', address: '11:22:33:44:55:66' }], onReading: (msg) => readings.push(msg) })

  worker.start()
  await new Promise((resolve) => setImmediate(resolve))

  // Build a minimal valid JK cell-info frame the same way the jk.test.js
  // suite does, inline here to keep this test self-contained.
  const INFO_FRAME_LEN = 300
  const FIELD_OFFSET = 32
  const frame = Buffer.alloc(INFO_FRAME_LEN)
  frame.writeUInt8(0x55, 0)
  frame.writeUInt8(0xaa, 1)
  frame.writeUInt8(0xeb, 2)
  frame.writeUInt8(0x90, 3)
  frame.writeUInt8(0x02, 4)
  frame.writeUInt16LE(3300, 6)
  frame.writeUInt32LE(13200, 118 + FIELD_OFFSET)
  frame.writeInt32LE(-1000, 126 + FIELD_OFFSET)
  frame.writeUInt8(60, 141 + FIELD_OFFSET)
  frame.writeUInt32LE(100000, 146 + FIELD_OFFSET)
  let s = 0
  for (const b of frame.subarray(0, INFO_FRAME_LEN - 1)) s = (s + b) & 0xff
  frame.writeUInt8(s, INFO_FRAME_LEN - 1)

  const callback = notificationCallbacks.get('11:22:33:44:55:66')
  callback(jk.NOTIFY_CHAR, frame)

  assert.equal(readings.length, 1)
  assert.equal(readings[0].id, 'house1')
  assert.equal(readings[0].soc, 60)
  assert.equal(readings[0].packVoltage, 13.2)
})

test('an implausible reading is reported as an error instead of published', async () => {
  const { app, notificationCallbacks } = createApp()
  const readings = []
  const worker = new BleApiWorker({ app, devices: [{ id: 'daly1', type: 'daly', address: '11:22:33:44:55:67' }], onReading: (msg) => readings.push(msg) })

  worker.start()
  await new Promise((resolve) => setImmediate(resolve))

  function crc16Modbus (data) {
    let crc = 0xffff
    for (const b of data) {
      crc ^= b
      for (let i = 0; i < 8; i++) crc = crc & 1 ? (crc >> 1) ^ 0xa001 : crc >> 1
    }
    return crc & 0xffff
  }
  const payload = Buffer.alloc(0x3e * 2)
  payload.writeUInt16BE(2500, 0x2a * 2) // SOC = 250% - implausible
  const withoutCrc = Buffer.concat([Buffer.from([0xd2, 0x03, payload.length]), payload])
  const crc = crc16Modbus(withoutCrc)
  const frame = Buffer.concat([withoutCrc, Buffer.from([crc & 0xff, (crc >> 8) & 0xff])])

  const callback = notificationCallbacks.get('11:22:33:44:55:67')
  callback(daly.NOTIFY_CHAR, frame)

  assert.equal(readings.length, 1)
  assert.equal(readings[0].id, 'daly1')
  assert.match(readings[0].error, /implausible reading/)
})

test('subscribeGATT failure is reported via onReading as an error', async () => {
  const { app } = createApp({ subscribeGATTImpl: async () => { throw new Error('device not found') } })
  const readings = []
  const worker = new BleApiWorker({ app, devices: [{ id: 'house1', type: 'jk', address: '11:22:33:44:55:66' }], onReading: (msg) => readings.push(msg) })

  worker.start()
  await new Promise((resolve) => setImmediate(resolve))

  assert.equal(readings.length, 1)
  assert.equal(readings[0].id, 'house1')
  assert.match(readings[0].error, /device not found/)
})

test('stop() closes all open GATT handles', async () => {
  const handle = createFakeHandle()
  const { app } = createApp({ subscribeGATTImpl: async () => handle })
  const worker = new BleApiWorker({ app, devices: [{ id: 'house1', type: 'jk', address: '11:22:33:44:55:66' }], onReading: () => {} })

  worker.start()
  await new Promise((resolve) => setImmediate(resolve))
  await worker.stop()

  assert.equal(handle.close.mock.calls.length, 1)
})

test('an unknown device type is skipped without calling subscribeGATT', async () => {
  const { app, subscribeGATT } = createApp()
  const worker = new BleApiWorker({ app, devices: [{ id: 'mystery1', type: 'acme', address: '11:22:33:44:55:99' }], onReading: () => {} })

  worker.start()
  await new Promise((resolve) => setImmediate(resolve))

  assert.equal(subscribeGATT.mock.calls.length, 0)
})
