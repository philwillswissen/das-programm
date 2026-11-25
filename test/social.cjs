// Gemeinsame Einheiten, Aktivitaetsvorschlaege und der dezente Anstupser in fremden Meldungen.
const http = require("node:http");
const { webcrypto: c } = require("node:crypto");
const { chromium, devices } = require("/opt/node-tools/node_modules/playwright");
const BASE = process.env.BASE || "http://127.0.0.1:8787";
require("../scripts/guard.cjs").requireScratchTarget(BASE);

const PIN = process.env.PIN || "";
let pass = 0, fail = 0;
const ok = (x, m) => (x ? (pass++, console.log("  ✓ " + m)) : (fail++, console.log("  ✗ " + m)));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const api = (p, method = "GET", body) =>
  fetch(BASE + "/api/" + p, { method, headers: { "content-type": "application/json", "x-pin": PIN },
    body: body ? JSON.stringify(body) : undefined }).then(async (r) => ({ status: r.status, data: await r.json().catch(() => null) }));

const b64u = { enc: (b) => Buffer.from(b).toString("base64url") };
const cat = (...p) => { const o = new Uint8Array(p.reduce((n, x) => n + x.length, 0)); let i = 0; for (const x of p) { o.set(x, i); i += x.length; } return o; };
const hk = async (salt, ikm, info, len) => {
  const k = await c.subtle.importKey("raw", ikm, "HKDF", false, ["deriveBits"]);
  return new Uint8Array(await c.subtle.deriveBits({ name: "HKDF", hash: "SHA-256", salt, info }, k, len * 8));
};
async function newDevice() {
  const kp = await c.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]);
  const raw = new Uint8Array(await c.subtle.exportKey("raw", kp.publicKey));
  const auth = c.getRandomValues(new Uint8Array(16));
  return { kp, raw, auth, p256dh: b64u.enc(raw), authB64: b64u.enc(auth) };
}
async function decrypt(dev, buf) {
  const b = new Uint8Array(buf), salt = b.slice(0, 16), idlen = b[20];
  const asPub = b.slice(21, 21 + idlen), ct = b.slice(21 + idlen);
  const asKey = await c.subtle.importKey("raw", asPub, { name: "ECDH", namedCurve: "P-256" }, false, []);
  const shared = new Uint8Array(await c.subtle.deriveBits({ name: "ECDH", public: asKey }, dev.kp.privateKey, 256));
  const te = new TextEncoder();
  const ikm = await hk(dev.auth, shared, cat(te.encode("WebPush: info"), new Uint8Array([0]), dev.raw, asPub), 32);
  const cek = await hk(salt, ikm, cat(te.encode("Content-Encoding: aes128gcm"), new Uint8Array([0])), 16);
  const nonce = await hk(salt, ikm, cat(te.encode("Content-Encoding: nonce"), new Uint8Array([0])), 12);
  const key = await c.subtle.importKey("raw", cek, "AES-GCM", false, ["decrypt"]);
  const plain = new Uint8Array(await c.subtle.decrypt({ name: "AES-GCM", iv: nonce }, key, ct));
  let end = plain.length; while (end > 0 && plain[end - 1] === 0) end--;
  return JSON.parse(Buffer.from(plain.slice(0, end - 1)).toString());
}

const today = () => new Date().toISOString().slice(0, 10);
const plus = (n) => new Date(Date.now() + n * 864e5).toISOString().slice(0, 10);

(async () => {
  const received = [];
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on("data", (d) => chunks.push(d));
    req.on("end", () => { received.push({ path: req.url, body: Buffer.concat(chunks) }); res.writeHead(201); res.end(); });
  });
  await new Promise((r) => server.listen(8902, "127.0.0.1", r));
  const PUSH = "http://127.0.0.1:8902";

  const s0 = await api("state");
  for (const m of s0.data.members) await api("member/" + m.id, "DELETE");
  for (const p of s0.data.plans || []) await api("plan/" + p.id, "DELETE");
  await api("settings", "POST", { required: 2, fine: 20, currency: "€", sickMax: 2, nudges: true });
  const anna = (await api("member", "POST", { name: "Anna" })).data.id;
  const ben = (await api("member", "POST", { name: "Ben" })).data.id;
  const chris = (await api("member", "POST", { name: "Chris" })).data.id;
  const dani = (await api("member", "POST", { name: "Dani" })).data.id;
  const dBen = await newDevice(), dChris = await newDevice(), dDani = await newDevice();
  await api("push/subscribe", "POST", { device: "dBen", member_id: ben, sub: { endpoint: PUSH + "/ben", keys: { p256dh: dBen.p256dh, auth: dBen.authB64 } } });
  await api("push/subscribe", "POST", { device: "dChris", member_id: chris, sub: { endpoint: PUSH + "/chris", keys: { p256dh: dChris.p256dh, auth: dChris.authB64 } } });
  await api("push/subscribe", "POST", { device: "dDani", member_id: dani, sub: { endpoint: PUSH + "/dani", keys: { p256dh: dDani.p256dh, auth: dDani.authB64 } } });

  console.log("\n== Gemeinsame Einheit: einer trägt ein ==");
  received.length = 0;
  const grp = await api("entry", "POST", {
    member_id: anna, date: today(), kind: "workout", sport: "Bouldern",
    note: "Halle, zu dritt", with: [ben, chris], device: "dAnna",
  });
  ok(grp.data.group === 3, "ein Eintrag wird für drei Personen angelegt");
  let st = (await api("state")).data;
  ok(st.entries.filter((e) => e.sport === "Bouldern").length === 3, "jeder bekommt seine eigene Einheit gutgeschrieben");
  const gid = st.entries.find((e) => e.sport === "Bouldern").group_id;
  ok(gid && st.entries.filter((e) => e.group_id === gid).length === 3, "alle drei hängen an derselben Gruppe");
  ok(st.entries.filter((e) => e.group_id === gid && e.member_id === anna).length === 1, "die eintragende Person ist dabei");

  await sleep(1500);
  ok(received.length === 3, received.length + " Benachrichtigungen an die anderen Geräte");

  // Wer selbst dabei war, bekommt eine Bestätigung ...
  const anBen = await decrypt(dBen, received.find((r) => r.path === "/ben").body);
  ok(/z\u00e4hlt/i.test(anBen.body), "wer dabei war, erfährt, dass es für ihn zählt: „" + anBen.body + "“");
  ok(/\u{1F64C}/u.test(anBen.body), "und es wird gefeiert");
  ok(!/n\u00e4chste Mal dabei/i.test(anBen.body), "ohne Einladung zu etwas, wo er schon war");

  // ... wer nicht dabei war, eine Einladung.
  const anDani = await decrypt(dDani, received.find((r) => r.path === "/dani").body);
  ok(/Anna, Ben und Chris/.test(anDani.body) && /Bouldern/.test(anDani.body),
     "die anderen erfahren, wer was gemacht hat: „" + anDani.body + "“");
  ok(/zusammen|Gemeinsame|zu dritt|durchgezogen/.test(anDani.body), "und dass sie zusammen unterwegs waren");
  ok(/\u{1F64C}/u.test(anDani.body), "gemeinsamer Sport wird gefeiert");
  ok(/n\u00e4chste|dabei|mit dir|anschlie\u00dft/i.test(anDani.body), "und sie werden zum nächsten Mal eingeladen");

  console.log("\n== Gemeinsamen Eintrag löschen ==");
  const one = (await api("state")).data.entries.find((e) => e.group_id === gid);
  await api("entry/" + one.id, "DELETE");
  st = (await api("state")).data;
  ok(st.entries.filter((e) => e.group_id === gid).length === 0, "die ganze Gruppe verschwindet, nicht nur einer");

  console.log("\n== Dezenter Anstupser in fremden Meldungen ==");
  received.length = 0;
  await api("entry", "POST", { member_id: anna, date: today(), kind: "workout", sport: "Laufen", device: "dAnna" });
  await sleep(1500);
  const toBen = await decrypt(dBen, received.find((r) => r.path === "/ben").body);
  const { behindHint } = require("../nudge.js");
  const days = ["Mo", "Di", "Mi", "Do", "Fr", "Sa", "So"];
  const quiet = days.filter((_, i) => !behindHint({ dow: i, required: 2, credit: 0, recipientId: 2, authorId: 1 }));
  ok(quiet.join() === "Mo,Di", "gestupst wird erst ab Mittwoch, vorher still (" + quiet.join(", ") + ")");
  ok(behindHint({ dow: 4, required: 2, credit: 1, recipientId: 2, authorId: 1 }) === " Dir fehlt noch eine.",
     "bei einer fehlenden Einheit im Singular");
  ok(behindHint({ dow: 4, required: 3, credit: 0, recipientId: 2, authorId: 1 }) === " Dir fehlen noch 3.",
     "bei mehreren mit Zahl");
  ok(behindHint({ dow: 4, required: 2, credit: 2, recipientId: 2, authorId: 1 }) === "", "wer durch ist, bekommt nichts");
  ok(behindHint({ dow: 4, required: 2, credit: 0, recipientId: 1, authorId: 1 }) === "", "sich selbst stupst niemand");
  ok(behindHint({ dow: 4, required: 2, credit: 0, recipientId: null, authorId: 1 }) === "",
     "Ger\u00e4te ohne Person bekommen keinen pers\u00f6nlichen Zusatz");
  const dow = (new Date().getUTCDay() + 6) % 7;
  if (dow >= 2) {
    ok(/fehl(t|en) (dir|noch)/i.test(toBen.body), "wer hinterherhinkt, wird mitgenommen: „" + toBen.body + "“");
    ok(toBen.body.length < 190, "die Nachricht bleibt kurz genug (" + toBen.body.length + " Zeichen)");
  } else {
    ok(!/fehl/i.test(toBen.body), "früh in der Woche wird nicht gestupst: „" + toBen.body + "“");
    ok(/\?|schau|zieh|zusammen|funke/i.test(toBen.body), "stattdessen eine Einladung: „" + toBen.body + "“");
  }
  // Ben holt auf, dann darf nichts mehr angehängt werden
  await api("entry", "POST", { member_id: ben, date: today(), kind: "workout", sport: "Laufen", device: "dBen" });
  await api("entry", "POST", { member_id: ben, date: today(), kind: "workout", sport: "Laufen", device: "dBen" });
  received.length = 0;
  await api("entry", "POST", { member_id: anna, date: today(), kind: "workout", sport: "Laufen", device: "dAnna" });
  await sleep(1500);
  const after = await decrypt(dBen, received.find((r) => r.path === "/ben").body);
  ok(!/fehl/i.test(after.body), "wer sein Ziel hat, wird nicht gestupst: „" + after.body + "“");

  console.log("\n== Aktivität vorschlagen ==");
  received.length = 0;
  const plan = await api("plan", "POST", {
    member_id: chris, sport: "Schwimmen", date: plus(2), time: "18:30",
    note: "Hallenbad, Treffpunkt Kasse", dateText: "übermorgen", device: "dChris",
  });
  ok(plan.status === 200 && plan.data.id, "Vorschlag angelegt");
  await sleep(1500);
  ok(received.some((r) => r.path === "/ben"), "die anderen werden gefragt");
  const invite = await decrypt(dBen, received.find((r) => r.path === "/ben").body);
  ok(/Chris schlägt Schwimmen vor/.test(invite.body) && /18:30/.test(invite.body),
     "Einladung nennt Person, Sportart und Zeit: „" + invite.body + "“");

  st = (await api("state")).data;
  const p1 = st.plans.find((p) => p.id === plan.data.id);
  ok(p1 && p1.joined.includes(chris), "wer vorschlägt, ist automatisch dabei");
  await api("plan/" + plan.data.id + "/join", "POST", { member_id: anna });
  await api("plan/" + plan.data.id + "/join", "POST", { member_id: ben });
  st = (await api("state")).data;
  ok(st.plans.find((p) => p.id === plan.data.id).joined.length === 3, "weitere können zusagen");
  await api("plan/" + plan.data.id + "/join", "POST", { member_id: ben, leave: true });
  st = (await api("state")).data;
  ok(st.plans.find((p) => p.id === plan.data.id).joined.length === 2, "und wieder absagen");
  ok((await api("plan", "POST", { member_id: chris, date: "quatsch" })).status === 400, "ohne gültiges Datum kein Vorschlag");

  const old = await api("plan", "POST", { member_id: chris, sport: "Laufen", date: plus(-5), device: "dChris" });
  st = (await api("state")).data;
  ok(!st.plans.some((p) => p.id === old.data.id), "vergangene Vorschläge tauchen nicht mehr auf");

  console.log("\n== In der App ==");
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
  await page.waitForSelector(".plan");
  ok((await page.textContent(".plan")).includes("Schwimmen"), "Vorschlag steht oben im Feed");
  ok((await page.textContent(".plan")).includes("Dabei:"), "zeigt, wer schon zugesagt hat");
  await page.click('.plan button:has-text("Doch nicht"), .plan button:has-text("Bin dabei")');
  await page.waitForTimeout(900);
  ok(true, "Zu- und Absagen geht per Knopf");

  await page.click('button:has-text("Gemeinsame Einheit vorschlagen")');
  await page.waitForSelector("#pSport");
  await page.fill("#pSport", "Tennis");
  await page.fill("#pDate", plus(1));
  await page.fill("#pTime", "17:00");
  await page.click('button:has-text("Vorschlagen")');
  await page.waitForSelector('.plan:has-text("Tennis")');
  ok(true, "neuer Vorschlag lässt sich in der App anlegen");

  await page.click('nav a[href="#add"]');
  await page.waitForSelector("#sport");
  const visibleCrew = await page.$$eval("[data-crew]", (els) => els.filter((e) => e.style.display !== "none").map((e) => e.textContent));
  ok(visibleCrew.length === 3, "beim Eintrag stehen die anderen zur Auswahl (" + visibleCrew.join(", ") + ")");
  const hidden = await page.$$eval("[data-crew]", (els) => els.filter((e) => e.style.display === "none").length);
  ok(hidden === 1, "sich selbst kann man nicht als Mitmacher wählen");
  await page.fill("#sport", "Volleyball");
  await page.click('[data-crew="' + ben + '"]');
  ok(await page.$eval('[data-crew="' + ben + '"]', (e) => e.classList.contains("on")), "Auswahl ist sichtbar");
  await page.click("#saveBtn:not([disabled])");
  await page.waitForTimeout(1600);
  st = (await api("state")).data;
  const vb = st.entries.filter((e) => e.sport === "Volleyball");
  ok(vb.length === 2, "die Einheit landet bei beiden");
  await page.click('nav a[href="#feed"]');
  await page.waitForSelector('.post:has-text("Volleyball")');
  const post = await page.textContent('.post:has-text("Volleyball")');
  ok(/Anna & Ben|Ben & Anna/.test(post), "im Feed steht ein Beitrag für beide: " + post.replace(/\s+/g, " ").trim().slice(0, 50));
  ok((await page.$$('.post:has-text("Volleyball")')).length === 1, "und nicht zweimal derselbe");

  const tiny = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
  await api("entry", "POST", { member_id: anna, date: today(), kind: "workout", sport: "Tanzen", photo: tiny, with: [chris], device: "dAnna" });
  await page.reload({ waitUntil: "networkidle" });
  await page.waitForSelector('.post:has-text("Tanzen")');
  ok((await page.$$('.post:has-text("Tanzen") img.ph')).length === 1, "das Foto taucht im Sammelbeitrag auf");

  // Zu einer Einheit ohne Bild - etwa einer automatisch uebernommenen - soll
  // sich eines nachtragen lassen.
  await page.locator('.post:has-text("Volleyball") button[title="Aktionen"]').click();
  await page.waitForSelector("#form.on");
  ok(await page.locator('#form button:has-text("Foto hinzuf\u00fcgen")').isVisible(),
     "Eintraege ohne Bild bieten an, eines hinzuzuf\u00fcgen");
  await page.click('#form button:has-text("Abbrechen")');
  await page.waitForFunction(() => !document.getElementById("form").classList.contains("on"));
  await page.locator('.post:has-text("Tanzen") button[title="Aktionen"]').click();
  await page.waitForSelector("#form.on");
  ok(await page.locator('#form button:has-text("Foto tauschen")').isVisible(),
     "und Eintraege mit Bild, es zu tauschen");
  ok(errors.length === 0, "keine JavaScript-Fehler" + (errors.length ? ": " + errors[0] : ""));

  await browser.close();
  server.close();
  console.log(`\n${pass} ok, ${fail} fehlgeschlagen\n`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
