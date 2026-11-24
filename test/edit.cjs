// Einträge ändern und löschen - über die API und in der App.
const BASE = process.env.BASE || "http://127.0.0.1:8787";
require("../scripts/guard.cjs").requireScratchTarget(BASE);
const PIN = process.env.PIN || "";
const { chromium, devices } = require("/opt/node-tools/node_modules/playwright");
let pass = 0, fail = 0;
const ok = (x, m) => (x ? (pass++, console.log("  ✓ " + m)) : (fail++, console.log("  ✗ " + m)));
const api = (p, method = "GET", body) =>
  fetch(BASE + "/api/" + p, { method, headers: { "content-type": "application/json", "x-pin": PIN },
    body: body ? JSON.stringify(body) : undefined }).then(async (r) => ({ status: r.status, data: await r.json().catch(() => null) }));
const today = () => new Date().toISOString().slice(0, 10);
const gestern = () => new Date(Date.now() - 864e5).toISOString().slice(0, 10);
const entryById = async (id) => (await api("state")).data.entries.find((e) => e.id === id);

(async () => {
  const s0 = await api("state");
  for (const m of s0.data.members) await api("member/" + m.id, "DELETE");
  const anna = (await api("member", "POST", { name: "Anna" })).data.id;
  const ben = (await api("member", "POST", { name: "Ben" })).data.id;

  console.log("\n== Ändern ==");
  const e1 = (await api("entry", "POST", { member_id: anna, date: today(), kind: "workout", sport: "Laufen", note: "zu schnell getippt", device: "x" })).data.id;
  ok((await api("entry/" + e1, "POST", { sport: "Radfahren", note: "doch Rad", date: gestern(), kind: "workout" })).status === 200,
     "Eintrag lässt sich ändern");
  let e = await entryById(e1);
  ok(e.sport === "Radfahren" && e.note === "doch Rad" && e.date === gestern(),
     "Sportart, Kommentar und Datum sind übernommen");

  ok((await api("entry/" + e1, "POST", { kind: "sick", units: 2 })).status === 200, "auch in eine Krankmeldung");
  e = await entryById(e1);
  ok(e.kind === "sick" && e.units === 2, "mit der richtigen Zahl an Einheiten");
  ok(e.sport === null, "die Sportart wird dabei entfernt");

  ok((await api("entry/" + e1, "POST", { kind: "workout", sport: "Yoga" })).status === 200, "und wieder zurück");
  ok((await entryById(e1)).kind === "workout", "Krankmeldung wieder zur Einheit gemacht");
  ok((await api("entry/999999", "POST", { sport: "X" })).status === 404, "unbekannter Eintrag wird abgelehnt");
  await api("entry/" + e1, "POST", { date: "quatsch", sport: "Yoga" });
  ok(/^\d{4}-\d{2}-\d{2}$/.test((await entryById(e1)).date), "ein unsinniges Datum wird ignoriert statt gespeichert");

  console.log("\n== Gemeinsame Einheit ==");
  const grp = await api("entry", "POST", { member_id: anna, date: today(), kind: "workout", sport: "Bouldern", with: [ben], device: "x" });
  const alle = (await api("state")).data.entries.filter((x) => x.sport === "Bouldern");
  ok(alle.length === 2, "zwei Einträge für die gemeinsame Runde");
  const res = await api("entry/" + alle[0].id, "POST", { sport: "Klettern", note: "war doch Klettern", kind: "workout" });
  ok(res.data.changed === "gruppe", "die Änderung betrifft die ganze Gruppe");
  const danach = (await api("state")).data.entries.filter((x) => x.group_id === grp.data && x.group_id);
  const geklettert = (await api("state")).data.entries.filter((x) => x.sport === "Klettern");
  ok(geklettert.length === 2, "beide Einträge sind geändert (" + geklettert.length + ")");
  ok(geklettert.every((x) => x.note === "war doch Klettern"), "auch der Kommentar bei beiden");

  console.log("\n== Löschen ==");
  const e2 = (await api("entry", "POST", { member_id: anna, date: today(), kind: "workout", sport: "Laufen", device: "x" })).data.id;
  ok((await api("entry/" + e2, "DELETE")).status === 200, "Eintrag lässt sich löschen");
  ok(!(await entryById(e2)), "und ist danach weg");
  await api("entry/" + geklettert[0].id, "DELETE");
  ok((await api("state")).data.entries.filter((x) => x.sport === "Klettern").length === 0,
     "beim Löschen einer gemeinsamen Einheit verschwinden beide");

  console.log("\n== In der App ==");
  const browser = await chromium.launch({ args: ["--no-sandbox"] });
  const ctx = await browser.newContext({ ...devices["iPhone 13"], locale: "de-DE" });
  await ctx.addInitScript((v) => { localStorage.pin = v; localStorage.installLater = String(Date.now()); }, PIN);
  const page = await ctx.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  page.on("dialog", (d) => d.accept());
  await page.goto(BASE, { waitUntil: "networkidle" });
  await page.click('button:has-text("Anna")');
  await page.waitForTimeout(400);

  await page.click('nav a[href="#feed"]');
  await page.waitForSelector(".post");
  ok(await page.locator('.post >> nth=0').locator('button[title="Ändern"]').isVisible(), "jeder Eintrag hat einen Ändern-Knopf");
  ok(await page.locator('.post >> nth=0').locator('button[title="Löschen"]').isVisible(), "und einen zum Löschen");

  await page.locator('.post:has-text("Yoga") button[title="Ändern"]').click();
  await page.waitForSelector('h2:has-text("Eintrag ändern")');
  ok(true, "der Ändern-Knopf öffnet das Formular");
  ok(await page.inputValue("#sport") === "Yoga", "die Sportart ist vorbelegt");
  ok(await page.isDisabled("#who"), "die Person lässt sich nachträglich nicht umhängen");
  ok(!(await page.$("#file")), "und es gibt kein Dateifeld mehr");
  ok(!(await page.$('[data-crew]')), "auch keine Mitmacher-Auswahl");

  await page.fill("#sport", "Pilates");
  await page.fill("#note", "in Ruhe nachgetragen");
  await page.click('button:has-text("Änderungen speichern")');
  await page.waitForSelector('.post:has-text("Pilates")');
  ok(true, "die Änderung landet im Feed");
  const geaendert = (await api("state")).data.entries.find((x) => x.sport === "Pilates");
  ok(geaendert && geaendert.note === "in Ruhe nachgetragen", "und steht so in der Datenbank");

  await page.locator('.post:has-text("Pilates") button[title="Ändern"]').click();
  await page.waitForSelector('h2:has-text("Eintrag ändern")');
  await page.click('button:has-text("Abbrechen")');
  await page.waitForSelector(".post");
  ok(await page.isVisible('.post:has-text("Pilates")'), "Abbrechen ändert nichts");

  await page.locator('.post:has-text("Pilates") button[title="Ändern"]').click();
  await page.waitForSelector('h2:has-text("Eintrag ändern")');
  await page.click('button:has-text("Eintrag löschen")');
  await page.waitForTimeout(1200);
  ok(!(await api("state")).data.entries.some((x) => x.sport === "Pilates"), "Löschen aus der Bearbeitung heraus geht auch");

  await page.click('nav a[href="#add"]');
  await page.waitForSelector("#sport");
  ok((await page.textContent('h2')).includes("Neuer Eintrag"), "danach ist das Formular wieder leer für einen neuen Eintrag");
  ok(!!(await page.$("#file")), "und das Dateifeld ist zurück");

  ok(errors.length === 0, "keine JavaScript-Fehler" + (errors.length ? ": " + errors[0] : ""));
  await browser.close();
  console.log(`\n${pass} ok, ${fail} fehlgeschlagen\n`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
