// Guthaben: sammeln, automatisch einsetzen, Grenzen einhalten, Sonntagsmeldung.
const { settle } = require("../stats.js");
const { chromium, devices } = require("/opt/node-tools/node_modules/playwright");
const BASE = process.env.BASE || "http://127.0.0.1:8787";
const PIN = process.env.PIN || "";
let pass = 0, fail = 0;
const ok = (x, m) => (x ? (pass++, console.log("  ✓ " + m)) : (fail++, console.log("  ✗ " + m)));
const api = (p, method = "GET", body) =>
  fetch(BASE + "/api/" + p, { method, headers: { "content-type": "application/json", "x-pin": PIN },
    body: body ? JSON.stringify(body) : undefined }).then(async (r) => ({ status: r.status, data: await r.json().catch(() => null) }));

const S = (o = {}) => ({ required: 2, fine: 20, sickMax: 2, start: "2026-10-05", bonus: 1, bonusCost: 3, currency: "€", ...o });
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

(async () => {
  console.log("\n== Sammeln ==");
  let r = run({ "2026-10-05": { work: 4 } }, "2026-10-14");
  ok(r.credits === 2, "zwei Einheiten über dem Ziel geben zwei Guthaben (" + r.credits + ")");
  r = run({ "2026-10-05": { work: 2 } }, "2026-10-14");
  ok(r.credits === 0, "genau das Ziel gibt kein Guthaben");
  r = run({ "2026-10-05": { work: 1, sick: 1 } }, "2026-10-14");
  ok(r.credits === 0 && r.missed === 0, "Krankmeldung rettet die Woche, gibt aber kein Guthaben");
  r = run({ "2026-10-05": { work: 3, sick: 2 } }, "2026-10-14");
  ok(r.credits === 1, "Guthaben entsteht nur aus echten Einheiten, nicht aus Krankmeldungen (" + r.credits + ")");

  console.log("\n== Automatisch einsetzen ==");
  r = run({ "2026-10-05": { work: 4 }, "2026-10-12": { work: 4 }, "2026-10-19": { work: 1 } }, "2026-10-26");
  ok(r.missed === 0 && r.saved === 1, "drei Guthaben decken die fehlende Einheit");
  ok(r.credits === 1, "danach bleibt ein Guthaben übrig (" + r.credits + ")");
  ok(r.paid === 0, "keine Strafe fällig");
  ok(r.streak === 3, "die Serie bleibt erhalten (" + r.streak + ")");

  r = run({ "2026-10-05": { work: 4 }, "2026-10-12": { work: 1 } }, "2026-10-19");
  ok(r.missed === 1 && r.saved === 0, "zwei Guthaben reichen nicht");
  ok(r.credits === 2, "und bleiben unangetastet");

  console.log("\n== Nie eine ganze Woche ==");
  r = run({ "2026-10-05": { work: 8 }, "2026-10-12": { work: 0 } }, "2026-10-19");
  ok(r.credits === 6 && r.missed === 1 && r.saved === 0,
     "wer gar nichts macht, kann auch mit sechs Guthaben nichts retten");
  r = run({ "2026-10-05": { work: 8 }, "2026-10-12": { sick: 1 } }, "2026-10-19");
  ok(r.missed === 0 && r.saved === 1, "eine Krankmeldung z\u00e4hlt als Eintrag und schaltet das Guthaben frei");
  r = run({ "2026-10-05": { work: 8 }, "2026-10-12": {} }, "2026-10-19");
  ok(r.missed === 1 && r.saved === 0, "eine komplett leere Woche rettet nichts, egal wie viel Guthaben da ist");
  r = run({ "2026-10-05": { work: 8 }, "2026-10-12": { work: 1, sick: 1 } }, "2026-10-19");
  ok(r.missed === 0 && r.saved === 0, "Sport plus Krankmeldung erreicht das Ziel ganz ohne Guthaben");
  ok(r.credits === 6, "Guthaben bleibt dann unberuehrt");

  r = run({ "2026-10-05": { work: 12 }, "2026-10-12": { work: 1, sick: 1 } }, "2026-10-19", { required: 3 });
  ok(r.missed === 0 && r.saved === 1, "bei Ziel 3 decken Guthaben die dritte Einheit, wenn Sport und Krankmeldung stehen");
  r = run({ "2026-10-05": { work: 12 }, "2026-10-12": { work: 1 } }, "2026-10-19", { required: 3 });
  ok(r.missed === 0 && r.saved === 1 && r.spent === 6, "bei Ziel 3 und einer Einheit decken sechs Guthaben zwei (" + r.spent + ")");
  r = run({ "2026-10-05": { work: 12 }, "2026-10-12": { sick: 3 } }, "2026-10-19", { required: 3 });
  ok(r.missed === 0, "drei Krankmeldungen reichen ohne Guthaben");

  console.log("\n== Vier machen rettet keine Leerwoche ==");
  r = run({ "2026-10-05": { work: 4 }, "2026-10-12": { work: 0 } }, "2026-10-19");
  ok(r.missed === 1, "eine Woche mit vier Einheiten rettet die nächste Nullwoche nicht");
  ok(r.credits === 2, "die zwei Guthaben bleiben liegen");

  console.log("\n== Regler ==");
  r = run({ "2026-10-05": { work: 4 }, "2026-10-12": { work: 1 } }, "2026-10-19", { bonus: 0 });
  ok(r.missed === 1 && r.credits === 0, "ausgeschaltet sammelt und rettet gar nichts");
  r = run({ "2026-10-05": { work: 4 }, "2026-10-12": { work: 1 } }, "2026-10-19", { bonusSince: "2026-10-12" });
  ok(r.credits === 0 && r.missed === 1, "Wochen vor dem Einschalten z\u00e4hlen nicht r\u00fcckwirkend");
  r = run({ "2026-10-05": { work: 4 }, "2026-10-12": { work: 1 } }, "2026-10-19", { bonusSince: "2026-10-05" });
  ok(r.credits === 2 && r.missed === 1, "ab dem Einschalttag wird gesammelt (" + r.credits + ")");
  r = run({ "2026-10-05": { work: 4 }, "2026-10-12": { work: 1 } }, "2026-10-19", { bonusCost: 2 });
  ok(r.missed === 0 && r.credits === 0, "mit Preis 2 reicht es (" + r.credits + " übrig)");
  r = run({ "2026-10-05": { work: 4 }, "2026-10-12": { work: 1 } }, "2026-10-19", { bonusCost: 5 });
  ok(r.missed === 1, "mit Preis 5 reicht es nicht");

  console.log("\n== Laufende Woche ==");
  const thisMonday = (() => { const d = new Date(); d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7)); return d.toISOString().slice(0, 10); })();
  const lastMonday = (() => { const d = new Date(thisMonday + "T12:00:00Z"); d.setUTCDate(d.getUTCDate() - 7); return d.toISOString().slice(0, 10); })();
  const todayIso = new Date().toISOString().slice(0, 10);
  r = settle({ members: M, entries: mk({ [lastMonday]: { work: 5 }, [thisMonday]: { work: 1 } }), settings: S({ start: lastMonday }), today: todayIso });
  r = r[1];
  ok(r.credits === 3, "Guthaben aus der Vorwoche steht bereit (" + r.credits + ")");
  ok(r.week.canRescue === true, "die laufende Woche könnte gerettet werden");
  ok(r.rescueCost === 3, "und würde drei Guthaben kosten");
  const r2 = settle({ members: M, entries: mk({ [lastMonday]: { work: 5 }, [thisMonday]: { work: 4 } }), settings: S({ start: lastMonday }), today: todayIso })[1];
  ok(r2.week.canRescue === false && r2.pending === 2, "wer schon durch ist, sammelt stattdessen (+" + r2.pending + ")");

  console.log("\n== Im Worker ==");
  const s0 = await api("state");
  for (const m of s0.data.members) await api("member/" + m.id, "DELETE");
  await api("settings", "POST", { required: 2, fine: 20, sickMax: 2, bonus: true, bonusCost: 3, start: lastMonday, nudges: true });
  await api("settings", "POST", { bonusSince: lastMonday });   // f\u00fcr den Test ab der Vorwoche sammeln
  const anna = (await api("member", "POST", { name: "Anna", joined: lastMonday })).data.id;
  for (let i = 0; i < 5; i++) await api("entry", "POST", { member_id: anna, date: lastMonday, kind: "workout", sport: "Laufen", device: "x" });
  await api("entry", "POST", { member_id: anna, date: todayIso, kind: "workout", sport: "Laufen", device: "x" });
  let st = (await api("state")).data;
  ok(st.stats[anna].credits === 3, "der Server liefert den Guthabenstand mit (" + st.stats[anna].credits + ")");
  ok(st.stats[anna].week.canRescue === true, "und sagt, dass die Woche gerettet werden kann");
  ok(st.settings.bonusCost === 3, "der Preis steht in den Einstellungen");
  ok(/^\d{4}-\d{2}-\d{2}$/.test(st.settings.bonusSince), "der Einschalttag wurde festgehalten (" + st.settings.bonusSince + ")");

  const sunday = new Date(Date.parse(thisMonday) + 6 * 864e5 + 20 * 36e5).toISOString();
  let rep = await api("bonus-report", "POST", { now: sunday });
  ok(rep.data.reports.length === 1 && /Guthaben/.test(rep.data.reports[0].text),
     "Sonntagsmeldung wird gebaut: „" + rep.data.reports[0].text + "“");
  rep = await api("bonus-report", "POST", { now: sunday, send: true });
  ok(rep.data.reports.length === 1, "und einmal verschickt");
  st = (await api("state")).data;
  ok(st.events.some((e) => e.kind === "bonus" && e.member_id === anna), "sie landet als Eintrag im Feed");
  rep = await api("bonus-report", "POST", { now: sunday, send: true });
  ok(rep.data.reports.length === 0, "ein zweites Mal kommt sie nicht");

  await api("settings", "POST", { bonus: false });
  rep = await api("bonus-report", "POST", { now: sunday });
  ok(rep.data.reports.length === 0, "ausgeschaltet gibt es auch keine Meldung");
  await api("settings", "POST", { bonus: true });

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
  ok(/3 Guthaben/.test(heroTx), "der Guthabenstand steht oben: " + heroTx.replace(/\s+/g, " ").trim().slice(0, 70));
  ok(/würden die Woche decken/.test(heroTx), "und was er gerade wert ist");
  ok((await page.textContent("body")).includes("Guthaben"), "die Rangliste zeigt die Spalte");

  await page.click('nav a[href="#feed"]');
  await page.waitForSelector(".post");
  ok((await page.textContent("#app")).includes("Guthaben die Woche ab"), "die Sonntagsmeldung steht im Feed");

  await page.click('nav a[href="#set"]');
  await page.waitForSelector("#bonusCost");
  ok(await page.inputValue("#bonusCost") === "3", "der Preis lässt sich in den Regeln ändern");
  await page.fill("#bonusCost", "4");
  await page.click('button:has-text("Merken")');
  await page.waitForTimeout(900);
  ok((await api("state")).data.settings.bonusCost === 4, "geänderter Preis wird gespeichert");
  await page.click('button:has-text("Ausschalten")');
  await page.waitForTimeout(900);
  ok((await api("state")).data.settings.bonus === 0, "und der Regler schaltet das Ganze ab");
  await page.click('nav a[href="#home"]');
  await page.waitForSelector(".hero");
  ok(!/Guthaben/.test(await page.textContent(".hero")), "ausgeschaltet verschwindet die Anzeige");
  ok(errors.length === 0, "keine JavaScript-Fehler" + (errors.length ? ": " + errors[0] : ""));

  await api("settings", "POST", { bonus: false, bonusCost: 3 });
  await browser.close();
  console.log(`\n${pass} ok, ${fail} fehlgeschlagen\n`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
