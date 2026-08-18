# signalk-bms-ble

SignalK plugin that reads state of charge, voltage, current, cell voltages
and capacity from JK-BMS and Daly Smart BMS battery management systems over
Bluetooth LE, and publishes them under `electrical.batteries.<id>.*`.

## Supported hardware

- **JK-BMS**, JK02 protocol family (BLE UART passthrough, service `0xFFE0`).
  Verified against JK-B2A8S20P hardware.
- **Daly Smart BMS**, D2 dialect (Modbus-RTU-style framing over BLE, service
  `0xFFF0`). Verified against BMS-ST103-303E hardware.

Both protocols have variants across firmware/board generations that use
different byte offsets for the same fields (see
`diag/findings/PROTOCOL_NOTES.md`). The plugin validates every parsed
reading against physically sane ranges (SOC 0-100%, voltage, current) and
drops + reports readings that fail this check instead of silently
publishing wrong numbers — if your device reports "implausible reading" in
the SignalK log, please open a GitHub issue with your BMS model/firmware so
support for that variant can be added.

## Requirements

This plugin has two ways of talking to BLE hardware — it picks automatically,
see "Two BLE backends" under Architecture below.

- SignalK server, Node.js >= 18.
- **Linux with BlueZ.** Developed and tested on Raspberry Pi OS / Debian
  with BlueZ 5.66-5.85.
- **Bluetooth permissions.** SignalK typically runs as a non-root user. On
  most distros that user needs to be in the `bluetooth` group (or have
  equivalent BlueZ D-Bus policy permissions) to use Bluetooth LE at all:
  ```
  sudo usermod -aG bluetooth <signalk-user>
  ```
  then log the user out/in (or reboot) for the group change to take
  effect. Without this, connections typically fail with a permission or
  D-Bus access error.

**Only if signalk-server is older than 2.31.0** (no built-in BLE API, see
below — the plugin falls back to its own Python worker in that case):

- **Python 3** with the standard `venv` module. On Debian/Ubuntu/Raspberry
  Pi OS this is a separate package from the base `python3` install:
  ```
  sudo apt install python3-venv
  ```
  Without it, the plugin's first-run virtual environment setup fails with
  an `ensurepip is not available` error.
- Internet access on first plugin start (to `pip install bleak` into the
  plugin's own virtual environment, created automatically under `.venv/`).
  The Python BLE library used here (`bleak`) also has macOS (CoreBluetooth)
  and Windows (WinRT) backends, so those platforms may work for the
  fallback path, but its connection retry/timeout/watchdog logic was
  written against BlueZ-specific behavior and hasn't been exercised there.

## Installation

```
cd ~/.signalk
npm install signalk-bms-ble
```

Restart signalk-server, then enable the plugin under **Server → Plugin
Config** and add your devices to the device list (see "Finding your
device's Bluetooth address" below).

### Testing an unreleased branch

To try a fix or feature branch (e.g. to test something before it's
released, or to help verify an issue fix), the branch has to replace the
plugin **in the exact location SignalK actually loads plugins from** —
`~/.signalk/node_modules/signalk-bms-ble/`. Cloning the repo somewhere
else (e.g. your home directory) does nothing: SignalK never looks there,
so it silently keeps running whatever was installed before (or nothing),
which looks like "the install worked but BLE never connects" with no
indication of what actually went wrong.

```
cd ~/.signalk/node_modules
mv signalk-bms-ble signalk-bms-ble.bak   # keep the working install as a fallback
git clone -b <branch-name> https://github.com/matztam/signalk-bms-ble.git
```

Restart signalk-server. To go back to the released version afterward:

```
cd ~/.signalk/node_modules
rm -rf signalk-bms-ble
mv signalk-bms-ble.bak signalk-bms-ble
```

Restart signalk-server again.

If you're on the Python-worker fallback path (older signalk-server, see
"Two BLE backends" below), the plugin creates its own `.venv/` on first
start inside whichever directory it's actually running from - so this
works the same way whether installed via `npm install` or `git clone`,
as long as the directory itself is in the right place.

## Configuration

Each entry in the device list needs:

| Field | Meaning |
|---|---|
| `id` | SignalK battery instance id, used as `electrical.batteries.<id>.*` — must be unique across devices, e.g. `house1` |
| `type` | `jk` or `daly` |
| `address` | Bluetooth MAC address of the BMS, e.g. `11:22:33:44:55:66` |
| `enabled` | Uncheck to stop polling a device without deleting its config |

### Finding your device's Bluetooth address

The plugin does not auto-discover devices — with multiple BMS of the same
brand this is ambiguous by service UUID alone, and you'd risk pointing an
`id` at the wrong physical battery. Instead, find the address with the
diagnostic scripts in `diag/` (own virtualenv under `diag/venv/`, see
`diag/README.md`):

```
cd diag
python3 -m venv venv && venv/bin/pip install bleak
venv/bin/python scan.py
```

This lists nearby BLE devices; match yours by name (JK/Daly units usually
advertise a manufacturer-ish name) or by process of elimination (power one
battery off/on and see which entry appears/disappears).

## Published SignalK paths

Per configured device, under `electrical.batteries.<id>.*`:

| Path | Meaning | Condition |
|---|---|---|
| `capacity.stateOfCharge` | SOC, 0-1 (SignalK convention) | always |
| `voltage` | Pack voltage in V | always |
| `current` | Current in A (negative = discharging) | always |
| `cellVoltages.<n>.voltage` | Individual cell voltages | always |
| `capacity.actual` | Current full-charge capacity in J (BMS-reported Ah × voltage × 3600 — not a fixed nameplate value, drifts with cell aging/calibration) | when the BMS reports a capacity |
| `capacity.remaining` | Remaining capacity in J (SOC × `capacity.actual`) | same as above |
| `capacity.timeRemaining` | Time to empty in s | same as above, only while discharging with the smoothed current below -0.05 A; uses a smoothed current (~45s time constant) so brief load spikes don't make the value jump around, and the 0.05 A floor avoids a technically-finite but meaningless huge value (e.g. hundreds of thousands of hours) when the smoothed current is merely very close to zero |

`capacity.timeRemaining` is what an NMEA2000 plotter (PGN 127506) shows as
"time remaining" next to SOC/voltage/current.

## Status page

`/signalk-bms-ble/` (same host/port as the SignalK server, e.g.
`http://<signalk-host>/signalk-bms-ble/`) shows a mobile-friendly HTML page
with live values for every device reporting cell voltages (SOC bar,
voltage, current, capacity, time remaining, cell voltages), refreshing
itself every 10s. Also listed as "BMS Status" in SignalK's own webapp
overview (App Dock etc.).

<img src="screenshots/status-page.png" alt="Status page on a phone, showing three battery cards with SOC bars, voltage, current, capacity and cell voltages" width="320">

(Screenshot uses example data, not a live connection.)

Technically a static page under `public/index.html`, mounted automatically
by SignalK under `/<package-name>/` via the `signalk-webapp` keyword in
`package.json` (the same mechanism used by e.g. `@signalk/freeboard-sk` or
`@signalk/app-dock`) — this mount point sits outside the admin login
SignalK enforces on `/plugins/*`. The page fetches its data client-side
from the standard, unauthenticated SignalK REST API
(`/signalk/v1/api/vessels/self/electrical/batteries`), so there's no
server-side rendering code in the plugin itself.

## Architecture

### Two BLE backends

`plugin.start()` checks whether `app.bleApi` exists (added in
`signalk-server` 2.31.0's built-in [BLE Provider
API](https://github.com/SignalK/signalk-server/pull/2588)) and picks the
transport accordingly — the plugin config page and SignalK log ("Running
(server BLE API) — ..." vs "Running (Python worker) — ...") say which one is
active:

- **Server BLE API (preferred, signalk-server >= 2.31.0)** —
  `lib/bleApiWorker.js` declares a `GATTSubscriptionDescriptor` per device
  (service UUID, notify characteristic, and either init writes for JK's
  "wake up and start streaming" nudge or a periodic write for Daly's
  "answer once per request" behavior — see `lib/protocols/jk.js` and
  `lib/protocols/daly.js`) and hands it to `app.bleApi.subscribeGATT()`.
  The server then owns discovery, connection lifecycle, provider
  selection, and reconnection — no Python subprocess, no venv, no
  hand-rolled connect-serialization lock. Frame reassembly/parsing
  (`lib/protocols/*.js`) and the physical-sanity check
  (`lib/protocols/sanity.js`) are plain JS ports of the same logic
  `ble_worker.py` uses, so both backends produce identical readings.
  `bleApiWorker.js` does still run its own small recovery layer on top of
  what the server guarantees:
  - a per-device data-timeout watchdog force-reconnects a connection that
    goes quiet for 20s without delivering a notification, since the
    server's `onDisconnect` callback only fires on an actual BlueZ-level
    disconnect and doesn't cover a subscription that's silently stopped
    producing data;
  - if `subscribeGATT()` keeps failing with "No provider ... can see
    &lt;mac&gt;" for about a minute straight, the reported error gets a
    diagnostic hint pointing at a likely cause the plugin can't fix
    itself (BlueZ already holding a stale connection to the device from
    an earlier, uncleanly-closed attempt) and the manual fix
    (`bluetoothctl disconnect <mac>` on the server).
- **Python worker (fallback, older servers)** — `ble_worker.py`, **a
  single long-lived** Python process (via `bleak`/BlueZ-DBus), spawned and
  supervised by `lib/bleWorker.js`. Each configured BMS gets its own
  `asyncio` task that **connects once and stays connected** (no
  poll/disconnect cycle), continuously receiving readings via BLE
  notifications. Discovery+connect attempts are serialized across all
  devices via a shared `asyncio.Lock` (BlueZ only allows one such
  operation at a time), bounded by an outer timeout (`LOCK_TIMEOUT_S`) so
  one stuck device can't block the others. A watchdog thread hard-exits
  the whole process if something still hangs past `WATCHDOG_TIMEOUT_S`.
  Runs in its own virtual environment (`.venv/`, created automatically on
  first plugin start). See `diag/findings/PROTOCOL_NOTES.md` for the
  decision history (including why persistent connections instead of poll
  cycles, and why Python/`bleak` instead of a pure Node BLE module —
  `@abandonware/noble` typically needs exclusive HCI access and conflicts
  with a running `bluetoothd`, and `node-ble` hung indefinitely on connect
  in testing).

Both backends feed the same `onReading(msg)` callback shape into
`index.js`, so everything below this point (SignalK delta conversion,
capacity math, the status page, the config schema) is backend-agnostic.

- `index.js` — SignalK plugin entry point: picks the backend, config
  schema (device list, per-device enable/disable), converts readings into
  SignalK deltas (including converting the BMS-reported Ah capacity into
  SignalK's joule-based `capacity.actual`/`.remaining`/`.timeRemaining`,
  using a smoothed current for the time-remaining calculation), shows live
  values on the plugin config page.

**Why persistent connections instead of poll/disconnect cycles?**
An earlier approach (predating both current backends) reconnected for
every reading (discover → connect → read → disconnect). Repeated discovery
turned out live to be the main source of intermittent "did not advertise"
failures — a device could work reliably for many cycles and then fail
several times in a row, even though a plain `bluetoothctl scan` always
found it. A live experiment also confirmed that a single BLE adapter can
hold several simultaneously open connections — BlueZ's "only one operation
at a time" limit applies only to *establishing* connections, not to
*holding* them open. Details in `diag/findings/PROTOCOL_NOTES.md`.

## Adding a new BMS brand

Needs implementing on both backends, since either can be active depending on
the server version:

1. In `lib/protocols/`: add a new file (see `jk.js`/`daly.js` as templates)
   exporting the service/characteristic UUIDs, a frame parser, and either
   the init writes needed to start the device streaming or a periodic
   request builder — whichever the device needs (see `daly.js`'s
   `REQUEST_INTERVAL_MS` vs `jk.js`'s `initWrites`).
2. In `lib/bleApiWorker.js`: add a branch in `_subscribe()`'s descriptor
   switch for the new type.
3. In `ble_worker.py`: write a new `Protocol` subclass (see
   `JkProtocol`/`DalyProtocol` as templates) — implement `notify_char`,
   `write_char`, `request()`, `feed()`; optionally `extra_requests()` (if
   the device only starts pushing live data after a second request) and
   `request_interval_s` (if the device doesn't keep pushing on its own and
   needs periodic re-requesting — see `DalyProtocol`). Register it in
   `PROTOCOLS`. This keeps the fallback path working for servers older
   than 2.31.0.
4. In `index.js`: add the new type key + display name to `KNOWN_TYPES`.

No other code needs to change — the device list in the plugin config stays
MAC-address-based and type-agnostic.

## Diagnostic scripts

`diag/` contains the scripts originally used to reverse-engineer the BMS
protocols (`scan.py`, `inspect_gatt.py`, `probe.py`, own virtualenv under
`diag/venv/`). Useful for investigating a new/unknown BMS model before
writing a new `Protocol` class, or for finding a device's Bluetooth
address (see "Finding your device's Bluetooth address" above).

## Known limitations

- The discharge case (negative current) for the Daly protocol has so far
  only been verified against the register formula, not cross-checked
  against a real discharge load.
- No pairing/bonding needed; an open GATT connection is enough. Only one
  connection per BMS at a time — the vendor's own phone app must not be
  connected at the same time as the plugin.
- On Raspberry Pi hardware with onboard BLE (e.g. Pi 4B, Broadcom chip via
  UART rather than USB), occasional multi-minute rough phases have been
  observed (BlueZ takes unusually long for discovery/scanner teardown),
  typically shortly after a reboot. The system has recovered on its own in
  every observed case; `LOCK_TIMEOUT_S` prevents an affected device from
  blocking the others while this happens. This has not been observed on
  USB Bluetooth adapters. Details in `diag/findings/PROTOCOL_NOTES.md`.
- **On very low-RAM hardware** (e.g. a Raspberry Pi with 512MB or less),
  check free RAM before installing (`free -h`) and avoid installing/starting
  this plugin at the same time as other RAM-heavy setup work — an earlier
  per-poll-subprocess design (since replaced by the single persistent
  process described above) pushed a 416MB Pi into swapping badly enough to
  make SignalK itself unresponsive. See `diag/findings/PROTOCOL_NOTES.md`.

## Example: a multi-battery setup

For reference, a device list covering a JK-BMS house bank plus two Daly
starter/house banks might look like this. Capacities are whatever each
BMS itself reports (see above) — not derived from any model number:

| id | type | address | capacity |
|---|---|---|---|
| house1 | jk | 11:22:33:44:55:66 | ~105 Ah |
| starter | daly | 11:22:33:44:55:67 | ~100 Ah |
| house2 | daly | 11:22:33:44:55:68 | ~280 Ah |

## License

AGPL-3.0-only, see `LICENSE`.
