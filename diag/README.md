# BMS BLE Diagnose-Skripte

Diese Skripte laufen zunächst auf diesem PC (Laptop mit eingebautem
Bluetooth-Adapter, in Reichweite der BMS) und dienen dazu, vor dem Bau des
eigentlichen SignalK-Plugins herauszufinden, was die drei BMS (1x
JK-B2A8S20P, 2x Daly BMS-ST103-303E) tatsächlich über BLE senden. Der
Raspberry Pi (späterer Produktivstandort von SignalK) kommt erst zum
Einsatz, wenn das Protokoll geklärt ist und das eigentliche Plugin getestet
werden soll.

## Setup auf diesem PC

```bash
cd diag
python3 -m venv venv
./venv/bin/pip install bleak
```

Bluetooth muss aktiv sein:
```bash
sudo systemctl status bluetooth
bluetoothctl power on
```

## Ablauf

### 1. Scannen — Geräte identifizieren

```bash
./venv/bin/python scan.py
```

Listet alle sichtbaren BLE-Geräte mit Name, Adresse, RSSI, beworbenen
Service-UUIDs und Hersteller-ID. Notiere dir, welche Adresse zu welchem
physischen BMS gehört (ggf. ein Gerät nach dem anderen einschalten/in
Reichweite bringen, um sie zuzuordnen). Falls ein Gerät nicht auftaucht:
u.U. ist es schon mit dem Handy (Original-App) verbunden/gepaired — Handy-
Bluetooth kurz ausschalten und erneut scannen.

### 2. GATT-Struktur inspizieren

```bash
./venv/bin/python inspect_gatt.py AA:BB:CC:DD:EE:FF
```

Zeigt alle Services/Charakteristiken des Geräts. Erwartet wird:
- JK-BMS: Service `0000ffe0-...`, Charakteristik `0000ffe1-...` mit
  `write` und `notify` in den Properties.
- Daly: Service `0000fff0-...`, `0000fff1-...` (notify), `0000fff2-...`
  (write).

Falls die UUIDs abweichen, bitte die komplette Ausgabe sichern — dann
müssen wir die Adressen im Plugin anpassen.

### 3. Status-Request senden und Rohdaten mitschneiden

```bash
./venv/bin/python probe.py AA:BB:CC:DD:EE:FF
```

Erkennt automatisch JK vs. Daly anhand der Service-UUID und schickt den
passenden Anfrage-Frame. Bei Daly wird zuerst der "D2"-Dialekt probiert,
bei ausbleibender Antwort automatisch der "P81/DL"-Dialekt. Die komplette
Hex-Ausgabe (Request + alle Notify-Antworten) bitte 1:1 zurückmelden —
daraus lässt sich ablesen:

- ob der Frame überhaupt beantwortet wird (Protokoll/Adresse korrekt?)
- welcher Daly-Dialekt tatsächlich gesprochen wird
- die JK-Firmware-Generation (Byte-Offsets hängen davon ab)

## Wichtige Hinweise

- **Nur eine Verbindung gleichzeitig**: Wenn die Original-App auf dem
  Handy noch verbunden ist, blockiert das den Pi-Zugriff. Handy-App
  schließen bzw. Bluetooth auf dem Handy deaktivieren, während getestet
  wird.
- **Pairing**: Manche JK-BMS-Firmware verlangt BLE-Pairing/Bonding statt
  nur einer offenen GATT-Verbindung. Falls `probe.py` bei JK keine Antwort
  bekommt, probieren wir als nächstes `bluetoothctl pair AA:BB:CC:DD:EE:FF`
  vor dem Verbindungsversuch.
- **Daly-Dialekt unbekannt**: Das Modell "ST103-303E" taucht in keiner
  bekannten Referenz auf. Es ist ein White-Label-Modul — genau deshalb der
  Fallback-Versuch in `probe.py`.
