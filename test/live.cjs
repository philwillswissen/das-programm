// Nur-Lesen-Pruefung gegen die laufende Instanz. Schreibt nichts, loescht nichts.
const BASE = process.env.BASE || "https://das-programm.phil89.workers.dev";
const PIN = process.env.PIN || "";
let pass = 0, fail = 0;
const ok = (x, m) => (x ? (pass++, console.log("  ✓ " + m)) : (fail++, console.log("  ✗ " + m)));

(async () => {
  console.log("\n== Erreichbarkeit ==");
  const page = await fetch(BASE + "/");
  const html = await page.text();
  ok(page.ok && html.includes("Das Programm"), "die App wird ausgeliefert");
  ok(html.includes("icon.svg"), "das App-Zeichen ist eingebunden");

  const mf = await (await fetch(BASE + "/manifest.json")).json();
  ok(mf.name === "Das Programm", "Manifest stimmt");
  ok(mf.icons.filter((i) => i.type === "image/png").length >= 2, "PNG-Icons sind hinterlegt");

  console.log("\n== Zwischenspeicher ==");
  for (const path of ["/icon.svg", "/icon-192.png", "/", "/sw.js"]) {
    const r = await fetch(BASE + path);
    const etag = r.headers.get("etag");
    const cc = r.headers.get("cache-control") || "";
    ok(/no-cache/.test(cc), path + " wird bei jedem Aufruf nachgefragt (" + cc + ")");
    ok(!/immutable|max-age=\d{3,}/.test(cc), path + " liegt nicht dauerhaft im Browser fest");
    if (!etag) continue;   // der Rand entfernt ETags bei komprimierten Antworten
    const again = await fetch(BASE + path, { headers: { "if-none-match": etag } });
    ok(again.status === 304 || again.ok, path + " beantwortet die Rueckfrage (" + again.status + ")");
  }

  console.log("\n== Zugang ==");
  ok((await fetch(BASE + "/api/state", { headers: { "x-pin": "" } })).status === 401, "ohne PIN kein Zugriff");
  if (PIN) {
    const st = await (await fetch(BASE + "/api/state", { headers: { "x-pin": PIN } })).json();
    ok(Array.isArray(st.members), st.members.length + " Teilnehmer in der Datenbank");
    ok(typeof st.vapidPublicKey === "string", "Push-Schluessel wird ausgeliefert");
    ok(st.settings && typeof st.settings.required === "number",
       "Regeln: " + st.settings.required + " Einheiten, " + st.settings.fine + " " + st.settings.currency +
       ", Guthaben " + (st.settings.bonus ? "an" : "aus"));
    ok(Array.isArray(st.entries), st.entries.length + " Eintraege");
  }

  console.log(`\n${pass} ok, ${fail} fehlgeschlagen\n`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
