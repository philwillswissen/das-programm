// Die Kasse: niemand zahlt vorher ein. Wer etwas für die Gruppe bezahlt,
// begleicht damit seine Schulden - und kann dabei auch ins Plus geraten.
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
const today = () => new Date().toISOString().slice(0, 10);

(async () => {
  console.log("\n== Rechnung ==");
  const members = [{ id: 1, name: "Anna" }, { id: 2, name: "Ben" }];
  const settings = { required: 2, fine: 20, sickMax: 2, start: monday(3), bonus: 0 };
  // Anna verpasst zwei Wochen, Ben eine.
  const entries = [{ member_id: 2, date: monday(2), kind: "workout" }, { member_id: 2, date: monday(2), kind: "workout" }];
  const expenses = [
    { id: 1, member_id: 1, amount: 60, date: today(), title: "Grillen" },
    { id: 2, member_id: null, amount: 10, date: today(), title: "Kohle" },
  ];
  const r = settle({ members, entries, expenses, settings, today: today() });

  ok(r[1].owed === 60, "Anna hat 60 € angesammelt (3 verpasste Wochen)");
  ok(r[1].settled === 60, "und 60 € ausgelegt");
  ok(r[1].balance === 0, "ihr Saldo ist ausgeglichen");
  ok(r[2].owed === 40, "Ben hat 40 € angesammelt (" + r[2].owed + ")");
  ok(r[2].settled === 0, "und nichts bezahlt");
  ok(r[2].balance === -40, "er steht mit 40 € in der Kreide");

  const mehr = settle({ members, entries,
    expenses: [{ id: 1, member_id: 1, amount: 95, date: today(), title: "Ausflug" }], settings, today: today() });
  ok(mehr[1].balance === 35, "wer mehr auslegt als fällig war, kommt ins Plus (" + mehr[1].balance + ")");
  ok(mehr[1].owed === 60 && mehr[1].settled === 95, "beide Zahlen bleiben getrennt sichtbar");

  const ohne = settle({ members, entries, settings, today: today() });
  ok(ohne[1].settled === 0 && ohne[1].balance === -60, "ohne Ausgaben schuldet jeder, was er angesammelt hat");

  const krumm = settle({ members, entries,
    expenses: [{ id: 1, member_id: 1, amount: 33.333, date: today(), title: "x" }], settings, today: today() });
  ok(krumm[1].settled === 33.33, "krumme Beträge werden auf Cent gerundet (" + krumm[1].settled + ")");

  console.log("\n== Im Worker ==");
  const s0 = await api("state");
  for (const m of s0.data.members) await api("member/" + m.id, "DELETE");
  for (const x of s0.data.expenses) await api("expense/" + x.id, "DELETE");
  await api("settings", "POST", { required: 2, fine: 20, sickMax: 2, start: monday(3), bonus: false });
  const anna = (await api("member", "POST", { name: "Anna", joined: monday(3) })).data.id;
  const ben = (await api("member", "POST", { name: "Ben", joined: monday(3) })).data.id;

  ok((await api("expense", "POST", { title: "Grillen", amount: 60, member_id: anna })).status === 200,
     "Ausgabe lässt sich auf eine Person buchen");
  let st = (await api("state")).data;
  ok(st.expenses[0].member_id === anna, "die Person steht an der Ausgabe");
  ok(st.stats[anna].settled === 60, "und zählt als gezahlt (" + st.stats[anna].settled + ")");
  ok(st.stats[ben].settled === 0, "nicht bei den anderen");
  ok(st.stats[anna].balance === 60 - st.stats[anna].owed, "der Saldo ergibt sich daraus");

  await api("expense", "POST", { title: "Kohle", amount: 10 });
  st = (await api("state")).data;
  ok(st.expenses.some((x) => !x.member_id), "eine Ausgabe ohne Person ist weiter möglich");
  ok(st.stats[anna].settled === 60, "die zählt niemandem zu");
  ok((await api("expense", "POST", { title: "x", amount: 5, member_id: 999999 })).status === 200,
     "eine unbekannte Person lässt die Buchung nicht scheitern");
  st = (await api("state")).data;
  ok(st.expenses.find((x) => x.title === "x").member_id === null, "sie wird dann niemandem zugeordnet");

  console.log("\n== Teilnehmer löschen ==");
  const chris = (await api("member", "POST", { name: "Chris" })).data.id;
  await api("expense", "POST", { title: "Eis", amount: 7, member_id: chris });
  await api("member/" + chris, "DELETE");
  st = (await api("state")).data;
  ok(st.expenses.some((x) => x.title === "Eis" && x.member_id === null),
     "die Ausgabe bleibt der Gruppe erhalten, nur ohne Person");

  console.log("\n== In der App ==");
  const browser = await chromium.launch({ args: ["--no-sandbox"] });
  const ctx = await browser.newContext({ ...devices["iPhone 13"], locale: "de-DE" });
  await ctx.addInitScript((v) => { localStorage.pin = v; localStorage.installLater = String(Date.now()); }, PIN);
  const page = await ctx.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  await page.goto(BASE, { waitUntil: "networkidle" });
  await page.click('button:has-text("Anna")');
  await page.waitForSelector('h2:has-text("Kasse")');

  const kasse = page.locator('.card:has(h2:has-text("Kasse"))');
  const kopf = await kasse.locator("tr").first().textContent();
  ok(/Angesammelt/.test(kopf) && /Gezahlt/.test(kopf) && /Saldo/.test(kopf),
     "die Startseite zeigt angesammelt, gezahlt und Saldo");
  const annaZeile = (await kasse.locator('tr:has-text("Anna")').textContent()).replace(/\s+/g, " ");
  ok(/60,00/.test(annaZeile), "Annas Zahlen stehen drin: " + annaZeile.trim());
  const benZeile = (await kasse.locator('tr:has-text("Ben")').textContent()).replace(/\s+/g, " ");
  ok(/0,00/.test(benZeile), "Bens auch: " + benZeile.trim());
  await kasse.locator("summary").click();   // Tabelle aller Personen aufklappen
  ok(await kasse.locator('tr:has-text("ohne Person")').isVisible(), "Ausgaben ohne Person stehen in einer eigenen Zeile");

  await page.click('.card:has(h2:has-text("Kasse")) button.i');
  await page.waitForSelector("#info.on");
  const info = await page.textContent("#info");
  ok(/kein(en)? Topf/i.test(info) && /Saldo/.test(info), "das i erklärt, wie die Kasse gemeint ist");
  await page.click("#info button");

  await page.click('nav a[href="#set"]');
  await page.click('a[href="#set/kasse"]');
  await page.waitForSelector("#ep");
  ok((await page.locator("#ep option").count()) >= 3, "beim Buchen lässt sich die Person wählen");
  await page.selectOption("#ep", { label: "Ben" });
  await page.fill("#et", "Pizza");
  await page.fill("#ea", "25");
  await page.click('button:has-text("Buchen")');
  await page.waitForSelector('.item:has-text("Pizza")');
  ok(/bezahlt von Ben/.test(await page.textContent('.item:has-text("Pizza")')), "die Liste zeigt, wer bezahlt hat");
  st = (await api("state")).data;
  ok(st.stats[ben].settled === 25, "und es zählt bei Ben (" + st.stats[ben].settled + ")");

  await page.click('nav a[href="#home"]');
  await page.waitForSelector('h2:has-text("Kasse")');
  ok(/25,00/.test(await kasse.locator('tr:has-text("Ben")').textContent()), "die Startseite zieht sofort nach");

  ok(errors.length === 0, "keine JavaScript-Fehler" + (errors.length ? ": " + errors[0] : ""));
  await browser.close();
  console.log(`\n${pass} ok, ${fail} fehlgeschlagen\n`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
