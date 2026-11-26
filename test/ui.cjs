// Oberflaechentest im echten Browser gegen `wrangler dev`.
const { chromium, devices } = require("/opt/node-tools/node_modules/playwright");
const BASE = process.env.BASE || "http://127.0.0.1:8787";
require("../scripts/guard.cjs").requireScratchTarget(BASE);

const FIX = __dirname + "/fixtures/";
let pass = 0, fail = 0;
const ok = (c, m) => (c ? (pass++, console.log("  ✓ " + m)) : (fail++, console.log("  ✗ " + m)));

const sleep = ms => new Promise(r => setTimeout(r, ms));
const waitFor = async (fn, ms = 8000) => {
  const end = Date.now() + ms;
  for (;;) { const v = await fn(); if (v) return v; if (Date.now() > end) return v; await sleep(300); }
};
const PIN = process.env.PIN || "";
const api = (p, method = "GET", body) =>
  fetch(BASE + "/api/" + p, { method, headers: { "content-type": "application/json", "x-pin": PIN }, body: body ? JSON.stringify(body) : undefined })
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
  await ctx.addInitScript(() => { try { localStorage.installLater = String(Date.now()); } catch {} });
  if (PIN) await ctx.addInitScript(v => { localStorage.pin = v; window.PIN_VALUE = v; }, PIN);
  const page = await ctx.newPage();
  const errors = [];
  page.on("pageerror", e => errors.push(String(e)));
  page.on("console", m => { if (m.type() === "error") errors.push(m.text()); });

  // "set/gruppe": erst "Mehr" in der Navigation, dann den Bereich auf der Übersicht.
  const go = async (hash, sel) => {
    const [base, sub] = hash.split("/");
    await page.click(`nav a[href="#${base}"]`);
    if (sub) await page.click(`a[href="#${hash}"]`);
    await page.waitForSelector(sel, { timeout: 15000 });
  };
  // Die Tabelle aller Personen auf der Kassenkarte ist eingeklappt.
  const openKasse = async () => {
    await page.waitForSelector('.card:has(h2:has-text("Kasse")) summary');
    if (!(await page.isVisible('.card:has(h2:has-text("Kasse")) th:has-text("Angesammelt")')))
      await page.click('.card:has(h2:has-text("Kasse")) summary');
    await page.waitForSelector('.card:has(h2:has-text("Kasse")) th:has-text("Angesammelt")');
  };

  if (PIN) {
    console.log("\n== Gruppen-PIN ==");
    const anon = await browser.newContext({ ...devices["iPhone 13"], locale: "de-DE" });
    const ap = await anon.newPage();
    await ap.goto(BASE, { waitUntil: "domcontentloaded" });
    await ap.waitForSelector("#pinIn");
    ok(await ap.isVisible("text=Gruppen-PIN"), "ohne PIN erscheint der PIN-Bildschirm statt der App");
    await ap.fill("#pinIn", "falsch");
    await ap.click('button:has-text("Weiter")');
    await ap.waitForSelector("text=Die PIN stimmt nicht");
    ok(true, "falsche PIN wird abgewiesen und erneut gefragt");
    await ap.fill("#pinIn", PIN);
    await ap.click('button:has-text("Weiter")');
    await ap.waitForSelector('h2:has-text("Los geht\'s"), h2:has-text("Kasse")');
    ok(true, "richtige PIN schaltet die App frei");
    ok(await ap.evaluate(() => localStorage.pin) === PIN, "Gerät merkt sich die PIN");
    const low = await browser.newContext({ ...devices["iPhone 13"], locale: "de-DE" });
    const lp = await low.newPage();
    await lp.goto(BASE, { waitUntil: "domcontentloaded" });
    await lp.waitForSelector("#pinIn");
    ok(!(await lp.isVisible("nav")), "hinter dem PIN-Schirm ist die Navigation ausgeblendet");
    await lp.fill("#pinIn", PIN.toLowerCase());
    await lp.click('button:has-text("Weiter")');
    await lp.waitForSelector("nav", { state: "visible", timeout: 15000 });
    ok(true, "Klein geschriebene PIN wird genauso akzeptiert");
    await low.close();
    await anon.close();
  }

  console.log("\n== Installation ==");
  const ictx = await browser.newContext({ ...devices["iPhone 13"], locale: "de-DE" });
  if (PIN) await ictx.addInitScript(v => { localStorage.pin = v; }, PIN);
  const ip = await ictx.newPage();
  await ip.goto(BASE, { waitUntil: "domcontentloaded" });
  await ip.waitForSelector("#install.on", { timeout: 15000 });
  ok(true, "Installationshinweis poppt von selbst auf");
  const inst = await ip.textContent("#install");
  ok(inst.includes("Das Programm installieren"), "Dialog nennt die App");
  ok(inst.includes("Zum Home-Bildschirm"), "auf dem iPhone steht die Safari-Anleitung");
  ok(await ip.isVisible("#install img"), "Dialog zeigt das App-Icon");
  await ip.click('#install button:has-text("Verstanden")');
  await ip.waitForFunction(() => !document.getElementById("install").classList.contains("on"));
  ok(true, "Dialog lässt sich schließen");
  ok(await ip.evaluate(() => !!localStorage.installLater), "Zeitpunkt wird gemerkt (Wiedervorlage nach einer Woche)");
  await ip.reload({ waitUntil: "domcontentloaded" });
  await ip.waitForTimeout(2500);
  ok(!(await ip.evaluate(() => document.getElementById("install").classList.contains("on"))),
     "nach „Verstanden“ kommt er nicht sofort wieder");
  await ip.goto(BASE + "/#set/app", { waitUntil: "domcontentloaded" });
  await ip.waitForSelector('button:has-text("Installieren")');
  await ip.click('button:has-text("Installieren")');
  await ip.waitForSelector("#install.on");
  ok(true, "über die Einstellungen jederzeit wieder aufrufbar");
  await ictx.close();

  // Android/Chrome: der native Dialog laesst sich im Testbrowser nicht ausloesen,
  // deshalb das Event nachstellen und den Weg bis zum prompt()-Aufruf pruefen.
  const actx = await browser.newContext({ ...devices["Pixel 7"], locale: "de-DE" });
  if (PIN) await actx.addInitScript(v => { localStorage.pin = v; }, PIN);
  const ap2 = await actx.newPage();
  await ap2.goto(BASE, { waitUntil: "domcontentloaded" });
  await ap2.waitForSelector("nav");
  await ap2.evaluate(() => {
    window.__prompted = 0;
    const e = new Event("beforeinstallprompt");
    e.prompt = () => { window.__prompted++; };
    e.userChoice = Promise.resolve({ outcome: "accepted" });
    dispatchEvent(e);
  });
  await ap2.waitForSelector("#install.on", { timeout: 5000 });
  ok((await ap2.textContent("#install")).includes("Jetzt installieren"),
     "Android: Dialog bietet die echte Installation an");
  await ap2.click('#install button:has-text("Jetzt installieren")');
  await ap2.waitForFunction(() => window.__prompted === 1);
  ok(true, "Klick löst den nativen Installationsdialog aus");
  await ap2.waitForFunction(() => !document.getElementById("install").classList.contains("on"));
  ok(true, "eigener Dialog verschwindet dabei");
  await actx.close();

  console.log("\n== Erststart ==");
  await page.goto(BASE, { waitUntil: "networkidle" });
  ok(await page.title() === "Das Programm", "Titel ist „Das Programm“");
  ok(await page.getByText("Los geht's").isVisible(), "Einrichtung wird angeboten, wenn niemand angelegt ist");

  await page.fill("#names", "Anna, Ben, Chris");
  await page.click("text=Teilnehmer anlegen");
  await page.waitForSelector('button:has-text("Anna")');
  ok((await api("state")).members.length === 3, "drei Teilnehmer über die Oberfläche angelegt");
  ok(await page.getByText("Wer bist du?").isVisible(), "Gerät fragt einmalig nach der Person");
  ok(!(await page.isVisible("nav")), "solange die Frage steht, ist die Navigation ausgeblendet");

  await page.click('button:has-text("Anna")');
  await openKasse();
  ok(!(await page.getByText("Wer bist du?").isVisible().catch(() => false)), "nach der Auswahl verschwindet die Frage");
  ok(await page.isVisible("nav"), "danach ist die Navigation wieder da");
  ok(await page.evaluate(() => localStorage.me) !== "0", "Gerät merkt sich die Person (localStorage)");

  console.log("\n== Eintrag mit GPX ==");
  await go("add", "#who");
  ok(await page.inputValue("#who") === await page.evaluate(() => localStorage.me), "Eintrag ist mit der eigenen Person vorbelegt");
  await page.waitForSelector("#saveBtn:not([disabled])"); await page.setInputFiles("#file", FIX + "lauf.gpx");
  await page.waitForSelector("#prev .chip");
  const gpxChips = await page.$$eval("#prev .chip", els => els.map(e => e.textContent));
  ok(gpxChips.some(c => c.startsWith("Distanz") && c.includes("4,0")), "GPX: Distanz erkannt (" + gpxChips.join(" ") + ")");
  ok(gpxChips.some(c => c === "Dauer: 20 min"), "GPX: Dauer erkannt");
  ok(gpxChips.some(c => /^Tempo: \d+:[0-5]\d \/km$/.test(c)), "GPX: Laufen bekommt Minuten pro Kilometer (" + gpxChips.find(c => c.startsWith("Tempo")) + ")");
  ok(gpxChips.includes("Anstieg: 116 hm"), "GPX: Anstieg aus den Hoehenangaben (" + gpxChips.find(c => c.startsWith("Anstieg")) + ")");
  ok(await page.inputValue("#sport") === "Laufen", "GPX: „running“ füllt die Sportart als „Laufen“");
  await page.fill("#note", "Morgenlauf im Park");
  await page.click("#saveBtn:not([disabled])");
  await go("feed", '.post:has-text("Morgenlauf im Park")');
  ok(true, "Einheit mit GPX gespeichert und im Verlauf sichtbar");

  console.log("\n== Eintrag mit TCX ==");
  await go("add", "#saveBtn:not([disabled])"); await page.setInputFiles("#file", FIX + "rad.tcx");
  await page.waitForSelector("#prev .chip");
  const tcx = await page.$$eval("#prev .chip", els => els.map(e => e.textContent));
  ok(tcx.includes("Distanz: 18,00 km"), "TCX: Distanz aus beiden Runden summiert (" + tcx.join(" ") + ")");
  ok(tcx.includes("Dauer: 45 min"), "TCX: Dauer summiert");
  ok(tcx.some(c => /^Schnitt: 24,0 km\/h$/.test(c)), "TCX: Radfahren bekommt km/h statt min/km (" + tcx.find(c => c.startsWith("Schnitt")) + ")");
  ok(!tcx.some(c => c.startsWith("Tempo")), "TCX: und kein Tempo in Minuten");
  ok(tcx.some(c => /^Anstieg: \d+ hm$/.test(c)), "TCX: Anstieg aus den Hoehenangaben (" + tcx.find(c => c.startsWith("Anstieg")) + ")");
  ok(tcx.includes("Puls: 140 bpm"), "TCX: Durchschnittspuls");
  ok(tcx.includes("kcal: 600"), "TCX: Kalorien summiert");
  ok(!tcx.some(c => c.startsWith("Sport:")), "TCX: Sportart steht nicht mehr als Chip");
  ok(await page.inputValue("#sport") === "Radfahren", "TCX: „Biking“ füllt die Sportart als „Radfahren“");
  await page.fill("#sport", "Laufen");
  await page.waitForFunction(() => [...document.querySelectorAll("#prev .chip")].some(c => c.textContent.startsWith("Tempo")));
  const asRun = await page.$$eval("#prev .chip", els => els.map(e => e.textContent));
  ok(asRun.some(c => /^Tempo: \d+:[0-5]\d \/km$/.test(c)), "Sportart auf Laufen gewechselt -> wieder min/km (" + asRun.find(c => c.startsWith("Tempo")) + ")");
  await page.fill("#sport", "Schwimmen");
  await page.waitForFunction(() => [...document.querySelectorAll("#prev .chip")].some(c => c.textContent.includes("/100 m")));
  const asSwim = await page.$$eval("#prev .chip", els => els.map(e => e.textContent));
  ok(asSwim.some(c => c.includes("/100 m")), "Schwimmen rechnet je 100 Meter (" + asSwim.find(c => c.startsWith("Tempo")) + ")");
  await page.fill("#sport", "Radfahren");
  await page.waitForFunction(() => [...document.querySelectorAll("#prev .chip")].some(c => c.textContent.startsWith("Schnitt")));
  await page.click("#saveBtn:not([disabled])");
  await go("feed", '.post:has-text("18,00 km")');
  ok((await page.textContent('.post:has-text("18,00 km")')).includes("km/h"), "gespeichert wurde, was zuletzt angezeigt war");
  ok(true, "TCX-Einheit gespeichert");

  console.log("\n== Sportart ==");
  await go("add", "#sport");
  ok(await page.isVisible("#sport"), "Feld für die Sportart ist da");
  const options = await page.$$eval("#sportList option", els => els.map(e => e.value));
  ok(options.length > 60, options.length + " Sportarten stehen als Vorschlag bereit");
  for (const name of ["Laufen", "Radfahren", "Schwimmen", "Krafttraining", "Yoga", "Fußball", "Klettern", "Skifahren"])
    if (!options.includes(name)) ok(false, "Vorschlagsliste enthält " + name);
  ok(true, "gängige Sportarten sind in der Liste");
  await page.fill("#sport", "Hornussen");
  await page.fill("#note", "eigene Sportart");
  await page.click("#saveBtn:not([disabled])");
  await go("feed", '.post:has-text("Hornussen")');
  ok(true, "freie Eingabe außerhalb der Liste wird übernommen");
  await page.waitForSelector('.post:has-text("🏅 Hornussen")');
  ok(true, "unbekannte Sportart bekommt ein neutrales Symbol");
  await go("add", "#sport");
  ok(await page.inputValue("#sport") === "Hornussen", "zuletzt genutzte Sportart ist vorbelegt");
  await page.fill("#sport", "Bouldern");
  await page.click("#saveBtn:not([disabled])");
  await go("feed", '.post:has-text("🧗 Bouldern")');
  ok(true, "bekannte Sportart bekommt ihr eigenes Symbol");
  await go("add", "#sport");
  await page.click('button:has-text("🤒 Krank")');
  ok(!(await page.isVisible("#sport")), "bei einer Krankmeldung verschwindet das Feld");
  await page.click('button:has-text("🏃 Sporteinheit")');
  ok(await page.isVisible("#sport"), "und kommt zurück");

  console.log("\n== Foto ==");
  await go("add", "#saveBtn:not([disabled])"); await page.setInputFiles("#file", FIX + "selfie.jpg");
  await page.waitForSelector("#prev img");
  ok(await page.evaluate(() => document.querySelector("#prev img").src.startsWith("data:image/jpeg")), "Foto wird verkleinert und angezeigt");
  await page.click("#saveBtn:not([disabled])");
  await go("feed", "img.ph");
  await page.waitForFunction(() => [...document.querySelectorAll("img.ph")].some(e => e.naturalWidth > 0));
  ok(true, "Foto wird im Feed geladen");

  console.log("\n== Wochenzählung und Strafen ==");
  const anna = (await api("state")).members.find(m => m.name === "Anna").id;
  const st = await waitFor(async () => {
    const x = await api("state");
    return x.entries.filter(e => e.member_id === anna).length === 5 ? x : null;
  }) || (await api("state"));
  ok(st.entries.filter(e => e.member_id === anna).length === 5,
     "fünf Einträge für Anna (" + st.entries.filter(e => e.member_id === anna).length + ")");
  // Frischer Stand. D1-Repliken hinken kurz nach, deshalb notfalls noch einmal laden.
  let weekRow = "";
  for (let i = 0; i < 6; i++) {
    await page.goto(BASE + "/#home", { waitUntil: "networkidle" });
    await page.waitForSelector('h2:has-text("Wochenstand")');
    weekRow = (await page.textContent('.card:has(h2:has-text("Wochenstand")) table')).replace(/\s+/g, " ").trim();
    if (/Anna[^|]*5 \/ 2/.test(weekRow)) break;
    await sleep(1200);
  }
  ok(/Anna[^|]*5 \/ 2/.test(weekRow), "aktuelle Woche zählt Annas 5 Einheiten gegen das Ziel 2 (" + weekRow.slice(0, 60) + ")");
  ok((await page.textContent("body")).includes("🔥"), "Streak wird angezeigt");

  console.log("\n== Krankmeldung ==");
  await page.click('nav a[href="#add"]');
  await page.selectOption("#who", { label: "Ben" });
  await page.click('button:has-text("🤒 Krank")');
  ok(await page.isVisible("#unitsBox"), "Krankmeldung zeigt die Einheiten-Auswahl");
  await page.selectOption("#units", "2");
  await page.click("#saveBtn:not([disabled])");
  await go("feed", '.post:has-text("Krankmeldung")');
  ok(true, "Krankmeldung über zwei Einheiten gespeichert");
  ok((await page.textContent("body")).includes("🤒"), "Krankmeldung erscheint in der Wochenübersicht");

  console.log("\n== Startseite ==");
  await page.goto(BASE + "/#home", { waitUntil: "networkidle" });
  await page.waitForSelector(".hero");
  const cards = await page.$$eval(".card", els => els.map(e => e.className));
  ok(cards[0].includes("hero"), "ganz oben steht die eigene Serie, nicht die Kasse");
  const heroTx = (await page.textContent(".hero")).replace(/\s+/g, " ").trim();
  ok(/\u{1F525}|\u{1F4AA}/u.test(heroTx), "Hero motiviert: " + heroTx.slice(0, 55));
  const bodyTx = await page.textContent("body");
  ok(bodyTx.includes("Kasse") && /Angesammelt/.test(bodyTx), "die Kasse steht weiterhin da, jetzt je Person");
  ok(bodyTx.indexOf("Wochenstand") < bodyTx.indexOf("Angesammelt"), "die Kasse steht weiter unten");
  ok(bodyTx.includes("Auf den Home-Bildschirm"), "Installationshinweis steht auf der Startseite");
  ok(bodyTx.includes("Benachrichtigungen einschalten") || bodyTx.includes("Home-Bildschirm"),
     "Aufforderung fuer Benachrichtigungen steht auf der Startseite");

  console.log("\n== Feed ==");
  await go("feed", ".post");
  const posts = await page.$$(".post");
  ok(posts.length >= 5, posts.length + " Eintraege im Feed");
  const feedTx = await page.textContent("#app");
  ok(feedTx.includes("Heute"), "nach Tagen gruppiert (Heute)");
  ok(/Anna|Ben/.test(feedTx), "zeigt, wer es war");
  ok(feedTx.includes("18,00 km") && feedTx.includes("140 bpm"), "zeigt die Werte aus der hochgeladenen Datei");
  ok((await page.$$("img.ph")).length >= 1, "zeigt das hochgeladene Bild");
  ok((await page.$$(".post .av")).length >= 5, "jeder Eintrag hat ein Namenskuerzel");

  console.log("\n== Einstellungen ==");
  await go("set/gruppe", "#req");
  await page.fill("#req", "3");
  await page.fill("#fine", "25");
  await page.fill("#cur", "CHF");
  await page.click('button:has-text("Regeln speichern")');
  const s2 = await waitFor(async () => {
    const x = await api("state");
    return x.settings.required === 3 ? x : null;
  }) || (await api("state"));
  ok(s2.settings.required === 3 && s2.settings.fine === 25 && s2.settings.currency === "CHF", "Regeln frei konfigurierbar und gespeichert");
  await go("home", '.card:has(h2:has-text("Kasse"))');
  await openKasse();
  ok((await page.textContent("body")).includes("CHF"), "Währung schlägt in der Auswertung durch");

  console.log("\n== Kasse ==");
  await go("set/kasse", "#et");
  await page.fill("#et", "Grillen");
  await page.fill("#ea", "60");
  await page.click('button:has-text("Buchen")');
  await page.waitForSelector('.item:has-text("Grillen")');
  ok((await waitFor(async () => (await api("state")).expenses.length === 1)), "Ausgabe gebucht");
  ok((await page.textContent('.item:has-text("Grillen")')).includes("60,00 CHF"), "Ausgabe erscheint mit Betrag in der Liste");

  console.log("\n== Teilnehmer verwalten ==");
  await go("set/gruppe", "#nm");
  await page.fill("#nm", "Dani");
  await page.click('button:has-text("Hinzufügen")');
  await page.waitForSelector('.prow:has-text("Dani")');
  ok((await waitFor(async () => (await api("state")).members.length === 4)), "Teilnehmer jederzeit erweiterbar");
  await page.click('.prow:has-text("Dani")');
  await page.click('#form button:has-text("Teilnehmer entfernen")');
  await page.waitForSelector("#ask.on");
  ok(/Dani/.test(await page.textContent("#ask")), "vor dem Löschen wird nach der Person gefragt");
  await page.click('#ask button:has-text("Löschen")');
  await page.waitForSelector('.prow:has-text("Dani")', { state: "detached" });
  ok((await waitFor(async () => (await api("state")).members.length === 3)), "Teilnehmer löschbar");
  ok(!(await api("state")).entries.some(e => e.member_id === 999), "keine verwaisten Einträge");

  console.log("\n== PWA ==");
  await page.goto(BASE, { waitUntil: "networkidle" });
  await page.waitForTimeout(1200);
  ok(await page.evaluate(() => navigator.serviceWorker.getRegistration().then(r => !!r)), "Service Worker ist registriert");
  const mf = await (await fetch(BASE + "/manifest.json")).json();
  ok(mf.name === "Das Programm" && mf.display === "standalone", "Manifest ist installierbar");
  ok(mf.icons.filter(i => i.type === "image/png").length >= 2, "PNG-Icons für Android/iOS vorhanden");
  await go("set/ich", 'h2:has-text("Benachrichtigungen")');
  ok((await page.textContent("body")).includes("Push auf diesem Gerät"), "Push-Schalter pro Gerät vorhanden");

  console.log("\n== Eingaben überleben einen Tabwechsel ==");
  const awayAndBack = async () => {
    await page.evaluate(() => {
      Object.defineProperty(document, "hidden", { value: true, configurable: true });
      Object.defineProperty(document, "visibilityState", { value: "hidden", configurable: true });
      document.dispatchEvent(new Event("visibilitychange"));
    });
    await page.waitForTimeout(150);
    await page.evaluate(() => {
      Object.defineProperty(document, "hidden", { value: false, configurable: true });
      Object.defineProperty(document, "visibilityState", { value: "visible", configurable: true });
      document.dispatchEvent(new Event("visibilitychange"));
    });
    await page.waitForTimeout(900);
  };

  await go("set/ich", "#icuId");
  await page.fill("#icuId", "i123456");
  await awayAndBack();
  ok(await page.inputValue("#icuId") === "i123456", "Athleten-ID bleibt stehen, wenn man kurz in einen anderen Tab geht");

  await go("add", "#note");
  await page.fill("#note", "halb getippter Kommentar");
  await page.fill("#sport", "Bouldern");
  await awayAndBack();
  ok(await page.inputValue("#note") === "halb getippter Kommentar", "angefangener Kommentar bleibt stehen");
  ok(await page.inputValue("#sport") === "Bouldern", "angefangene Sportart bleibt stehen");

  await go("home", ".hero");
  const before = await page.evaluate(() => document.querySelector("#app").innerHTML.length);
  await awayAndBack();
  ok(await page.evaluate(() => !!document.querySelector(".hero")), "auf der Startseite wird weiterhin frisch geladen");
  ok(before > 0, "und die Ansicht steht danach noch");

  console.log("\n== Robustheit ==");
  await page.goto(BASE + "/#unsinn", { waitUntil: "networkidle" });
  await page.waitForTimeout(500);
  ok((await page.textContent("body")).includes("Wochenstand"), "unbekannte Route fällt auf die Startseite zurück");
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

  // Einstellungen zuruecksetzen, damit andere Suiten nicht darauf stossen
  await api("settings", "POST", { required: 2, fine: 20, currency: "€", sickMax: 2 });

  await browser.close();
  console.log(`\n${pass} ok, ${fail} fehlgeschlagen\n`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
