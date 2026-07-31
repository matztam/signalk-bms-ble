#!/usr/bin/env python3
"""
BLE polling worker for the signalk-bms-ble plugin.

Connects to any number of BMS over Bluetooth LE (via bleak / BlueZ-DBus,
same stack used during protocol diagnosis — avoids the HCI-socket conflicts
noble/HCI-raw approaches have with a running bluetoothd), polls each in turn
(a single BLE adapter can't run multiple GATT connection attempts at once —
concurrent connects fail with "Operation already in progress"), and prints
one JSON object per line to stdout for every successful reading. All logging
goes to stderr so stdout stays clean newline-delimited JSON for the parent
Node process.

Single long-lived process (one BleakScanner, one asyncio event loop, for the
worker's whole lifetime) rather than a subprocess per poll attempt — a
previous per-poll-subprocess design was too heavy for a memory-constrained
Raspberry Pi (416MB RAM), where several concurrent Python interpreters
pushed the system into swapping and made SignalK itself unresponsive. See
diag/findings/PROTOCOL_NOTES.md for that investigation. The tradeoff: a rare
BlueZ/DBus hang (observed once, see WATCHDOG_TIMEOUT_S) can no longer be
isolated to a throwaway subprocess, so a watchdog thread hard-exits this
whole process if a poll attempt doesn't return in time; the parent
(lib/bleWorker.js) already auto-restarts a dead worker, so this just costs
one reconnect cycle instead of hanging forever.

Devices are configured via the BMS_DEVICES env var, MAC address and brand
are never hardcoded: a JSON array like
  [{"id": "house-1", "type": "jk", "address": "11:22:33:44:55:66"},
   {"id": "daly-1", "type": "daly", "address": "11:22:33:44:55:67"}]

Adding a new BMS brand/protocol: subclass Protocol below, implement
async read(client) -> dict, and add an entry to PROTOCOLS. No other code
needs to change; the "type" field in BMS_DEVICES then selects it.

Output line shape:
  {"id": "...", "packVoltage": 13.4, "current": 18.9, "soc": 56.1,
   "cellVoltages": [3.355, 3.363, ...]}
or on error:
  {"id": "...", "error": "..."}
"""
import asyncio
import json
import os
import sys
import threading
import time

from bleak import BleakClient, BleakScanner

POLL_INTERVAL_S = 2
# Increased from an earlier 8s/12s after comparing against the vendor
# special retry/backoff logic on the Android BLE side - it just waits
# without an aggressive hard timeout. Advertisement misses right after the
# scanner restarts (see poll_once: stopped/restarted around every connect
# to avoid "Operation already in progress") are the main cause of the
# "did not advertise" errors seen live, not the devices actually being
# unreachable - a live bluetoothctl scan always found them. More patience
# here reduces spurious failures without the code complexity of a
# stop/restart-aware warmup delay.
DISCOVER_TIMEOUT_S = 20
CONNECT_TIMEOUT_S = 15
# Hard ceiling for a single device's poll attempt (discovery + connect +
# read), enforced by a watchdog thread that os._exit()s the whole process
# if exceeded - see module docstring for why a plain asyncio timeout is not
# trusted to be enough on its own (BlueZ/DBus can leave a coroutine blocked
# in a kernel wait that asyncio's cooperative cancellation can't interrupt).
WATCHDOG_TIMEOUT_S = DISCOVER_TIMEOUT_S + CONNECT_TIMEOUT_S + 10


def log(msg):
    print(msg, file=sys.stderr, flush=True)


def emit(obj):
    print(json.dumps(obj), flush=True)


class Protocol:
    """Base class for a BMS BLE protocol. One instance per device."""

    #: GATT characteristic UUID to subscribe to for notifications.
    notify_char = None
    #: GATT characteristic UUID to write requests to (defaults to notify_char
    #: for single-characteristic protocols like JK's UART passthrough).
    write_char = None

    def request(self) -> bytes:
        """Bytes to write to trigger a status response."""
        raise NotImplementedError

    def extra_requests(self):
        """Optional further request frames to write after the initial one,
        each after a short delay. Some BMS (observed on JK02) only start
        pushing the live-data frame after a *second*, different request
        (e.g. a device-info query) primes them - the first request alone
        only yields settings/device-info frames. Override if needed."""
        return []

    def feed(self, chunk: bytes):
        """Feed one notification's raw bytes. Return a parsed reading dict
        once a complete, validated frame has been assembled, else None."""
        raise NotImplementedError

    async def read(self, client: BleakClient) -> dict:
        write_char = self.write_char or self.notify_char
        loop = asyncio.get_event_loop()
        result = loop.create_future()

        def handler(_sender, data: bytearray):
            if result.done():
                return
            reading = self.feed(bytes(data))
            if reading is not None:
                result.set_result(reading)

        await client.start_notify(self.notify_char, handler)
        try:
            await client.write_gatt_char(write_char, self.request(), response=False)
            for extra in self.extra_requests():
                try:
                    await asyncio.wait_for(asyncio.shield(result), timeout=1.5)
                    break  # already got a reading, no need to send more nudges
                except asyncio.TimeoutError:
                    pass
                await client.write_gatt_char(write_char, extra, response=False)
            return await asyncio.wait_for(result, timeout=CONNECT_TIMEOUT_S)
        finally:
            await client.stop_notify(self.notify_char)


class JkProtocol(Protocol):
    """JK-BMS JK02 family. Service 0xFFE0, single char 0xFFE1 (UART passthrough)."""

    SERVICE_UUID = "0000ffe0-0000-1000-8000-00805f9b34fb"
    notify_char = "0000ffe1-0000-1000-8000-00805f9b34fb"

    RSP_HEADER = bytes([0x55, 0xAA, 0xEB, 0x90])
    INFO_FRAME_LEN = 300
    # Verified against JK-B2A8S20P hardware: pack voltage / current / SOC
    # live 32 bytes further into the frame than the "32S" layout published
    # by syssi/esphome-jk-bms. Other JK firmware/board generations may use
    # a different offset (0 or 16) - see diag/findings/PROTOCOL_NOTES.md.
    FIELD_OFFSET = 32

    def __init__(self):
        self._buf = bytearray()

    @staticmethod
    def _sum8(data: bytes) -> int:
        return sum(data) & 0xFF

    def request(self) -> bytes:
        return self._command(0x96)  # cell-info: on its own only yields settings/device-info

    def extra_requests(self):
        # Observed live: the device-info request (0x97) is what actually
        # makes this unit start pushing 0x02 cell-info frames; 0x96 alone
        # does not. Confirmed reproducible across repeated connections -
        # see diag/findings/PROTOCOL_NOTES.md.
        return [self._command(0x97)]

    def _command(self, cmd: int) -> bytes:
        frame = bytes([0xAA, 0x55, 0x90, 0xEB, cmd, 0x00]) + bytes(13)
        return frame + bytes([self._sum8(frame)])

    def feed(self, chunk: bytes):
        self._buf += chunk
        idx = self._buf.find(self.RSP_HEADER)
        if idx == -1:
            return None
        if idx > 0:
            del self._buf[:idx]
        if len(self._buf) < self.INFO_FRAME_LEN:
            return None
        frame = bytes(self._buf[: self.INFO_FRAME_LEN])
        del self._buf[: self.INFO_FRAME_LEN]
        if frame[4] != 0x02:
            return None  # settings/device-info frame, keep waiting for cell-info
        expected = frame[self.INFO_FRAME_LEN - 1]
        actual = self._sum8(frame[: self.INFO_FRAME_LEN - 1])
        if expected != actual:
            return None
        return self._parse(frame)

    def _parse(self, frame: bytes) -> dict:
        off = self.FIELD_OFFSET

        cell_voltages = []
        for i in range(32):
            pos = 6 + i * 2
            mv = frame[pos] | (frame[pos + 1] << 8)
            if mv != 0:
                cell_voltages.append(mv / 1000)

        def u32(pos):
            return frame[pos] | (frame[pos + 1] << 8) | (frame[pos + 2] << 16) | (frame[pos + 3] << 24)

        def i32(pos):
            v = u32(pos)
            return v - 0x100000000 if v & 0x80000000 else v

        return {
            "cellVoltages": cell_voltages,
            "packVoltage": u32(118 + off) / 1000,
            "current": i32(126 + off) / 1000,
            "soc": frame[141 + off],
        }


class DalyProtocol(Protocol):
    """Daly Smart BMS D2 dialect. Service 0xFFF0, notify 0xFFF1, write 0xFFF2."""

    SERVICE_UUID = "0000fff0-0000-1000-8000-00805f9b34fb"
    notify_char = "0000fff1-0000-1000-8000-00805f9b34fb"
    write_char = "0000fff2-0000-1000-8000-00805f9b34fb"

    CURRENT_OFFSET = 30000

    @staticmethod
    def _crc16_modbus(data: bytes) -> int:
        crc = 0xFFFF
        for b in data:
            crc ^= b
            for _ in range(8):
                crc = (crc >> 1) ^ 0xA001 if crc & 1 else crc >> 1
        return crc & 0xFFFF

    def request(self) -> bytes:
        frame = bytes([0xD2, 0x03, 0x00, 0x00, 0x00, 0x3E])
        crc = self._crc16_modbus(frame)
        return frame + bytes([crc & 0xFF, (crc >> 8) & 0xFF])

    def feed(self, chunk: bytes):
        frame = chunk
        if len(frame) < 5 or frame[0] != 0xD2 or frame[1] != 0x03:
            return None
        byte_count = frame[2]
        total = 3 + byte_count + 2
        if len(frame) < total:
            return None
        payload = frame[3 : 3 + byte_count]
        crc_expected = frame[3 + byte_count] | (frame[4 + byte_count] << 8)
        crc_actual = self._crc16_modbus(frame[: 3 + byte_count])
        if crc_expected != crc_actual:
            return None
        return self._parse(payload)

    def _parse(self, payload: bytes) -> dict:
        def reg(i):
            pos = i * 2
            return (payload[pos] << 8) | payload[pos + 1]

        cell_count = reg(0x31)
        cell_voltages = [reg(i) / 1000 for i in range(cell_count)]

        return {
            "cellVoltages": cell_voltages,
            "packVoltage": reg(0x28) / 10,
            "current": (reg(0x29) - self.CURRENT_OFFSET) / 10,
            "soc": reg(0x2A) / 10,
        }


# Registry mapping the "type" field in BMS_DEVICES to a Protocol subclass.
# To support a new brand: write a Protocol subclass above and add it here.
PROTOCOLS = {
    "jk": JkProtocol,
    "daly": DalyProtocol,
}


class Watchdog:
    """Pets itself before/after every poll attempt; a background thread
    checks whether it's been fed recently and hard-exits the process if
    not. This is the only reliable way found to escape a BlueZ/DBus call
    that never returns and doesn't respond to asyncio cancellation (see
    module docstring) without paying for a subprocess per poll."""

    def __init__(self, timeout_s: float):
        self._timeout_s = timeout_s
        self._last_pet = time.monotonic()
        self._current_device = None
        self._stop = False

    def pet(self, device_id=None):
        self._last_pet = time.monotonic()
        self._current_device = device_id

    def stop(self):
        self._stop = True

    def run(self):
        while not self._stop:
            time.sleep(1)
            if time.monotonic() - self._last_pet > self._timeout_s:
                log(
                    f"watchdog: no progress for {self._timeout_s:.0f}s "
                    f"(stuck on {self._current_device!r}) - exiting so the "
                    "supervisor can restart us"
                )
                sys.stderr.flush()
                sys.stdout.flush()
                os._exit(1)  # deliberately skips cleanup - a clean shutdown
                # is exactly what's not possible if bleak/BlueZ is wedged.


async def poll_once(device: dict) -> dict:
    protocol_cls = PROTOCOLS[device["type"]]
    protocol = protocol_cls()

    # No long-lived background scanner: each poll does its own short,
    # dedicated discovery scan (find_device_by_address starts and stops
    # BlueZ discovery internally) immediately followed by connect, then
    # nothing is scanning while connected. This mirrors how the vendor's
    # own app behaves (reverse-engineered: no persistent scanner visible
    # in its Android BLE plugin either) and was found live to have a much
    # better success rate than keeping one scanner running continuously
    # and stopping/restarting it around every connect - that approach
    # left real gaps where a device's advertisement could be missed right
    # after the scanner restarted, especially noticeable when a device's
    # advertising interval didn't line up well with our stop/start
    # timing. See diag/findings/PROTOCOL_NOTES.md for the full history
    # (including why the *previous* approach of stop/start around a
    # shared scanner was itself a fix for "Operation already in
    # progress" - a single dedicated scan-then-connect per poll avoids
    # that problem too, since nothing else is scanning during connect).
    found = await BleakScanner.find_device_by_address(device["address"], timeout=DISCOVER_TIMEOUT_S)
    if found is None:
        raise TimeoutError(f"{device['address']} did not advertise within {DISCOVER_TIMEOUT_S:.0f}s")

    async with BleakClient(found, timeout=CONNECT_TIMEOUT_S) as client:
        # BlueZ sometimes reports the connection as established before
        # GATT service resolution has actually finished, causing an
        # immediate start_notify()/write_gatt_char() to fail with
        # "Service Discovery has not been performed yet". A short settle
        # delay avoids the race (observed live; bleak has no built-in
        # wait for "services truly ready").
        await asyncio.sleep(1.5)
        return await protocol.read(client)


async def round_robin(devices: list, watchdog: Watchdog):
    """Poll all configured devices one at a time, forever. A single BLE
    adapter can only drive one GATT connection attempt at a time, so
    devices are visited in sequence rather than concurrently."""
    while True:
        for device in devices:
            watchdog.pet(device["id"])
            try:
                reading = await poll_once(device)
                emit({"id": device["id"], **reading})
            except Exception as exc:  # noqa: BLE001 - report and keep going
                log(f"{device['id']} ({device['address']}): {exc!r}")
                emit({"id": device["id"], "error": str(exc)})
        watchdog.pet()  # idle between cycles shouldn't count as "stuck"
        await asyncio.sleep(POLL_INTERVAL_S)


def main():
    devices = json.loads(os.environ.get("BMS_DEVICES", "[]"))
    if not devices:
        log("BMS_DEVICES is empty — nothing to poll")
        return

    unknown = sorted({d["type"] for d in devices} - PROTOCOLS.keys())
    if unknown:
        log(f"Unknown device type(s) {unknown}, known types: {sorted(PROTOCOLS)}")
        devices = [d for d in devices if d["type"] in PROTOCOLS]
    if not devices:
        return

    watchdog = Watchdog(WATCHDOG_TIMEOUT_S)
    threading.Thread(target=watchdog.run, daemon=True).start()

    log(f"Starting round-robin polling for {len(devices)} device(s), interval={POLL_INTERVAL_S}s")
    asyncio.run(round_robin(devices, watchdog))


if __name__ == "__main__":
    main()
