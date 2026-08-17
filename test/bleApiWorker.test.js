'use strict'

const { test, mock } = require('node:test')
const assert = require('node:assert/strict')
const BleApiWorker = require('../lib/bleApiWorker')
const jk = require('../lib/protocols/jk')
const daly = require('../lib/protocols/daly')
const wattcycle = require('../lib/protocols/wattcycle')

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
  const unsubscribeAdvertisements = mock.fn()
  const onAdvertisement = mock.fn((_pluginId, _callback) => unsubscribeAdvertisements)

  return {
    app: {
      debug: mock.fn(),
      pluginId: 'signalk-bms-ble',
      bleApi: { subscribeGATT, onAdvertisement }
    },
    subscribeGATT,
    onAdvertisement,
    unsubscribeAdvertisements,
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
  // Write-without-response - the server's default (with response) gets
  // "Write not permitted" back from real hardware; see the comment in
  // bleApiWorker.js's descriptor construction.
  assert.equal(descriptor.init[0].withResponse, false)
  assert.equal(descriptor.init[1].withResponse, false)
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
  assert.equal(descriptor.periodicWrite[0].withResponse, false)
})

test('subscribes to a WattCycle device with an auth init write and a periodic write descriptor', async () => {
  const { app, subscribeGATT } = createApp()
  const worker = new BleApiWorker({ app, devices: [{ id: 'wattcycle1', type: 'wattcycle', address: '11:22:33:44:55:68' }], onReading: () => {} })

  worker.start()
  await new Promise((resolve) => setImmediate(resolve))

  const [descriptor] = subscribeGATT.mock.calls[0].arguments
  assert.equal(descriptor.service, wattcycle.SERVICE_UUID)
  assert.deepEqual(descriptor.notify, [wattcycle.NOTIFY_CHAR])
  assert.equal(descriptor.init.length, 1)
  assert.equal(descriptor.init[0].uuid, wattcycle.AUTH_CHAR)
  assert.equal(descriptor.init[0].data, wattcycle.AUTH_KEY.toString('hex'))
  assert.equal(descriptor.init[0].withResponse, false)
  assert.equal(descriptor.periodicWrite.length, 1)
  assert.equal(descriptor.periodicWrite[0].uuid, wattcycle.WRITE_CHAR)
  assert.equal(descriptor.periodicWrite[0].intervalMs, wattcycle.REQUEST_INTERVAL_MS)
  assert.equal(descriptor.periodicWrite[0].withResponse, false)
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

test('subscribeGATT failure is reported via onReading as an error, then retried', async () => {
  const { app } = createApp({ subscribeGATTImpl: async () => { throw new Error('device not found') } })
  const readings = []
  const worker = new BleApiWorker({ app, devices: [{ id: 'house1', type: 'jk', address: '11:22:33:44:55:66' }], onReading: (msg) => readings.push(msg) })

  worker.start()
  await new Promise((resolve) => setImmediate(resolve))

  assert.equal(readings.length, 1)
  assert.equal(readings[0].id, 'house1')
  assert.match(readings[0].error, /device not found/)

  // stop() must cancel the pending retry-backoff wait immediately, both so
  // the plugin actually stops promptly and so this test doesn't keep the
  // process alive for RETRY_DELAY_MS.
  await worker.stop()
})

test('a permanently failing subscribeGATT is retried, not given up on', async () => {
  let attempts = 0
  const { app } = createApp({
    subscribeGATTImpl: async () => {
      attempts++
      throw new Error('No provider with GATT support and available slots can see 11:22:33:44:55:66')
    }
  })
  const readings = []
  const worker = new BleApiWorker({ app, devices: [{ id: 'house1', type: 'jk', address: '11:22:33:44:55:66' }], onReading: (msg) => readings.push(msg) })

  worker.start()
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(attempts, 1)

  // Force the retry backoff to elapse immediately instead of waiting out
  // the real RETRY_DELAY_MS, by resolving the worker's own pending timer.
  for (const entry of worker._retryTimers) entry.clear()
  await new Promise((resolve) => setImmediate(resolve))

  assert.equal(attempts, 2)
  assert.equal(readings.length, 2)

  await worker.stop()
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

test('start() subscribes to the advertisement stream so the server\'s device table gets populated', async () => {
  // Without an onAdvertisement() subscriber, signalk-server's local BLE
  // provider discards every advertisement it sees instead of recording it
  // (LocalBLEProvider.emitDeviceAdvertisement bails out early when there
  // are no subscribers) - so subscribeGATT() would otherwise fail forever
  // with "No provider ... can see <mac>" even for a device that's right
  // there and discoverable. We don't care about the advertisement payload
  // itself, only that subscribing keeps the device table populated.
  const { app, onAdvertisement } = createApp()
  const worker = new BleApiWorker({ app, devices: [{ id: 'house1', type: 'jk', address: '11:22:33:44:55:66' }], onReading: () => {} })

  worker.start()

  assert.equal(onAdvertisement.mock.calls.length, 1)
  assert.equal(onAdvertisement.mock.calls[0].arguments[0], 'signalk-bms-ble')
})

test('stop() unsubscribes from the advertisement stream', async () => {
  const { app, unsubscribeAdvertisements } = createApp()
  const worker = new BleApiWorker({ app, devices: [{ id: 'house1', type: 'jk', address: '11:22:33:44:55:66' }], onReading: () => {} })

  worker.start()
  await new Promise((resolve) => setImmediate(resolve))
  await worker.stop()

  assert.equal(unsubscribeAdvertisements.mock.calls.length, 1)
})

test('subscribeGATT failing with "No provider ... can see" repeatedly past the threshold gets a stale-connection hint appended', async () => {
  const { app } = createApp({
    subscribeGATTImpl: async () => {
      throw new Error('No provider with GATT support and available slots can see 11:22:33:44:55:66')
    }
  })
  const readings = []
  const worker = new BleApiWorker({ app, devices: [{ id: 'house1', type: 'jk', address: '11:22:33:44:55:66' }], onReading: (msg) => readings.push(msg) })

  worker.start()
  await new Promise((resolve) => setImmediate(resolve))

  // Drive 12 consecutive failures (STALE_CONNECTION_HINT_THRESHOLD) by
  // forcing each retry backoff to elapse immediately.
  for (let i = 0; i < 11; i++) {
    for (const entry of worker._retryTimers) entry.clear()
    await new Promise((resolve) => setImmediate(resolve))
  }

  assert.equal(readings.length, 12)
  // Only the 12th failure should carry the hint - not every one of them.
  for (let i = 0; i < 11; i++) {
    assert.doesNotMatch(readings[i].error, /stale connection/)
  }
  assert.match(readings[11].error, /device not seen for over a minute/)
  assert.match(readings[11].error, /bluetoothctl disconnect 11:22:33:44:55:66/)

  await worker.stop()
})

test('a successful connection after "not seen" failures resets the streak, so the hint only fires on a fresh run of failures', async () => {
  let shouldFail = true
  const { app } = createApp({
    subscribeGATTImpl: async () => {
      if (shouldFail) throw new Error('No provider with GATT support and available slots can see 11:22:33:44:55:66')
      return createFakeHandle()
    }
  })
  const readings = []
  const worker = new BleApiWorker({ app, devices: [{ id: 'house1', type: 'jk', address: '11:22:33:44:55:66' }], onReading: (msg) => readings.push(msg) })

  worker.start()
  await new Promise((resolve) => setImmediate(resolve))

  for (let i = 0; i < 4; i++) {
    for (const entry of worker._retryTimers) entry.clear()
    await new Promise((resolve) => setImmediate(resolve))
  }
  shouldFail = false
  for (const entry of worker._retryTimers) entry.clear()
  await new Promise((resolve) => setImmediate(resolve))

  assert.equal(readings.filter((r) => /stale connection/.test(r.error || '')).length, 0)

  await worker.stop()
})

test('a connection that stops delivering notifications is force-reconnected after the data timeout', async (t) => {
  t.mock.timers.enable({ apis: ['setInterval', 'Date'] })

  let subscribeCalls = 0
  const handles = []
  const { app } = createApp({
    subscribeGATTImpl: async () => {
      subscribeCalls++
      const h = createFakeHandle()
      handles.push(h)
      return h
    }
  })
  const readings = []
  const worker = new BleApiWorker({ app, devices: [{ id: 'house1', type: 'jk', address: '11:22:33:44:55:66' }], onReading: (msg) => readings.push(msg) })

  worker.start()
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(subscribeCalls, 1)

  // No notifications ever arrive on this connection. Advance past
  // DATA_TIMEOUT_MS (20000ms); the watchdog checks every
  // min(DATA_TIMEOUT_MS, 5000)ms.
  t.mock.timers.tick(5000)
  t.mock.timers.tick(5000)
  t.mock.timers.tick(5000)
  t.mock.timers.tick(5000)
  t.mock.timers.tick(5000)
  await new Promise((resolve) => setImmediate(resolve))

  assert.equal(handles[0].close.mock.calls.length, 1)
  assert.equal(subscribeCalls, 2)
  assert.ok(readings.some((r) => /no data for/.test(r.error || '')))

  await worker.stop()
})

test('notifications reset the data-timeout watchdog, so an active connection is never force-reconnected', async (t) => {
  t.mock.timers.enable({ apis: ['setInterval', 'Date'] })

  const { app, notificationCallbacks } = createApp()
  const worker = new BleApiWorker({ app, devices: [{ id: 'daly1', type: 'daly', address: '11:22:33:44:55:67' }], onReading: () => {} })

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
  const withoutCrc = Buffer.concat([Buffer.from([0xd2, 0x03, payload.length]), payload])
  const crc = crc16Modbus(withoutCrc)
  const frame = Buffer.concat([withoutCrc, Buffer.from([crc & 0xff, (crc >> 8) & 0xff])])
  const callback = notificationCallbacks.get('11:22:33:44:55:67')

  // A notification every 5s (faster than the 5s watchdog check interval
  // and well under the 20s timeout) should keep the connection alive
  // indefinitely.
  for (let i = 0; i < 6; i++) {
    t.mock.timers.tick(5000)
    callback(daly.NOTIFY_CHAR, frame)
  }
  await new Promise((resolve) => setImmediate(resolve))

  assert.equal(app.bleApi.subscribeGATT.mock.calls.length, 1)

  await worker.stop()
})
