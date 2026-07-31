#!/usr/bin/env python3
"""
BLE worker for the signalk-bms-ble plugin.

Connects to any number of BMS over Bluetooth LE (via bleak / BlueZ-DBus,
same stack used during protocol diagnosis — avoids the HCI-socket conflicts
noble/HCI-raw approaches have with a running bluetoothd) and holds one
persistent connection per device for the worker's whole lifetime, printing
one JSON object per line to stdout for every fresh reading pushed by the
device's own BLE notifications. All logging goes to stderr so stdout stays
clean newline-delimited JSON for the parent Node process.

Why persistent connections instead of poll/disconnect cycles: an earlier
design reconnected on every poll (discover -> connect -> read -> disconnect,
repeated every couple of seconds). That repeated discovery was found live to
be the main source of intermittent "did not advertise" failures - a device
could work fine for many cycles and then fail for several in a row, even
though a plain `bluetoothctl scan` always found it and the vendor's own app
it just connects once and stays connected, same as this. A quick live
experiment confirmed a single adapter can hold multiple simultaneous BMS
connections open (the "only one GATT operation at a time" limit turned out
to apply to *establishing* connections, not to *holding* several already-
open ones) - so each device gets its own long-lived asyncio task that
connects once (serialized against the others to avoid "Operation already in
progress" during the connect itself), subscribes to notifications, and just
keeps listening. A device that drops reconnects on its own without
affecting the others.

Single long-lived process (one asyncio event loop for the worker's whole
lifetime) rather than a subprocess per poll attempt — a previous per-poll-
subprocess design was too heavy for a memory-constrained Raspberry Pi
(416MB RAM), where several concurrent Python interpreters pushed the system
into swapping and made SignalK itself unresponsive. See
diag/findings/PROTOCOL_NOTES.md for that investigation. The tradeoff: a rare
BlueZ/DBus hang (observed once, see WATCHDOG_TIMEOUT_S) can no longer be
isolated to a throwaway subprocess, so a watchdog thread hard-exits this
whole process if no device has made progress in too long; the parent
(lib/bleWorker.js) already auto-restarts a dead worker, so this just costs
one reconnect cycle instead of hanging forever.

Devices are configured via the BMS_DEVICES env var, MAC address and brand
are never hardcoded: a JSON array like
  [{"id": "house-1", "type": "jk", "address": "11:22:33:44:55:66"},
   {"id": "daly-1", "type": "daly", "address": "11:22:33:44:55:67"}]

Adding a new BMS brand/protocol: subclass Protocol below, implement feed()
to turn raw notification bytes into a reading dict, and add an entry to
PROTOCOLS. No other code needs to change; the "type" field in BMS_DEVICES
then selects it.

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

# Time to wait between reconnect attempts for a device that dropped or
# never connected in the first place.
RECONNECT_DELAY_S = 5
# How long to wait for a device to show up in a discovery scan before
# giving up on this connection attempt (it'll be retried).
DISCOVER_TIMEOUT_S = 20
CONNECT_TIMEOUT_S = 15
# Once connected, how long without a single fresh reading before treating
# the connection as dead and reconnecting. Generous: some protocols only
# push new data every few seconds, and BLE notifications are inherently a
# bit bursty.
STALE_CONNECTION_S = 60
# Hard ceiling on any one device going without progress (whether waiting to
# connect or waiting on an already-open connection) before the watchdog
# thread hard-exits the whole process - see module docstring for why a
# plain asyncio timeout is not trusted to be enough on its own (BlueZ/DBus
# can leave a coroutine blocked in a kernel wait that asyncio's cooperative
# cancellation can't interrupt). Set comfortably above the largest
# individual timeout above so a single slow-but-working device doesn't
# trigger it.
WATCHDOG_TIMEOUT_S = max(DISCOVER_TIMEOUT_S + CONNECT_TIMEOUT_S, STALE_CONNECTION_S) + 30


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

    #: Seconds between repeated request() writes while connected. Some BMS
    #: (observed on Daly D2) only answer a request once and go silent
    #: afterwards rather than pushing fresh frames on their own - unlike
    #: JK02, which keeps pushing 0x02 cell-info frames unprompted once
    #: nudged via extra_requests(). Override to None for protocols that do
    #: free-run so we don't write to the device needlessly.
    request_interval_s = None

    def feed(self, chunk: bytes):
        """Feed one notification's raw bytes. Return a parsed reading dict
        once a complete, validated frame has been assembled, else None."""
        raise NotImplementedError

    async def stream(self, client: BleakClient, on_reading, setup_lock: asyncio.Lock):
        """Subscribe to notifications and keep calling on_reading(dict) for
        every complete, validated frame received, for as long as the caller
        awaits this coroutine (typically until the connection drops or is
        cancelled). Sends the initial request, then extra_requests() as
        needed to get the device to start pushing data - see
        extra_requests() docstring - but once readings are flowing this
        just listens; the device keeps pushing on its own.

        setup_lock serializes GATT setup (start_notify + the initial
        request(s), up to the first reading) across devices - observed
        live: two devices reaching this point on the same adapter at
        almost the same moment can make write_gatt_char() fail with a GATT
        "Unlikely Error", not just the discover+connect step. Held only
        until the first reading (or a timeout) so it doesn't block other
        devices' setup once this one is just idly listening/re-requesting."""
        write_char = self.write_char or self.notify_char
        got_first_reading = asyncio.Event()

        def handler(_sender, data: bytearray):
            reading = self.feed(bytes(data))
            if reading is not None:
                got_first_reading.set()
                on_reading(reading)

        async with setup_lock:
            await client.start_notify(self.notify_char, handler)
            try:
                await client.write_gatt_char(write_char, self.request(), response=False)
                for extra in self.extra_requests():
                    try:
                        await asyncio.wait_for(got_first_reading.wait(), timeout=1.5)
                        break  # already got a reading, no need to send more nudges
                    except asyncio.TimeoutError:
                        pass
                    await client.write_gatt_char(write_char, extra, response=False)
                await asyncio.wait_for(got_first_reading.wait(), timeout=CONNECT_TIMEOUT_S)
            except BaseException:
                await client.stop_notify(self.notify_char)
                raise
        try:
            if self.request_interval_s is None:
                # Free-running: the device keeps pushing frames on its own,
                # just stay connected and let the notify handler keep
                # firing on_reading() until the caller cancels us (e.g.
                # because the connection dropped).
                await asyncio.Event().wait()
            else:
                # This protocol only answers once per request and then
                # goes quiet - keep re-requesting periodically for as long
                # as we're connected.
                while True:
                    await asyncio.sleep(self.request_interval_s)
                    await client.write_gatt_char(write_char, self.request(), response=False)
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
    # Confirmed live: Daly answers each 0xD2 0x03 request once and then
    # goes quiet - it does not free-run like JK02 does.
    request_interval_s = 5

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
    """Each device task pets its own key regularly (on connect attempts,
    reconnects, and every reading); a background thread checks whether any
    of them has gone quiet for too long and hard-exits the whole process if
    so. This is the only reliable way found to escape a BlueZ/DBus call
    that never returns and doesn't respond to asyncio cancellation (see
    module docstring) without paying for a subprocess per device. A single
    process-wide exit (rather than per-device recovery) is deliberate: a
    device that's stuck long enough to trip this is more likely a wedged
    adapter/DBus connection than a per-device problem, and restarting the
    whole worker resets that shared state for everyone."""

    def __init__(self, timeout_s: float):
        self._timeout_s = timeout_s
        self._last_pet = {}
        self._stop = False

    def pet(self, device_id: str):
        self._last_pet[device_id] = time.monotonic()

    def stop(self):
        self._stop = True

    def run(self):
        while not self._stop:
            time.sleep(1)
            now = time.monotonic()
            for device_id, last_pet in self._last_pet.items():
                if now - last_pet > self._timeout_s:
                    log(
                        f"watchdog: no progress for {self._timeout_s:.0f}s "
                        f"(stuck on {device_id!r}) - exiting so the "
                        "supervisor can restart us"
                    )
                    sys.stderr.flush()
                    sys.stdout.flush()
                    os._exit(1)  # deliberately skips cleanup - a clean
                    # shutdown is exactly what's not possible if
                    # bleak/BlueZ is wedged.


async def run_device(device: dict, watchdog: Watchdog, connect_lock: asyncio.Lock):
    """Hold a single persistent connection to one device, forever. Discovery
    only happens once per connection attempt (not once per reading) - this
    is the whole point of the persistent-connection architecture: repeated
    discovery was the actual source of intermittent "did not advertise"
    failures, not the devices themselves being flaky (confirmed live: the
    vendor app, which also connects once and stays connected, never had
    this problem; see diag/findings/PROTOCOL_NOTES.md). On any disconnect
    or error, wait RECONNECT_DELAY_S and reconnect from scratch.

    connect_lock serializes the discover+connect phase across all devices -
    not just at startup but for the lifetime of the process, since any
    device can independently drop and reconnect at any time. Without this,
    a reconnect on one device can race a reconnect (or the initial connect)
    on another and both fail with "Operation already in progress" - BlueZ
    only supports one discovery/connect operation in flight at a time, but
    holding an already-open connection doesn't need the lock at all."""
    device_id = device["id"]
    protocol_cls = PROTOCOLS[device["type"]]

    while True:
        watchdog.pet(device_id)
        try:
            async with connect_lock:
                found = await BleakScanner.find_device_by_address(device["address"], timeout=DISCOVER_TIMEOUT_S)
                if found is None:
                    raise TimeoutError(f"{device['address']} did not advertise within {DISCOVER_TIMEOUT_S:.0f}s")
                client = BleakClient(found, timeout=CONNECT_TIMEOUT_S)
                await client.connect()
                # BlueZ sometimes reports the connection as established
                # before GATT service resolution has actually finished,
                # causing an immediate start_notify()/write_gatt_char() to
                # fail with "Service Discovery has not been performed yet".
                # A short settle delay avoids the race (observed live;
                # bleak has no built-in wait for "services truly ready").
                # Kept inside connect_lock along with stream()'s own
                # setup_lock use: two devices settling/setting up at once
                # was observed to also collide, not just discover+connect.
                await asyncio.sleep(1.5)
                log(f"{device_id} ({device['address']}): connected")

            try:
                protocol = protocol_cls()

                def on_reading(reading: dict):
                    watchdog.pet(device_id)
                    emit({"id": device_id, **reading})

                await protocol.stream(client, on_reading, connect_lock)
            finally:
                await client.disconnect()
        except Exception as exc:  # noqa: BLE001 - report and keep retrying
            log(f"{device_id} ({device['address']}): {exc!r}")
            emit({"id": device_id, "error": str(exc)})

        log(f"{device_id}: disconnected, reconnecting in {RECONNECT_DELAY_S}s")
        await asyncio.sleep(RECONNECT_DELAY_S)


async def run_all(devices: list, watchdog: Watchdog):
    """Launch one persistent-connection task per device, sharing a single
    connect_lock so discovery+connect (whether the initial one or any later
    reconnect) is always serialized across devices - BlueZ only supports
    one such operation in flight at a time. Once a device is connected,
    holding its connection open runs fully in parallel with the others.
    Proven live: two simultaneous persistent connections held open for 60+s
    with zero errors, see diag/findings/PROTOCOL_NOTES.md."""
    connect_lock = asyncio.Lock()
    tasks = [asyncio.create_task(run_device(device, watchdog, connect_lock)) for device in devices]
    await asyncio.gather(*tasks)


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

    log(f"Starting persistent connections for {len(devices)} device(s)")
    asyncio.run(run_all(devices, watchdog))


if __name__ == "__main__":
    main()
