// Guthaben: sammeln nach Stufen, Deckel, automatisch einsetzen, Grenzen,
// Sonntagsmeldung.
const { settle, creditsEarned, MAX_CREDITS, stepsOf, capOf } = require("../stats.js");
const { chromium, devices } = require("/opt/node-tools/node_modules/playwright");
const BASE = process.env.BASE || "http://127.0.0.1:8787";
require("../scripts/guard.cjs").requireScratchTarget(BASE);
const PIN = process.env.PIN || "";
let pass = 0, fail = 0;
const ok = (x, m) => (x ? (pass++, console.log("  ✓ " + m)) : (fail++, console.log("  ✗ " + m)));
const api = (p, method = "GET", body) =>
  fetch(BASE + "/api/" + p, { method, headers: { "content-type": "application/json", "x-pin": PIN },
    body: body ? JSON.stringify(body) : undefined }).then(async (r) => ({ status: r.status, data: await r.json().catch(() => null) }));

const S = (o = {}) => ({ required: 2, fine: 20, sickMax: 2, start: "2026-10-05", bonus: 1, bonusCost: 3, bonusSince: "", currency: "€", ...o });
const M = [{ id: 1, name: "A", joined: "2026-10-05" }];
const mk = (weeks) => {
  const e = [];
  for (const [date, spec] of Object.entries(weeks)) {
    for (let i = 0; i < (spec.work || 0); i++) e.push({ member_id: 1, date, kind: "workout", units: 1 });
    if (spec.sick) e.push({ member_id: 1, date, kind: "sick", units: spec.sick });
  }
  return e;
};
const run = (weeks, today, settings) => settle({ members: M, entries: mk(weeks), settings: S(settings), today })[1];
const W = ["2026-10-05", "2026-10-12", "2026-10-19", "2026-10-26", "2026-11-02", "2026-11-09", "2026-11-16"];

(async () => {
  console.log("\n== Was eine zusätzliche Einheit bringt ==");
  ok(creditsEarned(2, 2) === 0, "das Ziel selbst bringt nichts");
  ok(creditsEarned(3, 2) === 1, "die dritte Einheit bringt 1");
  ok(creditsEarned(4, 2) === 1.5, "die vierte noch 0,5 (zusammen " + creditsEarned(4, 2) + ")");
  ok(creditsEarned(5, 2) === 1.8, "die fünfte noch 0,3 (zusammen " + creditsEarned(5, 2) + ")");
  ok(creditsEarned(9, 2) === 1.8, "danach bringt es nichts mehr (" + creditsEarned(9, 2) + ")");
  ok(creditsEarned(4, 3) === 1, "bei Ziel 3 zählt erst die vierte Einheit");
  ok(MAX_CREDITS === 9, "mehr als 9 lassen sich nicht ansparen");

  console.log("\n== Eigene Stufen ==");
  let r;
  ok(creditsEarned(5, 2, [2, 1, 0.5]) === 3.5, "eigene Stufen zaehlen (" + creditsEarned(5, 2, [2, 1, 0.5]) + ")");
  ok(creditsEarned(9, 2, [2, 1, 0.5]) === 3.5, "auch hier ist nach der Liste Schluss");
  ok(creditsEarned(3, 2, [0]) === 0, "eine Null bringt nichts");
  ok(stepsOf({}) === undefined || stepsOf({}).join() === "1,0.5,0.3", "ohne Einstellung gilt die Vorgabe");
  ok(stepsOf({ creditSteps: [2, 1] }).join() === "2,1", "mit Einstellung gelten deren Werte");
  ok(capOf({}) === 9 && capOf({ creditMax: 4 }) === 4, "der Deckel kommt genauso aus den Einstellungen");

  r = run({ [W[0]]: { work: 5 } }, W[1], { creditSteps: [2, 1, 0.5] });
  ok(r.credits === 3.5, "die Abrechnung nutzt sie (" + r.credits + ")");
  r = run({ [W[0]]: { work: 5 } }, W[1], { creditSteps: [2, 1, 0.5], creditMax: 3 });
  ok(r.credits === 3 && r.maxCredits === 3, "und haelt sich an den eigenen Deckel (" + r.credits + ")");
  r = run({ [W[0]]: { work: 3 }, [W[1]]: { work: 1 } }, W[2], { creditSteps: [3] });
  ok(r.missed === 0 && r.saved === 1, "mit grosszuegigen Stufen reicht schon eine starke Woche");

  console.log("\n== Sammeln ==");
  r = run({ [W[0]]: { work: 4 } }, W[1]);
  ok(r.credits === 1.5, "eine Woche mit vier Einheiten gibt 1,5 (" + r.credits + ")");
  r = run({ [W[0]]: { work: 2 } }, W[1]);
  ok(r.credits === 0, "genau das Ziel gibt kein Guthaben");
  r = run({ [W[0]]: { work: 1, sick: 1 } }, W[1]);
  ok(r.credits === 0 && r.missed === 0, "Krankmeldung rettet die Woche, gibt aber kein Guthaben");
  r = run({ [W[0]]: { work: 3, sick: 2 } }, W[1]);
  ok(r.credits === 1, "Guthaben entsteht nur aus echten Einheiten (" + r.credits + ")");

  const voll = {};
  for (const w of W.slice(0, 6)) voll[w] = { work: 5 };
  r = run(voll, W[6]);
  ok(r.credits === 9, "sechs starke Wochen landen beim Deckel 9 statt " + 6 * 1.8 + " (" + r.credits + ")");

  console.log("\n== Automatisch einsetzen ==");
  r = run({ [W[0]]: { work: 4 }, [W[1]]: { work: 4 }, [W[2]]: { work: 1 } }, W[3]);
  ok(r.credits === 0 && r.saved === 1 && r.missed === 0, "zwei starke Wochen (3,0) decken eine fehlende Einheit");
  ok(r.owed === 0, "keine Strafe fällig");
  ok(r.streak === 3, "die Serie bleibt erhalten (" + r.streak + ")");

  r = run({ [W[0]]: { work: 4 }, [W[1]]: { work: 1 } }, W[2]);
  ok(r.missed === 1 && r.saved === 0, "1,5 Guthaben reichen nicht");
  ok(r.credits === 1.5, "und bleiben unangetastet (" + r.credits + ")");

  console.log("\n== Nie rückwirkend ==");
  // Erst die magere Woche, dann die starken: das Guthaben war zu spät da.
  r = run({ [W[0]]: { work: 1 }, [W[1]]: { work: 4 }, [W[2]]: { work: 4 } }, W[3]);
  ok(r.missed === 1, "die erste Woche bleibt verloren, obwohl später genug zusammenkam");
  ok(r.credits === 3, "das Guthaben steht danach bereit (" + r.credits + ")");

  console.log("\n== Nie eine ganze Woche ==");
  r = run({ [W[0]]: { work: 4 }, [W[1]]: { work: 4 }, [W[2]]: {} }, W[3]);
  ok(r.missed === 1 && r.saved === 0 && r.credits === 3,
     "wer gar nichts macht, rettet auch mit 3 Guthaben nichts");
  r = run({ [W[0]]: { work: 4 }, [W[1]]: { work: 4 }, [W[2]]: { sick: 1 } }, W[3]);
  ok(r.missed === 0 && r.saved === 1, "eine Krankmeldung zählt als Eintrag und schaltet das Guthaben frei");
  r = run({ [W[0]]: { work: 4 }, [W[1]]: { work: 4 }, [W[2]]: { work: 1, sick: 1 } }, W[3]);
  ok(r.missed === 0 && r.saved === 0 && r.credits === 3,
     "Sport plus Krankmeldung erreicht das Ziel ohne Guthaben (" + r.credits + " übrig)");

  const ziel3 = { [W[0]]: { work: 6 }, [W[1]]: { work: 6 } };
  r = run({ ...ziel3, [W[2]]: { work: 1, sick: 1 } }, W[3], { required: 3 });
  ok(r.missed === 0 && r.saved === 1, "bei Ziel 3 decken Guthaben die dritte Einheit");
  r = run({ ...ziel3, [W[2]]: {} }, W[3], { required: 3 });
  ok(r.missed === 1, "bei Ziel 3 bleibt die leere Woche trotzdem verloren");
  r = run({ ...ziel3, [W[2]]: { sick: 3 } }, W[3], { required: 3, sickMax: 3 });
  ok(r.missed === 0 && r.saved === 0, "drei Krankmeldungen reichen ohne Guthaben");

  console.log("\n== Regler ==");
  r = run({ [W[0]]: { work: 4 }, [W[1]]: { work: 4 }, [W[2]]: { work: 1 } }, W[3], { bonus: 0 });
  ok(r.missed === 1 && r.credits === 0, "ausgeschaltet sammelt und rettet gar nichts");
  r = run({ [W[0]]: { work: 4 }, [W[1]]: { work: 4 }, [W[2]]: { work: 1 } }, W[3], { bonusCost: 2 });
  ok(r.missed === 0 && r.credits === 1, "mit Preis 2 bleibt mehr übrig (" + r.credits + ")");
  r = run({ [W[0]]: { work: 4 }, [W[1]]: { work: 4 }, [W[2]]: { work: 1 } }, W[3], { bonusCost: 5 });
  ok(r.missed === 1, "mit Preis 5 reicht es nicht");
  r = run({ [W[0]]: { work: 4 }, [W[1]]: { work: 4 }, [W[2]]: { work: 1 } }, W[3], { bonusSince: W[1] });
  ok(r.credits === 1.5 && r.missed === 1, "Wochen vor dem Einschalten zählen nicht rückwirkend (" + r.credits + ")");

  console.log("\n== Laufende Woche ==");
  const monday = (back) => { const d = new Date(); d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7) - 7 * back); return d.toISOString().slice(0, 10); };
  const todayIso = new Date().toISOString().slice(0, 10);
  const vorwochen = { [monday(2)]: { work: 4 }, [monday(1)]: { work: 4 } };
  r = settle({ members: M, entries: mk({ ...vorwochen, [todayIso]: { work: 1 } }),
    settings: S({ start: monday(2) }), today: todayIso })[1];
  ok(r.credits === 3, "Guthaben aus den Vorwochen steht bereit (" + r.credits + ")");
  ok(r.week.canRescue === true, "die laufende Woche könnte gerettet werden");
  ok(r.rescueCost === 3, "und würde drei Guthaben kosten");
  const r2 = settle({ members: M, entries: mk({ ...vorwochen, [todayIso]: { work: 4 } }),
    settings: S({ start: monday(2) }), today: todayIso })[1];
  ok(r2.week.canRescue === false && r2.pending === 1.5, "wer schon durch ist, sammelt stattdessen (+" + r2.pending + ")");
  const r3 = settle({ members: M, entries: mk({ ...vorwochen, [todayIso]: { work: 9 } }),
    settings: S({ start: monday(2) }), today: todayIso })[1];
  ok(r3.pending === 1.8, "auch neun Einheiten bringen nur 1,8 (" + r3.pending + ")");
  ok(r3.maxCredits === 9, "der Deckel steht im Ergebnis");

  console.log("\n== Im Worker ==");
  const s0 = await api("state");
  for (const m of s0.data.members) await api("member/" + m.id, "DELETE");
  await api("settings", "POST", { required: 2, fine: 20, sickMax: 2, bonus: true, bonusCost: 3, start: monday(2), nudges: true });
  await api("settings", "POST", { bonusSince: monday(2) });
  const anna = (await api("member", "POST", { name: "Anna", joined: monday(2) })).data.id;
  for (const back of [2, 1]) for (let i = 0; i < 4; i++)
    await api("entry", "POST", { member_id: anna, date: monday(back), kind: "workout", sport: "Laufen", device: "x" });
  await api("entry", "POST", { member_id: anna, date: todayIso, kind: "workout", sport: "Laufen", device: "x" });

  let st = (await api("state")).data;
  ok(st.stats[anna].credits === 3, "der Server liefert den Guthabenstand mit (" + st.stats[anna].credits + ")");
  ok(st.stats[anna].week.canRescue === true, "und sagt, dass die Woche gerettet werden kann");
  ok(st.settings.bonusCost === 3, "der Preis steht in den Einstellungen");
  ok(/^\d{4}-\d{2}-\d{2}$/.test(st.settings.bonusSince), "der Einschalttag wurde festgehalten");
  ok(st.settings.importMin === undefined, "die Übernahmezeit steht nicht mehr in den Einstellungen");

  const sunday = new Date(Date.parse(monday(0)) + 6 * 864e5 + 20 * 36e5).toISOString();
  let rep = await api("bonus-report", "POST", { now: sunday });
  ok(rep.data.reports.length === 1 && /Guthaben/.test(rep.data.reports[0].text),
     "Sonntagsmeldung: „" + rep.data.reports[0].text + "“");
  rep = await api("bonus-report", "POST", { now: sunday, send: true });
  ok(rep.data.reports.length === 1, "und einmal verschickt");
  st = (await api("state")).data;
  ok(st.events.some((e) => e.kind === "bonus" && e.member_id === anna), "sie landet als Eintrag im Feed");
  rep = await api("bonus-report", "POST", { now: sunday, send: true });
  ok(rep.data.reports.length === 0, "ein zweites Mal kommt sie nicht");

  console.log("\n== Wieder ausschalten ==");
  // Die Frage, auf die es ankommt: wird die Kasse danach wieder streng gerechnet?
  const vorher = (await api("state")).data;
  const annaVor = vorher.stats[anna];
  ok(annaVor.saved === 0 && annaVor.credits === 3, "Ausgangslage: 3 Guthaben, nichts gerettet");

  // Eine magere Woche nachtragen, die nur das Guthaben rettet.
  const extra = (await api("entry", "POST", { member_id: anna, date: monday(0), kind: "workout", sport: "Laufen", device: "x" })).data.id;
  // ... und die laufende Woche abschliessen, indem wir den Start zurueckdatieren
  await api("settings", "POST", { start: monday(3) });
  const mitGuthaben = (await api("state")).data.stats[anna];

  await api("settings", "POST", { bonus: false });
  const ohne = (await api("state")).data;
  const annaOhne = ohne.stats[anna];
  ok(annaOhne.credits === 0, "ausgeschaltet steht das Guthaben auf null");
  ok(annaOhne.saved === 0, "keine Woche gilt mehr als gerettet");
  ok(annaOhne.missed >= mitGuthaben.missed, "verpasste Wochen werden wieder voll gezaehlt (" +
     mitGuthaben.missed + " -> " + annaOhne.missed + ")");
  ok(annaOhne.owed === annaOhne.missed * ohne.settings.fine, "die Strafe passt zur Zahl der verpassten Wochen");
  ok(ohne.settings.bonusSince === "", "der Einschalttag ist vergessen");

  // Und wieder an: es beginnt von vorne, nicht rueckwirkend.
  await api("settings", "POST", { bonus: true });
  const wieder = (await api("state")).data;
  ok(/^\d{4}-\d{2}-\d{2}$/.test(wieder.settings.bonusSince), "beim Wiedereinschalten wird der Tag neu gesetzt");
  ok(wieder.settings.bonusSince === new Date().toISOString().slice(0, 10), "und zwar auf heute");
  ok(wieder.stats[anna].credits === 0, "das Guthaben beginnt bei null statt rueckwirkend zu entstehen");

  // Ausgangslage wiederherstellen, damit die folgenden Prüfungen stimmen.
  await api("entry/" + extra, "DELETE");
  await api("settings", "POST", { bonus: false });
  await api("settings", "POST", { start: monday(2), bonus: true });
  await api("settings", "POST", { bonusSince: monday(2) });

  console.log("\n== In der App ==");
  const browser = await chromium.launch({ args: ["--no-sandbox"] });
  const ctx = await browser.newContext({ ...devices["iPhone 13"], locale: "de-DE" });
  await ctx.addInitScript((v) => { localStorage.pin = v; localStorage.installLater = String(Date.now()); }, PIN);
  const page = await ctx.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  await page.goto(BASE, { waitUntil: "networkidle" });
  await page.click('button:has-text("Anna")');
  await page.waitForSelector(".hero");
  const heroTx = await page.textContent(".hero");
  ok(/3 von 9 Guthaben/.test(heroTx), "Guthabenstand und Deckel stehen oben: " + heroTx.replace(/\s+/g, " ").trim().slice(-60));
  ok(/decken die Woche/.test(heroTx), "und was er gerade wert ist");

  await page.click('.hero button.i');
  await page.waitForSelector("#info.on");
  const info = await page.textContent("#info");
  ok(/3\. Einheit/.test(info) && /0,5/.test(info) && /9/.test(info), "das i erklärt die Guthaben-Regeln nach den Einstellungen");
  ok(/Rückwirkend geht nichts/.test(info), "und sagt, dass nichts rückwirkend geht");
  await page.click('#info button');
  await page.waitForFunction(() => !document.getElementById("info").classList.contains("on"));
  ok(true, "das Fenster lässt sich schließen");

  await page.click('nav a[href="#set"]');
  await page.click('a[href="#set/gruppe"]');
  await page.waitForSelector("#req");
  const cards = await page.$$eval("#app .card h2", (els) => els.map((e) => e.textContent.replace(/i$/, "").trim()));
  ok(cards[cards.length - 2] === "Guthaben", "die Guthaben-Regel steht ganz unten in den Einstellungen (" + cards.slice(-3).join(" | ") + ")");
  ok(!(await page.$("#importMin")), "kein Feld mehr für die Übernahmezeit");

  ok(await page.inputValue("#creditSteps") === "1  0,5  0,3", "die Stufen stehen als Feld da (" + await page.inputValue("#creditSteps") + ")");
  await page.fill("#creditSteps", "2; 1; 0,5");
  await page.click('.card:has(h2:has-text("Guthaben")) button:has-text("Guthaben speichern")');
  await page.waitForFunction(() => document.querySelector("#creditSteps")?.value === "2  1  0,5");
  let gs = (await api("state")).data.settings;
  ok(gs.creditSteps.join() === "2,1,0.5", "Komma und Semikolon werden verstanden (" + gs.creditSteps.join() + ")");
  await page.fill("#creditMax", "4");
  await page.click('.card:has(h2:has-text("Guthaben")) button:has-text("Guthaben speichern")');
  await page.waitForFunction(() => document.querySelector("#creditMax")?.value === "4");
  gs = (await api("state")).data.settings;
  ok(gs.creditMax === 4, "der Deckel laesst sich einstellen (" + gs.creditMax + ")");
  ok(/die 3. Einheit 2/.test((await page.textContent('.card:has(h2:has-text("Guthaben"))')).replace(/\s+/g, " ")),
     "der Hinweis rechnet es an der Zielvorgabe vor");
  await api("settings", "POST", { creditSteps: [1, 0.5, 0.3], creditMax: 9 });

  await page.click('.card:has(h2:has-text("Motivation")) button.i');
  await page.waitForSelector("#info.on");
  ok(/mittwochs/.test(await page.textContent("#info")), "auch der Anstupser hat eine Erklärung");
  ok(errors.length === 0, "keine JavaScript-Fehler" + (errors.length ? ": " + errors[0] : ""));

  await api("settings", "POST", { bonus: false, bonusCost: 3 });
  await browser.close();
  console.log(`\n${pass} ok, ${fail} fehlgeschlagen\n`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
