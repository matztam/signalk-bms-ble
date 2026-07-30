# signalk-bms-ble

SignalK-Plugin, das SOC, Spannung, Strom und Zellspannungen von JK-BMS und
Daly Smart BMS Geräten über Bluetooth LE ausliest und unter
`electrical.batteries.<id>.*` veröffentlicht.

## Architektur

- `ble_worker.py` — Python-Subprozess (via `bleak`/BlueZ-DBus), verbindet
  sich der Reihe nach mit jedem konfigurierten BMS, fragt Live-Daten ab und
  gibt sie zeilenweise als JSON auf stdout aus. Läuft in einer eigenen venv
  (`.venv/`, wird beim ersten Plugin-Start automatisch angelegt).
- `lib/bleWorker.js` — spawnt/überwacht den Python-Prozess, parst dessen
  JSON-Zeilen, startet ihn bei Absturz automatisch neu.
- `index.js` — SignalK-Plugin-Entry-Point: Konfigurations-Schema (Geräteliste),
  wandelt Readings in SignalK-Deltas um, zeigt die letzten Werte live auf der
  Plugin-Config-Seite an.

**Warum ein Python-Subprozess statt eines reinen Node-BLE-Moduls?**
`@abandonware/noble` braucht meist exklusiven HCI-Zugriff und kollidiert mit
laufendem `bluetoothd`. `node-ble` (DBus/BlueZ, wie bleak) wurde getestet,
hing aber beim Connect unbegrenzt fest, ohne eigenes Timeout. `bleak` ist die
einzige Bibliothek, die sich gegen die reale Hardware als zuverlässig
herausgestellt hat — siehe `diag/findings/PROTOCOL_NOTES.md`.

## Neues BMS-Fabrikat hinzufügen

1. In `ble_worker.py`: eine neue `Protocol`-Subklasse schreiben (siehe
   `JkProtocol`/`DalyProtocol` als Vorlage) — `notify_char`, `write_char`,
   `request()`, `feed()` implementieren. In `PROTOCOLS` registrieren.
2. In `index.js`: den neuen Typ-Key + Anzeigename in `KNOWN_TYPES` ergänzen.

Kein anderer Code muss angefasst werden — die Geräteliste in der Plugin-Config
bleibt MAC-Adress-basiert und typ-agnostisch.

## Diagnose-Skripte

`diag/` enthält die Skripte, mit denen die Protokolle ursprünglich
reverse-engineered wurden (`scan.py`, `inspect_gatt.py`, `probe.py`, eigene
venv unter `diag/venv/`). Nützlich, um ein neues/unbekanntes BMS-Modell zu
untersuchen, bevor man eine neue `Protocol`-Klasse schreibt.

## Bekannte Geräte (dieses Boot-Setup)

| id | Typ | Adresse | Anzeigename |
|---|---|---|---|
| jk-1 | jk | 11:22:33:44:55:66 | Example-BMS |
| daly-1 | daly | 11:22:33:44:55:67 | DL-EXAMPLE1 |
| daly-2 | daly | 11:22:33:44:55:68 | DL-EXAMPLE2 |

Alle drei sind elektrisch 4S-Packs (nicht 8S, trotz JK-Modellbezeichnung
"B2A8S20P" — siehe PROTOCOL_NOTES.md für Details).

## Bekannte Einschränkungen / offene Punkte

- Entladefall (negativer Strom) beim Daly-Protokoll ist bisher nur anhand der
  Registerformel verifiziert, nicht mit echter Entladelast gegengetestet.
- BLE-Verbindungsstabilität war beim Testen auf dem Laptop schwankend
  (siehe PROTOCOL_NOTES.md) — auf dem Ziel-Pi erneut beobachten.
- Kein Pairing/Bonding nötig; eine offene GATT-Verbindung reicht für alle
  drei Geräte. Nur eine Verbindung pro BMS gleichzeitig möglich — die
  Original-Handy-Apps dürfen während des Plugin-Betriebs nicht gleichzeitig
  verbunden sein.

## Lokale Installation (SignalK auf diesem Rechner)

```
ln -s /home/matthias/projekte/signalk-bms-plugin ~/.signalk/node_modules/signalk-bms-ble
```

und in `~/.signalk/package.json` unter `dependencies` ergänzen:

```json
"signalk-bms-ble": "file:../projekte/signalk-bms-plugin"
```

Danach signalk-server (neu) starten, Plugin unter Server → Plugin Config
aktivieren und die Geräteliste eintragen.
