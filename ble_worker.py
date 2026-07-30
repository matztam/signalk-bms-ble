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
import subprocess
import sys
import time

from bleak import BleakClient, BleakScanner

POLL_INTERVAL_S = 5
CONNECT_TIMEOUT_S = 15
# Only used as a fallback (SKIP_DISCOVERY_ENV unset, e.g. if the background
# scanner subprocess died) - the normal path relies on start_background_scanner()
# instead. See its docstring for why per-device discovery was replaced.
DISCOVER_TIMEOUT_S = 12
# Give the background scanner a few seconds to build up its device cache
# before the first poll attempt relies on it having already seen everyone.
SCANNER_WARMUP_S = 5
# Hard ceiling enforced from OUTSIDE the asyncio event loop (see
# poll_once_isolated below) - a plain asyncio.wait_for() was not enough:
# BlueZ/DBus occasionally leaves a connect attempt blocked in a kernel wait
# (epoll_wait on a DBus reply that never arrives) that asyncio's cooperative
# cancellation cannot interrupt, observed live to hang for minutes. Running
# each poll attempt as its own OS subprocess lets the parent SIGKILL it.
SUBPROCESS_TIMEOUT_S = DISCOVER_TIMEOUT_S + CONNECT_TIMEOUT_S + 10


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


async def ensure_discoverable(address: str):
    """BlueZ drops a device from its cache if it hasn't advertised recently,
    and BleakClient(address) then fails with BleakDeviceNotFoundError even
    though the device is in range and would answer a fresh scan. Do a short
    targeted scan first so the connect attempt has a live cache entry.

    Only used when SKIP_DISCOVERY_ENV is not set - see module docstring /
    background_scanner() for why the normal round-robin path skips this
    entirely in favor of one long-lived scan in the parent process."""
    found = await BleakScanner.find_device_by_address(address, timeout=DISCOVER_TIMEOUT_S)
    if found is None:
        raise TimeoutError(f"{address} did not advertise within {DISCOVER_TIMEOUT_S}s")


# Set by the parent process (see poll_once_isolated) once its own
# background_scanner() has been running long enough that BlueZ's systemwide
# device cache (shared across processes via DBus - confirmed live: one
# process's scan results are visible to `bluetoothctl devices` run from a
# completely different process) should already know about all configured
# devices. When set, the isolated --poll-one subprocess skips doing its own
# discovery scan and connects directly.
SKIP_DISCOVERY_ENV = "BMS_SKIP_DISCOVERY"


async def poll_once(device: dict) -> dict:
    protocol_cls = PROTOCOLS[device["type"]]
    protocol = protocol_cls()

    async def _do():
        if not os.environ.get(SKIP_DISCOVERY_ENV):
            await ensure_discoverable(device["address"])
        async with BleakClient(device["address"], timeout=CONNECT_TIMEOUT_S) as client:
            # BlueZ sometimes reports the connection as established before
            # GATT service resolution has actually finished, causing an
            # immediate start_notify()/write_gatt_char() to fail with
            # "Service Discovery has not been performed yet". A short
            # settle delay avoids the race (observed live; bleak has no
            # built-in wait for "services truly ready").
            await asyncio.sleep(1.5)
            return await protocol.read(client)

    # Soft timeout on top of bleak's own per-call timeouts, in case
    # cancellation does get through cleanly - the hard backstop against
    # BlueZ/DBus calls that don't respond to cancellation at all is the
    # subprocess-level SIGKILL in poll_once_isolated() below.
    overall_timeout = DISCOVER_TIMEOUT_S + CONNECT_TIMEOUT_S + 5
    return await asyncio.wait_for(_do(), timeout=overall_timeout)


def poll_once_isolated(device: dict, skip_discovery: bool) -> dict:
    """Run poll_once() for one device in its own subprocess (this same
    script, re-invoked with --poll-one) and hard-kill it if it doesn't
    finish in time. See SUBPROCESS_TIMEOUT_S for why this is necessary
    instead of just an asyncio timeout."""
    env = dict(os.environ)
    if skip_discovery:
        env[SKIP_DISCOVERY_ENV] = "1"
    proc = subprocess.run(
        [sys.executable, __file__, "--poll-one", json.dumps(device)],
        capture_output=True,
        text=True,
        timeout=SUBPROCESS_TIMEOUT_S,
        env=env,
    )
    if proc.returncode != 0 or not proc.stdout.strip():
        reason = proc.stderr.strip().splitlines()[-1] if proc.stderr.strip() else f"exit code {proc.returncode}, no output"
        raise RuntimeError(reason)
    return json.loads(proc.stdout.strip().splitlines()[-1])


def start_background_scanner():
    """Launch a standalone subprocess that keeps a single BLE discovery
    session running for the worker's whole lifetime, in place of each
    poll_once() starting/stopping its own scan. Root cause investigation
    (see diag/findings/PROTOCOL_NOTES.md) found that repeatedly starting
    and stopping discovery, once per device, left BlueZ unable to report
    fresh advertisements for anyone but the first device polled in a
    cycle - independent of which physical device that was. BlueZ's device
    cache is shared systemwide over DBus (confirmed live: `bluetoothctl
    devices` run from a separate process sees results from this scan), so
    the isolated --poll-one subprocesses can skip discovery entirely
    (SKIP_DISCOVERY_ENV) and connect directly once this has been running
    a few seconds.

    Returns the Popen handle; caller is responsible for keeping it alive
    and terminating it on shutdown."""
    return subprocess.Popen(
        [sys.executable, "-c", (
            "import asyncio\n"
            "from bleak import BleakScanner\n"
            "async def main():\n"
            "    async with BleakScanner():\n"
            "        await asyncio.Event().wait()\n"
            "asyncio.run(main())\n"
        )],
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
    )


def round_robin(devices: list):
    """Poll all configured devices one at a time, forever. A single BLE
    adapter can only drive one GATT connection attempt at a time, so devices
    are visited in sequence rather than concurrently."""
    scanner_proc = start_background_scanner()
    log(f"Background scanner started (pid={scanner_proc.pid}), warming up for {SCANNER_WARMUP_S}s")
    time.sleep(SCANNER_WARMUP_S)

    try:
        while True:
            for device in devices:
                skip_discovery = scanner_proc.poll() is None  # still running?
                try:
                    reading = poll_once_isolated(device, skip_discovery)
                    emit({"id": device["id"], **reading})
                except subprocess.TimeoutExpired:
                    msg = f"poll subprocess did not finish within {SUBPROCESS_TIMEOUT_S}s, killed"
                    log(f"{device['id']} ({device['address']}): {msg}")
                    emit({"id": device["id"], "error": msg})
                except Exception as exc:  # noqa: BLE001 - report and keep going
                    log(f"{device['id']} ({device['address']}): {exc!r}")
                    emit({"id": device["id"], "error": str(exc)})
            time.sleep(POLL_INTERVAL_S)
    finally:
        scanner_proc.terminate()


def run_poll_one(device: dict):
    """Entry point used by the isolated subprocess (see poll_once_isolated):
    poll exactly one device once, print the JSON result to stdout on
    success. On failure, print the error to stderr (parent logs it) and
    exit non-zero - deliberately no traceback noise, connect failures are
    an expected, routine outcome here, not a bug."""
    try:
        reading = asyncio.run(poll_once(device))
    except Exception as exc:  # noqa: BLE001 - report to parent and exit
        print(repr(exc), file=sys.stderr)
        sys.exit(1)
    print(json.dumps(reading))


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

    log(f"Starting round-robin polling for {len(devices)} device(s), interval={POLL_INTERVAL_S}s")
    round_robin(devices)


if __name__ == "__main__":
    if len(sys.argv) == 3 and sys.argv[1] == "--poll-one":
        run_poll_one(json.loads(sys.argv[2]))
    else:
        main()
