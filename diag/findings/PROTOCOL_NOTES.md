# Verifizierte Protokoll-Details (Stand 2026-07-30, Test auf Laptop development laptop)

## Geräte-Zuordnung (BLE MAC-Adressen)

- **JK-BMS** "Example-BMS" (JK-B2A8S20P): `11:22:33:44:55:66`
- **Daly BMS 1**: `11:22:33:44:55:67` (Name: `DL-EXAMPLE1`)
- **Daly BMS 2**: `11:22:33:44:55:68` (Name: `DL-EXAMPLE2`)
- Balancer-eigene BLE-Geräte (NICHT relevant, ignorieren): `11:22:33:44:55:69`, `11:22:33:44:55:6a`

## JK-BMS (JK02-Protokoll, Header `55 AA EB 90`)

- Service `0000ffe0`, Characteristic `0000ffe1` (write + notify).
- Request: `AA 55 90 EB 96 00` + 13×`00` + 1-Byte-Checksumme (simple sum) = COMMAND_CELL_INFO.
- BMS antwortet fortlaufend mit drei Frame-Typen (gleicher Request triggert alle):
  - `data[4]=0x01`: Settings-Frame (Limits, nicht die Live-Werte!)
  - `data[4]=0x02`: **Cell-Info-Frame — das brauchen wir.** Fixe Länge 300 Bytes,
    kommt in BLE-Notify-Chunks (128+128+44 Bytes hier beobachtet).
  - `data[4]=0x03`: Device-Info-Frame (Modellname, Gerätename, Seriennummer als ASCII)
- Checksum Cell-Info-Frame: simple Byte-Summe über data[0..298], Ergebnis in data[299]. Verifiziert (match).
- **Wichtige Abweichung von esphome-jk-bms Referenzcode**: Unser Gerät nutzt einen
  Feld-Offset von **32** (nicht 0 wie JK02_24S, nicht 16 wie JK02_32S) für die
  Blöcke ab Byte 118. Vermutlich eine weitere Board-Variante. Byte-Layout:
  - Zellspannungen: `cell[i] = get_u16(6 + i*2) * 0.001` V — **kein Offset**, ab Byte 6, unverändert.
  - Pack-Spannung: `get_u32(118+32=150) * 0.001` V
  - Strom (signed): `get_i32(126+32=158) * 0.001` A
  - SOC: `data[141+32=173]` (uint8, direkt %)
  - Getestet/verifiziert mit echten Daten: 4 Zellen à ~3.33V, Summe 13.33V,
    Pack-Spannung-Feld exakt 13.326V (stimmt), SOC 65%, Strom 4.821A — alles plausibel.
  - **Falls sich das Verhalten künftig ändert** (z.B. nach Firmware-Update, oder
    bei mehr aktiven Zellen): Offset-Hypothese erneut gegen Zellspannungssumme
    verifizieren, da unklar ist, ob es an der tatsächlichen Zellenzahl hängt.
- Nur 4 von 8 möglichen Zellslots sind belegt → das Pack ist elektrisch 4S,
  trotz Modellbezeichnung "B2A8S20P" (8S = max. unterstützte Zellenzahl des Boards).

## Daly Smart BMS (D2-Dialekt, Modbus-RTU-artig, Header `D2 03`)

- Service `0000fff0`, notify `0000fff1`, write `0000fff2`.
- Request: `D2 03 00 00 00 3E` + CRC16/Modbus (LE) = `D7 B9`. Liest 62 Register ab 0x0000.
- Response: `D2 03 7C` + 124 Bytes Daten (62 × uint16 BE) + CRC16/Modbus (LE). CRC verifiziert exakt.
- Register-Layout (bestätigt via github.com/syssi/esphome-daly-bms docs/protocol-register-map.md,
  UND durch eigene Cross-Validierung Zellsumme≈Pack-Spannung):
  - Zellspannung N (1-basiert): register `0x00 + (N-1)`, uint16 BE, ×0.001 V
  - Zellenzahl: register `0x31` (bei uns: 4 → 4S-Pack, nicht 8S/mehr)
  - Pack-Gesamtspannung: register `0x28`, uint16 BE, ×0.1 V
  - Strom: register `0x29`, uint16 BE, **(raw − 30000) × 0.1 A** (Daly-typischer Offset,
    negative Werte = Entladung, positive = Ladung — Vorzeichen noch nicht live mit
    tatsächlicher Entladung gegengetestet, nur Ladefall beobachtet)
  - SOC: register `0x2A`, uint16 BE, ×0.1 %
  - Max. Zellspannung: register `0x2B`, uint16 BE, ×0.001 V
- Verifiziert mit echten Daten (beide BMS):
  - BMS1: 4 Zellen [3.355, 3.363, 3.356, 3.362]V, Summe 13.436V, Pack-Spannung-Feld 13.4V ✓, SOC 56.1%, Strom +18.9A
  - BMS2: 4 Zellen [3.342, 3.351, 3.352, 3.337]V, Summe 13.382V, Pack-Spannung-Feld 13.3V ✓, SOC 62.2%, Strom +18.0A
- Beide Daly-BMS sind ebenfalls 4S-Packs (13S/4S ~13.3-13.4V ≈ 4×LFP), passend zum JK-BMS.

## JK-BMS: zweiter Request nötig, um Live-Daten zu triggern

Ein einzelner `0x96`-("cell info")-Request liefert vom getesteten Gerät NUR die
`0x01`(Settings)- und `0x03`(Device-Info)-Frames, keinen `0x02`(Cell-Info)-Frame.
Erst ein zusätzlicher `0x97`("device info")-Request bringt das BMS dazu, danach
laufend (alle ~0.4s) `0x02`-Frames zu pushen. Reproduzierbar über mehrere
Verbindungen bestätigt. `JkProtocol.extra_requests()` in `ble_worker.py` sendet
deshalb den `0x97`-Request automatisch nach, falls die erste Antwort nach 1.5s
noch kein Cell-Info-Frame war. Grund für das Geräteverhalten unklar
(evtl. wird der periodische Push erst durch eine zweite "Aktivität" auf dem
UART-Bridge-Chip angestoßen) — nicht weiter untersucht, da der Workaround
zuverlässig funktioniert.

## BLE-Adapter-Stabilität (Laptop development laptop, USB-BT-Adapter)

- Nach vielen aufeinanderfolgenden Verbindungsversuchen/-abbrüchen (z.B. durch
  Testläufe, die per `timeout` hart gekillt wurden statt sauber zu disconnecten)
  gerät `bluetoothd` in einen Zustand, in dem `BleakScanner.discover()` Geräte
  nicht mehr findet, obwohl sie nachweislich in Reichweite und aktiv sind
  (mit dem Handy verbindbar). Symptom: alle drei BMS verschwinden aus
  `bluetoothctl devices`. Fix: `sudo systemctl restart bluetooth`. Nach dem
  Neustart sind alle drei sofort wieder sichtbar.
- Einmal beobachtet: ein `BleakClient`-Connect hing >80s fest, obwohl
  `DISCOVER_TIMEOUT_S=8` und `CONNECT_TIMEOUT_S=15` konfiguriert waren —
  bleak/BlueZ-DBus scheint das eigene Timeout in seltenen Fällen nicht
  durchzusetzen. Fix: `poll_once()` in `ble_worker.py` wickelt jetzt den
  gesamten Discover+Connect+Read-Vorgang zusätzlich in ein äußeres
  `asyncio.wait_for(..., timeout=DISCOVER_TIMEOUT_S + CONNECT_TIMEOUT_S + 5)`,
  damit ein hängendes Gerät nie länger als ~28s blockiert (statt potentiell
  unbegrenzt).
  - **Einschränkung dieses Fixes**: `asyncio.wait_for`-Cancellation ist
    kooperativ — wenn der abgebrochene Code selbst in einem blockierenden
    DBus-Call hängt (`epoll_wait` auf eine DBus-Antwort, die nie kommt —
    per `cat /proc/<pid>/wchan` bestätigt), kehrt die Coroutine trotzdem
    nicht zurück, egal wie das Timeout konfiguriert ist. Live beobachtet:
    ein Worker-Prozess hing >4 Minuten fest, mit `asyncio.wait_for`-Timeout
    von nur ~28s konfiguriert.
  - **Endgültiger Fix**: `poll_once()` läuft jetzt nicht mehr im
    Haupt-Event-Loop, sondern wird für jeden Poll-Versuch als eigener
    kurzlebiger Subprozess gestartet (`ble_worker.py --poll-one '<json>'`,
    siehe `poll_once_isolated()`). Der Elternprozess nutzt
    `subprocess.run(..., timeout=SUBPROCESS_TIMEOUT_S)`, das den Kindprozess
    bei Überschreitung per SIGKILL beendet — ein Betriebssystem-Kill wirkt
    immer, unabhängig davon, ob die Coroutine kooperativ abbricht. Seither
    in mehreren Testläufen zu 100% zuverlässig: alle drei BMS liefern in
    jedem Round-Robin-Zyklus echte Daten, keine Hänger mehr beobachtet.
- `signalk-beluga-core` (separates, bereits installiertes Plugin) advertised
  den Laptop selbst als eigenes BLE-Peripheral-Gerät (under the configured device name). Ob/wie stark
  das den gleichzeitigen Central-Betrieb unseres Plugins auf demselben
  Adapter stört, ist nicht abschließend geklärt — beim Test mit
  deaktiviertem beluga-core traten weiterhin Verbindungsfehler auf, aber
  seltener als davor. Für den späteren Pi-Betrieb ggf. beachten, falls dort
  ebenfalls ein BLE-Peripheral-Advertiser läuft.
- node-ble (DBus/BlueZ, wie bleak) wurde für eine reine-Node-Lösung ohne
  Python-Subprozess evaluiert, aber `device.gatt()` hing dort unbegrenzt
  ohne jedes Timeout — deutlich unzuverlässiger als bleak. Deshalb bleibt
  die Architektur bei einem Python/bleak-Subprozess (`ble_worker.py`),
  gespawnt von `lib/bleWorker.js` nach dem Muster von `signalk-beluga-core`.
- **Root cause gefunden: nur das ERSTE Gerät im Round-Robin-Zyklus wird
  zuverlässig per Scan gefunden — unabhängig davon, welches physische
  Gerät das ist.** Getestet mit zwei verschiedenen Device-Reihenfolgen in
  `BMS_DEVICES`: in beiden Fällen war exakt das erste Listenelement in
  praktisch jedem Zyklus erfolgreich, alle nachfolgenden scheiterten
  konsistent mit `did not advertise within Ns` — trotz `INTER_DEVICE_DELAY_S`-
  Pause und großzügigem `DISCOVER_TIMEOUT_S=12`. Da jeder Poll-Versuch in
  einem komplett frischen Subprozess läuft (`poll_once_isolated`, eigener
  Python-Interpreter, eigener `BleakScanner`), liegt der Effekt nicht am
  Python/bleak-Zustand, sondern am **BlueZ-Daemon/Adapter-Zustand selbst**:
  nach einem Scan+Connect+Disconnect-Zyklus scheint der Adapter für eine
  gewisse Zeit "nachzuhängen" und neue `StartDiscovery`-Aufrufe liefern für
  andere Geräte keine frischen Advertising-Reports mehr, bis er sich erholt
  hat (Ursache nicht abschließend geklärt — evtl. BlueZ-interne Discovery-
  Session-Verwaltung, die sich nicht sauber zwischen kurz aufeinanderfolgenden
  `StartDiscovery`/`StopDiscovery`-Zyklen zurücksetzt).
  - Ausprobiert, aber nicht ausreichend: `INTER_DEVICE_DELAY_S=2` Pause
    zwischen Geräten. Half nicht messbar.
  - **Umgesetzter Fix**: `start_background_scanner()` startet einen
    eigenständigen Subprozess, der für die gesamte Worker-Laufzeit EINEN
    durchgehenden `BleakScanner()`-Scan offen hält (kein Start/Stop pro
    Gerät mehr). Da BlueZ seinen Geräte-Cache systemweit über DBus teilt
    (verifiziert: ein von Prozess A gestarteter Scan macht Geräte auch für
    `bluetoothctl devices` aus einem komplett anderen Prozess sichtbar),
    genügt das, damit alle konfigurierten Geräte durchgehend im Cache
    bleiben. Die isolierten `--poll-one`-Subprozesse überspringen dann ihre
    eigene Discovery-Phase (`BMS_SKIP_DISCOVERY=1`, siehe
    `SKIP_DISCOVERY_ENV`) und verbinden direkt.
  - **Zusätzlich gefundene, eigenständige Fehlerquelle**: `BleakClient.connect()`
    ruft intern selbst nochmal `BleakScanner.find_device_by_address()` auf,
    komplett unabhängig davon, ob schon ein externer Scan läuft (Quellcode:
    `bleak/backends/bluezdbus/client.py`, Kommentar "A Discover must have
    been run before connecting to any devices"). Ein zweites,
    unzusammenhängendes Problem trat während der Untersuchung auf: das
    JK-BMS hing über `bluetoothctl info <addr>` als `Connected: yes` fest
    (Rest einer nicht sauber getrennten Verbindung aus einem abgebrochenen
    Testlauf) — ein bereits verbundenes BLE-Peripheral stoppt typischerweise
    sein Advertising, wodurch es für JEDEN Scan unsichtbar wird, unabhängig
    vom Discovery-Mechanismus. `bluetoothctl disconnect <addr>` (oder ein
    kompletter `sudo systemctl restart bluetooth`) behebt das. **Nach
    Bluetooth-Neustart und mit dem Background-Scanner-Fix: 6/6 Zyklen zu
    100% erfolgreich für alle drei Geräte, keine einzige Fehlermeldung.**
    Falls künftig wieder ein einzelnes Gerät konsequent scheitert, zuerst
    `bluetoothctl info <addr>` prüfen, ob es fälschlich als "Connected: yes"
    geführt wird, bevor an der Protokoll-/Timing-Logik gesucht wird.

## Offene Punkte für die Plugin-Implementierung

1. Entladefall (negativer Strom) beim Daly noch nicht live verifiziert — Vorzeichen-Konvention
   vor Produktiveinsatz mit tatsächlicher Last gegenprüfen.
2. JK-BMS Offset=32-Hypothese ist nur mit diesem einen Gerät/dieser Firmware getestet.
3. Kein Pairing/Bonding nötig war — offene GATT-Verbindung hat für alle drei Geräte gereicht.
4. BLE-Verbindungen sind auf diesem Laptop-Adapter spürbar unzuverlässiger als bei den
   isolierten Diagnose-Skript-Läufen — noch unklar, wie viel davon USB-Adapter-/Umgebungs-
   spezifisch ist und wie viel sich auf dem späteren Pi (ggf. mit Onboard-BT oder anderem
   Adapter) reproduziert. Vor Produktivbetrieb auf dem Pi erneut beobachten.

## Erster Pi-Deployment-Versuch gescheitert: Subprozess-Architektur zu schwer (2026-07-30)

Der Subprozess-pro-Poll-Ansatz (Hintergrund-Scanner-Subprozess + isolierter
`--poll-one`-Subprozess je Gerät, siehe oben) funktionierte auf dem Laptop
zuverlässig, hat aber den Ziel-Pi (416MB RAM, `free -h` zeigte im Normalbetrieb
schon nur ~80-120MB verfügbar) überlastet: mehrere gleichzeitig laufende
Python-Interpreter (venv-Overhead pro Prozess) plus ein zeitgleich laufender
`pip install` von `signalk-beluga-core` (dessen eigene venv-Erstinstallation)
trieben die Load auf 9-12 und den Server ins Swappen. Folge: SignalK
antwortete auf HTTP-Anfragen nicht mehr (`curl` gegen Port 80 lokal auf dem
Pi lieferte `HTTP:000`), das Admin-UI war für den Nutzer nicht mehr
erreichbar. Deaktivieren des Plugins (`enabled: false` in der
Plugin-Config-Datei) reichte NICHT aus, um es zu stoppen — SignalK scheint
den `enabled`-Status nicht live zu respektieren, sondern nur beim Laden des
Plugins aus `node_modules`. Was tatsächlich half:
1. Den Plugin-Symlink aus `~/.signalk/node_modules/` entfernen (verhindert,
   dass SignalK das Plugin überhaupt findet/lädt).
2. Sauberer `sudo reboot` (nicht Strom trennen — Dateisystem-Risiko), da der
   Pi durch die hohe Last so verlangsamt war, dass selbst einzelne SSH-Befehle
   wiederholt mit Verbindungsabbrüchen scheiterten.

**Fix: kompletter Umbau von "Subprozess pro Poll-Versuch" auf "ein einziger
Dauerprozess"** (siehe aktueller Code in `ble_worker.py`), nach dem Vorbild
von `signalk-victron-ble` (ebenfalls Python/bleak-basiert, aber als ein
einziger `asyncio.run()`-Aufruf für die gesamte Laufzeit implementiert — dort
allerdings technisch einfacher, weil Victron-BLE passiv aus
Advertisement-Paketen liest statt aktiv GATT-Connects zu machen wie JK/Daly).

Wichtige Design-Änderungen beim Umbau:
- Ein `BleakScanner` läuft als `async with`-Context für die komplette
  Worker-Lebensdauer statt als separater Subprozess.
- **Neu gefundenes Problem dabei**: den Scanner permanent parallel zum
  `BleakClient.connect()` laufen zu lassen erzeugt bei JEDEM Connect-Versuch
  `org.bluez.Error.InProgress` (reproduzierbar, 100% der Fälle) — Scanner und
  Connect konkurrieren um denselben Adapter. Fix: `scanner.stop()` unmittelbar
  vor jedem `BleakClient`-Connect, `scanner.start()` im `finally`-Block direkt
  danach. Mit diesem Fix: 3/3 Zyklen (9/9 Leseversuche) auf dem Laptop
  fehlerfrei erfolgreich.
- Statt der Subprozess-SIGKILL-Absicherung gegen hängende BlueZ/DBus-Calls
  (siehe oben) übernimmt jetzt ein **Watchdog-Thread** diese Rolle: er wird
  vor/nach jedem Poll-Versuch "gefüttert" und beendet den gesamten
  Python-Prozess per `os._exit(1)`, falls er `WATCHDOG_TIMEOUT_S` lang keine
  Fütterung sieht. `lib/bleWorker.js` startet den toten Prozess automatisch
  neu (bereits vorhandene Resilience-Logik) — kostet im Hängefall einen
  Reconnect-Zyklus statt eines zusätzlichen Subprozesses pro Poll.
- Ergebnis: nur noch EIN Python-Prozess über die gesamte Laufzeit (statt
  bis zu 3-4 gleichzeitig), massiv geringerer RAM/CPU-Fußabdruck.

**Noch nicht erneut auf dem Pi getestet** — nächster Schritt vor dem nächsten
Deploy-Versuch: erneut sicherstellen, dass keine andere RAM-hungrige
Installation (z.B. `pip install`/venv-Builds anderer Plugins) parallel läuft.

## Umbau auf Dauerverbindungen statt Poll/Disconnect-Zyklen (2026-07-31)

Trotz großzügigerer Timeouts (`DISCOVER_TIMEOUT_S=20`) blieb `daly-1` auf dem
Pi 4B weiterhin intermittierend nicht erreichbar ("did not advertise"),
während ein einfaches `bluetoothctl scan` das Gerät zuverlässig fand und die
Hersteller-App sich jedes Mal "einwandfrei" verband. Die Android-App wurde
BLE-Brücke): die Java/Kotlin-Schicht (Scan-Callback, GATT-Callback,
Method-Channel-Setup) enthält keinerlei besondere Retry-/Backoff-Logik — nur
Standard-Android-BLE-Aufrufe. Die eigentliche App-Logik liegt in
struktureller Unterschied war schon an der Java-Brücke sichtbar: die App
verbindet sich einmal und bleibt verbunden, statt wie unser bisheriger
Poll-Ansatz für jede Messung neu zu scannen und neu zu verbinden.

**Hypothese**: nicht die Geräte selbst sind unzuverlässig, sondern das
wiederholte Discovery+Connect pro Poll-Zyklus ist die eigentliche
Fehlerquelle (verpasste Advertisement-Fenster bei jedem neuen Scan-Versuch).

Ein isolierter Test (`test_persistent_connections.py`, nicht Teil des
Plugins) bestätigte zusätzlich, dass ein einzelner BLE-Adapter durchaus
**mehrere gleichzeitig offene** GATT-Verbindungen halten kann — die
"nur eine Operation gleichzeitig"-Grenze von BlueZ/DBus betrifft nur das
**Herstellen** einer Verbindung (Scan+Connect), nicht das **Halten**
mehrerer bereits offener Verbindungen. Beide Daly-Geräte liefen 60+s
gleichzeitig verbunden mit 12/12 Messungen, 0 Fehlern.

**Umbau**: `ble_worker.py` verbindet sich jetzt pro Gerät genau einmal und
bleibt verbunden, statt für jede Messung neu zu scannen/verbinden/trennen:

- `Protocol.stream(client, on_reading, setup_lock)` ersetzt das alte
  `Protocol.read(client)`. Abonniert einmalig die Notify-Characteristic,
  schickt die initiale(n) Anfrage(n) (`request()`/`extra_requests()`, siehe
  oben), und lässt danach den Notify-Handler laufend `on_reading()` für
  jeden neuen Frame aufrufen, bis der Aufrufer abbricht (Verbindung verloren
  o.ä.).
- **Wichtiger Protokoll-Unterschied entdeckt**: JK02 "pusht" nach der
  initialen Anfrage von selbst weiter (free-running) — bestätigt live über
  90s durchgehend, 112 Messungen ohne einen einzigen erneuten Request nötig.
  Daly (D2-Dialekt) dagegen beantwortet eine Anfrage genau einmal und
  schweigt dann wieder — braucht periodisches erneutes `write_gatt_char()`
  (`request_interval_s = 5`, übernommen aus dem erfolgreichen Testskript),
  sonst bleiben nach der ersten Antwort keine weiteren Daten mehr.
- `run_device()` pro Gerät ist eine Endlosschleife: verbinden → `stream()`
  aufrufen (blockiert, bis Verbindung abbricht) → bei jedem Fehler/Abbruch
  `RECONNECT_DELAY_S=5s` warten und von vorn beginnen. Ein Geräteausfall
  betrifft nur dieses Gerät, nicht die anderen.
- `run_all()` startet für jedes Gerät einen eigenen `asyncio`-Task und hält
  sie alle parallel offen (`asyncio.gather`).
- **Zweite Race Condition gefunden und gefixt, die im Testskript (nur ein
  einmaliger Connect ohne Reconnects während der Laufzeit) nicht sichtbar
  war**: sobald zwei Geräte fast gleichzeitig verbinden bzw. neu verbinden
  (z.B. nach einem Reconnect mitten im Betrieb), kollidieren nicht nur
  Discovery+Connect (`org.bluez.Error.InProgress`), sondern auch das direkt
  anschließende GATT-Setup (`start_notify`/erste `write_gatt_char`-Anfrage)
  mit `BleakGATTProtocolErrorCode.UNLIKELY_ERROR` ("GATT Protocol Error:
  Unlikely Error"). Fix: ein einziges, geteiltes `asyncio.Lock`
  (`connect_lock`) serialisiert nicht nur Discovery+Connect, sondern auch
  den Settle-Delay und das gesamte initiale GATT-Setup bis zur ersten
  erfolgreichen Messung — für jeden Verbindungsversuch, nicht nur beim
  Start. Das Lock wird freigegeben, sobald ein Gerät nur noch passiv lauscht
  bzw. im Daly-Fall periodisch nachfragt; das läuft dann uneingeschränkt
  parallel zu den anderen Geräten.
- Watchdog: statt eines globalen "Rundenende"-Zeitstempels (ergab in einem
  Dauerverbindungsmodell keinen Sinn mehr, da es keine Runden mehr gibt)
  führt `Watchdog._last_pet` jetzt pro Geräte-ID einen eigenen Zeitstempel;
  `pet(device_id)` wird bei jedem Connect-Versuch und bei jeder empfangenen
  Messung aufgerufen. Bleibt irgendein Gerät zu lange ohne Fortschritt,
  beendet sich der gesamte Prozess weiterhin komplett (`os._exit(1)`) — ein
  einzelnes hängendes Gerät deutet eher auf einen verklemmten
  Adapter/DBus-Zustand hin als auf ein isoliertes Geräteproblem.

**Live verifiziert (Laptop development laptop, vor Pi-Deployment)**:
- Beide Daly-Geräte gleichzeitig, 75s, 0 Fehler, durchgehend frische Daten
  (Request-Intervall 5s eingehalten).
- Alle drei Geräte gleichzeitig (JK-1 in Reichweite, beide Daly außer
  Reichweite von der Testposition): JK-1 lieferte 112 fehlerfreie Messungen
  über 90s am Stück, während die außer Reichweite befindlichen Daly-Geräte
  alle 5s einen Reconnect-Versuch unternahmen (erwartungsgemäß scheiternd)
  — ohne dass dies die bereits laufende JK-1-Verbindung jemals gestört hätte.

**Noch offen**: erneuter Pi-4B-Deploy-Test mit allen drei Geräten in
Reichweite (klärt, ob dies das ursprüngliche `daly-1`-Flackern tatsächlich
behebt), plus Abgleich mit dem Heartbeat-Mechanismus in `index.js` (der für
den alten Poll-Rhythmus gedacht war und bei durchgehendem Streaming
möglicherweise seltener/gar nicht mehr nötig ist).

**Update**: Heartbeat-Mechanismus wurde entfernt (siehe Commit) — bei
Dauerverbindungen kommen echte Messungen alle paar Sekunden von selbst,
und bei einem echten Verbindungsabbruch soll bewusst keine Ersatzmeldung
mehr gesendet werden (Nutzerentscheidung).

## `connect_lock` konnte unbegrenzt lange blockiert bleiben — `LOCK_TIMEOUT_S` nachgerüstet (2026-07-31)

Nach Aktivierung aller drei Geräte auf dem Pi 4B: `jk-1` löste nach 20s
korrekt einen Discovery-Timeout aus und gab den `connect_lock` scheinbar
frei — aber `daly-1`/`daly-2` blieben danach **~3,5 Minuten** komplett
still (kein einziger Log-Eintrag, kein Timeout, keine Messung), bevor sich
der Prozess von selbst erholte. Der `WATCHDOG_TIMEOUT_S=90`-Watchdog hätte
das eigentlich abfangen müssen, tat es aber nicht.

Lokale Reproduktion (Laptop development laptop, BlueZ 5.85) zeigte zunächst
keinen Hänger über mehrere Minuten, dann aber — nach Neustart des Tests —
wiederholt echte, mehrfach reproduzierbare Hänge von einzelnen
`find_device_by_address()`-Aufrufen weit über ihren eigenen
`timeout`-Parameter hinaus (in einem Fall >50s statt der übergebenen 15s),
obwohl ein isolierter `bluetoothctl scan` die Geräte weiterhin sofort fand
und ein einzelner, isolierter `find_device_by_address()`-Aufruf ohne
umgebenden Code zuverlässig exakt beim `timeout`-Wert abbrach. Das deutet
darauf hin, dass der Hänger nicht am Gerät oder am Timeout-Parameter
selbst liegt, sondern am Scanner-Teardown danach.

**Root Cause identifiziert**: `bleak`s `find_device_by_filter()` (worauf
`find_device_by_address()` aufbaut) öffnet den Scanner über
`async with cls(**kwargs) as scanner:` — der eigentliche `timeout`-Parameter
schützt nur die Warteschleife auf ein passendes Advertisement
(`async_timeout(timeout)` um die `async for`-Schleife), NICHT das
Verlassen des `async with`-Blocks. Der Scanner-Teardown
(`BleakScannerBlueZDBus.stop()`) awaited einen `StopDiscovery`-D-Bus-Call
komplett ungeschützt, ohne eigenes Timeout. Hängt BlueZ bei der
Bearbeitung von `StopDiscovery` (beobachtet auf Pi mit BlueZ 5.66,
reproduziert auch lokal mit BlueZ 5.85 unter dichtem BLE-Umgebungsrauschen
— viele gleichzeitig sichtbare fremde BLE-Geräte in Log-Auszügen), kann
`find_device_by_address()` insgesamt beliebig lange blockieren, weit über
den übergebenen `timeout` hinaus — und da dieser Aufruf innerhalb von
`connect_lock` liegt, blockiert das dann auch alle anderen Geräte auf
unbestimmte Zeit.

**Warum der Watchdog das nicht abgefangen hat**: technisch ungeklärt (der
Watchdog-Mechanismus selbst wurde isoliert getestet und funktioniert
korrekt, auch gegen einen echten blockierenden Syscall in einem anderen
Thread — `os._exit()` aus dem Watchdog-Thread beendet den Prozess
zuverlässig). Denkbar ist ein Zusammenspiel aus Thread-Scheduling unter
Last und der Tatsache, dass `dbus_fast` (das von `bleak` verwendete, reine
Python/asyncio-D-Bus-Binding) den blockierten Call technisch als
awaitbares Future modelliert, das bei Cancellation eigentlich reagieren
sollte — nicht abschließend geklärt, aber durch den Fix unten ohnehin
entschärft.

**Fix**: `run_device()` umschließt jetzt die komplette
discover+connect+settle-Sequenz mit einem expliziten
`asyncio.wait_for(..., timeout=LOCK_TIMEOUT_S)`
(`LOCK_TIMEOUT_S = DISCOVER_TIMEOUT_S + CONNECT_TIMEOUT_S + 15`, aktuell
50s). Läuft dieser äußere Timeout ab, wird der Versuch abgebrochen, der
`connect_lock` durch das reguläre `async with`-Cancellation-Verhalten
freigegeben, und der normale Retry-Mechanismus (`RECONNECT_DELAY_S`)
übernimmt — statt dass ein einzelnes hängendes Gerät alle anderen auf
unbestimmte Zeit blockiert. Der Watchdog bleibt als letzte
Absicherungsebene bestehen (falls doch mal etwas hängt, das selbst
`wait_for`s Cancellation nicht respektiert), ist jetzt aber nicht mehr die
einzige Verteidigungslinie gegen einen hängenden Scanner-Teardown.

**Live verifiziert (Laptop, dichtes BLE-Umfeld, absichtlich provoziert)**:
über 120s hielt `daly-1` durchgehend seine Verbindung, während `daly-2`
mehrfach am 50s-Limit abbrach, erneut versuchte und schließlich erfolgreich
verband — ohne dass `daly-1` davon jemals beeinträchtigt wurde. Das ist
strikt besser als vorher: vor dem Fix hätte ein hängendes `daly-2` in
diesem Szenario potenziell auch `daly-1` für Minuten blockiert.

**Noch offen**: erneuter Pi-4B-Test mit dem Fix, insbesondere ob `daly-1`s
ursprüngliches Flackern jetzt tatsächlich behoben ist.

**Update nach Live-Beobachtung auf dem Pi 4B**: über ~75 Minuten zeigte
sich ein wiederkehrendes Muster aus längeren stabilen Phasen (20-25+
Minuten fehlerfrei) unterbrochen von kürzeren rauen Phasen (5-6 Minuten,
u.a. direkt nach einem Reboot), in denen der Onboard-BLE-Chip
(Broadcom BCM4345C0, per UART angebunden) Discovery-Probleme hat. Das
System erholt sich in jedem Fall von selbst, ohne dass ein Gerät das
andere dauerhaft blockiert und ohne dass SignalKs HTTP-Antwortzeit je
beeinträchtigt wurde. Entscheidung: erstmal so weiterlaufen lassen statt
in einen USB-BLE-Dongle zu investieren; der Fix begrenzt den Schaden
zuverlässig genug.

## Nennkapazität (Ah) aus beiden Protokollen ausgelesen, für `capacity.actual`/`.remaining`/`.timeRemaining` (2026-08-01)

Anlass: der Garmin-Plotter zeigt neben SOC/Spannung/Strom einen
Zeit-Platzhalter an (vermutlich `capacity.timeRemaining` aus PGN 127506),
den wir bisher nicht befüllt haben. Beide BMS-Typen melden ihre aktuelle
volle Ladekapazität (nicht die feste Werks-Nennkapazität — der Wert drfitet
mit Zellalterung/-kalibrierung) bereits im ohnehin abgefragten Antwortframe
mit, wir haben sie bisher nur nicht ausgelesen:

- **Daly (D2-Dialekt)**: Register `0x30`, ×0.1 Ah. Live gegen beide
  Geräte verifiziert: 279.4 Ah (daly-1) und 280.0 Ah (daly-2), passend zu
  den verbauten 280Ah-Zellen. Die leichte Abweichung zwischen den beiden
  sonst baugleichen Geräten bestätigt, dass es der aktuelle Ist-Wert ist,
  nicht ein fester Konstantenwert im Protokoll.
- **JK-BMS (JK02)**: im Cell-Info-Frame (`0x02`) bei Offset `146 +
  FIELD_OFFSET` (also `178` mit unserem verifizierten `FIELD_OFFSET=32`),
  u32 × 0.001 Ah — vom `esphome-jk-bms`-Projekt intern als
  `full_charge_capacity_sensor_` bezeichnet, obwohl der Feldname im
  Protokoll `Nominal_Capacity` lautet. Cross-verifiziert gegen eine
  zweite, unabhängige Fundstelle im Settings-Frame (`0x01`, Offset `130`,
  ohne FIELD_OFFSET) — beide liefern übereinstimmend 105.000 Ah, passend
  zur tatsächlich verbauten JK-Bank (andere/kleinere Zellen als bei den
  Dalys).

`ble_worker.py` liefert das jetzt als `fullChargeCapacityAh` im Reading
zusätzlich zu den bisherigen Feldern. `index.js` rechnet daraus (Ah → Wh
via ×packVoltage → J via ×3600, da SignalKs `capacity.*`-Felder in Joule
sind):
- `capacity.actual` = fullChargeCapacityAh × packVoltage × 3600
- `capacity.remaining` = (soc/100 × fullChargeCapacityAh) × packVoltage × 3600
- `capacity.timeRemaining` = (soc/100 × fullChargeCapacityAh) / |current| × 3600,
  nur bei `current < 0` (Entladung, SignalK-Vorzeichenkonvention) — bei
  Ladung oder Ruhestrom gibt es keine sinnvolle "Zeit bis leer".

Live-verifiziert (Laptop, alle drei Geräte): korrekte Werte in allen drei
Readings, plausible Hochrechnung (z.B. 279Ah bei 99.8% SOC und
hypothetischen 20A Entladestrom → ~13.9h, exakt wie erwartet).

**Noch offen**: Deploy auf den Pi 4B und Sichtprüfung im Garmin-Plotter,
ob der bisherige Zeit-Platzhalter jetzt einen Wert anzeigt.
