// Rangliste: geschaffte Wochen, Serie, Rekord - und das Sortieren.
// Medaillen gehen immer nach geschafften Wochen, egal wonach sortiert ist.
const { settle } = require("../stats.js");
const BASE = process.env.BASE || "http://127.0.0.1:8787";
require("../scripts/guard.cjs").requireScratchTarget(BASE);
const PIN = process.env.PIN || "";
const { chromium, devices } = require("/opt/node-tools/node_modules/playwright");
let pass = 0, fail = 0;
const ok = (x, m) => (x ? (pass++, console.log("  ✓ " + m)) : (fail++, console.log("  ✗ " + m)));
const api = (p, method = "GET", body) =>
  fetch(BASE + "/api/" + p, { method, headers: { "content-type": "application/json", "x-pin": PIN },
    body: body ? JSON.stringify(body) : undefined }).then(async (r) => ({ status: r.status, data: await r.json().catch(() => null) }));

const monday = (back) => { const d = new Date(); d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7) - 7 * back); return d.toISOString().slice(0, 10); };

(async () => {
  console.log("\n== Wochen und Serien ==");
  const M = [{ id: 1, name: "A", joined: monday(5) }];
  const settings = { required: 2, fine: 20, sickMax: 2, start: monday(5), bonus: 0 };
  // Muster über fünf abgeschlossene Wochen, dann die laufende.
  const bauen = (muster) => {
    const e = [];
    muster.forEach((voll, i) => {
      const date = monday(muster.length - 1 - i);
      for (let k = 0; k < (voll ? 2 : 1); k++) e.push({ member_id: 1, date, kind: "workout" });
    });
    return e;
  };
  const lauf = (muster) => settle({ members: M, entries: bauen(muster), settings, today: new Date().toISOString().slice(0, 10) })[1];

  let r = lauf([true, true, true, true, false, false]);
  ok(r.weeksDone === 4, "vier von sechs Wochen geschafft (" + r.weeksDone + "/" + r.weeks + ")");
  ok(r.bestStreak === 4, "der Rekord ist die längste Serie (" + r.bestStreak + ")");
  ok(r.streak === 0, "die aktuelle Serie ist gerissen (" + r.streak + ")");

  r = lauf([true, false, true, true, true, true]);
  ok(r.streak === 4 && r.bestStreak === 4, "eine laufende Serie zählt mit (" + r.streak + "/" + r.bestStreak + ")");
  r = lauf([false, false, false, false, false, false]);
  ok(r.weeksDone === 0 && r.bestStreak === 0, "wer nie durchkommt, hat keinen Rekord");
  r = lauf([true, true, true, true, true, true]);
  ok(r.weeksDone === 5 && r.weeks === 5, "wer immer durchkommt, hat alle abgeschlossenen Wochen (" + r.weeksDone + "/" + r.weeks + ")");
  ok(r.bestStreak === 6 && r.streak === 6, "die laufende Woche zählt in der Serie schon mit (" + r.streak + ")");

  console.log("\n== In der App ==");
  const s0 = await api("state");
  for (const m of s0.data.members) await api("member/" + m.id, "DELETE");
  for (const x of s0.data.expenses) await api("expense/" + x.id, "DELETE");
  await api("settings", "POST", { required: 2, fine: 20, sickMax: 2, start: monday(3), bonus: false });

  // Anna: wenige Wochen, aber viele Einheiten. Ben: mehr Wochen, weniger Einheiten.
  const anna = (await api("member", "POST", { name: "Anna", joined: monday(3) })).data.id;
  const ben = (await api("member", "POST", { name: "Ben", joined: monday(3) })).data.id;
  const eintrag = (id, back, n) => Promise.all(Array.from({ length: n }, () =>
    api("entry", "POST", { member_id: id, date: monday(back), kind: "workout", sport: "Laufen", device: "x" })));
  await eintrag(anna, 3, 8);          // eine Woche, viele Einheiten
  for (const b of [3, 2, 1]) await eintrag(ben, b, 2);   // drei Wochen sauber durch

  const st = (await api("state")).data.stats;
  ok(st[anna].sessions === 8 && st[anna].weeksDone === 1, "Anna: viele Einheiten, eine Woche");
  ok(st[ben].sessions === 6 && st[ben].weeksDone === 3, "Ben: weniger Einheiten, drei Wochen");
  ok(st[ben].bestStreak === 3, "Bens Rekord steht bei 3 (" + st[ben].bestStreak + ")");

  const browser = await chromium.launch({ args: ["--no-sandbox"] });
  const ctx = await browser.newContext({ ...devices["iPhone 13"], locale: "de-DE" });
  await ctx.addInitScript((v) => { localStorage.pin = v; localStorage.installLater = String(Date.now()); }, PIN);
  const page = await ctx.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  await page.goto(BASE, { waitUntil: "networkidle" });
  await page.click('button:has-text("Anna")');
  const karte = page.locator('.card:has(h2:has-text("Rangliste"))');
  await karte.waitFor();

  const kopf = (await karte.locator("tr").first().textContent()).replace(/\s+/g, " ");
  ok(/Wochen/.test(kopf) && /Einheiten/.test(kopf) && /Rekord/.test(kopf), "die Spalten stehen da: " + kopf.trim());
  ok(!/Angesammelt|€/.test(kopf), "die Euro-Spalte ist weg");

  const zeilen = () => karte.locator("tr:not(:first-child)").allTextContents()
    .then((xs) => xs.map((x) => x.replace(/\s+/g, " ").trim()));
  let z = await zeilen();
  ok(/^🥇 Ben/.test(z[0]), "Standard: Ben führt mit den meisten geschafften Wochen (" + z[0] + ")");
  ok(/3\/3/.test(z[0]), "seine geschafften und gesamten Wochen stehen zusammen (" + z[0] + ")");
  ok(/^🥈 Anna/.test(z[1]), "Anna ist Zweite (" + z[1] + ")");

  await karte.locator('th:has-text("Einheiten")').click();
  z = await zeilen();
  ok(/Anna/.test(z[0]), "nach Einheiten sortiert steht Anna oben (" + z[0] + ")");
  ok(/^🥈 Anna/.test(z[0]) && /^🥇 Ben/.test(z[1]),
     "die Medaillen bleiben trotzdem an den geschafften Wochen (" + z[0] + " | " + z[1] + ")");

  await karte.locator('th:has-text("Einheiten")').click();
  z = await zeilen();
  ok(/Ben/.test(z[0]), "ein zweiter Tipp dreht die Richtung (" + z[0] + ")");

  await karte.locator('th:has-text("Rekord")').click();
  z = await zeilen();
  ok(/Ben/.test(z[0]), "nach Rekord sortiert führt Ben");

  ok(errors.length === 0, "keine JavaScript-Fehler" + (errors.length ? ": " + errors[0] : ""));
  await browser.close();
  console.log(`\n${pass} ok, ${fail} fehlgeschlagen\n`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
