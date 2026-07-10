# ⛳ Spikegolf Tracker · GKBS / Obiralm

Eine kleine, hübsche **Web-App fürs iPhone**, mit der ihr euer Spikegolf-Turnier
auf der Alm austragen könnt: eigene Kurse mit Hindernissen anlegen, Spieler
verwalten, Schläge zählen und am Ende eine Gesamt-Rangliste über alle Kurse.

Alles läuft **offline** direkt im Browser – ideal, wenn oben am Berg der Empfang
schwach ist. Es gibt keinen Server, keine Anmeldung, keine App-Store-Installation.
Die Daten werden lokal auf dem Handy gespeichert.

## Funktionen

- 👤 **Spieler** anlegen, benennen und mit eigener Farbe versehen
- ⛳ **Kurse** definieren: Start, Ziel, Par (Ziel-Schlagzahl), optional Höhenmeter
- 🗺️ **Luftbild-Karte der Alm**: Start 🚩, Ziel 🏁 und Hindernisse direkt auf dem
  Satellitenbild antippen und platzieren — die Bahn wird als gepunktete Route eingezeichnet
- 🧭 **Karten-Tab**: alle Bahnen nummeriert auf der Karte, Nummer antippen → direkt spielen
- 🌲🏠🪨 **Hindernisse** pro Kurs (Baum, Dach, Stein, Zaun, Wasser, Sonstiges) mit eigener Beschreibung, wahlweise auf der Karte platziert
- 🎯 **Spielen**: pro Kurs die Schläge jedes Spielers mit großen +/− Buttons zählen (auto-gespeichert)
- 🏆 **Rangliste**: Gesamtschläge über alle Kurse pro Person, mit Par-Differenz (wie beim Golf: wenig = gut)
- 📤 **Backup**: Daten exportieren/importieren (JSON) übers ⋯-Menü
- 📱 **PWA**: „Zum Home-Bildschirm hinzufügen" für App-Feeling + Offline-Betrieb

## Auf dem iPhone nutzen

1. Die App über den Hosting-Link (siehe unten) in **Safari** öffnen.
2. Auf **Teilen** → **„Zum Home-Bildschirm"** tippen.
3. Ab jetzt startet Spikegolf wie eine echte App – auch ohne Empfang.

## Hosting (GitHub Pages)

Da die App nur aus statischen Dateien besteht, lässt sie sich kostenlos über
**GitHub Pages** veröffentlichen:

1. Im GitHub-Repo: **Settings → Pages**
2. Bei *Branch* den Branch dieser Dateien wählen (z. B. `main`), Ordner `/ (root)`.
3. Nach ein paar Minuten ist die App unter
   `https://<user>.github.io/<repo>/` erreichbar. Diesen Link am iPhone öffnen.

## Lokal ausprobieren

```bash
python3 -m http.server 8000
# dann http://localhost:8000 im Browser öffnen
```

## Projektstruktur

| Datei | Zweck |
|-------|-------|
| `index.html` | App-Grundgerüst (Tab-Leiste, Bottom-Sheet) |
| `styles.css` | Grünes Alm-Design, mobile-first |
| `app.js` | Gesamte Logik + Datenhaltung (localStorage) |
| `manifest.webmanifest` | PWA-Metadaten (Name, Icons, Farben) |
| `sw.js` | Service Worker für Offline-Betrieb |
| `map.jpg` | Luftbild der Alm (Kartengrundlage) |
| `hero.jpg` | Panorama-Banner (aus dem DJI-Drohnenfoto) |
| `icons/` | App-Icons (180/192/512 px) |
| `tools/make_icons.py` | Erzeugt die Icons (pure Python, ohne Abhängigkeiten) |
| `tools/make_map.mjs` | Schneidet `map.jpg` aus einem Karten-Screenshot zu |
| `tools/test_app.mjs` | End-to-End-Test des kompletten Ablaufs |

## Karte austauschen

Die Positionen werden als **Bruchteile (0–1)** des Bildes gespeichert — `map.jpg`
kann also später durch eine höher aufgelöste Version **desselben Ausschnitts**
ersetzt werden, ohne dass eingezeichnete Kurse verrutschen. Einfach neue Datei
als `map.jpg` ablegen (und in `app.js` ggf. `MAP.aspect` = Höhe/Breite anpassen).

## Ideen für später

- 🖼️ Höher aufgelöstes Luftbild als Kartengrundlage
- ⛰️ Echte **Elevation/GPS** – Höhenmeter automatisch bestimmen
- 📊 Verlauf mehrerer Turniere / Historie
- 🔗 Ergebnisse als Bild teilen
