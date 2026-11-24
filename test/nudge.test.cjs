// Motivationsnachrichten: Zeitfenster, Einmaligkeit, Personalisierung, Wetter.
const BASE = process.env.BASE || "http://127.0.0.1:8787";
const PIN = process.env.PIN || "";
let pass = 0, fail = 0;
const ok = (c, m) => (c ? (pass++, console.log("  ✓ " + m)) : (fail++, console.log("  ✗ " + m)));
const api = (p, method = "GET", body) =>
  fetch(BASE + "/api/" + p, {
    method, headers: { "content-type": "application/json", "x-pin": PIN },
    body: body ? JSON.stringify(body) : undefined,
  }).then(async (r) => ({ status: r.status, data: await r.json().catch(() => null) }));

const { slotFor, favourites, buildMessage, localParts } = require("../nudge.js");

// Montag der Woche zu einem Datum
const weekOf = (d) => { const x = new Date(d + "T12:00:00Z"); x.setUTCDate(x.getUTCDate() - ((x.getUTCDay() + 6) % 7)); return x.toISOString().slice(0, 10); };
const atBerlin = (isoDate, hour) => new Date(`${isoDate}T${String(hour).padStart(2, "0")}:30:00+01:00`).toISOString();

const http = require("node:http");
const { webcrypto: c } = require("node:crypto");
const b64u = { enc: (b) => Buffer.from(b).toString("base64url"), dec: (s) => new Uint8Array(Buffer.from(s, "base64url")) };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
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

const received = [];
const PUSH = "http://127.0.0.1:8901";
let dev;

(async () => {
  dev = await newDevice();
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on("data", (d) => chunks.push(d));
    req.on("end", () => { received.push({ path: req.url, body: Buffer.concat(chunks) }); res.writeHead(201); res.end(); });
  });
  await new Promise((r) => server.listen(8901, "127.0.0.1", r));
  process.on("exit", () => server.close());

  console.log("\n== Zeitfenster ==");
  const weeks = ["2026-11-02", "2026-11-09", "2026-11-16", "2026-11-23", "2026-11-30", "2026-12-07"];
  const startDays = new Set(), pushDays = new Set(), startHours = new Set();
  for (const w of weeks) for (const id of [1, 2, 3, 4]) {
    const a = slotFor(id, w, "start"), b = slotFor(id, w, "push");
    startDays.add(a.dow); pushDays.add(b.dow); startHours.add(a.hour);
  }
  ok([...startDays].every((d) => d === 3 || d === 4), "erster Schubs kommt mittwochs oder donnerstags");
  ok(startDays.size === 2, "mal am Mittwoch, mal am Donnerstag");
  ok([...pushDays].every((d) => d === 5 || d === 6), "zweiter Schubs kommt freitags oder samstags");
  ok(pushDays.size === 2, "mal am Freitag, mal am Samstag");
  ok([...startHours].every((h) => h >= 11 && h <= 14), "mittags, zwischen 11 und 14 Uhr");
  ok(startHours.size > 1, "auch die Uhrzeit variiert");
  const stable = slotFor(7, "2026-11-23", "start");
  ok(JSON.stringify(stable) === JSON.stringify(slotFor(7, "2026-11-23", "start")), "pro Person und Woche stabil");
  ok(localParts(new Date("2026-11-26T12:30:00Z"), "Europe/Berlin").dow === 4, "Wochentag wird in Ortszeit bestimmt");

  console.log("\n== Lieblingssportarten ==");
  const hist = [
    { member_id: 1, kind: "workout", sport: "Radfahren", date: "2026-11-20" },
    { member_id: 1, kind: "workout", sport: "Radfahren", date: "2026-11-18" },
    { member_id: 1, kind: "workout", sport: "Krafttraining", date: "2026-11-15" },
    { member_id: 1, kind: "workout", sport: "Laufen", date: "2026-06-01" },
    { member_id: 2, kind: "workout", sport: "Schwimmen", date: "2026-11-20" },
    { member_id: 1, kind: "sick", sport: null, date: "2026-11-19" },
  ];
  const favs = favourites(hist, 1, "2026-11-25");
  ok(favs[0] === "Radfahren", "häufigste Sportart steht vorn (" + favs.join(", ") + ")");
  ok(!favs.includes("Laufen"), "sehr alte Einträge zählen nicht mehr");
  ok(!favourites(hist, 1, "2026-11-25").includes(null), "Krankmeldungen tauchen nicht auf");
  ok(favourites(hist, 3, "2026-11-25").length === 0, "ohne Historie keine Vorschläge");

  console.log("\n== Nachrichten ==");
  const ctx = (o) => ({ name: "Anna", week: "2026-11-23", dow: 3, days: 4, left: 2, required: 2, fine: 20, currency: "€", streak: 0, aheadOf: null, ...o });
  const dry = [{ date: "2026-11-25", code: 1, temp: 14, rain: 10 }, { date: "2026-11-26", code: 1, temp: 12, rain: 5 }];
  const wet = [{ date: "2026-11-25", code: 61, temp: 8, rain: 85 }, { date: "2026-11-26", code: 1, temp: 11, rain: 10 }];

  const streaky = buildMessage("start", ctx({ streak: 5 }), ["Radfahren"], dry, 0);
  ok(/5 Wochen/.test(streaky.body), "lange Serie wird erwähnt: „" + streaky.body + "“");
  ok(/Radfahren/.test(streaky.body), "Lieblingssportart wird vorgeschlagen");
  ok(/14°/.test(streaky.body), "Temperatur fliesst ein");

  const rainy = buildMessage("start", ctx({}), ["Radfahren", "Krafttraining"], wet, 1);
  ok(/Krafttraining|drinnen|Regen|nass/.test(rainy.body), "bei Regen wird etwas drinnen vorgeschlagen: „" + rainy.body + "“");
  ok(!/^Heute 8° und trocken/.test(rainy.body), "nicht trocken genannt, wenn es regnet");

  const noHistory = buildMessage("start", ctx({}), [], null, 2);
  ok(noHistory.body.length > 20 && !/undefined|null|NaN/.test(noHistory.body), "ohne Historie und Wetter trotzdem sinnvoll: „" + noHistory.body + "“");

  const last = buildMessage("last", ctx({ left: 1, days: 1 }), ["Laufen"], dry, 3);
  ok(/20 €/.test(last.body), "am letzten Tag wird der Strafbetrag genannt: „" + last.body + "“");

  const social = buildMessage("start", ctx({ aheadOf: "Ben" }), [], null, 4);
  ok(typeof social.body === "string", "Gruppenlage kann einfliessen");

  let varied = new Set();
  for (let i = 0; i < 20; i++) varied.add(buildMessage("push", ctx({ left: 1 }), ["Laufen"], dry, i).body);
  ok(varied.size >= 3, varied.size + " verschiedene Formulierungen bei 20 Seeds");
  ok([...varied].every((b) => b.length <= 190), "Texte bleiben kurz genug für eine Benachrichtigung");
  ok([...varied].every((b) => !/undefined|NaN|\[object/.test(b)), "keine kaputten Platzhalter");

  console.log("\n== Zusammenspiel mit der Datenbank ==");
  const s0 = await api("state");
  for (const m of s0.data.members) await api("member/" + m.id, "DELETE");
  await api("settings", "POST", { required: 2, fine: 20, currency: "€", sickMax: 2, nudges: true, place: "", tz: "Europe/Berlin" });
  const anna = (await api("member", "POST", { name: "Anna" })).data.id;
  const ben = (await api("member", "POST", { name: "Ben" })).data.id;

  const monday = weekOf(new Date().toISOString().slice(0, 10));
  const thursday = new Date(Date.parse(monday) + 3 * 864e5).toISOString().slice(0, 10);
  const slotA = slotFor(anna, monday, "start");
  const dayA = new Date(Date.parse(monday) + ((slotA.dow + 6) % 7) * 864e5).toISOString().slice(0, 10);

  let res = await api("nudges", "POST", { now: atBerlin(dayA, slotA.hour) });
  ok(res.data.nudges.some((n) => n.member === "Anna"), "Anna ist in ihrem Zeitfenster dran");
  res = await api("nudges", "POST", { now: atBerlin(dayA, (slotA.hour + 3) % 24) });
  ok(!res.data.nudges.some((n) => n.member === "Anna"), "außerhalb des Zeitfensters passiert nichts");

  await api("entry", "POST", { member_id: anna, date: thursday, kind: "workout", sport: "Laufen", device: "x" });
  await api("entry", "POST", { member_id: anna, date: thursday, kind: "workout", sport: "Laufen", device: "x" });
  res = await api("nudges", "POST", { now: atBerlin(dayA, slotA.hour), force: "start" });
  ok(!res.data.nudges.some((n) => n.member === "Anna"), "wer sein Ziel hat, bekommt nichts");
  ok(res.data.nudges.some((n) => n.member === "Ben"), "Ben hat noch nichts und bekommt einen Schubs");

  console.log("\n== Nur einmal pro Woche ==");
  const slotB = slotFor(ben, monday, "start");
  const dayB = new Date(Date.parse(monday) + ((slotB.dow + 6) % 7) * 864e5).toISOString().slice(0, 10);
  await api("push/subscribe", "POST", {
    device: "nudge-ben", member_id: ben,
    sub: { endpoint: PUSH + "/ben", keys: { p256dh: dev.p256dh, auth: dev.authB64 } },
  });
  received.length = 0;
  let real = await api("nudges", "POST", { now: atBerlin(dayB, slotB.hour), send: true });
  await sleep(1200);
  ok(real.data.nudges.some((n) => n.member === "Ben"), "Schubs wird verschickt");
  ok(received.length === 1, "genau eine Benachrichtigung an Bens Ger\u00e4t");
  const text = await decrypt(dev, received[0].body);
  ok(text.title === "Das Programm" && text.body.length > 25 && !/undefined|NaN/.test(text.body),
     "Text kommt lesbar an: \u201E" + text.body + "\u201C");

  received.length = 0;
  real = await api("nudges", "POST", { now: atBerlin(dayB, slotB.hour), send: true });
  await sleep(1000);
  ok(real.data.nudges.length === 0 && received.length === 0, "in derselben Woche kommt kein zweiter");

  console.log("\n== Wetter (echte Open-Meteo-Antwort) ==");
  // workerd loest im Testcontainer keine Namen auf, deshalb hier direkt gegen die API.
  const mem = new Map();
  const fakeDb = {
    prepare(sql) {
      const self = { _args: [], bind(...a) { self._args = a; return self; },
        async first() { return sql.includes("SELECT v,exp FROM cache") ? mem.get(self._args[0]) || null : null; },
        async run() { if (sql.includes("INSERT OR REPLACE INTO cache")) mem.set(self._args[0], { v: self._args[1], exp: self._args[2] }); return {}; } };
      return self;
    },
  };
  const { geocode, forecast } = require("../nudge.js");
  const geo = await geocode(fakeDb, "M\u00fcnchen");
  ok(geo && Math.abs(geo.lat - 48.14) < 0.5 && Math.abs(geo.lon - 11.58) < 0.5,
     "Ortssuche liefert Koordinaten: " + JSON.stringify(geo));
  ok(mem.size === 1, "Ergebnis wird zwischengespeichert");
  const days = await forecast(fakeDb, geo, "Europe/Berlin");
  ok(Array.isArray(days) && days.length >= 3, (days || []).length + " Tage Vorhersage");
  ok(days.every((d) => /^\d{4}-\d{2}-\d{2}$/.test(d.date) && Number.isFinite(d.temp) && Number.isFinite(d.rain)),
     "Datum, Temperatur und Regenwahrscheinlichkeit sind brauchbar: " + JSON.stringify(days[0]));
  const wxMsg = buildMessage("start", ctx({}), ["Radfahren", "Krafttraining"], days, 7);
  ok(/\d+\u00b0|Regen|regnet|nass|Schnee|trocken/.test(wxMsg.body),
     "daraus wird ein Wetterhinweis: \u201E" + wxMsg.body + "\u201C");
  ok(await geocode(fakeDb, "Hier-gibt-es-keinen-Ort-xyz") === null, "unbekannter Ort liefert nichts");
  ok(await forecast(fakeDb, null, "Europe/Berlin") === null, "ohne Ort kein Wetter");

  await api("settings", "POST", { place: "Hier-gibt-es-keinen-Ort-xyz" });
  const noGeo = await api("nudges", "POST", { now: atBerlin(dayB, slotB.hour), force: "start" });
  ok(noGeo.data.nudges.length > 0, "nicht erreichbares Wetter legt die Nachricht nicht lahm");
  await api("settings", "POST", { place: "" });

  await api("settings", "POST", { nudges: false });
  res = await api("nudges", "POST", { now: atBerlin(dayA, slotA.hour) });
  ok(res.data.nudges.length === 0, "abgeschaltet wird gar nichts verschickt");
  await api("settings", "POST", { nudges: true });

  console.log(`\n${pass} ok, ${fail} fehlgeschlagen\n`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
