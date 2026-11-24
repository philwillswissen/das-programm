# Regeln für die Arbeit an diesem Projekt

## Die wichtigste Regel: die veröffentlichte Datenbank ist tabu

In der D1-Datenbank **`sportkasse`** liegen die echten Einträge der Gruppe.
Sie wurde schon einmal durch Testläufe geleert. Das darf nicht wieder passieren.

**Niemals** gegen `sportkasse`:

- `wrangler d1 execute sportkasse --remote` mit `DELETE`, `DROP`, `UPDATE`,
  `INSERT`, `ALTER` oder `CREATE`
- eine Testsuite laufen lassen, die Daten anlegt oder löscht
- `wrangler d1 time-travel restore` ohne ausdrückliche Zustimmung des Nutzers

Lesen ist erlaubt, und nur über den Wrapper:

```bash
npm run db -- "SELECT count(*) FROM entries"
```

Er lehnt alles ab, was nicht `SELECT`, `PRAGMA`, `EXPLAIN` oder `WITH` ist.
Es gibt dafür **keinen** Schalter. Schemaänderungen macht der Worker selbst
beim Start – siehe `migrate()` und `ALTERS` in `worker.js`.

## Wo getestet wird

| Ziel | Datenbank | Schreiben | Befehl |
|---|---|---|---|
| lokal (`wrangler dev`) | lokale Kopie | ja | `npm test` |
| Probeumgebung | `sportkasse-test` | ja | `npm run test:staging` |
| veröffentlicht | `sportkasse` | **nein** | `npm run test:live` |

Jede schreibende Suite ruft oben `requireScratchTarget(BASE)` aus
`scripts/guard.cjs` auf. Der Riegel bricht ab, sobald `BASE` auf
`das-programm.phil89.workers.dev` zeigt – auch mit gesetzter
`ALLOW_STAGING_WIPE`. Diesen Aufruf nicht entfernen und die Hostliste in
`scripts/guard.cjs` nicht aufweichen.

`npm run test:live` liest ausschließlich: Auslieferung, Caching-Header,
PIN-Schutz, Zustand der Einstellungen.

### Zwei Browser-Engines

Die meisten Oberflächentests laufen in Chromium. `test/iphone.cjs` läuft in
**echtem WebKit** – derselben Engine wie Safari auf dem iPhone. Das ist kein
Luxus: `confirm()` wurde einmal eingebaut und zeigte sich in der installierten
App nicht, der Eintrag verschwand kommentarlos. Chromium im iPhone-Kostüm
hätte das nie gezeigt.

Fehlt WebKit im Container, überspringt sich die Suite selbst. Nachinstallieren:

```bash
node /opt/node-tools/node_modules/playwright/cli.js install-deps webkit
node /opt/node-tools/node_modules/playwright/cli.js install webkit
```

**Keine nativen Dialoge.** `confirm()`, `alert()` und `prompt()` gehören nicht
in diese App – in einer installierten PWA zeigt weder Chrome noch Safari sie
zuverlässig an. Nachfragen laufen über `ask()` (Fenster `#ask`). Drei Suiten
zählen mit, ob doch ein nativer Dialog auftaucht, und schlagen dann fehl.

## Reihenfolge bei neuen Funktionen

1. `npm test` lokal, bis alles grün ist
2. `npm run deploy:staging` und `npm run test:staging`
3. `npm run backup` (läuft bei `npm run deploy` automatisch mit)
4. `npm run deploy`
5. `npm run test:live`

Sicherungen landen in `backups/` und gehören nicht ins Repo.

## Aufbau

| Datei | Inhalt |
|---|---|
| `worker.js` | API, Schema, Auslieferung der Oberfläche, Cron, Push |
| `stats.js` | Abrechnung einer Woche: Strafen, Serie, Guthaben |
| `nudge.js` | Motivationsnachrichten: Zeitfenster, Textbausteine, Wetter |
| `icu.js` | Import über intervals.icu: Zugang, Sportarten, Einheiten |
| `report.js` | Zahlen für die Auswertungsseite, liest `meta` zurück |
| `push.js` | Web Push nach RFC 8291 und 8292, ohne Abhängigkeiten |
| `public/index.html` | die komplette Oberfläche, eine Datei, kein Framework |
| `scripts/guard.cjs` | entscheidet, wogegen schreibende Tests laufen dürfen |
| `test/iphone.cjs` | dieselbe App in echtem WebKit – was hier fällt, fällt auf dem iPhone |

Die Abrechnung läuft **nur** im Worker (`stats.js`). Die Oberfläche zeigt an,
was `/api/state` liefert – sie rechnet nicht selbst, damit Anzeige und
Benachrichtigungen nicht auseinanderlaufen.

## Einheiten an zwei Stellen

Die Formatierung von Distanz, Dauer, Tempo und Anstieg steht zweimal da: in
`icu.js` für den Import und in `public/index.html` für hochgeladene Dateien.
Das ist bewusst – die Oberfläche rechnet offline, der Worker beim Import.
`test/icu.cjs` füttert beide Seiten mit denselben Werten und vergleicht das
Ergebnis. Wer eine Seite ändert, ändert die andere mit, sonst schlägt der
Test fehl.

## Diagramme

Die Reihenfarben (`--s1` bis `--s8` in `public/index.html`) sind die geprüfte
Standardpalette der dataviz-Vorgaben, gegen beide Kartenflächen validiert.
Reihenfolge nicht ändern und nicht durchwechseln – ab neun Reihen zusammenfassen.
Jeder Balken trägt Name und Zahl, damit Farbe nie allein die Bedeutung trägt,
und es gibt zu jedem Diagramm eine Tabellenansicht.

## Secrets

`VAPID_PUBLIC`, `VAPID_PRIVATE`, `VAPID_SUBJECT`, `PIN` liegen als
Worker-Secrets, lokal in `.dev.vars` (nicht im Repo). Für die Probeumgebung
mit `--env staging` gesetzt.
