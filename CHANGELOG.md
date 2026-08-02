# Changelog

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
