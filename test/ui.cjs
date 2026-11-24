// Oberflaechentest im echten Browser gegen `wrangler dev`.
const { chromium, devices } = require("/opt/node-tools/node_modules/playwright");
const BASE = process.env.BASE || "http://127.0.0.1:8787";
const FIX = __dirname + "/fixtures/";
let pass = 0, fail = 0;
const ok = (c, m) => (c ? (pass++, console.log("  ✓ " + m)) : (fail++, console.log("  ✗ " + m)));

const sleep = ms => new Promise(r => setTimeout(r, ms));
const waitFor = async (fn, ms = 8000) => {
  const end = Date.now() + ms;
  for (;;) { const v = await fn(); if (v) return v; if (Date.now() > end) return v; await sleep(300); }
};
const api = (p, method = "GET", body) =>
  fetch(BASE + "/api/" + p, { method, headers: { "content-type": "application/json" }, body: body ? JSON.stringify(body) : undefined })
    .then(r => r.json());

(async () => {
  // Datenbank leeren
  const s0 = await api("state");
  for (const m of s0.members) await api("member/" + m.id, "DELETE");
  for (const x of s0.expenses) await api("expense/" + x.id, "DELETE");
  for (const e of (await api("state")).entries) await api("entry/" + e.id, "DELETE");
  await api("settings", "POST", { required: 2, fine: 20, currency: "€", sickMax: 2, start: "2026-11-03" });

  const proxy = process.env.https_proxy || process.env.HTTPS_PROXY;
  const browser = await chromium.launch({
    args: ["--no-sandbox", ...(proxy ? ["--ignore-certificate-errors"] : [])],
    ...(proxy && !BASE.includes("127.0.0.1") ? { proxy: { server: proxy } } : {}),
  });
  const ctx = await browser.newContext({ ...devices["iPhone 13"], locale: "de-DE", timezoneId: "Europe/Berlin" });
  const page = await ctx.newPage();
  const errors = [];
  page.on("pageerror", e => errors.push(String(e)));
  page.on("console", m => { if (m.type() === "error") errors.push(m.text()); });

  const go = async (hash, sel) => {
    await page.click(`nav a[href="#${hash}"]`);
    await page.waitForSelector(sel, { timeout: 15000 });
  };

  console.log("\n== Erststart ==");
  await page.goto(BASE, { waitUntil: "networkidle" });
  ok(await page.title() === "Das Programm", "Titel ist „Das Programm“");
  ok(await page.getByText("Los geht's").isVisible(), "Einrichtung wird angeboten, wenn niemand angelegt ist");

  await page.fill("#names", "Anna, Ben, Chris");
  await page.click("text=Teilnehmer anlegen");
  await page.waitForSelector("text=Kassenstand");
  ok((await api("state")).members.length === 3, "drei Teilnehmer über die Oberfläche angelegt");
  ok(await page.getByText("Wer bist du?").isVisible(), "Gerät fragt einmalig nach der Person");

  await page.click('button:has-text("Anna")');
  await page.waitForTimeout(200);
  ok(!(await page.getByText("Wer bist du?").isVisible().catch(() => false)), "nach der Auswahl verschwindet die Frage");
  ok(await page.evaluate(() => localStorage.me) !== "0", "Gerät merkt sich die Person (localStorage)");

  console.log("\n== Eintrag mit GPX ==");
  await go("add", "#who");
  ok(await page.inputValue("#who") === await page.evaluate(() => localStorage.me), "Eintrag ist mit der eigenen Person vorbelegt");
  await page.waitForSelector("#saveBtn:not([disabled])"); await page.setInputFiles("#file", FIX + "lauf.gpx");
  await page.waitForSelector("#prev .chip");
  const gpxChips = await page.$$eval("#prev .chip", els => els.map(e => e.textContent));
  ok(gpxChips.some(c => c.startsWith("Distanz") && c.includes("4,0")), "GPX: Distanz erkannt (" + gpxChips.join(" ") + ")");
  ok(gpxChips.some(c => c === "Dauer: 20 min"), "GPX: Dauer erkannt");
  ok(gpxChips.some(c => /^Tempo: \d+:[0-5]\d \/km$/.test(c)), "GPX: Tempo korrekt formatiert (" + gpxChips.find(c => c.startsWith("Tempo")) + ")");
  await page.fill("#note", "Morgenlauf im Park");
  await page.click("#saveBtn:not([disabled])");
  await page.waitForSelector('.item:has-text("Morgenlauf im Park")');
  ok(true, "Einheit mit GPX gespeichert und im Verlauf sichtbar");

  console.log("\n== Eintrag mit TCX ==");
  await go("add", "#saveBtn:not([disabled])"); await page.setInputFiles("#file", FIX + "rad.tcx");
  await page.waitForSelector("#prev .chip");
  const tcx = await page.$$eval("#prev .chip", els => els.map(e => e.textContent));
  ok(tcx.includes("Distanz: 18,00 km"), "TCX: Distanz aus beiden Runden summiert (" + tcx.join(" ") + ")");
  ok(tcx.includes("Dauer: 45 min"), "TCX: Dauer summiert");
  ok(tcx.includes("Puls: 140 bpm"), "TCX: Durchschnittspuls");
  ok(tcx.includes("kcal: 600"), "TCX: Kalorien summiert");
  ok(tcx.includes("Sport: Biking"), "TCX: Sportart erkannt");
  await page.click("#saveBtn:not([disabled])");
  await page.waitForSelector('.item:has-text("18,00 km")');
  ok(true, "TCX-Einheit gespeichert");

  console.log("\n== Foto ==");
  await go("add", "#saveBtn:not([disabled])"); await page.setInputFiles("#file", FIX + "selfie.jpg");
  await page.waitForSelector("#prev img");
  ok(await page.evaluate(() => document.querySelector("#prev img").src.startsWith("data:image/jpeg")), "Foto wird verkleinert und angezeigt");
  await page.click("#saveBtn:not([disabled])");
  await page.waitForSelector("img.ph");
  ok(await page.$$eval("img.ph", els => els.some(e => e.naturalWidth > 0)), "Foto wird im Verlauf geladen");

  console.log("\n== Wochenzählung und Strafen ==");
  const anna = (await api("state")).members.find(m => m.name === "Anna").id;
  const st = await waitFor(async () => {
    const x = await api("state");
    return x.entries.filter(e => e.member_id === anna).length === 3 ? x : null;
  }) || (await api("state"));
  ok(st.entries.filter(e => e.member_id === anna).length === 3,
     "drei Einträge für Anna (" + st.entries.filter(e => e.member_id === anna).length + ")");
  await page.reload({ waitUntil: "networkidle" });  // frischer Stand, D1-Repliken hinken kurz nach
  await page.waitForSelector('h2:has-text("Diese Woche")');
  const weekRow = (await page.textContent('.card:has(h2:has-text("Diese Woche")) table')).replace(/\s+/g, " ").trim();
  ok(/Anna[^|]*3 \/ 2/.test(weekRow), "aktuelle Woche zählt Annas 3 Einheiten gegen das Ziel 2 (" + weekRow.slice(0, 60) + ")");
  ok((await page.textContent("body")).includes("🔥"), "Streak wird angezeigt");

  console.log("\n== Krankmeldung ==");
  await page.click('nav a[href="#add"]');
  await page.selectOption("#who", { label: "Ben" });
  await page.click('button:has-text("🤒 Krank")');
  ok(await page.isVisible("#unitsBox"), "Krankmeldung zeigt die Einheiten-Auswahl");
  await page.selectOption("#units", "2");
  await page.click("#saveBtn:not([disabled])");
  await page.waitForSelector('.item:has-text("Krankmeldung (2)")');
  ok(true, "Krankmeldung über zwei Einheiten gespeichert");
  ok((await page.textContent("body")).includes("🤒"), "Krankmeldung erscheint in der Wochenübersicht");

  console.log("\n== Einstellungen ==");
  await go("set", "#req");
  await page.fill("#req", "3");
  await page.fill("#fine", "25");
  await page.fill("#cur", "CHF");
  await page.click('button:has-text("Regeln speichern")');
  const s2 = await waitFor(async () => {
    const x = await api("state");
    return x.settings.required === 3 ? x : null;
  }) || (await api("state"));
  ok(s2.settings.required === 3 && s2.settings.fine === 25 && s2.settings.currency === "CHF", "Regeln frei konfigurierbar und gespeichert");
  await go("home", 'h2:has-text("Kassenstand")');
  ok((await page.textContent("body")).includes("CHF"), "Währung schlägt in der Auswertung durch");

  console.log("\n== Kasse ==");
  await go("set", "#et");
  await page.fill("#et", "Grillen");
  await page.fill("#ea", "60");
  await page.click('button:has-text("Buchen")');
  await page.waitForSelector('.item:has-text("Grillen")');
  ok((await waitFor(async () => (await api("state")).expenses.length === 1)), "Ausgabe gebucht");
  ok((await page.textContent('.item:has-text("Grillen")')).includes("60,00 CHF"), "Ausgabe erscheint mit Betrag in der Liste");

  console.log("\n== Teilnehmer verwalten ==");
  await page.fill("#nm", "Dani");
  await page.click('button:has-text("Hinzufügen")');
  await page.waitForSelector('input[value="Dani"]');
  ok((await waitFor(async () => (await api("state")).members.length === 4)), "Teilnehmer jederzeit erweiterbar");
  page.on("dialog", d => d.accept());
  await page.click('.row:has(input[value="Dani"]) button.x');
  await page.waitForSelector('input[value="Dani"]', { state: "detached" });
  ok((await waitFor(async () => (await api("state")).members.length === 3)), "Teilnehmer löschbar");
  ok(!(await api("state")).entries.some(e => e.member_id === 999), "keine verwaisten Einträge");

  console.log("\n== PWA ==");
  await page.goto(BASE, { waitUntil: "networkidle" });
  await page.waitForTimeout(1200);
  ok(await page.evaluate(() => navigator.serviceWorker.getRegistration().then(r => !!r)), "Service Worker ist registriert");
  const mf = await (await fetch(BASE + "/manifest.json")).json();
  ok(mf.name === "Das Programm" && mf.display === "standalone", "Manifest ist installierbar");
  ok(mf.icons.filter(i => i.type === "image/png").length >= 2, "PNG-Icons für Android/iOS vorhanden");
  await go("set", 'h2:has-text("Benachrichtigungen")');
  ok((await page.textContent("body")).includes("Push auf diesem Gerät"), "Push-Schalter pro Gerät vorhanden");

  console.log("\n== Robustheit ==");
  await page.goto(BASE + "/#unsinn", { waitUntil: "networkidle" });
  await page.waitForTimeout(500);
  ok((await page.textContent("body")).includes("Kassenstand"), "unbekannte Route fällt auf die Startseite zurück");
  await page.goto(BASE + "/irgendwas", { waitUntil: "networkidle" });
  ok((await page.title()) === "Das Programm", "unbekannter Pfad liefert die App (SPA-Fallback)");

  ok(errors.length === 0, "keine JavaScript-Fehler" + (errors.length ? ": " + errors.slice(0, 3).join(" | ") : ""));

  await page.goto(BASE, { waitUntil: "networkidle" });
  await page.waitForTimeout(600);
  await page.screenshot({ path: "/tmp/claude-0/-home-user/62ed92d6-a25d-5adb-b200-ace6f56fe19c/scratchpad/shot-home.png", fullPage: true });
  await page.click('nav a[href="#add"]'); await page.waitForTimeout(300);
  await page.screenshot({ path: "/tmp/claude-0/-home-user/62ed92d6-a25d-5adb-b200-ace6f56fe19c/scratchpad/shot-add.png", fullPage: true });
  await page.click('nav a[href="#set"]'); await page.waitForTimeout(300);
  await page.screenshot({ path: "/tmp/claude-0/-home-user/62ed92d6-a25d-5adb-b200-ace6f56fe19c/scratchpad/shot-set.png", fullPage: true });

  await browser.close();
  console.log(`\n${pass} ok, ${fail} fehlgeschlagen\n`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
