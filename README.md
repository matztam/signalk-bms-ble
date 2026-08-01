# signalk-bms-ble

SignalK-Plugin, das SOC, Spannung, Strom, Zellspannungen und Restkapazität
von JK-BMS und Daly Smart BMS Geräten über Bluetooth LE ausliest und unter
`electrical.batteries.<id>.*` veröffentlicht.

## Architektur

- `ble_worker.py` — **ein einziger langlebiger** Python-Prozess (via
  `bleak`/BlueZ-DBus). Jedes konfigurierte BMS bekommt einen eigenen
  `asyncio`-Task, der sich **einmal verbindet und dauerhaft verbunden
  bleibt** (kein Poll/Disconnect-Zyklus) und laufend Messwerte über BLE-
  Notifications empfängt. Discovery+Connect-Versuche werden über ein
  geteiltes `asyncio.Lock` zwischen allen Geräten serialisiert (BlueZ
  erlaubt nur einen solchen Vorgang gleichzeitig), außerdem durch ein
  äußeres Timeout (`LOCK_TIMEOUT_S`) begrenzt, damit ein einzelnes
  hängendes Gerät nicht alle anderen blockiert. Ein Watchdog-Thread
  beendet den ganzen Prozess hart, falls trotzdem etwas über
  `WATCHDOG_TIMEOUT_S` hinaus hängen bleibt. Ergebnisse gehen zeilenweise
  als JSON auf stdout. Läuft in einer eigenen venv (`.venv/`, wird beim
  ersten Plugin-Start automatisch angelegt). Details und die
  Entscheidungsgeschichte (u.a. warum Dauerverbindungen statt Poll-Zyklen)
  stehen in `diag/findings/PROTOCOL_NOTES.md`.
- `lib/bleWorker.js` — spawnt/überwacht den Python-Prozess, parst dessen
  JSON-Zeilen, startet ihn bei Absturz automatisch neu.
- `index.js` — SignalK-Plugin-Entry-Point: Konfigurations-Schema
  (Geräteliste, pro Gerät ein-/ausschaltbar), wandelt Readings in
  SignalK-Deltas um (inkl. Umrechnung der vom BMS gemeldeten Ah-Kapazität
  in SignalKs Joule-basierte `capacity.actual`/`.remaining`/
  `.timeRemaining`, mit geglättetem Strom für die Restlaufzeit-Berechnung),
  zeigt die letzten Werte live auf der Plugin-Config-Seite an.

**Warum ein Python-Prozess statt eines reinen Node-BLE-Moduls?**
`@abandonware/noble` braucht meist exklusiven HCI-Zugriff und kollidiert mit
laufendem `bluetoothd`. `node-ble` (DBus/BlueZ, wie bleak) wurde getestet,
hing aber beim Connect unbegrenzt fest, ohne eigenes Timeout. `bleak` ist die
einzige Bibliothek, die sich gegen die reale Hardware als zuverlässig
herausgestellt hat — siehe `diag/findings/PROTOCOL_NOTES.md`.

**Warum Dauerverbindungen statt Poll/Disconnect-Zyklen?**
Ein früherer Ansatz verband sich für jede Messung neu (Discover → Connect →
Lesen → Trennen). Wiederholtes Discovery erwies sich live als Hauptquelle
intermittierender "did not advertise"-Fehler — ein Gerät konnte über viele
Zyklen hinweg zuverlässig funktionieren und dann mehrfach hintereinander
scheitern, obwohl ein einfaches `bluetoothctl scan` es immer fand und die
Hersteller-App sich jedes Mal einwandfrei verband (bestätigt durch
verbunden). Ein Live-Experiment bestätigte außerdem, dass ein einzelner
BLE-Adapter mehrere gleichzeitig offene Verbindungen halten kann — die
"nur eine Operation gleichzeitig"-Grenze von BlueZ betrifft nur das
*Herstellen*, nicht das *Halten* von Verbindungen. Details in
`diag/findings/PROTOCOL_NOTES.md`.

## Neues BMS-Fabrikat hinzufügen

1. In `ble_worker.py`: eine neue `Protocol`-Subklasse schreiben (siehe
   `JkProtocol`/`DalyProtocol` als Vorlage) — `notify_char`, `write_char`,
   `request()`, `feed()` implementieren; optional `extra_requests()` (falls
   das Gerät erst nach einer zweiten Anfrage Live-Daten pusht) und
   `request_interval_s` (falls das Gerät nicht von selbst weiter pusht,
   sondern periodisch erneut angefragt werden muss — siehe DalyProtocol).
   In `PROTOCOLS` registrieren.
2. In `index.js`: den neuen Typ-Key + Anzeigename in `KNOWN_TYPES` ergänzen.

Kein anderer Code muss angefasst werden — die Geräteliste in der Plugin-Config
bleibt MAC-Adress-basiert und typ-agnostisch.

## Diagnose-Skripte

`diag/` enthält die Skripte, mit denen die Protokolle ursprünglich
reverse-engineered wurden (`scan.py`, `inspect_gatt.py`, `probe.py`, eigene
venv unter `diag/venv/`). Nützlich, um ein neues/unbekanntes BMS-Modell zu
untersuchen, bevor man eine neue `Protocol`-Klasse schreibt.

## Veröffentlichte SignalK-Pfade

Pro konfiguriertem Gerät unter `electrical.batteries.<id>.*`:

| Pfad | Bedeutung | Voraussetzung |
|---|---|---|
| `capacity.stateOfCharge` | SOC, 0–1 (SignalK-Konvention) | immer |
| `voltage` | Packspannung in V | immer |
| `current` | Strom in A (negativ = Entladung) | immer |
| `cellVoltages.<n>.voltage` | Einzelzellspannungen | immer |
| `capacity.actual` | Aktuelle volle Ladekapazität in J (vom BMS gemeldete Ah × Spannung × 3600 — kein fester Werks-Nennwert, driftet mit Zellalterung/-kalibrierung) | wenn das BMS eine Kapazität meldet |
| `capacity.remaining` | Verbleibende Kapazität in J (SOC × `capacity.actual`) | wie oben |
| `capacity.timeRemaining` | Restlaufzeit bis leer in s | wie oben, nur während Entladung (`current < 0`); Berechnung nutzt einen geglätteten Strom (Zeitkonstante ~45s), damit kurze Lastspitzen den Wert nicht springen lassen |

`capacity.timeRemaining` ist z.B. das, was ein NMEA2000-Plotter (PGN 127506)
als "Zeit bis leer" neben SOC/Spannung/Strom anzeigt.

## Bekannte Geräte (dieses Boot-Setup)

| id | Typ | Adresse | Anzeigename | Kapazität |
|---|---|---|---|---|
| jk-1 | jk | 11:22:33:44:55:66 | Example-BMS | ~105 Ah |
| daly-1 | daly | 11:22:33:44:55:67 | DL-EXAMPLE1 | ~280 Ah |
| daly-2 | daly | 11:22:33:44:55:68 | DL-EXAMPLE2 | ~280 Ah |

Alle drei sind elektrisch 4S-Packs (nicht 8S, trotz JK-Modellbezeichnung
"B2A8S20P" — siehe PROTOCOL_NOTES.md für Details). Die Kapazitätsangaben
sind die vom jeweiligen BMS selbst gemeldeten, aktuellen Werte (siehe oben),
nicht aus der Modellbezeichnung abgeleitet.

## Bekannte Einschränkungen / offene Punkte

- Entladefall (negativer Strom) beim Daly-Protokoll ist bisher nur anhand der
  Registerformel verifiziert, nicht mit echter Entladelast gegengetestet.
- Kein Pairing/Bonding nötig; eine offene GATT-Verbindung reicht für alle
  drei Geräte. Nur eine Verbindung pro BMS gleichzeitig möglich — die
  Original-Handy-Apps dürfen während des Plugin-Betriebs nicht gleichzeitig
  verbunden sein.
- Auf Raspberry-Pi-Hardware mit onboard-BLE (z.B. Pi 4B, Broadcom-Chip per
  UART statt USB) wurden gelegentliche, mehrminütige raue Phasen
  beobachtet (BlueZ braucht ungewöhnlich lange für Discovery/Scanner-
  Teardown), typischerweise kurz nach einem Neustart. Das System erholt
  sich in jedem beobachteten Fall selbstständig; `LOCK_TIMEOUT_S` verhindert,
  dass ein betroffenes Gerät dabei die anderen blockiert. Details in
  PROTOCOL_NOTES.md.
- **Erster Deployment-Versuch auf einem Raspberry Pi mit nur 416MB RAM
  scheiterte**: ein damaliger Subprozess-pro-Poll-Ansatz (mehrere gleichzeitig
  laufende Python-Interpreter) brachte den Pi zum Swappen und SignalK
  reagierte gar nicht mehr — Details in PROTOCOL_NOTES.md. Deshalb der
  Umbau auf einen einzigen Dauerprozess mit persistenten Verbindungen. Bei
  RAM-armer Hardware trotzdem Vorsicht geboten: RAM-Headroom vor dem Deploy
  prüfen (`free -h`), und nicht gleichzeitig mit anderen RAM-hungrigen
  Setup-Vorgängen (z.B. Erstinstallation anderer Plugins) deployen.

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
