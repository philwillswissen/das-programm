// Auswertungsseite: Rechnung, Darstellung und die Lesbarkeit der Diagramme.
const BASE = process.env.BASE || "http://127.0.0.1:8787";
require("../scripts/guard.cjs").requireScratchTarget(BASE);
const PIN = process.env.PIN || "";
const { chromium, devices } = require("/opt/node-tools/node_modules/playwright");
let pass = 0, fail = 0;
const ok = (x, m) => (x ? (pass++, console.log("  ✓ " + m)) : (fail++, console.log("  ✗ " + m)));
const api = (p, method = "GET", body) =>
  fetch(BASE + "/api/" + p, { method, headers: { "content-type": "application/json", "x-pin": PIN },
    body: body ? JSON.stringify(body) : undefined }).then(async (r) => ({ status: r.status, data: await r.json().catch(() => null) }));

const { parseMeta, report } = require("../report.js");
const day = (back) => new Date(Date.now() - back * 864e5).toISOString().slice(0, 10);

(async () => {
  console.log("\n== Messwerte zurücklesen ==");
  const a = parseMeta(JSON.stringify({ Distanz: "8,20 km", Dauer: "44 min", Anstieg: "116 hm", Puls: "151 bpm", kcal: "540" }));
  ok(a.km === 8.2, "Distanz mit Komma (" + a.km + ")");
  ok(a.secs === 2640, "Dauer in Minuten (" + a.secs + " s)");
  ok(a.climb === 116 && a.hr === 151 && a.kcal === 540, "Anstieg, Puls, Kalorien");
  const b = parseMeta(JSON.stringify({ Dauer: "1:12 h", Distanz: "32,40 km" }));
  ok(b.secs === 4320, "Dauer in Stunden und Minuten (" + b.secs + " s)");
  ok(parseMeta(null).hasData === false, "ohne Messwerte kein hasData");
  ok(parseMeta("kaputt").km === 0, "kaputte Angaben stürzen nicht ab");
  ok(parseMeta(JSON.stringify({ Dauer: "40 min" })).hasData === true, "Dauer allein reicht als Messwert");

  console.log("\n== Rechnung ==");
  const members = [{ id: 1, name: "Anna" }, { id: 2, name: "Ben" }];
  const meta = (km, min) => JSON.stringify({ Distanz: km.toFixed(2).replace(".", ",") + " km", Dauer: min + " min", Anstieg: "50 hm" });
  const entries = [
    { member_id: 1, date: day(1), kind: "workout", sport: "Laufen", meta: meta(10, 60), group_id: null },
    { member_id: 1, date: day(2), kind: "workout", sport: "Laufen", meta: meta(5, 30), group_id: null },
    { member_id: 1, date: day(3), kind: "workout", sport: "Bouldern", meta: null, group_id: "g1" },
    { member_id: 2, date: day(3), kind: "workout", sport: "Bouldern", meta: null, group_id: "g1" },
    { member_id: 2, date: day(9), kind: "workout", sport: "Radfahren", meta: meta(30, 90), group_id: null },
    { member_id: 2, date: day(4), kind: "sick", units: 2, sport: null, meta: null, group_id: null },
  ];
  const r = report({ members, entries, settings: { required: 2, start: day(30) }, today: day(0) });

  ok(r.weeks.length === 12, "zwölf Wochen im Verlauf");
  ok(r.members[1].sessions === 3, "Annas Einheiten (" + r.members[1].sessions + ")");
  ok(r.members[1].km === 15, "Annas Kilometer (" + r.members[1].km + ")");
  ok(r.members[1].hours === 1.5, "Annas Stunden (" + r.members[1].hours + ")");
  ok(r.members[1].withData === 2, "eine Einheit ohne Messwerte wird als solche gezählt");
  ok(r.members[1].sports[0].sport === "Laufen" && r.members[1].sports[0].count === 2, "häufigste Sportart vorn");
  ok(r.members[2].sick === 2, "Krankmeldung zählt getrennt (" + r.members[2].sick + ")");
  ok(!r.members[2].sports.some((s) => s.sport === null), "Krankmeldung taucht nicht als Sportart auf");
  ok(r.team.sessions === 5, "Team-Einheiten (" + r.team.sessions + ")");
  ok(r.team.km === 45, "Team-Kilometer (" + r.team.km + ")");
  ok(r.team.together === 1, "eine gemeinsame Einheit erkannt");
  ok(r.team.perMember.length === 2, "jede Person steht in der Übersicht");
  ok(r.members[1].weekdays.reduce((a, b) => a + b, 0) === 3, "Wochentage summieren sich auf die Einheiten");
  ok(r.team.stacked.length === 12, "gestapelter Verlauf über zwölf Wochen");
  const lastWeek = r.team.stacked[r.team.stacked.length - 1];
  ok(Object.values(lastWeek.byMember).reduce((a, b) => a + b, 0) >= 1, "die laufende Woche ist gefüllt");
  ok(r.members[1].avgMinutes === 45, "Durchschnittsdauer nur aus Einheiten mit Messwerten (" + r.members[1].avgMinutes + ")");
  const leer = report({ members, entries: [], settings: { required: 2, start: day(30) }, today: day(0) });
  ok(leer.team.sessions === 0 && leer.team.sports.length === 0, "ohne Einträge bleibt alles bei null");

  console.log("\n== Erst ab dem Start der Challenge ==");
  const mitAlt = [...entries, { member_id: 1, date: day(40), kind: "workout", sport: "Laufen", meta: meta(20, 100), group_id: null }];
  const spaet = report({ members, entries: mitAlt, settings: { required: 2, start: day(30) }, today: day(0) });
  ok(spaet.members[1].sessions === 3, "was vor dem Start lag, zählt nicht mit (" + spaet.members[1].sessions + ")");
  ok(spaet.team.km === 45, "auch nicht in den Kilometern (" + spaet.team.km + ")");
  const frueh = report({ members, entries: mitAlt, settings: { required: 2, start: day(60) }, today: day(0) });
  ok(frueh.members[1].sessions === 4, "mit früherem Start zählt sie mit (" + frueh.members[1].sessions + ")");
  const mitAelteren = [...mitAlt, { member_id: 1, date: day(20), kind: "workout", sport: "Laufen", meta: meta(7, 40), group_id: null }];
  const alleDabei = report({ members, entries: mitAelteren, settings: { required: 2, start: day(30) }, today: day(0) });
  ok(alleDabei.members[1].sessions === 4, "ohne Beitrittsdatum zählt alles seit dem Start (" + alleDabei.members[1].sessions + ")");
  const spaeterDabei = report({
    members: [{ id: 1, name: "Anna", joined: day(10) }, { id: 2, name: "Ben" }],
    entries: mitAelteren, settings: { required: 2, start: day(30) }, today: day(0),
  });
  ok(spaeterDabei.members[1].sessions === 3, "wer später dazukommt, bekommt die Zeit davor nicht angerechnet (" + spaeterDabei.members[1].sessions + ")");
  ok(spaeterDabei.team.sessions === 6, "in der Gruppe zählt sie trotzdem seit dem Start (" + spaeterDabei.team.sessions + ")");

  console.log("\n== In der App ==");
  const s0 = await api("state");
  for (const m of s0.data.members) await api("member/" + m.id, "DELETE");
  await api("settings", "POST", { start: day(30) });
  const anna = (await api("member", "POST", { name: "Anna", joined: day(30) })).data.id;
  const ben = (await api("member", "POST", { name: "Ben", joined: day(30) })).data.id;
  for (const [mid, sport, km, min, back] of [
    [anna, "Laufen", 10, 60, 1], [anna, "Laufen", 8, 45, 3], [anna, "Bouldern", 0, 90, 8],
    [ben, "Radfahren", 32, 72, 2], [ben, "Schwimmen", 1.5, 30, 5], [ben, "Radfahren", 20, 50, 12],
  ]) {
    await api("entry", "POST", {
      member_id: mid, date: day(back), kind: "workout", sport, device: "x",
      meta: { Distanz: km.toFixed(2).replace(".", ",") + " km", Dauer: min + " min", Anstieg: "80 hm" },
    });
  }

  const browser = await chromium.launch({ args: ["--no-sandbox"] });
  const ctx = await browser.newContext({ ...devices["iPhone 13"], locale: "de-DE" });
  await ctx.addInitScript((v) => { localStorage.pin = v; localStorage.installLater = String(Date.now()); }, PIN);
  const page = await ctx.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  await page.goto(BASE, { waitUntil: "networkidle" });
  await page.click('button:has-text("Anna")');
  await page.waitForTimeout(400);

  await page.click('nav a[href="#stats"]');
  await page.waitForSelector(".tile");
  ok(true, "die Seite „Zahlen“ ist über die Navigation erreichbar");
  const tiles = await page.$$eval(".tile", (els) => els.map((e) => e.textContent.replace(/\s+/g, " ").trim()));
  ok(tiles.length === 4, "vier Kennzahlen oben: " + tiles.join(" | "));
  ok(/^3 ?Einheiten/.test(tiles[0]), "Einheiten stimmen (" + tiles[0] + ")");
  ok(/18 ?Kilometer/.test(tiles[2]), "Kilometer stimmen (" + tiles[2] + ")");

  ok((await page.$$('.card:has(h2:text-is("Einheiten je Woche")) .vbar')).length === 12, "Wochenverlauf zeigt zwölf Säulen");
  ok((await page.$$('.card:has(h2:text-is("Lieblingstage")) .vbar')).length === 7, "Lieblingstage zeigen sieben Säulen");
  const wdLabels = await page.$$eval('.card:has(h2:text-is("Lieblingstage")) .vbar u', e => e.map(x => x.textContent));
  ok(wdLabels.join("") === "MoDiMiDoFrSaSo", "mit Wochentagen beschriftet (" + wdLabels.join(" ") + ")");
  ok(await page.isVisible(".vbars .goal"), "mit gestrichelter Ziellinie");
  const lastCls = await page.locator('.card:has(h2:text-is("Einheiten je Woche")) .vbar i').last().getAttribute("class");
  ok(!/\bq\b/.test(lastCls || ""), "die laufende Woche ist nie grau wie eine verfehlte (" + (lastCls || "grün") + ")");
  const sportRows = await page.$$eval('.card:has(h2:text-is("Sportarten")) .hbar .nm', (e) => e.map((x) => x.textContent.trim()));
  ok(sportRows[0].includes("Laufen"), "häufigste Sportart steht oben (" + sportRows.join(", ") + ")");
  const clipped = await page.$$eval(".hbar .nm", (els) => els.filter((e) => e.scrollWidth > e.clientWidth + 1).map((e) => e.textContent.trim()));
  ok(clipped.length === 0, "kein Name wird abgeschnitten" + (clipped.length ? ": " + clipped.join(", ") : ""));
  ok((await page.$$('.card:has(h2:text-is("Als Tabelle")) tr')).length >= 3, "es gibt auch eine Tabellenansicht");

  await page.click('button:has-text("Team")');
  await page.waitForSelector(".legend b");
  const legend = await page.$$eval(".legend span", (e) => e.map((x) => x.textContent.trim()));
  ok(legend.some((l) => l.includes("Anna")) && legend.some((l) => l.includes("Ben")),
     "im Team hat jede Person ihre Farbe und steht in der Legende");
  ok((await page.$$(".vstack i")).length >= 2, "der Wochenverlauf ist nach Personen gestapelt");
  const teamTiles = await page.$$eval(".tile b", (e) => e.map((x) => x.textContent));
  ok(teamTiles[0] === "6", "Team-Einheiten (" + teamTiles[0] + ")");
  ok(await page.isVisible('.card:has(h2:text-is("Wer wie viel"))'), "und eine Übersicht, wer wie viel gemacht hat");

  console.log("\n== Farbe trägt nie allein ==");
  const barRows = await page.$$eval('.card:has(h2:text-is("Wer wie viel")) .hbar',
    (els) => els.map((e) => ({ name: e.querySelector(".nm").textContent.trim(), value: e.querySelector(".vl").textContent.trim() })));
  ok(barRows.every((r) => r.name && r.value), "jeder Balken hat Namen und Zahl danebenstehen");
  const cols = await page.$$eval(".vbar em", (e) => e.map((x) => x.textContent));
  ok(cols.some((c) => c !== ""), "Säulen tragen ihre Zahl über sich");

  console.log("\n== Antippen ==");
  await page.click('button:has-text("Ich")');
  await page.waitForSelector('.card:has(h2:text-is("Lieblingstage"))');
  await page.locator('.card:has(h2:text-is("Einheiten je Woche")) .vbar').last().click();
  await page.waitForTimeout(250);
  let tip = await page.textContent("#tip");
  ok(await page.evaluate(() => document.getElementById("tip").classList.contains("on")), "ein Tipp auf eine Säule zeigt Details");
  ok(/^Woche ab \d\d\.\d\d\. · \d+ Einheit/.test(tip || ""), "Wochen-Säule nennt die Woche: „" + (tip || "") + "“");
  await page.locator('.card:has(h2:text-is("Lieblingstage")) .vbar').first().click();
  await page.waitForTimeout(250);
  tip = await page.textContent("#tip");
  ok(/^Montag · \d+ Einheit/.test(tip || ""), "Wochentags-Säule nennt den Tag: „" + (tip || "") + "“");

  ok(errors.length === 0, "keine JavaScript-Fehler" + (errors.length ? ": " + errors[0] : ""));
  await browser.close();

  console.log(`\n${pass} ok, ${fail} fehlgeschlagen\n`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
