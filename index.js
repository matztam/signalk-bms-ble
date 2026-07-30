'use strict'

const BleWorker = require('./lib/bleWorker')

// Device "type" values this plugin currently understands. Adding a new
// brand/protocol: implement it in ble_worker.py (see the PROTOCOLS registry
// there) and add its key + label here so it shows up in the config UI.
const KNOWN_TYPES = {
  jk: 'JK-BMS (JK02 protocol)',
  daly: 'Daly Smart BMS (D2 protocol)'
}

module.exports = function (app) {
  const plugin = {
    id: 'signalk-bms-ble',
    name: 'BMS over Bluetooth LE',
    description: 'Reads SOC, voltage, current and cell voltages from JK-BMS and Daly Smart BMS units over Bluetooth LE.'
  }

  let bleWorker = null
  let statusText = ''
  // Last known reading (or error) per device id, shown live on the plugin
  // config page — see plugin.schema() below.
  const lastReadings = new Map()

  function statusIcon (r) {
    if (!r) return '⏳'
    if (r.disabled) return '⏸'
    return r.error ? '⚠' : '✅'
  }

  function formatReading (id, r) {
    if (!r) return `${statusIcon(r)} ${id} — no data yet`
    if (r.disabled) return `${statusIcon(r)} ${id} — disabled`
    if (r.error) return `${statusIcon(r)} ${id} — ${r.error}  (last update ${r.at})`
    const cells = Array.isArray(r.cellVoltages) && r.cellVoltages.length > 0
      ? `\n      cells: ${r.cellVoltages.map((v) => `${v.toFixed(3)} V`).join(', ')}`
      : ''
    return `${statusIcon(r)} ${id} — ${r.soc}% SOC, ${r.packVoltage.toFixed(2)} V, ${r.current.toFixed(2)} A${cells}\n      (last update ${r.at})`
  }

  // A function (not a static object) so the admin UI re-fetches it on every
  // /plugins request and the live readings shown below stay current.
  plugin.schema = function () {
    const configuredIds = lastReadings.size > 0 ? [...lastReadings.keys()] : []
    const activeIds = configuredIds.filter((id) => !lastReadings.get(id)?.disabled)
    const okCount = activeIds.filter((id) => lastReadings.get(id)?.error === undefined).length
    const disabledCount = configuredIds.length - activeIds.length
    const summary = configuredIds.length === 0
      ? 'No readings yet — start the plugin and wait a few seconds.'
      : `${okCount}/${activeIds.length} device(s) reporting OK` + (disabledCount > 0 ? ` (${disabledCount} disabled)` : '')

    const properties = {
      _liveSummary: {
        type: 'null',
        title: `Live status: ${summary}`
      }
    }

    for (const [id, r] of lastReadings.entries()) {
      properties[`_live_${id}`] = {
        type: 'null',
        title: formatReading(id, r)
      }
    }

    properties.devices = {
      type: 'array',
      title: 'BMS devices',
      description: 'One entry per physical BMS. Find the Bluetooth address with the diagnostic scripts in diag/ (scan.py, then inspect_gatt.py) — the plugin does not auto-discover devices, since multiple BMS of the same brand are indistinguishable by service UUID alone.',
      items: {
        type: 'object',
        required: ['id', 'type', 'address'],
        properties: {
          enabled: {
            type: 'boolean',
            title: 'Enabled',
            description: 'Uncheck to stop polling this device without removing its configuration (e.g. while it\'s out of range).',
            default: true
          },
          id: {
            type: 'string',
            title: 'SignalK battery instance ID',
            description: 'Used as electrical.batteries.<id>.* — e.g. "house1". Must be unique across devices.'
          },
          type: {
            type: 'string',
            title: 'BMS type',
            enum: Object.keys(KNOWN_TYPES),
            enumNames: Object.values(KNOWN_TYPES),
            default: 'jk'
          },
          address: {
            type: 'string',
            title: 'Bluetooth address',
            description: 'e.g. 11:22:33:44:55:66'
          }
        }
      },
      default: []
    }

    return {
      type: 'object',
      description: 'Documentation: see README.md in the plugin folder.',
      properties
    }
  }

  plugin.start = function (options) {
    const allDevices = Array.isArray(options.devices) ? options.devices : []

    if (allDevices.length === 0) {
      statusText = 'No devices configured'
      app.setPluginStatus(statusText)
      return
    }

    const unknown = allDevices.filter((d) => !KNOWN_TYPES[d.type])
    if (unknown.length > 0) {
      const msg = `Unknown BMS type(s): ${unknown.map((d) => `${d.id}=${d.type}`).join(', ')}`
      app.setPluginError(msg)
      return
    }

    const seenIds = new Set()
    for (const d of allDevices) {
      if (seenIds.has(d.id)) {
        app.setPluginError(`Duplicate device id "${d.id}" — instance IDs must be unique`)
        return
      }
      seenIds.add(d.id)
    }

    const devices = allDevices.filter((d) => d.enabled !== false)
    const disabled = allDevices.filter((d) => d.enabled === false)
    lastReadings.clear()
    for (const d of disabled) {
      lastReadings.set(d.id, { disabled: true, at: new Date().toLocaleTimeString() })
    }

    if (devices.length === 0) {
      statusText = 'All configured devices are disabled'
      app.setPluginStatus(statusText)
      return
    }

    bleWorker = new BleWorker({
      app,
      devices,
      onReading: (msg) => publishReading(msg)
    })
    bleWorker.start()

    statusText = `Running — polling ${devices.length} device(s): ${devices.map((d) => d.id).join(', ')}`
    if (disabled.length > 0) statusText += ` (${disabled.length} disabled: ${disabled.map((d) => d.id).join(', ')})`
    app.setPluginStatus(statusText)
  }

  function publishReading (msg) {
    const { id, error } = msg
    const at = new Date().toLocaleTimeString()

    if (error) {
      app.debug(`${id}: ${error}`)
      lastReadings.set(id, { error, at })
      return
    }

    const isFiniteNumber = (v) => typeof v === 'number' && Number.isFinite(v)
    if (!isFiniteNumber(msg.soc) || !isFiniteNumber(msg.packVoltage) || !isFiniteNumber(msg.current)) {
      const reason = `incomplete reading (soc=${msg.soc}, packVoltage=${msg.packVoltage}, current=${msg.current})`
      app.debug(`${id}: ${reason}`)
      lastReadings.set(id, { error: reason, at })
      return
    }

    lastReadings.set(id, { ...msg, at })
    app.debug(`${id}: ${msg.soc}% SOC, ${msg.packVoltage}V, ${msg.current}A`)

    const path = `electrical.batteries.${id}`
    const values = [
      { path: `${path}.stateOfCharge`, value: msg.soc / 100 },
      { path: `${path}.voltage`, value: msg.packVoltage },
      { path: `${path}.current`, value: msg.current }
    ]

    if (Array.isArray(msg.cellVoltages)) {
      msg.cellVoltages.forEach((v, i) => {
        if (isFiniteNumber(v)) values.push({ path: `${path}.cellVoltages.${i + 1}.voltage`, value: v })
      })
    }

    app.handleMessage(plugin.id, {
      updates: [
        {
          source: { label: plugin.id },
          values
        }
      ]
    })
  }

  plugin.stop = function () {
    if (bleWorker) {
      bleWorker.stop()
      bleWorker = null
    }
    lastReadings.clear()
    statusText = ''
    app.setPluginStatus('Stopped')
  }

  return plugin
}
