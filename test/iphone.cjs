// Die App in der echten Safari-Engine (WebKit), nicht in Chromium mit
// iPhone-Kostuem. Was hier faellt, faellt auch auf dem iPhone.
const { webkit, devices } = require("/opt/node-tools/node_modules/playwright");
const BASE = process.env.BASE || "http://127.0.0.1:8787";
require("../scripts/guard.cjs").requireScratchTarget(BASE);
const PIN = process.env.PIN || "";
const FIX = __dirname + "/fixtures/";
let pass = 0, fail = 0;
const ok = (x, m) => (x ? (pass++, console.log("  ✓ " + m)) : (fail++, console.log("  ✗ " + m)));
const api = (p, method = "GET", body) =>
  fetch(BASE + "/api/" + p, { method, headers: { "content-type": "application/json", "x-pin": PIN },
    body: body ? JSON.stringify(body) : undefined }).then(async (r) => ({ status: r.status, data: await r.json().catch(() => null) }));

const monday = (back) => { const d = new Date(); d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7) - 7 * back); return d.toISOString().slice(0, 10); };
const gestern = () => new Date(Date.now() - 864e5).toISOString().slice(0, 10);

// Ändern, Foto und Löschen liegen hinter dem Knopf "Aktionen" am Beitrag.
const act = async (page, text, label) => {
  await page.locator(`.post:has-text("${text}") button[title="Aktionen"]`).first().click();
  await page.waitForSelector("#form.on");
  await page.locator(`#form button:has-text("${label}")`).click();
};
(async () => {
  // WebKit liegt nicht in jedem Container. Fehlt es, sagen wir das und
  // lassen die Suite nicht scheitern - installieren:
  //   node /opt/node-tools/node_modules/playwright/cli.js install webkit
  try { await webkit.executablePath(); } catch { /* unten abgefangen */ }
  const fs = require("node:fs");
  if (!fs.existsSync(webkit.executablePath())) {
    console.log("  – WebKit ist nicht installiert, übersprungen");
    console.log("    node /opt/node-tools/node_modules/playwright/cli.js install webkit");
    process.exit(0);
  }

  const s0 = await api("state");
  for (const m of s0.data.members) await api("member/" + m.id, "DELETE");
  for (const x of s0.data.expenses) await api("expense/" + x.id, "DELETE");
  await api("settings", "POST", { required: 2, fine: 20, currency: "€", sickMax: 2, start: monday(2), bonus: true });
  const anna = (await api("member", "POST", { name: "Anna", joined: monday(2) })).data.id;
  const ben = (await api("member", "POST", { name: "Ben", joined: monday(2) })).data.id;
  for (let i = 0; i < 3; i++)
    await api("entry", "POST", { member_id: ben, date: monday(1), kind: "workout", sport: "Laufen", device: "x" });
  await api("entry", "POST", { member_id: anna, date: gestern(), kind: "workout", sport: "Pilates", device: "x" });

  const browser = await webkit.launch();
  const ctx = await browser.newContext({ ...devices["iPhone 13"], locale: "de-DE", timezoneId: "Europe/Berlin" });
  await ctx.addInitScript((v) => { try { localStorage.pin = v; localStorage.installLater = String(Date.now()); } catch {} }, PIN);
  const page = await ctx.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  page.on("console", (m) => { if (m.type() === "error") errors.push(m.text()); });
  let nativ = 0;
  page.on("dialog", (d) => { nativ++; d.dismiss(); });

  console.log("\n== Laden ==");
  await page.goto(BASE, { waitUntil: "networkidle" });
  ok(await page.title() === "Das Programm", "die Seite lädt in WebKit");
  await page.click('button:has-text("Anna")');
  await page.waitForSelector(".hero");
  ok(true, "Person auswählen funktioniert");
  const hero = (await page.textContent(".hero")).replace(/\s+/g, " ");
  ok(/Guthaben/.test(hero), "die Startseite rechnet: " + hero.trim().slice(0, 70));

  console.log("\n== Rückfrage beim Löschen ==");
  // Genau der Fehler von vorher: confirm() zeigt Safari in der installierten
  // App nicht an. Das eigene Fenster muss da sein.
  await page.click('nav a[href="#feed"]');
  await page.waitForSelector(".post");
  await act(page, "Pilates", "Löschen");
  await page.waitForSelector("#ask.on");
  ok(true, "das Fenster erscheint auch in Safari");
  ok(nativ === 0, "und es ist kein nativer Dialog");
  ok(/Pilates/.test(await page.textContent("#ask")), "es benennt die Einheit");
  await page.click('#ask button:has-text("Abbrechen")');
  await page.waitForFunction(() => !document.getElementById("ask").classList.contains("on"));
  ok((await api("state")).data.entries.some((e) => e.sport === "Pilates"), "Abbrechen löscht nichts");

  console.log("\n== Eintragen ==");
  await page.click('nav a[href="#add"]');
  await page.waitForSelector("#sport");
  await page.fill("#sport", "Klettern");
  await page.waitForSelector("#saveBtn:not([disabled])");
  await page.click("#saveBtn");
  await page.waitForTimeout(1200);
  ok((await api("state")).data.entries.some((e) => e.sport === "Klettern"), "ein Eintrag lässt sich speichern");

  console.log("\n== Datei vom iPhone ==");
  await page.click('nav a[href="#add"]');
  await page.waitForSelector("#file");
  await page.setInputFiles("#file", FIX + "lauf.gpx");
  await page.waitForSelector("#prev .chip");
  const chips = (await page.textContent("#prev")).replace(/\s+/g, " ");
  ok(/km/.test(chips), "GPX wird im Browser ausgewertet: " + chips.trim().slice(0, 60));

  console.log("\n== Zahlen ==");
  await page.click('nav a[href="#stats"]');
  await page.waitForSelector(".vbars .vbar", { timeout: 15000 });
  const zahlen = await page.textContent("#app");
  ok(/Laufen|Pilates|Klettern/.test(zahlen), "die Auswertung zeigt die Sportarten");
  ok((await page.$$(".vbar")).length > 0, "die Säulen sind gezeichnet (" + (await page.$$(".vbar")).length + ")");
  const hoehen = await page.$$eval(".vbar i", (els) => els.map((e) => e.style.height).filter(Boolean));
  ok(hoehen.length > 0, "und sie haben eine Höhe - WebKit rechnet die Prozente aus");
  ok((await page.$$(".tile")).length === 4, "die vier Kennzahlen stehen oben");

  console.log("\n== Einstellungen ==");
  await page.click('nav a[href="#set"]');
  await page.click('a[href="#set/gruppe"]');
  await page.waitForSelector("#req");
  ok(await page.inputValue("#creditSteps") === "1  0,5  0,3", "die Guthaben-Stufen stehen da");
  await page.click('.card:has(h2:has-text("Guthaben")) button.i');
  await page.waitForSelector("#info.on");
  ok(/Einheit/.test(await page.textContent("#info")), "die Erklärungen öffnen sich");
  await page.click("#info button");

  console.log("\n== Push auf dem iPhone ==");
  // iOS kann Web Push erst ab 16.4 und nur in der installierten App. Im
  // Safari-Tab darf die App deshalb nichts Falsches versprechen.
  const pushInfo = await page.evaluate(() => ({
    sw: "serviceWorker" in navigator,
    push: "PushManager" in window,
    standalone: matchMedia("(display-mode: standalone)").matches,
  }));
  console.log("  (WebKit hier: ServiceWorker " + pushInfo.sw + ", PushManager " + pushInfo.push + ")");
  const text = await page.textContent("#app");
  if (!pushInfo.push) {
    ok(!/Benachrichtigungen einschalten/.test(text) || /Startbildschirm/.test(text),
       "ohne Push-Unterstützung wird nichts Unmögliches angeboten");
  } else {
    ok(true, "PushManager vorhanden");
  }

  console.log("\n== Installieren ==");
  const ctx2 = await browser.newContext({ ...devices["iPhone 13"], locale: "de-DE" });
  if (PIN) await ctx2.addInitScript((v) => { try { localStorage.pin = v; } catch {} }, PIN);
  const p2 = await ctx2.newPage();
  await p2.goto(BASE, { waitUntil: "networkidle" });
  // Erst die Frage nach der Person, dann das Installationsfenster - nie beides übereinander.
  await p2.waitForSelector('button:has-text("Anna")');
  ok(!(await p2.evaluate(() => document.getElementById("install").classList.contains("on"))),
     "beim ersten Start liegt kein Installationsfenster über „Wer bist du?“");
  await p2.click('button:has-text("Anna")');
  await p2.waitForSelector("#install.on", { timeout: 8000 });
  const inst = (await p2.textContent("#install")).replace(/\s+/g, " ");
  ok(/Teilen|Startbildschirm/i.test(inst), "iPhone bekommt die Anleitung übers Teilen-Menü: " + inst.trim().slice(0, 80));
  ok(!/Jetzt installieren/.test(inst), "und nicht den Android-Knopf, den Safari nicht hat");
  await ctx2.close();

  console.log("\n== Service Worker ==");
  const reg = await page.evaluate(() =>
    navigator.serviceWorker ? navigator.serviceWorker.getRegistration().then((r) => !!r) : false);
  ok(reg, "der Service Worker ist registriert");

  ok(errors.length === 0, "keine JavaScript-Fehler" + (errors.length ? ": " + errors.slice(0, 2).join(" | ") : ""));
  ok(nativ === 0, "nirgends ein nativer Dialog");
  await browser.close();
  console.log(`\n${pass} ok, ${fail} fehlgeschlagen\n`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
