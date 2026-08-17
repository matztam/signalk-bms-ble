# Changelog

## 0.3.0

- Add battery and MOSFET/semiconductor temperature readings for both
  JK-BMS and Daly Smart BMS, requested in
  [#2](https://github.com/matztam/signalk-bms-ble/issues/2). New paths:
  `electrical.batteries.<id>.temperature` (standard SignalK path, the
  primary battery temperature sensor, Kelvin),
  `electrical.batteries.<id>.batteryTemperatures.<n>.temperature`
  (per-sensor, for BMS models reporting more than one), and
  `electrical.batteries.<id>.mosTemperature` (plugin-specific extension
  path - the SignalK battery schema has no standard field for this).
  Daly's request now reads 80 registers instead of 62 to reach the
  MOSFET-temperature register.
  **These fields are unverified against real hardware** - based on the
  documented JK02/Daly-D2 register layouts (see
  `diag/findings/PROTOCOL_NOTES.md` for sources), not a live device this
  project currently has access to. If you have a device with temperature
  sensors, please open an issue confirming whether the values look right.

## 0.2.3

- Fix `capacity.timeRemaining` showing absurd values (e.g. "7.9e+29 h")
  on the status page when the discharge current is very close to zero
  (noise around zero right after a charge/discharge transition, before
  current smoothing settles). The value was technically finite, so it
  slipped past the existing `Number.isFinite` guard on the status page.
  Now suppressed (shows "—") whenever the smoothed discharge current is
  below 0.05 A, the same way it's already suppressed while charging or
  idle.

## 0.2.2

- The server-BLE-API backend now recovers from two failure modes that
  previously left a device stuck with no updates until the plugin was
  restarted:
  - A connection that stops delivering notifications without the server
    ever reporting a disconnect (e.g. a silent BlueZ-level hiccup) is now
    force-reconnected after 20 seconds without data, instead of sitting
    there looking "connected" forever.
  - Repeated `subscribeGATT` failures with "No provider ... can see
    &lt;mac&gt;" (the device simply isn't in the server's view) now get a
    diagnostic hint after about a minute of consecutive failures,
    pointing at BlueZ potentially already holding a stale/orphaned
    connection to the device from an earlier attempt that was never
    cleanly closed - a state this plugin has no way to fix itself, but
    `bluetoothctl disconnect <mac>` on the server does. Confirmed live:
    exactly this situation was found and fixed this way on a device that
    had gone stale for several minutes.

## 0.2.1

- Fix the server-BLE-API backend's GATT writes (JK's init writes, Daly's
  periodic request write) failing with `Write not permitted` on real
  hardware. The server's default is write-*with*-response; these
  devices' write characteristics only accept write-*without*-response,
  same as the Python fallback already did
  (`write_gatt_char(..., response=False)`). The new backend's
  descriptors now set `withResponse: false` to match.

## 0.2.0

- Use signalk-server's built-in BLE Provider API (`app.bleApi`, added in
  signalk-server 2.31.0) when available, instead of always spawning the
  Python `ble_worker.py` subprocess. The server now owns BLE discovery,
  GATT connection lifecycle, and reconnection directly - no Python, no
  venv, no hand-rolled connect-serialization lock or watchdog thread on
  servers that have it. Automatically falls back to the existing Python
  worker on older servers, so this is a drop-in upgrade either way; the
  plugin config page and SignalK log report which backend is active.
- Added `lib/protocols/jk.js` and `lib/protocols/daly.js`, plain-JS ports
  of the frame parsing previously only implemented in `ble_worker.py`,
  shared by the new server-BLE-API backend.

## 0.1.2

- Replace example device addresses and a couple of development-setup
  references in the README and diagnostic notes with generic
  placeholders (no functional change).

## 0.1.1

- Fix a regression where `Protocol.stream` was accidentally defined
  outside the `Protocol` class, causing every connection attempt to fail
  with `'DalyProtocol' object has no attribute 'stream'`.
- Fix the "device did not advertise" error being masked by a generic
  "discover+connect exceeded 50s" message (Python 3.11+ makes
  `asyncio.TimeoutError` and the builtin `TimeoutError` the same class,
  so the outer error handler was catching both).

## 0.1.0

Initial public release.

- Read state of charge, voltage, current and cell voltages from JK-BMS
  (JK02 protocol) and Daly Smart BMS (D2 dialect) devices over Bluetooth
  LE, and publish them under `electrical.batteries.<id>.*`.
- Publish `capacity.actual`, `capacity.remaining` and `capacity.timeRemaining`
  from the BMS-reported full-charge capacity, with current smoothing so
  `capacity.timeRemaining` doesn't jump around on brief load spikes.
- Mobile-friendly live status page at `/signalk-bms-ble/`.
- Reject and report readings that fall outside physically sane ranges
  (wrong field offset for an unrecognized firmware/hardware generation)
  instead of silently publishing incorrect values.
