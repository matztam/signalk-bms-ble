#!/usr/bin/env python3
"""
BMS BLE diagnostic tool - step 3: send a status request and dump the raw
response bytes.

Auto-detects JK-BMS (service 0xFFE0) vs. Daly (service 0xFFF0) from the
GATT services, sends the appropriate probe command(s), and prints every
notification received as hex. For Daly, tries the D2/Modbus dialect first
and the P81/DL dialect second, since it's unknown which one ST103-303E
speaks.

Usage:
    ./venv/bin/python probe.py AA:BB:CC:DD:EE:FF
"""
import asyncio
import sys
from bleak import BleakClient

JK_SERVICE = "0000ffe0-0000-1000-8000-00805f9b34fb"
JK_CHAR = "0000ffe1-0000-1000-8000-00805f9b34fb"

DALY_SERVICE = "0000fff0-0000-1000-8000-00805f9b34fb"
DALY_NOTIFY_CHAR = "0000fff1-0000-1000-8000-00805f9b34fb"
DALY_WRITE_CHAR = "0000fff2-0000-1000-8000-00805f9b34fb"


def crc_sum(data: bytes) -> int:
    return sum(data) & 0xFF


def crc_modbus(data: bytes) -> int:
    crc = 0xFFFF
    for b in data:
        crc ^= b
        for _ in range(8):
            if crc & 1:
                crc = (crc >> 1) ^ 0xA001
            else:
                crc >>= 1
    return crc & 0xFFFF


def jk_cmd(cmd: int) -> bytes:
    frame = bytes([0xAA, 0x55, 0x90, 0xEB, cmd, 0x00]) + bytes(13)
    return frame + bytes([crc_sum(frame)])


def daly_d2_cmd(dev_id: int, fct: int, addr: int, count: int) -> bytes:
    frame = bytes([dev_id, fct]) + addr.to_bytes(2, "big") + count.to_bytes(2, "big")
    crc = crc_modbus(frame)
    return frame + crc.to_bytes(2, "little")


def daly_p81_cmd(fct: int, addr: int, count: int) -> bytes:
    frame = bytes([0x81, fct]) + addr.to_bytes(2, "big") + count.to_bytes(2, "big")
    crc = crc_modbus(frame)
    return frame + crc.to_bytes(2, "little")


received = []


def notify_handler(sender, data: bytearray):
    received.append(bytes(data))
    print(f"  <- notify from {sender}: {data.hex(' ')}  ({len(data)} bytes)")


async def probe_jk(client: BleakClient):
    print("Detected JK-BMS-style service (0xFFE0). Subscribing to notify...")
    await client.start_notify(JK_CHAR, notify_handler)
    cmd = jk_cmd(0x96)
    print(f"  -> writing status request: {cmd.hex(' ')}")
    await client.write_gatt_char(JK_CHAR, cmd, response=False)
    await asyncio.sleep(3)

    print("\n  -> writing device-info request (cmd 0x97):")
    cmd97 = jk_cmd(0x97)
    print(f"     {cmd97.hex(' ')}")
    await client.write_gatt_char(JK_CHAR, cmd97, response=False)
    await asyncio.sleep(3)

    await client.stop_notify(JK_CHAR)


async def probe_daly(client: BleakClient):
    print("Detected Daly-style service (0xFFF0). Subscribing to notify...")
    await client.start_notify(DALY_NOTIFY_CHAR, notify_handler)

    print("\n-- Trying D2/Modbus dialect (dev_id=0xD2) --")
    cmd = daly_d2_cmd(0xD2, 0x03, 0x00, 62)
    print(f"  -> writing: {cmd.hex(' ')}")
    received.clear()
    await client.write_gatt_char(DALY_WRITE_CHAR, cmd, response=False)
    await asyncio.sleep(3)

    if not received:
        print("  (no response)\n-- Trying P81/DL dialect --")
        cmd = daly_p81_cmd(0x03, 0x00, 64)
        print(f"  -> writing: {cmd.hex(' ')}")
        received.clear()
        await client.write_gatt_char(DALY_WRITE_CHAR, cmd, response=False)
        await asyncio.sleep(3)

    if not received:
        print("  (no response to either dialect - try response=True, or check")
        print("   whether the BMS needs pairing/bonding first)")

    await client.stop_notify(DALY_NOTIFY_CHAR)


async def main(address: str):
    print(f"Connecting to {address} ...")
    async with BleakClient(address) as client:
        print(f"Connected: {client.is_connected}\n")
        uuids = {s.uuid for s in client.services}

        if JK_SERVICE in uuids:
            await probe_jk(client)
        elif DALY_SERVICE in uuids:
            await probe_daly(client)
        else:
            print("Neither 0xFFE0 (JK) nor 0xFFF0 (Daly) service found.")
            print(f"Available services: {sorted(uuids)}")
            print("Run inspect_gatt.py first to see the full service list.")
            return

    print(f"\nTotal notifications received: {len(received)}")
    if received:
        combined = b"".join(received)
        print(f"Concatenated ({len(combined)} bytes): {combined.hex(' ')}")


if __name__ == "__main__":
    if len(sys.argv) != 2:
        print(f"Usage: {sys.argv[0]} <BLE_ADDRESS>")
        sys.exit(1)
    asyncio.run(main(sys.argv[1]))
