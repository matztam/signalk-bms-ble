# Changelog

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
