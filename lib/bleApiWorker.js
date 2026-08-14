'use strict'

// Uses SignalK server's own BLE Provider API (app.bleApi, added in
// signalk-server 2.31.0) instead of spawning ble_worker.py. The server
// handles discovery, GATT connection lifecycle, provider selection, and
// reconnection - everything ble_worker.py/BleWorker previously had to
// implement itself (persistent connections, connect_lock serialization,
// the watchdog thread). See index.js for how this is chosen over
// BleWorker (the Python-subprocess fallback for servers older than
// 2.31.0).
//
// Same public interface as BleWorker ({ app, devices, onReading },
// start()/stop()) so index.js can use either without caring which one
// it got.

const jk = require('./protocols/jk')
const daly = require('./protocols/daly')
const { implausibleReadingReason } = require('./protocols/sanity')

class BleApiWorker {
  constructor ({ app, devices, onReading }) {
    this.app = app
    this.devices = devices
    this.onReading = onReading
    this._handles = new Map() // device id -> GATTSubscriptionHandle
    this._stopping = false
  }

  start () {
    this._stopping = false
    for (const device of this.devices) {
      this._subscribe(device)
    }
  }

  async _subscribe (device) {
    const { app, onReading } = this
    const { id, type, address } = device
    const mac = address.toUpperCase()

    let descriptor
    if (type === 'jk') {
      descriptor = {
        mac,
        service: jk.SERVICE_UUID,
        notify: [jk.NOTIFY_CHAR],
        init: jk.initWrites.map((data) => ({ uuid: jk.NOTIFY_CHAR, data: data.toString('hex') }))
      }
    } else if (type === 'daly') {
      descriptor = {
        mac,
        service: daly.SERVICE_UUID,
        notify: [daly.NOTIFY_CHAR],
        periodicWrite: [{
          uuid: daly.WRITE_CHAR,
          data: daly.buildRequest().toString('hex'),
          intervalMs: daly.REQUEST_INTERVAL_MS
        }]
      }
    } else {
      app.debug(`BLE API worker: unknown device type "${type}" for ${id}, skipping`)
      return
    }

    // A fresh assembler per (re)connection: jk.JkFrameAssembler buffers
    // partial frames across notifications, and a stale partial frame
    // from before a disconnect should never be stitched onto bytes from
    // the new connection.
    let jkAssembler = type === 'jk' ? new jk.JkFrameAssembler() : null

    const handleNotification = (charUuid, data) => {
      let reading
      if (type === 'jk') {
        reading = jkAssembler.feed(data)
      } else {
        reading = daly.parseNotification(data)
      }
      if (reading == null) return

      const reason = implausibleReadingReason(reading)
      if (reason != null) {
        // Don't let the server's reconnect/failover logic loop on this -
        // a wrong offset is a static property of this device/firmware,
        // not a transient BLE hiccup, so retrying just repeats the same
        // misparse. Report once per reading instead so the cause (not
        // just "no data") is visible in the plugin's SignalK status and
        // this device's readings never reach SignalK.
        app.debug(`BLE API worker: ${id}: implausible reading, dropped (${reason})`)
        onReading({
          id,
          error: `implausible reading (${reason}) - this BMS's firmware/` +
            'hardware generation may need a different field offset; ' +
            'see diag/findings/PROTOCOL_NOTES.md and please open an issue ' +
            'with your device model'
        })
        return
      }
      onReading({ id, ...reading })
    }

    try {
      const handle = await app.bleApi.subscribeGATT(descriptor, app.pluginId || 'signalk-bms-ble', handleNotification)
      if (this._stopping) {
        await handle.close()
        return
      }
      this._handles.set(id, handle)
      handle.onDisconnect(() => {
        app.debug(`BLE API worker: ${id} (${mac}): disconnected`)
        onReading({ id, error: 'disconnected' })
        // A fresh assembler for the next connection - see comment above.
        if (type === 'jk') jkAssembler = new jk.JkFrameAssembler()
      })
      handle.onConnect(() => {
        app.debug(`BLE API worker: ${id} (${mac}): connected`)
      })
    } catch (err) {
      app.debug(`BLE API worker: ${id} (${mac}): subscribeGATT failed — ${err.message}`)
      onReading({ id, error: err.message })
    }
  }

  async stop () {
    this._stopping = true
    const closes = [...this._handles.values()].map((handle) => handle.close().catch(() => {}))
    this._handles.clear()
    await Promise.all(closes)
  }
}

module.exports = BleApiWorker
