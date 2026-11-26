// Kudos und Kommentare: Ablage, Push an die Richtigen, Oberfläche im Browser.
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

(async () => {
  const received = [];
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on("data", (d) => chunks.push(d));
    req.on("end", () => { received.push({ path: req.url, body: Buffer.concat(chunks) }); res.writeHead(201); res.end(); });
  });
  await new Promise((r) => server.listen(8903, "127.0.0.1", r));
  const PUSH = "http://127.0.0.1:8903";
  const got = async (who, dev) => {
    const hit = received.filter((r) => r.path === "/" + who);
    return Promise.all(hit.map((h) => decrypt(dev, h.body)));
  };

  const s0 = await api("state");
  for (const m of s0.data.members) await api("member/" + m.id, "DELETE");
  for (const p of s0.data.plans || []) await api("plan/" + p.id, "DELETE");
  await api("settings", "POST", { required: 2, fine: 20, currency: "€", sickMax: 2, nudges: true });
  const anna = (await api("member", "POST", { name: "Anna" })).data.id;
  const ben = (await api("member", "POST", { name: "Ben" })).data.id;
  const chris = (await api("member", "POST", { name: "Chris" })).data.id;
  const dani = (await api("member", "POST", { name: "Dani" })).data.id;
  const dev = {};
  for (const [n, id] of [["anna", anna], ["ben", ben], ["chris", chris], ["dani", dani]]) {
    dev[n] = await newDevice();
    await api("push/subscribe", "POST", { device: "d-" + n, member_id: id,
      sub: { endpoint: PUSH + "/" + n, keys: { p256dh: dev[n].p256dh, auth: dev[n].authB64 } } });
  }

  console.log("\n== Kudos ==");
  const lauf = (await api("entry", "POST", { member_id: ben, date: today(), kind: "workout", sport: "Laufen", device: "d-ben" })).data.id;
  await sleep(1200);
  received.length = 0;
  let r = await api(`entry/${lauf}/kudos`, "POST", { member_id: anna, device: "d-anna" });
  ok(r.status === 200 && r.data.on, "Anna gibt Ben Kudos");
  await sleep(1200);
  ok(received.length === 1 && received[0].path === "/ben", "nur Ben bekommt eine Benachrichtigung (" + received.map((x) => x.path).join(",") + ")");
  let msg = (await got("ben", dev.ben))[0];
  ok(msg && msg.body === "Anna gibt dir Kudos für Laufen 👏", "„" + msg?.body + "“");
  ok(msg && msg.tag === "kudos-" + lauf, "Kudos zu einem Eintrag landen unter einem Tag");

  r = await api(`entry/${lauf}/kudos`, "POST", { member_id: ben, device: "d-ben" });
  ok(r.status === 400, "für die eigene Einheit gibt es keine Kudos");
  r = await api(`entry/${lauf}/kudos`, "POST", { member_id: 99999 });
  ok(r.status === 400, "ohne bekannte Person keine Kudos");

  received.length = 0;
  await api(`entry/${lauf}/kudos`, "POST", { member_id: anna, off: true, device: "d-anna" });
  let st = (await api("state")).data;
  ok(!st.kudos.some((k) => k.entry_id === lauf && k.member_id === anna), "Kudos lassen sich zurücknehmen");
  await api(`entry/${lauf}/kudos`, "POST", { member_id: anna, device: "d-anna" });
  await api(`entry/${lauf}/kudos`, "POST", { member_id: anna, device: "d-anna" });
  await sleep(1200);
  ok(received.length === 0, "an- und wieder abschalten schickt keinen zweiten Push");
  st = (await api("state")).data;
  ok(st.kudos.filter((k) => k.entry_id === lauf && k.member_id === anna).length === 1, "doppelt drücken zählt einmal");

  await api(`entry/${lauf}/kudos`, "POST", { member_id: chris, device: "d-chris" });
  await sleep(1200);
  msg = (await got("ben", dev.ben))[0];
  ok(msg && msg.body === "Chris und Anna geben dir Kudos für Laufen 👏", "die Meldung nennt alle: „" + msg?.body + "“");

  console.log("\n== Kommentare ==");
  received.length = 0;
  r = await api(`entry/${lauf}/comment`, "POST", { member_id: chris, text: "   ", device: "d-chris" });
  ok(r.status === 400, "leere Kommentare werden abgelehnt");
  r = await api(`entry/${lauf}/comment`, "POST", { member_id: chris, text: "Stark,  wie schnell?\nRespekt!", device: "d-chris" });
  ok(r.status === 200 && r.data.id, "Chris kommentiert");
  await sleep(1200);
  ok(received.length === 1 && received[0].path === "/ben", "nur der Autor erfährt vom ersten Kommentar");
  msg = (await got("ben", dev.ben))[0];
  ok(msg && msg.title === "💬 Chris zu deiner Einheit (Laufen)", "Titel: „" + msg?.title + "“");
  ok(msg && msg.body === "Stark, wie schnell? Respekt!", "der Kommentar ist der Text, auf eine Zeile gebracht");

  received.length = 0;
  await api(`entry/${lauf}/comment`, "POST", { member_id: ben, text: "Danke! 5:10er Schnitt", device: "d-ben" });
  await sleep(1200);
  ok(received.map((x) => x.path).join() === "/chris", "die Antwort des Autors geht an alle, die mitreden");
  msg = (await got("chris", dev.chris))[0];
  ok(msg && msg.title === "💬 Ben antwortet (Laufen)", "Titel für Mitredende: „" + msg?.title + "“");

  received.length = 0;
  await api(`entry/${lauf}/comment`, "POST", { member_id: anna, text: "👏", device: "d-anna" });
  await sleep(1200);
  ok(received.map((x) => x.path).sort().join() === "/ben,/chris", "Anna: Ben und Chris werden benachrichtigt, Dani nicht");

  st = (await api("state")).data;
  const cs = st.comments.filter((c) => c.entry_id === lauf);
  ok(cs.length === 3 && cs[0].member_id === chris && cs[2].member_id === anna, "drei Kommentare in der richtigen Reihenfolge");
  await api("comment/" + cs[2].id, "DELETE");
  st = (await api("state")).data;
  ok(st.comments.filter((c) => c.entry_id === lauf).length === 2, "eigener Kommentar lässt sich löschen");

  console.log("\n== Gemeinsame Einheit ==");
  await api("entry", "POST", { member_id: anna, date: today(), kind: "workout", sport: "Bouldern", with: [ben], device: "d-anna" });
  await sleep(1200);
  st = (await api("state")).data;
  const grp = st.entries.filter((e) => e.sport === "Bouldern").sort((a, b) => a.id - b.id);
  received.length = 0;
  r = await api(`entry/${grp[1].id}/kudos`, "POST", { member_id: chris, device: "d-chris" });
  ok(r.data.entry_id === grp[0].id, "Kudos hängen am Eintrag der Person, die eingetragen hat");
  r = await api(`entry/${grp[0].id}/kudos`, "POST", { member_id: ben });
  ok(r.status === 400, "wer dabei war, kann der Runde keine Kudos geben");
  await sleep(1200);
  ok(received.map((x) => x.path).sort().join() === "/anna,/ben", "beide aus der Runde bekommen die Kudos mit");
  msg = (await got("anna", dev.anna))[0];
  ok(msg && msg.body === "Chris gibt euch Kudos für Bouldern 👏", "„" + msg?.body + "“");

  received.length = 0;
  await api(`entry/${grp[1].id}/comment`, "POST", { member_id: dani, text: "Nächstes Mal komm ich mit", device: "d-dani" });
  await sleep(1200);
  msg = (await got("ben", dev.ben))[0];
  ok(msg && msg.title === "💬 Dani zu eurer Einheit (Bouldern)", "„" + msg?.title + "“");

  console.log("\n== Krankmeldung ==");
  const krank = (await api("entry", "POST", { member_id: chris, date: today(), kind: "sick", units: 1, device: "d-chris" })).data.id;
  await sleep(1200);
  received.length = 0;
  await api(`entry/${krank}/comment`, "POST", { member_id: anna, text: "Gute Besserung!", device: "d-anna" });
  await sleep(1200);
  msg = (await got("chris", dev.chris))[0];
  ok(msg && msg.title === "💬 Anna zu deiner Krankmeldung", "„" + msg?.title + "“");

  console.log("\n== Aufräumen ==");
  await api("entry/" + grp[1].id, "DELETE");
  st = (await api("state")).data;
  ok(!st.kudos.some((k) => grp.some((g) => g.id === k.entry_id)) && !st.comments.some((c) => grp.some((g) => g.id === c.entry_id)),
    "mit dem Eintrag verschwinden seine Kudos und Kommentare");
  await api("member/" + chris, "DELETE");
  st = (await api("state")).data;
  ok(!st.kudos.some((k) => k.member_id === chris) && !st.comments.some((c) => c.member_id === chris),
    "mit einer Person verschwinden ihre Kudos und Kommentare");

  console.log("\n== Oberfläche ==");
  const proxy = process.env.https_proxy || process.env.HTTPS_PROXY;
  const browser = await chromium.launch({
    args: ["--no-sandbox", ...(proxy ? ["--ignore-certificate-errors"] : [])],
    ...(proxy && !BASE.includes("127.0.0.1") ? { proxy: { server: proxy } } : {}),
  });
  const bctx = await browser.newContext({ ...devices["Pixel 7"], locale: "de-DE", timezoneId: "Europe/Berlin" });
  await bctx.addInitScript(([m, p]) => { try { localStorage.installLater = String(Date.now()); localStorage.me = String(m); if (p) localStorage.pin = p; } catch {} }, [dani, PIN]);
  const page = await bctx.newPage();
  const errors = [];
  let dialogs = 0;
  page.on("dialog", (d) => { dialogs++; d.dismiss().catch(() => {}); });
  page.on("pageerror", (e) => errors.push(String(e)));
  await page.goto(BASE + "/#feed", { waitUntil: "domcontentloaded" });
  const kb = `button[data-kudos="${lauf}"]`;
  await page.waitForSelector(kb, { timeout: 15000 });
  ok((await page.textContent(kb)).includes("Kudos · 1"), "der Knopf zeigt, wie viele schon Kudos gegeben haben");
  ok((await page.textContent(`.post:has(${kb}) .kfrom`)).includes("Anna"), "und wer");
  await page.click(kb);
  await page.waitForSelector(`${kb}[aria-pressed="true"]`);
  ok((await page.textContent(kb)).includes("Kudos · 2"), "antippen zählt sofort mit");
  ok((await page.textContent(`.post:has(${kb}) .kfrom`)).startsWith("👏 Du und Anna"), "„Du“ steht vorn");
  await sleep(600);
  st = (await api("state")).data;
  ok(st.kudos.some((k) => k.entry_id === lauf && k.member_id === dani), "und landet im Worker");
  await page.click(kb);
  await page.waitForSelector(`${kb}[aria-pressed="false"]`);
  ok(true, "noch einmal antippen nimmt sie zurück");

  ok((await page.locator(`.post:has(${kb}) .cmt`).count()) === 1, "die letzten Kommentare stehen unter dem Beitrag");
  await page.click(`.post:has(${kb}) .social button:has-text("Kommentare")`);
  await page.waitForSelector("#form.on #cmtText");
  ok((await page.locator("#cmtList .cmt").count()) === 1, "im Fenster stehen alle Kommentare");
  await page.fill("#cmtText", "Wann läufst du wieder?");
  await page.click("#cmtSend");
  await page.waitForFunction(() => document.querySelectorAll("#cmtList .cmt").length === 2);
  ok((await page.inputValue("#cmtText")) === "", "nach dem Senden ist das Feld leer");
  ok((await page.textContent("#cmtList")).includes("Wann läufst du wieder?"), "der neue Kommentar steht sofort da");
  const mine = page.locator('#cmtList .cmt:has-text("Wann läufst") button.x');
  ok((await mine.count()) === 1, "eigene Kommentare haben einen Löschknopf");
  ok((await page.locator('#cmtList .cmt:has-text("Danke!") button.x').count()) === 0, "fremde nicht");
  await mine.click();
  await page.click('#cmtList .sure button:has-text("Löschen")');
  await page.waitForFunction(() => document.querySelectorAll("#cmtList .cmt").length === 1);
  ok(true, "Löschen fragt im Fenster nach und entfernt den Kommentar");
  ok(dialogs === 0, "kein nativer Dialog (" + dialogs + ")");
  ok(!errors.length, "keine Fehler im Browser" + (errors.length ? ": " + errors.join(" | ") : ""));
  await page.screenshot({ path: process.env.SHOT_DIR ? process.env.SHOT_DIR + "/kommentare.png" : "/dev/null" }).catch(() => {});
  await page.click('#form button:has-text("Schließen")');
  await sleep(400);
  if (process.env.SHOT_DIR) await page.screenshot({ path: process.env.SHOT_DIR + "/feed-kudos.png" });
  await browser.close();

  server.close();
  console.log(`\n${pass} bestanden, ${fail} fehlgeschlagen`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
