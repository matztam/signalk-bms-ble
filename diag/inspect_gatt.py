#!/usr/bin/env python3
"""
BMS BLE diagnostic tool - step 2: inspect GATT services/characteristics.

Connects to a specific BLE address and prints every service and
characteristic (UUID + properties: read/write/notify/indicate).
Use this to confirm whether a device exposes the expected UUIDs:

  JK-BMS:  service 0xFFE0, characteristic 0xFFE1 (write + notify)
  Daly:    service 0xFFF0, notify 0xFFF1, write 0xFFF2

Usage:
    ./venv/bin/python inspect_gatt.py AA:BB:CC:DD:EE:FF
"""
import asyncio
import sys
from bleak import BleakClient


async def main(address: str):
    print(f"Connecting to {address} ...")
    async with BleakClient(address) as client:
        print(f"Connected: {client.is_connected}\n")
        for service in client.services:
            print(f"Service {service.uuid}  ({service.description})")
            for char in service.characteristics:
                props = ",".join(char.properties)
                print(f"  Characteristic {char.uuid}  [{props}]  handle={char.handle}")
                for descriptor in char.descriptors:
                    print(f"    Descriptor {descriptor.uuid}")
            print()


if __name__ == "__main__":
    if len(sys.argv) != 2:
        print(f"Usage: {sys.argv[0]} <BLE_ADDRESS>")
        sys.exit(1)
    asyncio.run(main(sys.argv[1]))
