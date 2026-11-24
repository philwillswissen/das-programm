# Das Programm

Die Sport-Challenge mit gemeinsamer Kasse – als PWA auf Cloudflare Workers + D1.

**Live:** https://das-programm.phil89.workers.dev

Jede Woche eine feste Zahl Sporteinheiten. Wer sie nicht schafft, zahlt in die
gemeinsame Kasse. Von dem Geld gibt es dann Grillen, Ausflüge oder was sonst ansteht.

## Was die App kann

- **Start** – ganz oben die eigene Serie und was diese Woche noch fehlt, darunter
  die laufende Woche, die letzten vier Wochen, die Rangliste und der Kassenstand.
  Solange Push auf dem Gerät aus ist, steht dort eine Aufforderung zum Einschalten.
- **Feed** – nach Tagen gruppiert: wer wann was gemacht hat, mit Kommentar, Foto und
  den Werten aus einer hochgeladenen GPX- oder TCX-Datei.
- **Eintrag** – Person, Sporteinheit oder Krankmeldung, Datum, Kommentar, dazu optional
  ein Foto oder eine Aktivitätsdatei (**GPX** und **TCX** aus Strava, Garmin, Komoot).
  Distanz, Dauer, Tempo, Puls und Kalorien werden daraus übernommen. Die Sportart
  wählst du aus rund 90 Vorschlägen oder tippst sie frei ein; aus der Datei wird sie
  automatisch erkannt.
- **Push** – Alle anderen Geräte bekommen eine Benachrichtigung, sobald jemand etwas
  einträgt. Pro Gerät an- und abschaltbar, mit Testbenachrichtigung. Wer selbst noch
  hinterherhinkt, bekommt ab Wochenmitte einen kurzen Zusatz angehängt.
- **Anstupser** – Ein stündlicher Cron-Trigger prüft, wer zurückliegt. Mitte der Woche
  (mal Mittwoch, mal Donnerstag), zum Wochenende (Freitag oder Samstag) und am Sonntag
  als letzte Chance. Der Text richtet sich nach Serie, Lieblingssportarten, Gruppenlage
  und – wenn ein Ort hinterlegt ist – nach dem Wetter von Open-Meteo. Höchstens einmal
  je Art und Woche.
- **Guthaben** (abschaltbar, standardmäßig aus) – Jede Einheit über dem Wochenziel
  gibt ein Guthaben. Fehlt später eine Einheit, springen davon automatisch welche ein
  (Standard: 3 je Einheit, einstellbar). Eine ganze Woche lässt sich nie decken: mindestens
  ein eigener Eintrag – Sport oder Krankmeldung – muss stehen. Gesammelt wird erst ab dem
  Tag, an dem die Regel eingeschaltet wurde. Sonntagabends sagt die App Bescheid, wenn das
  Guthaben die Woche trägt – als Benachrichtigung und als Eintrag im Feed.
- **Gemeinsam** – Beim Eintragen lässt sich ankreuzen, wer noch dabei war; einer
  dokumentiert, alle bekommen die Einheit. Im Feed stehen diese als ein Beitrag.
  Aus dem Feed heraus kann man eine gemeinsame Einheit vorschlagen, die anderen
  bekommen die Frage als Benachrichtigung und sagen per Knopf zu.
- **Einstellungen** – Einheiten pro Woche, Strafbetrag, Währung, Startdatum, wie viele
  Einheiten eine Krankmeldung ersetzt, Teilnehmer (samt „dabei seit") und Ausgaben
  aus der Kasse. Alles frei konfigurierbar.
- **Ohne Profil** – Das Handy merkt sich einmalig, wer du bist. Kein Login, kein Konto.
- **Installation** – Beim ersten Öffnen bietet die App sich selbst zur Installation an:
  auf Android über den nativen Dialog, auf dem iPhone mit der Anleitung für Safari.
- **Gruppen-PIN** – Ist das Secret `PIN` gesetzt, fragt die App einmal pro Gerät danach.
  Groß- und Kleinschreibung spielt keine Rolle.

## Aufbau

| Datei | Inhalt |
|---|---|
| `worker.js` | API, D1-Schema, Auslieferung der Oberfläche, Push-Versand |
| `stats.js` | Abrechnung einer Woche: Strafen, Serie, Guthaben |
| `nudge.js` | Motivationsnachrichten: Zeitfenster, Textbausteine, Wetter |
| `push.js` | Web Push nach RFC 8291 (aes128gcm) und RFC 8292 (VAPID), ohne Abhängigkeiten |
| `public/index.html` | die komplette Oberfläche (eine Datei, kein Framework) |
| `public/sw.js` | Service Worker: Offline-Cache und Benachrichtigungen |
| `test/` | API-, Push- und Browsertests |

Oberfläche und Icons liegen im Worker-Bundle, es gibt also nur ein Deployment-Artefakt
(ca. 105 KB).

## Entwicklung

```bash
npm install
cp .dev.vars.example .dev.vars   # eigene VAPID-Keys eintragen, siehe unten
npx wrangler dev
```

Tests gegen den laufenden `wrangler dev` (272 Prüfungen):

```bash
npm test
```

Einzeln: `test/run.mjs` (API), `test/push.test.mjs` (Verschlüsselung gegen den
Testvektor aus RFC 8291), `test/push-e2e.cjs` (Push von Ende zu Ende mit einem
lokalen Push-Dienst), `test/ui.cjs` (Oberfläche im echten Browser).

Gegen die Live-Instanz: `BASE=https://das-programm.phil89.workers.dev npm test`.

## Deployment

```bash
npx wrangler d1 create sportkasse        # database_id in wrangler.toml eintragen
npx wrangler secret put VAPID_PUBLIC
npx wrangler secret put VAPID_PRIVATE
npx wrangler secret put VAPID_SUBJECT    # z. B. mailto:du@example.com
npx wrangler deploy
```

Neue VAPID-Keys erzeugen:

```bash
node -e 'const{webcrypto:c}=require("crypto");const b=x=>Buffer.from(x).toString("base64url");(async()=>{const k=await c.subtle.generateKey({name:"ECDSA",namedCurve:"P-256"},true,["sign"]);console.log("VAPID_PUBLIC="+b(await c.subtle.exportKey("raw",k.publicKey)));console.log("VAPID_PRIVATE="+(await c.subtle.exportKey("jwk",k.privateKey)).d)})()'
```

Optional lässt sich die Gruppe mit einer gemeinsamen PIN schützen:
`npx wrangler secret put PIN`. Die Tests brauchen sie dann als `PIN=… npm test`.

## Hinweise

- **iPhone/iPad:** Push geht erst, wenn die App über „Teilen → Zum Home-Bildschirm"
  installiert und von dort geöffnet wurde (iOS 16.4+).
- Fotos werden im Browser auf max. 1100 px verkleinert und liegen in D1.
