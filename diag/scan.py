#!/usr/bin/env python3
"""
BMS BLE diagnostic tool - step 1: scan.

Scans for BLE advertisements and prints name, address, RSSI, advertised
service UUIDs, and manufacturer data for every device seen. Run this first
to identify which advertised name/address belongs to which physical BMS
(JK-B2A8S20P or Daly BMS-ST103-303E).

Usage:
    python3 -m venv venv
    ./venv/bin/pip install bleak
    ./venv/bin/python scan.py
"""
import asyncio
from bleak import BleakScanner


async def main():
    print("Scanning for 15 seconds... power-cycle the BMS or wake it via the")
    print("official app first if it doesn't show up (some BMS only advertise")
    print("briefly or only while unpaired from another device).\n")

    seen = {}

    def callback(device, adv_data):
        seen[device.address] = (device, adv_data)

    async with BleakScanner(callback) as scanner:
        await asyncio.sleep(15)

    if not seen:
        print("No BLE devices found. Check that Bluetooth is powered on")
        print("('bluetoothctl power on') and the BMS is within range/awake.")
        return

    print(f"Found {len(seen)} device(s):\n")
    for addr, (device, adv) in sorted(seen.items()):
        name = adv.local_name or device.name or "(no name)"
        print(f"Address: {addr}")
        print(f"  Name:            {name}")
        print(f"  RSSI:            {adv.rssi} dBm")
        print(f"  Service UUIDs:   {adv.service_uuids or '(none advertised)'}")
        if adv.manufacturer_data:
            for company_id, data in adv.manufacturer_data.items():
                print(f"  Manufacturer ID: 0x{company_id:04X}  data: {data.hex()}")
        else:
            print(f"  Manufacturer ID: (none)")
        print()

    print("Next: note the Address of each of your 3 BMS above (match by name")
    print("or by process of elimination / signal strength), then run:")
    print("  ./venv/bin/python inspect_gatt.py <ADDRESS>")


if __name__ == "__main__":
    asyncio.run(main())
