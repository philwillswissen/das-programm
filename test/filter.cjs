// Feed filtern - unauffällig, bis man ihn braucht. Und die Rückfrage beim Löschen.
const BASE = process.env.BASE || "http://127.0.0.1:8787";
require("../scripts/guard.cjs").requireScratchTarget(BASE);
const PIN = process.env.PIN || "";
const { chromium, devices } = require("/opt/node-tools/node_modules/playwright");
let pass = 0, fail = 0;
const ok = (x, m) => (x ? (pass++, console.log("  ✓ " + m)) : (fail++, console.log("  ✗ " + m)));
const api = (p, method = "GET", body) =>
  fetch(BASE + "/api/" + p, { method, headers: { "content-type": "application/json", "x-pin": PIN },
    body: body ? JSON.stringify(body) : undefined }).then(async (r) => ({ status: r.status, data: await r.json().catch(() => null) }));
const day = (back) => new Date(Date.now() - back * 864e5).toISOString().slice(0, 10);

(async () => {
  const s0 = await api("state");
  for (const m of s0.data.members) await api("member/" + m.id, "DELETE");
  const anna = (await api("member", "POST", { name: "Anna" })).data.id;
  const ben = (await api("member", "POST", { name: "Ben" })).data.id;
  for (const [mid, sport, back] of [
    [anna, "Laufen", 1], [anna, "Bouldern", 2], [anna, "Laufen", 4],
    [ben, "Radfahren", 1], [ben, "Laufen", 3],
  ]) await api("entry", "POST", { member_id: mid, date: day(back), kind: "workout", sport, device: "x" });
  await api("entry", "POST", { member_id: anna, date: day(0), kind: "workout", sport: "Schwimmen", with: [ben], device: "x" });

  const browser = await chromium.launch({ args: ["--no-sandbox"] });
  const ctx = await browser.newContext({ ...devices["iPhone 13"], locale: "de-DE" });
  await ctx.addInitScript((v) => { localStorage.pin = v; localStorage.installLater = String(Date.now()); }, PIN);
  const page = await ctx.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  await page.goto(BASE, { waitUntil: "networkidle" });
  await page.click('button:has-text("Anna")');
  await page.waitForTimeout(400);
  await page.click('nav a[href="#feed"]');
  await page.waitForSelector(".post");

  console.log("\n== Im Normalfall sieht man nichts davon ==");
  const alle = await page.$$(".post");
  ok(alle.length === 6, "alle sechs Einträge stehen da (" + alle.length + ")");
  ok(!(await page.$("select")), "keine Auswahlfelder im Weg");
  const trigger = page.locator('button:has-text("Filtern")');
  ok(await trigger.isVisible(), "nur eine schmale Zeile „Filtern“");
  const box = await trigger.boundingBox();
  ok(box.height < 40, "die zurückhaltend hoch ist (" + Math.round(box.height) + " px)");

  console.log("\n== Nach Person ==");
  await trigger.click();
  await page.waitForSelector(".card:has-text('Feed filtern')");
  ok((await page.$$(".card:has-text('Feed filtern') select")).length === 2, "zwei Auswahlfelder: Person und Sportart");
  await page.selectOption(".card:has-text('Feed filtern') select >> nth=0", { label: "Ben" });
  await page.waitForTimeout(400);
  let texte = await page.$$eval(".post", (els) => els.map((e) => e.textContent.replace(/\s+/g, " ")));
  ok(texte.length === 3, "Ben hat drei Einträge, die gemeinsame zählt mit (" + texte.length + ")");
  ok(texte.every((t) => t.includes("Ben")), "und in jedem steht Ben");
  ok(texte.some((t) => t.includes("Schwimmen")), "die gemeinsame Einheit ist dabei, obwohl Anna sie eingetragen hat");

  console.log("\n== Nach Sportart ==");
  await page.selectOption(".card:has-text('Feed filtern') select >> nth=0", { label: "alle Personen" });
  await page.selectOption(".card:has-text('Feed filtern') select >> nth=1", { label: "Laufen" });
  await page.waitForTimeout(400);
  texte = await page.$$eval(".post", (els) => els.map((e) => e.textContent));
  ok(texte.length === 3, "drei Laufeinheiten (" + texte.length + ")");
  ok(texte.every((t) => t.includes("Laufen")), "und nur Laufen");

  console.log("\n== Beides zusammen ==");
  await page.selectOption(".card:has-text('Feed filtern') select >> nth=0", { label: "Anna" });
  await page.waitForTimeout(400);
  ok((await page.$$(".post")).length === 2, "Anna und Laufen: zwei Einträge");

  console.log("\n== Wenn nichts passt ==");
  await page.selectOption(".card:has-text('Feed filtern') select >> nth=1", { label: "Radfahren" });
  await page.waitForTimeout(400);
  ok(await page.isVisible("text=Nichts gefunden"), "sagt die App Bescheid statt leer dazustehen");
  await page.click('button:has-text("Filter aufheben")');
  await page.waitForTimeout(400);
  ok((await page.$$(".post")).length === 6, "danach sind wieder alle da");
  ok(await page.locator('button:has-text("Filtern")').isVisible(), "und die Leiste ist wieder eingeklappt");

  console.log("\n== Rückfrage beim Löschen ==");
  // Kein confirm() mehr: ein eigenes Fenster, das auch in der installierten
  // App sicher erscheint. Ein nativer Dialog waere hier ein Fehler.
  let nativ = 0;
  page.on("dialog", (d) => { nativ++; d.dismiss(); });
  await page.locator('.post:has-text("Bouldern") button[title="Löschen"]').click();
  await page.waitForSelector("#ask.on");
  let gefragt = (await page.textContent("#ask")).replace(/\s+/g, " ");
  ok(true, "vor dem Löschen wird gefragt");
  ok(nativ === 0, "und zwar im eigenen Fenster, nicht über den Browser-Dialog");
  ok(/Bouldern/.test(gefragt), "die Frage nennt die Einheit: „" + gefragt.trim().slice(0, 70) + "“");
  ok(/Anna/.test(gefragt), "und wessen sie ist");
  ok(/nicht rückgängig/i.test(gefragt), "und dass es endgültig ist");
  ok(await page.isVisible("#backdrop.on"), "der Hintergrund ist abgedunkelt");

  await page.click('#ask button:has-text("Abbrechen")');
  await page.waitForSelector("#ask.on", { state: "detached" }).catch(() => {});
  await page.waitForFunction(() => !document.getElementById("ask").classList.contains("on"));
  ok((await api("state")).data.entries.some((e) => e.sport === "Bouldern"), "Abbrechen löscht nichts");
  ok(!(await page.isVisible("#backdrop.on")), "und der Hintergrund ist wieder frei");

  await page.locator('.post:has-text("Schwimmen") button[title="Löschen"]').click();
  await page.waitForSelector("#ask.on");
  gefragt = (await page.textContent("#ask")).replace(/\s+/g, " ");
  ok(/gemeinsame Einheit/i.test(gefragt), "bei einer gemeinsamen Einheit steht dabei, dass es alle betrifft");
  // Tipp auf den Hintergrund zaehlt als Abbrechen.
  await page.click("#backdrop", { position: { x: 20, y: 60 } });
  await page.waitForFunction(() => !document.getElementById("ask").classList.contains("on"));
  ok((await api("state")).data.entries.some((e) => e.sport === "Schwimmen"), "ein Tipp daneben löscht auch nichts");

  await page.locator('.post:has-text("Bouldern") button[title="Löschen"]').click();
  await page.waitForSelector("#ask.on");
  await page.click('#ask button:has-text("Löschen")');
  await page.waitForTimeout(900);
  ok(!(await api("state")).data.entries.some((e) => e.sport === "Bouldern"), "nach dem Bestätigen ist er weg");
  ok(nativ === 0, "an keiner Stelle ein nativer Dialog");

  console.log("\n== Keine leeren Tagesblöcke ==");
  const leereTage = await page.evaluate(() =>
    [...document.querySelectorAll(".day")]
      .filter((d) => !d.nextElementSibling?.classList.contains("post"))
      .map((d) => d.textContent));
  ok(leereTage.length === 0, "kein Tag ohne Einträge" + (leereTage.length ? ": " + leereTage.join(", ") : ""));

  console.log("\n== Foto nur zu Sporteinheiten ==");
  await api("entry", "POST", { member_id: anna, date: day(0), kind: "sick", units: 1, device: "x" });
  await page.reload({ waitUntil: "networkidle" });
  await page.click('nav a[href="#feed"]');
  await page.waitForSelector('.post:has-text("Krankmeldung")');
  ok((await page.locator('.post:has-text("Krankmeldung") button:has-text("Foto")').count()) === 0,
     "zu einer Krankmeldung wird kein Foto angeboten");
  ok(await page.locator('.post:has-text("Laufen") button:has-text("Foto")').first().isVisible(),
     "zu einer Sporteinheit schon");

  ok(errors.length === 0, "keine JavaScript-Fehler" + (errors.length ? ": " + errors[0] : ""));
  await browser.close();
  console.log(`\n${pass} ok, ${fail} fehlgeschlagen\n`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
