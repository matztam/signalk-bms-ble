'use strict'

const { test, mock } = require('node:test')
const assert = require('node:assert/strict')
const path = require('node:path')

// index.js requires ./lib/bleWorker at module load time; replace it in
// require.cache with a stub before requiring index.js, so tests never spawn
// a real Python subprocess. mock.module (node:test's built-in ES module
// mocking) needs Node 22+; require.cache substitution works from the
// project's minimum supported Node 18, so that's used here instead.
const bleWorkerPath = require.resolve('../lib/bleWorker')

class FakeBleWorker {
  constructor ({ onReading }) {
    FakeBleWorker.lastInstance = this
    this.onReading = onReading
    this.started = false
    this.stopped = false
  }

  start () {
    this.started = true
  }

  stop () {
    this.stopped = true
  }
}

require.cache[bleWorkerPath] = {
  id: bleWorkerPath,
  filename: bleWorkerPath,
  loaded: true,
  exports: FakeBleWorker
}

// Same stubbing approach for lib/bleApiWorker (the app.bleApi-based
// worker, chosen instead of BleWorker when app.bleApi is present - see
// index.js's plugin.start()).
const bleApiWorkerPath = require.resolve('../lib/bleApiWorker')

class FakeBleApiWorker {
  constructor ({ onReading }) {
    FakeBleApiWorker.lastInstance = this
    this.onReading = onReading
    this.started = false
    this.stopped = false
  }

  start () {
    this.started = true
  }

  stop () {
    this.stopped = true
  }
}

require.cache[bleApiWorkerPath] = {
  id: bleApiWorkerPath,
  filename: bleApiWorkerPath,
  loaded: true,
  exports: FakeBleApiWorker
}

const pluginFactory = require('../index')

function createApp ({ bleApi } = {}) {
  const app = {
    debug: mock.fn(),
    error: mock.fn(),
    setPluginStatus: mock.fn(),
    setPluginError: mock.fn(),
    handleMessage: mock.fn()
  }
  if (bleApi) app.bleApi = bleApi
  return app
}

function deltaValues (app) {
  // Flattens every values[] array handed to handleMessage across all calls
  // into a single { path: value } map of the most recent value per path -
  // sufficient for these tests, which only care about the latest publish.
  const out = {}
  for (const call of app.handleMessage.mock.calls) {
    const [, delta] = call.arguments
    for (const update of delta.updates) {
      for (const { path: p, value } of update.values) {
        out[p] = value
      }
    }
  }
  return out
}

test('schema exposes the device list with sane defaults', () => {
  const app = createApp()
  const plugin = pluginFactory(app)
  const schema = plugin.schema()

  assert.equal(schema.properties.devices.type, 'array')
  assert.deepEqual(schema.properties.devices.default, [])
  assert.deepEqual(schema.properties.devices.items.required, ['id', 'type', 'address'])
  assert.deepEqual(schema.properties.devices.items.properties.type.enum, ['jk', 'daly'])
})

test('start() with no devices reports status and does not spawn a worker', () => {
  const app = createApp()
  const plugin = pluginFactory(app)

  plugin.start({})

  assert.equal(app.setPluginStatus.mock.calls[0].arguments[0], 'No devices configured')
  assert.equal(app.setPluginError.mock.calls.length, 0)
  assert.equal(FakeBleWorker.lastInstance, undefined)
})

test('start() rejects an unknown BMS type without spawning a worker', () => {
  const app = createApp()
  const plugin = pluginFactory(app)
  FakeBleWorker.lastInstance = undefined

  plugin.start({ devices: [{ id: 'a', type: 'acme', address: '00:00:00:00:00:00' }] })

  assert.match(app.setPluginError.mock.calls[0].arguments[0], /Unknown BMS type/)
  assert.equal(FakeBleWorker.lastInstance, undefined)
})

test('start() rejects duplicate device ids', () => {
  const app = createApp()
  const plugin = pluginFactory(app)
  FakeBleWorker.lastInstance = undefined

  plugin.start({
    devices: [
      { id: 'house1', type: 'jk', address: '11:11:11:11:11:11' },
      { id: 'house1', type: 'daly', address: '22:22:22:22:22:22' }
    ]
  })

  assert.match(app.setPluginError.mock.calls[0].arguments[0], /Duplicate device id/)
  assert.equal(FakeBleWorker.lastInstance, undefined)
})

test('start() with only disabled devices reports status and does not spawn a worker', () => {
  const app = createApp()
  const plugin = pluginFactory(app)
  FakeBleWorker.lastInstance = undefined

  plugin.start({ devices: [{ id: 'a', type: 'jk', address: '11:11:11:11:11:11', enabled: false }] })

  assert.equal(app.setPluginStatus.mock.calls[0].arguments[0], 'All configured devices are disabled')
  assert.equal(FakeBleWorker.lastInstance, undefined)
})

test('start() with a valid device spawns and starts the worker', () => {
  const app = createApp()
  const plugin = pluginFactory(app)

  plugin.start({ devices: [{ id: 'house1', type: 'jk', address: '11:11:11:11:11:11' }] })

  assert.ok(FakeBleWorker.lastInstance)
  assert.equal(FakeBleWorker.lastInstance.started, true)
})

test('stop() tears down the worker and resets status', () => {
  const app = createApp()
  const plugin = pluginFactory(app)
  plugin.start({ devices: [{ id: 'house1', type: 'jk', address: '11:11:11:11:11:11' }] })
  const worker = FakeBleWorker.lastInstance

  plugin.stop()

  assert.equal(worker.stopped, true)
  assert.equal(app.setPluginStatus.mock.calls.at(-1).arguments[0], 'Stopped')
})

test('a reading publishes SOC (scaled to 0-1), voltage, current and cell voltages', () => {
  const app = createApp()
  const plugin = pluginFactory(app)
  plugin.start({ devices: [{ id: 'house1', type: 'jk', address: '11:11:11:11:11:11' }] })

  FakeBleWorker.lastInstance.onReading({
    id: 'house1',
    soc: 78,
    packVoltage: 13.31,
    current: -12.4,
    cellVoltages: [3.325, 3.328, 3.327, 3.33]
  })

  const values = deltaValues(app)
  assert.equal(values['electrical.batteries.house1.capacity.stateOfCharge'], 0.78)
  assert.equal(values['electrical.batteries.house1.voltage'], 13.31)
  assert.equal(values['electrical.batteries.house1.current'], -12.4)
  assert.equal(values['electrical.batteries.house1.cellVoltages.1.voltage'], 3.325)
  assert.equal(values['electrical.batteries.house1.cellVoltages.4.voltage'], 3.33)
})

test('an incomplete reading (missing soc/voltage/current) is not published to SignalK', () => {
  const app = createApp()
  const plugin = pluginFactory(app)
  plugin.start({ devices: [{ id: 'house1', type: 'jk', address: '11:11:11:11:11:11' }] })

  FakeBleWorker.lastInstance.onReading({ id: 'house1', soc: 78 })

  assert.equal(app.handleMessage.mock.calls.length, 0)
})

test('an error reading is not published to SignalK', () => {
  const app = createApp()
  const plugin = pluginFactory(app)
  plugin.start({ devices: [{ id: 'house1', type: 'jk', address: '11:11:11:11:11:11' }] })

  FakeBleWorker.lastInstance.onReading({ id: 'house1', error: 'implausible reading' })

  assert.equal(app.handleMessage.mock.calls.length, 0)
})

test('capacity.actual/remaining convert BMS-reported Ah to joules (Ah * V * 3600)', () => {
  const app = createApp()
  const plugin = pluginFactory(app)
  plugin.start({ devices: [{ id: 'house1', type: 'jk', address: '11:11:11:11:11:11' }] })

  FakeBleWorker.lastInstance.onReading({
    id: 'house1',
    soc: 50,
    packVoltage: 13.3,
    current: 0,
    fullChargeCapacityAh: 105
  })

  const values = deltaValues(app)
  const expectedActualJ = 105 * 13.3 * 3600
  assert.ok(Math.abs(values['electrical.batteries.house1.capacity.actual'] - expectedActualJ) < 1e-6)

  const expectedRemainingJ = 0.5 * 105 * 13.3 * 3600
  assert.ok(Math.abs(values['electrical.batteries.house1.capacity.remaining'] - expectedRemainingJ) < 1e-6)
})

test('capacity.timeRemaining is published while discharging', () => {
  const app = createApp()
  const plugin = pluginFactory(app)
  plugin.start({ devices: [{ id: 'house1', type: 'jk', address: '11:11:11:11:11:11' }] })

  FakeBleWorker.lastInstance.onReading({
    id: 'house1',
    soc: 50,
    packVoltage: 13.3,
    current: -10,
    fullChargeCapacityAh: 100
  })

  const values = deltaValues(app)
  // remaining = 50 Ah, at 10A discharge -> 5h = 18000s
  assert.ok(Math.abs(values['electrical.batteries.house1.capacity.timeRemaining'] - 18000) < 1e-6)
})

test('capacity.timeRemaining is omitted while charging or idle', () => {
  const app = createApp()
  const plugin = pluginFactory(app)
  plugin.start({ devices: [{ id: 'house1', type: 'jk', address: '11:11:11:11:11:11' }] })

  FakeBleWorker.lastInstance.onReading({
    id: 'house1',
    soc: 50,
    packVoltage: 13.3,
    current: 10, // charging
    fullChargeCapacityAh: 100
  })

  const values = deltaValues(app)
  assert.equal('electrical.batteries.house1.capacity.timeRemaining' in values, false)
  // actual/remaining should still be published regardless of charge direction
  assert.ok('electrical.batteries.house1.capacity.actual' in values)
})

test('capacity.timeRemaining is omitted when discharge current is near zero (avoids a meaningless huge value)', () => {
  const app = createApp()
  const plugin = pluginFactory(app)
  plugin.start({ devices: [{ id: 'house1', type: 'jk', address: '11:11:11:11:11:11' }] })

  // Technically discharging (current < 0) but small enough to be noise
  // around zero - dividing remainingAh by this would otherwise produce a
  // technically-finite but absurd number of hours.
  FakeBleWorker.lastInstance.onReading({
    id: 'house1',
    soc: 50,
    packVoltage: 13.3,
    current: -0.001,
    fullChargeCapacityAh: 100
  })

  const values = deltaValues(app)
  assert.equal('electrical.batteries.house1.capacity.timeRemaining' in values, false)
  assert.ok('electrical.batteries.house1.capacity.actual' in values)
})

test('capacity fields are omitted entirely when the BMS reports no capacity', () => {
  const app = createApp()
  const plugin = pluginFactory(app)
  plugin.start({ devices: [{ id: 'house1', type: 'jk', address: '11:11:11:11:11:11' }] })

  FakeBleWorker.lastInstance.onReading({ id: 'house1', soc: 50, packVoltage: 13.3, current: -1 })

  const values = deltaValues(app)
  assert.equal('electrical.batteries.house1.capacity.actual' in values, false)
  assert.equal('electrical.batteries.house1.capacity.remaining' in values, false)
  assert.equal('electrical.batteries.house1.capacity.timeRemaining' in values, false)
})

test('current smoothing converges toward a step change rather than jumping instantly', async () => {
  const app = createApp()
  const plugin = pluginFactory(app)
  plugin.start({ devices: [{ id: 'house1', type: 'jk', address: '11:11:11:11:11:11' }] })

  const baseReading = { id: 'house1', soc: 50, packVoltage: 13.3, fullChargeCapacityAh: 100 }

  // First reading seeds the smoother with its own value (no history yet).
  FakeBleWorker.lastInstance.onReading({ ...baseReading, current: -1 })
  const firstValues = deltaValues(app)
  const firstTimeRemaining = firstValues['electrical.batteries.house1.capacity.timeRemaining']
  // remaining = 50Ah, at a fully-settled 1A that would be 50h = 180000s
  assert.ok(Math.abs(firstTimeRemaining - 180000) < 1e-6)

  // A sudden large current step should NOT immediately produce the
  // instantaneous-current time-remaining (5h) - smoothing should still be
  // much closer to the prior value shortly after the step.
  FakeBleWorker.lastInstance.onReading({ ...baseReading, current: -10 })
  const secondValues = deltaValues(app)
  const secondTimeRemaining = secondValues['electrical.batteries.house1.capacity.timeRemaining']
  const instantaneousTimeRemaining = 18000 // 50Ah / 10A * 3600
  assert.ok(
    secondTimeRemaining > instantaneousTimeRemaining * 2,
    `expected smoothed timeRemaining (${secondTimeRemaining}) to still be well above the instantaneous value (${instantaneousTimeRemaining}) immediately after a step change`
  )
})

test('start() uses the Python worker (BleWorker) when app.bleApi is absent', () => {
  const app = createApp()
  const plugin = pluginFactory(app)
  FakeBleWorker.lastInstance = undefined
  FakeBleApiWorker.lastInstance = undefined

  plugin.start({ devices: [{ id: 'house1', type: 'jk', address: '11:22:33:44:55:66' }] })

  assert.ok(FakeBleWorker.lastInstance)
  assert.equal(FakeBleWorker.lastInstance.started, true)
  assert.equal(FakeBleApiWorker.lastInstance, undefined)
  assert.match(app.setPluginStatus.mock.calls.at(-1).arguments[0], /Python worker/)
})

test('start() uses the server BLE API worker when app.bleApi is present', () => {
  const app = createApp({ bleApi: { subscribeGATT: mock.fn() } })
  const plugin = pluginFactory(app)
  FakeBleWorker.lastInstance = undefined
  FakeBleApiWorker.lastInstance = undefined

  plugin.start({ devices: [{ id: 'house1', type: 'jk', address: '11:22:33:44:55:66' }] })

  assert.ok(FakeBleApiWorker.lastInstance)
  assert.equal(FakeBleApiWorker.lastInstance.started, true)
  assert.equal(FakeBleWorker.lastInstance, undefined)
  assert.match(app.setPluginStatus.mock.calls.at(-1).arguments[0], /server BLE API/)
})

test('capacity/current-smoothing logic behaves identically via the BLE API worker path', () => {
  const app = createApp({ bleApi: { subscribeGATT: mock.fn() } })
  const plugin = pluginFactory(app)
  plugin.start({ devices: [{ id: 'house1', type: 'jk', address: '11:22:33:44:55:66' }] })

  FakeBleApiWorker.lastInstance.onReading({
    id: 'house1', soc: 50, packVoltage: 13.3, current: -10, fullChargeCapacityAh: 100
  })

  const values = deltaValues(app)
  assert.ok(Math.abs(values['electrical.batteries.house1.capacity.timeRemaining'] - 18000) < 1e-6)
})
