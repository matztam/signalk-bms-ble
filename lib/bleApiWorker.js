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

// subscribeGATT() rejects immediately with "No provider ... can see <mac>"
// if no provider has observed an advertisement from the device yet - it
// does not itself wait for discovery, unlike bleak's find_device_by_address
// (which the Python fallback relies on and which blocks until found or
// timed out). Observed live: right after a fresh signalk-server boot, the
// very first subscribeGATT() call for every device fails this way because
// the local BlueZ provider's own scan hasn't produced an advertisement yet
// for any of them - not a per-device problem, just the server not having
// "seen" anything yet. Retrying with a short delay lets discovery catch up.
const RETRY_DELAY_MS = 5000

// A device can also disappear from the server's view for a much less
// transient reason: BlueZ itself already holds a stale/orphaned GATT
// connection to it (Connected: yes in `bluetoothctl info`) left over from
// an earlier connection attempt that was never cleanly closed. A connected
// BLE peripheral stops advertising, so the server's device table - which
// only learns about devices from advertisements - loses it entirely, and
// subscribeGATT() then fails with the same "No provider ... can see <mac>"
// error indefinitely, no amount of retrying fixes it. Observed live: this
// resolved itself instantly once the stale connection was closed with
// `bluetoothctl disconnect <mac>` on the server. This plugin has no way to
// force that disconnect itself (there's no BLE API for "release a
// connection you didn't make"), so past this many consecutive failures for
// the same device we stop treating it as ordinary "still searching" and
// call it out distinctly, so it's visible in the plugin's status/log
// instead of silently retrying forever indistinguishably from a device
// that's simply out of range.
const STALE_CONNECTION_HINT_THRESHOLD = 12

// Watchdog for a connection that's gone quiet without ever firing
// onDisconnect. handle.onDisconnect() is the server's job to call, and it
// should cover every real disconnect - but relying on it alone means a
// connection that's silently stopped delivering notifications (BlueZ-level
// hiccup, a GATT subscription that got dropped without the underlying link
// dropping, etc.) would sit there forever looking "connected" while no data
// ever arrives. Both device types notify at least every few seconds
// (Daly's periodicWrite triggers a response roughly every
// daly.REQUEST_INTERVAL_MS; JK pushes continuously), so anything beyond
// this counts as gone even if the server hasn't told us so yet.
const DATA_TIMEOUT_MS = 20000

class BleApiWorker {
  constructor ({ app, devices, onReading }) {
    this.app = app
    this.devices = devices
    this.onReading = onReading
    this._handles = new Map() // device id -> GATTSubscriptionHandle
    this._watchdogs = new Map() // device id -> data-timeout setInterval handle
    this._retryTimers = new Set()
    this._unsubscribeAdvertisements = null
    this._stopping = false
  }

  start () {
    this._stopping = false
    // subscribeGATT() only considers devices the server's own deviceTable
    // already knows about (populated from the advertisement stream), and
    // does not itself listen for advertisements or wait for one to arrive
    // - it fails immediately with "No provider ... can see <mac>" for any
    // device nobody has subscribed to advertisements for yet, even though
    // the device is right there and BlueZ/bluetoothctl sees it fine.
    // Observed live: with no onAdvertisement() subscriber at all, the
    // local BlueZ provider's advertisement handler bails out before ever
    // touching the device table (see LocalBLEProvider.emitDeviceAdvertisement's
    // `if (this.advCallbacks.size === 0) return`), so subscribeGATT()
    // never succeeds no matter how long you retry - discovery is
    // technically running, but its results are discarded. We don't care
    // about the advertisement contents ourselves; this subscription exists
    // purely to keep the device table populated so subscribeGATT() has
    // something to select a provider from.
    this._unsubscribeAdvertisements = this.app.bleApi.onAdvertisement(
      this.app.pluginId || 'signalk-bms-ble',
      () => {}
    )
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
        // withResponse: false - matches ble_worker.py's write_gatt_char(...,
        // response=False). Confirmed live: the server's default (write
        // *with* response) gets "Write not permitted" back from these
        // devices' write characteristics; only write-without-response
        // succeeds, same as the Python fallback always used.
        init: jk.initWrites.map((data) => ({ uuid: jk.NOTIFY_CHAR, data: data.toString('hex'), withResponse: false }))
      }
    } else if (type === 'daly') {
      descriptor = {
        mac,
        service: daly.SERVICE_UUID,
        notify: [daly.NOTIFY_CHAR],
        periodicWrite: [{
          uuid: daly.WRITE_CHAR,
          data: daly.buildRequest().toString('hex'),
          intervalMs: daly.REQUEST_INTERVAL_MS,
          // See the withResponse comment on the JK descriptor above - same
          // "Write not permitted" failure observed live on Daly's write
          // characteristic with the server's default write-with-response.
          withResponse: false
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

    // Reset on every construction and every successful (re)connection - see
    // the DATA_TIMEOUT_MS comment above.
    let lastDataAt = Date.now()

    const handleNotification = (charUuid, data) => {
      lastDataAt = Date.now()
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

    // subscribeGATT() covers reconnection once it has succeeded once (the
    // server re-executes the descriptor's connect->discover->subscribe
    // lifecycle on disconnect - see handle.onDisconnect below), but not
    // the initial "device not seen by any provider yet" case - see the
    // RETRY_DELAY_MS comment above. Retry that specific failure
    // indefinitely at a fixed interval; a device that's simply out of
    // range or powered off should keep being retried the same way the
    // Python fallback's run_device() loop did.
    let consecutiveNotSeenFailures = 0
    while (!this._stopping) {
      try {
        const handle = await app.bleApi.subscribeGATT(descriptor, app.pluginId || 'signalk-bms-ble', handleNotification)
        if (this._stopping) {
          await handle.close()
          return
        }
        consecutiveNotSeenFailures = 0
        lastDataAt = Date.now()
        this._handles.set(id, handle)

        let watchdogFired = false
        const watchdog = setInterval(() => {
          // Guards against firing twice: setInterval's own callback can
          // still be queued/mid-flight for this tick when the clearInterval
          // below runs (e.g. a fake-timer's tick() draining multiple due
          // callbacks before yielding back), so watchdogFired itself - not
          // just clearInterval() - has to gate the body.
          if (watchdogFired) return
          if (Date.now() - lastDataAt < DATA_TIMEOUT_MS) return
          watchdogFired = true
          clearInterval(watchdog)
          this._watchdogs.delete(id)
          app.debug(`BLE API worker: ${id} (${mac}): no data for ${DATA_TIMEOUT_MS}ms, forcing reconnect`)
          onReading({ id, error: `no data for ${DATA_TIMEOUT_MS}ms, reconnecting` })
          if (type === 'jk') jkAssembler = new jk.JkFrameAssembler()
          // handle.close() here does NOT invoke onDisconnect below - the
          // server's closeSession() removes its own disconnect listener
          // before calling device.disconnect(), specifically so a
          // programmatic close() doesn't also fire the "the device went
          // away" callback (see LocalBLEProvider.closeSession). So unlike a
          // real disconnect, this path has to kick off reconnection itself
          // rather than relying on the onDisconnect handler to do it.
          if (this._handles.get(id) === handle) this._handles.delete(id)
          handle.close().catch(() => {})
          if (!this._stopping) this._subscribe(device)
        }, Math.min(DATA_TIMEOUT_MS, 5000))
        watchdog.unref?.()
        this._watchdogs.set(id, watchdog)

        handle.onDisconnect(() => {
          if (watchdogFired) return
          app.debug(`BLE API worker: ${id} (${mac}): disconnected`)
          onReading({ id, error: 'disconnected' })
          clearInterval(watchdog)
          this._watchdogs.delete(id)
          // A fresh assembler for the next connection - see comment above.
          if (type === 'jk') jkAssembler = new jk.JkFrameAssembler()
        })
        handle.onConnect(() => {
          app.debug(`BLE API worker: ${id} (${mac}): connected`)
          lastDataAt = Date.now()
        })
        return
      } catch (err) {
        const isNotSeen = /No provider .* can see/.test(err.message)
        if (isNotSeen) {
          consecutiveNotSeenFailures++
        } else {
          consecutiveNotSeenFailures = 0
        }
        let message = err.message
        if (isNotSeen && consecutiveNotSeenFailures >= STALE_CONNECTION_HINT_THRESHOLD) {
          // See the STALE_CONNECTION_HINT_THRESHOLD comment above - this
          // isn't "still searching" anymore, it's had a full minute of the
          // server never seeing an advertisement from a device that's
          // otherwise fine. Surface the likely cause and the manual fix,
          // since this plugin can't force BlueZ to drop the connection
          // itself. >= (not ===) so the hint stays visible on every
          // subsequent failure once the threshold is crossed, instead of
          // appearing on exactly one retry and then silently reverting to
          // the bare error message for good - a user checking the status
          // page/log at any point after the first minute should still see
          // it, not just someone who happened to look at exactly the right
          // moment.
          message = `${err.message} (device not seen for over a minute - ` +
            'this can mean BlueZ already holds a stale connection to it ' +
            'from an earlier attempt that was never closed; try ' +
            `"bluetoothctl disconnect ${mac}" on the server)`
        }
        app.debug(`BLE API worker: ${id} (${mac}): subscribeGATT failed — ${err.message}, retrying in ${RETRY_DELAY_MS}ms`)
        onReading({ id, error: message })
        await this._wait(RETRY_DELAY_MS)
      }
    }
  }

  // Cancellable delay: stop() resolves every pending wait immediately
  // instead of waiting out the current retry backoff, so a device stuck
  // retrying doesn't keep the process/test runner alive after stop() and
  // so _subscribe()'s while loop gets straight back to its
  // !this._stopping check.
  _wait (ms) {
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this._retryTimers.delete(entry)
        resolve()
      }, ms)
      const entry = { clear: () => { clearTimeout(timer); resolve() } }
      this._retryTimers.add(entry)
    })
  }

  async stop () {
    this._stopping = true
    if (this._unsubscribeAdvertisements) {
      this._unsubscribeAdvertisements()
      this._unsubscribeAdvertisements = null
    }
    for (const entry of this._retryTimers) entry.clear()
    this._retryTimers.clear()
    for (const watchdog of this._watchdogs.values()) clearInterval(watchdog)
    this._watchdogs.clear()
    const closes = [...this._handles.values()].map((handle) => handle.close().catch(() => {}))
    this._handles.clear()
    await Promise.all(closes)
  }
}

module.exports = BleApiWorker
