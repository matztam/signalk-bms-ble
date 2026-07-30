'use strict'

// Spawns ble_worker.py (bleak/BlueZ-DBus) as a subprocess and turns its
// newline-delimited JSON stdout into onReading(device, reading) callbacks.
// Python is used here (not a Node BLE library) because bleak is the only
// stack that has proven reliable against our real BMS hardware: noble
// needs raw HCI access and typically fights with a running bluetoothd,
// and node-ble (DBus/BlueZ, same approach as bleak) hung indefinitely on
// connect during testing with no timeout of its own. See
// diag/findings/PROTOCOL_NOTES.md for the investigation.

const { spawn, execFile } = require('child_process')
const path = require('path')
const fs = require('fs')
const readline = require('readline')

const SCRIPT = path.join(__dirname, '..', 'ble_worker.py')
const VENV = path.join(__dirname, '..', '.venv')
const PYTHON = path.join(VENV, process.platform === 'win32' ? 'Scripts' : 'bin', 'python3')
const PIP = path.join(VENV, process.platform === 'win32' ? 'Scripts' : 'bin', 'pip')

const RESTART_DELAY_MS = 5000

class BleWorker {
  constructor ({ app, devices, onReading }) {
    this.app = app
    this.devices = devices
    this.onReading = onReading
    this._proc = null
    this._stopping = false
  }

  start () {
    this._stopping = false
    this._setupAndSpawn()
  }

  _setupAndSpawn () {
    // Everything here runs via async child_process calls, never the
    // *Sync variants: this fires on every plugin start AND every
    // watchdog-triggered worker restart (see ble_worker.py's Watchdog),
    // so a blocking exec here would freeze the whole Node event loop -
    // including SignalK's HTTP/admin-UI - for as long as the check took.
    // On an already-loaded/swapping Pi that measured in the
    // multi-second-to-minutes range and was mistaken for SignalK itself
    // hanging.
    if (fs.existsSync(PYTHON)) {
      execFile(PYTHON, ['-c', 'import bleak'], { stdio: 'pipe' }, (err) => {
        if (this._stopping) return
        if (!err) {
          this._spawn()
          return
        }
        this._installAndSpawn()
      })
      return
    }

    this._installAndSpawn()
  }

  _installAndSpawn () {
    const { app } = this

    execFile('python3', ['--version'], { stdio: 'pipe' }, (err) => {
      if (this._stopping) return
      if (err) {
        app.setPluginError('BLE worker: python3 not found — install Python 3')
        return
      }
      this._runSetupSteps()
    })
  }

  _runSetupSteps () {
    const { app } = this

    app.debug('BLE worker: first run — creating venv + installing bleak…')

    const runStep = (steps) => {
      if (this._stopping) return
      if (steps.length === 0) { this._spawn(); return }
      const [cmd, args] = steps[0]
      const remaining = steps.slice(1)
      const proc = spawn(cmd, args)
      proc.stdout.on('data', (d) => app.debug(`BLE worker setup: ${d.toString().trimEnd()}`))
      proc.stderr.on('data', (d) => app.debug(`BLE worker setup: ${d.toString().trimEnd()}`))
      proc.on('exit', (code) => {
        if (this._stopping) return
        if (code !== 0) {
          app.setPluginError('BLE worker: Python dependency installation failed — check debug log')
          return
        }
        runStep(remaining)
      })
      proc.on('error', (err) => app.setPluginError(`BLE worker: setup error — ${err.message}`))
    }

    runStep([
      ['python3', ['-m', 'venv', VENV]],
      [PIP, ['install', '--quiet', 'bleak']]
    ])
  }

  _spawn () {
    const { app, devices, onReading } = this

    const env = {
      ...process.env,
      BMS_DEVICES: JSON.stringify(devices)
    }

    const proc = spawn(PYTHON, [SCRIPT], { env })
    this._proc = proc

    const rl = readline.createInterface({ input: proc.stdout })
    rl.on('line', (line) => {
      let msg
      try {
        msg = JSON.parse(line)
      } catch {
        app.debug(`BLE worker: unparseable stdout line: ${line}`)
        return
      }
      onReading(msg)
    })

    proc.stderr.on('data', (d) => app.debug(`BLE worker: ${d.toString().trimEnd()}`))

    proc.on('spawn', () => app.debug(`BLE worker: ble_worker.py started (pid=${proc.pid})`))

    proc.on('exit', (code, signal) => {
      this._proc = null
      if (this._stopping) return
      app.debug(`BLE worker: exited (code=${code} signal=${signal}), restarting in ${RESTART_DELAY_MS}ms`)
      setTimeout(() => { if (!this._stopping) this._spawn() }, RESTART_DELAY_MS)
    })

    proc.on('error', (err) => app.debug(`BLE worker: failed to start — ${err.message}`))
  }

  stop () {
    this._stopping = true
    if (this._proc) {
      this._proc.kill('SIGTERM')
      this._proc = null
    }
  }
}

module.exports = BleWorker
