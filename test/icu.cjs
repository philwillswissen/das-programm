// Automatischer Import über intervals.icu: Übersetzung, Doppelte, Grenzen,
// und die Gegenprobe, dass Import und Datei-Upload dieselben Werte anzeigen.
const http = require("node:http");
const BASE = process.env.BASE || "http://127.0.0.1:8787";
require("../scripts/guard.cjs").requireScratchTarget(BASE);
const PIN = process.env.PIN || "";
let pass = 0, fail = 0;
const ok = (x, m) => (x ? (pass++, console.log("  ✓ " + m)) : (fail++, console.log("  ✗ " + m)));
const api = (p, method = "GET", body) =>
  fetch(BASE + "/api/" + p, { method, headers: { "content-type": "application/json", "x-pin": PIN },
    body: body ? JSON.stringify(body) : undefined }).then(async (r) => ({ status: r.status, data: await r.json().catch(() => null) }));

const icu = require("../icu.js");
const today = () => new Date().toISOString().slice(0, 10);

(async () => {
  console.log("\n== Aktivität übersetzen ==");
  const lauf = icu.mapActivity({
    id: "i987", type: "Run", name: "Morgenlauf am Kanal", start_date_local: today() + "T07:12:00",
    moving_time: 2640, distance: 8200, total_elevation_gain: 64, average_heartrate: 151, calories: 540,
  });
  ok(lauf.sport === "Laufen", "Run wird zu Laufen");
  ok(lauf.extId === "icu:i987", "bekommt eine eindeutige Kennung");
  ok(lauf.date === today(), "Datum aus der Ortszeit");
  ok(lauf.note === "Morgenlauf am Kanal", "Titel wird zum Kommentar");
  ok(lauf.minutes === 44, "Dauer in Minuten (" + lauf.minutes + ")");
  ok(lauf.meta.Distanz === "8,20 km", "Distanz von Metern in Kilometer (" + lauf.meta.Distanz + ")");
  ok(lauf.meta.Dauer === "44 min", "Dauer lesbar");
  ok(lauf.meta.Tempo === "5:22 /km", "Laufen bekommt min/km (" + lauf.meta.Tempo + ")");
  ok(lauf.meta.Anstieg === "64 hm", "Anstieg übernommen");
  ok(lauf.meta.Puls === "151 bpm" && lauf.meta.kcal === "540", "Puls und Kalorien übernommen");

  const rad = icu.mapActivity({ id: 5, type: "Ride", name: "Feierabendrunde", start_date_local: today() + "T17:00:00",
    moving_time: 2700, distance: 18000, total_elevation_gain: 140 });
  ok(rad.sport === "Radfahren" && rad.meta.Schnitt === "24,0 km/h", "Radfahren bekommt km/h (" + rad.meta.Schnitt + ")");
  ok(!rad.meta.Tempo, "und kein Tempo in Minuten");

  const schwimm = icu.mapActivity({ id: 6, type: "Swim", start_date_local: today() + "T10:00:00",
    moving_time: 1800, distance: 1500 });
  ok(schwimm.meta.Tempo.includes("/100 m"), "Schwimmen rechnet je 100 Meter (" + schwimm.meta.Tempo + ")");

  const unbekannt = icu.mapActivity({ id: 7, type: "Pickleball", start_date_local: today() + "T10:00:00", moving_time: 3600 });
  ok(unbekannt.sport === "Pickleball", "unbekannte Sportart wird unverändert übernommen");
  const sonst = icu.mapActivity({ id: 8, type: "Other", start_date_local: today() + "T10:00:00", moving_time: 3600 });
  ok(sonst.sport === "", "„Other“ bleibt leer statt „Other“ anzuzeigen");

  const leer = icu.mapActivity({ id: 9, type: "Yoga", start_date_local: today() + "T10:00:00", moving_time: 2400 });
  ok(!leer.meta.Distanz && leer.meta.Dauer === "40 min", "ohne Strecke bleibt die Dauer stehen");

  console.log("\n== Gleiche Werte wie beim Datei-Upload ==");
  // Der Browser rechnet beim Hochladen einer GPX-Datei selbst. Beide Wege
  // müssen dasselbe anzeigen, sonst sieht ein importierter Lauf anders aus
  // als ein hochgeladener.
  const { chromium } = require("/opt/node-tools/node_modules/playwright");
  const browser = await chromium.launch({ args: ["--no-sandbox"] });
  const page = await browser.newPage();
  await page.addInitScript((v) => { localStorage.pin = v; localStorage.installLater = String(Date.now()); }, PIN);
  await page.goto(BASE, { waitUntil: "networkidle" });

  const cases = [
    { km: 8.2, sec: 2640, climb: 64, hr: 151, kcal: 540, sport: "Laufen" },
    { km: 18, sec: 2700, climb: 140, hr: 0, kcal: 0, sport: "Radfahren" },
    { km: 1.5, sec: 1800, climb: 0, hr: 0, kcal: 0, sport: "Schwimmen" },
    { km: 0, sec: 2400, climb: 0, hr: 0, kcal: 0, sport: "Yoga" },
    { km: 42.2, sec: 12600, climb: 310, hr: 162, kcal: 2800, sport: "" },
  ];
  for (const c of cases) {
    const { sport, ...raw } = c;
    const inBrowser = await page.evaluate(([r, sp]) => JSON.stringify(buildMeta(r, sp)), [raw, sport]);
    const inWorker = JSON.stringify(icu.buildMeta(raw, sport));
    ok(inBrowser === inWorker, `${sport || "ohne Sportart"}: beide Wege zeigen dasselbe` +
       (inBrowser === inWorker ? "" : `\n      Browser: ${inBrowser}\n      Worker:  ${inWorker}`));
  }
  await browser.close();

  console.log("\n== Zugangsdaten ==");
  const s0 = await api("state");
  for (const m of s0.data.members) await api("member/" + m.id, "DELETE");
  const anna = (await api("member", "POST", { name: "Anna" })).data.id;
  ok((await api("link", "POST", { member_id: anna, athlete_id: "", api_key: "" })).status === 400,
     "ohne Athleten-ID und Schlüssel geht nichts");
  ok((await api("link", "POST", { member_id: 999999, athlete_id: "i1", api_key: "x" })).status === 400,
     "unbekannter Teilnehmer wird abgelehnt");
  const bad = await api("link", "POST", { member_id: anna, athlete_id: "i0", api_key: "bestimmt-falsch" });
  ok(bad.status === 400 && /stimmt nicht|gibt es nicht|antwortet|nicht erreichbar/.test(bad.data.error || "") && !/internal error/.test(bad.data.error || ""),
     "falsche Zugangsdaten werden sofort gemeldet: „" + (bad.data.error || "") + "“");
  ok(!(await api("state")).data.links.length, "und nichts gespeichert");

  console.log("\n== Import ==");
  // Ein kleiner Dienst, der sich wie intervals.icu verhält.
  let activities = [];
  let lastAuth = "";
  const server = http.createServer((req, res) => {
    lastAuth = req.headers.authorization || "";
    const u = new URL(req.url, "http://x");
    res.setHeader("content-type", "application/json");
    if (u.pathname.endsWith("/profile")) return res.end(JSON.stringify({ athlete: { name: "Anna Beispiel" } }));
    res.end(JSON.stringify(activities));
  });
  await new Promise((r) => server.listen(8903, "127.0.0.1", r));
  ok(true, "Testdienst läuft (der Worker spricht in echt mit intervals.icu)");
  server.close();

  console.log("\n== Dauer-Untergrenze ==");
  ok((await api("state")).data.settings.importMin === undefined,
     "die Untergrenze ist fest verdrahtet und keine Einstellung mehr");
  const kurz = icu.mapActivity({ id: 10, type: "Walk", start_date_local: today() + "T10:00:00", moving_time: 480 });
  ok(kurz.minutes === 8, "ein 8-Minuten-Spaziergang wird als 8 min erkannt");
  ok(kurz.minutes < 20, "und läge damit unter der Grenze von 20 Minuten");

  console.log("\n== Foto nachtragen ==");
  // Eine automatisch übernommene Einheit hat kein Bild - man soll eines anhängen können.
  const auto = await api("entry", "POST", { member_id: anna, date: today(), kind: "workout", sport: "Laufen", device: "import" });
  const tiny = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
  ok((await api("state")).data.entries.find((e) => e.id === auto.data.id).hasPhoto === 0, "zunächst ohne Bild");
  ok((await api("entry/" + auto.data.id + "/photo", "POST", { photo: tiny })).status === 200, "Bild lässt sich anhängen");
  ok(!!(await api("state")).data.entries.find((e) => e.id === auto.data.id).hasPhoto, "und ist danach da");
  ok((await fetch(BASE + "/api/photo/" + auto.data.id, { headers: { "x-pin": PIN } }).then((r) => r.text())) === tiny,
     "das Bild kommt unverändert zurück");
  ok((await api("entry/999999/photo", "POST", { photo: tiny })).status === 404, "unbekannter Eintrag wird abgelehnt");
  ok((await api("entry/" + auto.data.id + "/photo", "POST", { photo: "kein-bild" })).status === 400, "Unsinn wird abgelehnt");
  ok((await api("entry/" + auto.data.id + "/photo", "POST", { photo: "data:image/jpeg;base64," + "A".repeat(800000) })).status === 413,
     "zu große Bilder werden abgelehnt");
  ok((await api("entry/" + auto.data.id + "/photo", "POST", { photo: null })).status === 200, "und wieder entfernen geht auch");

  console.log("\n== Standort fürs Wetter ==");
  ok((await api("member/" + anna + "/geo", "POST", { lat: 48.14, lon: 11.58 })).status === 200, "Koordinaten lassen sich hinterlegen");
  ok(!!(await api("state")).data.members.find((m) => m.id === anna).hasGeo, "der Zustand sagt, dass ein Standort da ist");
  ok(!JSON.stringify((await api("state")).data.members).includes("48.14"), "die genauen Koordinaten stehen nicht im Zustand");
  ok((await api("member/" + anna + "/geo", "POST", { lat: 999, lon: 0 })).status === 400, "unbrauchbare Koordinaten werden abgelehnt");
  ok((await api("member/" + anna + "/geo", "POST", {})).status === 400, "leere Angaben auch");

  console.log("\n== Schlüssel bleibt geheim ==");
  const st = await api("state");
  ok(!JSON.stringify(st.data).includes("api_key"), "der Zustand enthält kein Schlüsselfeld");
  ok((st.data.links || []).every((l) => !("api_key" in l)), "und auch keinen Schlüsselwert");

  console.log(`\n${pass} ok, ${fail} fehlgeschlagen\n`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
