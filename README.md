# Das Programm

Die Sport-Challenge mit gemeinsamer Kasse – als PWA auf Cloudflare Workers + D1.

**Live:** https://das-programm.phil89.workers.dev

Jede Woche eine feste Zahl Sporteinheiten. Wer sie nicht schafft, zahlt in die
gemeinsame Kasse. Von dem Geld gibt es dann Grillen, Ausflüge oder was sonst ansteht.

## Was die App kann

- **Start** – Kassenstand, laufende Woche mit Fortschritt und Streak, letzte vier Wochen,
  Rangliste und Verlauf aller Einträge.
- **Eintrag** – Person, Sporteinheit oder Krankmeldung, Datum, Kommentar, dazu optional
  ein Foto oder eine Aktivitätsdatei (**GPX** und **TCX** aus Strava, Garmin, Komoot).
  Distanz, Dauer, Tempo, Puls und Kalorien werden daraus übernommen.
- **Push** – Alle anderen Geräte bekommen eine Benachrichtigung, sobald jemand etwas
  einträgt. Pro Gerät an- und abschaltbar, mit Testbenachrichtigung.
- **Einstellungen** – Einheiten pro Woche, Strafbetrag, Währung, Startdatum, wie viele
  Einheiten eine Krankmeldung ersetzt, Teilnehmer (samt „dabei seit") und Ausgaben
  aus der Kasse. Alles frei konfigurierbar.
- **Ohne Profil** – Das Handy merkt sich einmalig, wer du bist. Kein Login, kein Konto.

## Aufbau

| Datei | Inhalt |
|---|---|
| `worker.js` | API, D1-Schema, Auslieferung der Oberfläche, Push-Versand |
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

Tests gegen den laufenden `wrangler dev`:

```bash
node test/run.mjs        # API
node test/push.test.mjs  # Verschlüsselung gegen den RFC-8291-Testvektor
node test/push-e2e.cjs   # Push von Ende zu Ende
node test/ui.cjs         # Oberfläche im echten Browser
```

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
`npx wrangler secret put PIN`.

## Hinweise

- **iPhone/iPad:** Push geht erst, wenn die App über „Teilen → Zum Home-Bildschirm"
  installiert und von dort geöffnet wurde (iOS 16.4+).
- Fotos werden im Browser auf max. 1100 px verkleinert und liegen in D1.
