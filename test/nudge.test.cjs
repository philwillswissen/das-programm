// Motivationsnachrichten: Zeitfenster, Einmaligkeit, Personalisierung, Wetter.
const BASE = process.env.BASE || "http://127.0.0.1:8787";
require("../scripts/guard.cjs").requireScratchTarget(BASE);

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

  console.log("\n== Meldung über einen neuen Eintrag ==");
  const { entryMessage } = require("../nudge.js");
  const radMeta = { Distanz: "32,40 km", Dauer: "1:12 h", Anstieg: "140 hm" };
  const texte = [];
  for (let i = 0; i < 24; i++)
    texte.push(entryMessage({ who: "Philipp", kind: "workout", sport: "Radfahren", meta: radMeta, seed: i * 7 }));
  const verschieden = new Set(texte);
  ok(verschieden.size >= 6, verschieden.size + " verschiedene Formulierungen bei 24 Seeds");
  ok(texte.every((t) => t.includes("Philipp") && t.includes("Radfahren")), "immer mit Person und Sportart");
  ok(texte.every((t) => t.includes("32,40 km in 1:12 h")), "die Werte der Einheit stehen drin");
  ok(texte.every((t) => /\?|Schau|Zieh|zieht|zusammen|Funke|Lust/i.test(t)), "jede Fassung lädt zum Mitmachen ein");
  ok(texte.every((t) => t.length <= 190), "und bleibt kurz genug fürs Banner (längste " +
     Math.max(...texte.map((t) => t.length)) + ")");
  ok(texte.every((t) => !/undefined|NaN|\[object/.test(t)), "keine kaputten Platzhalter");

  // Niemanden falsch bezeichnen: keine Fürwörter über die eintragende Person.
  // ("ihr" als Anrede an die Gruppe ist in Ordnung - gemeint sind er/sie/ihm/sein.)
  const falschesWort = texte.filter((t) => /\b(er|ihn|ihm|sie|seine?[mnrs]?|ihre?[mnrs]?)\b(?! beide)/i.test(t)
    && !/\bihr beide\b/i.test(t));
  ok(falschesWort.length === 0,
     "keine Fürwörter, die jemanden falsch bezeichnen würden" + (falschesWort.length ? ": „" + falschesWort[0] + "“" : ""));

  ok(entryMessage({ who: "Anna", kind: "workout", sport: "Laufen", seed: 2 }).includes("Laufen"),
     "ohne Messwerte geht es auch");
  const mitKommentar = entryMessage({ who: "Anna", kind: "workout", sport: "Yoga", note: "endlich wieder", seed: 1 });
  ok(mitKommentar.includes("endlich wieder"), "ohne Werte wird der Kommentar gezeigt: „" + mitKommentar + "“");
  const krank = entryMessage({ who: "Franz", kind: "sick", seed: 1 });
  ok(/Besserung/.test(krank) && !/Zieh|Lust|Funke/.test(krank),
     "bei einer Krankmeldung wird niemand angestachelt: „" + krank + "“");
  console.log("\n== Gemeinsamer Sport wird gefeiert ==");
  const gemeinsam = [];
  for (let i = 0; i < 20; i++)
    gemeinsam.push(entryMessage({ who: "Franz und Svenja", kind: "workout", sport: "Bouldern", crew: 2, seed: i * 5 }));
  ok(gemeinsam.every((t) => /\u{1F64C}/u.test(t)), "jede Fassung feiert es sichtbar");
  ok(gemeinsam.every((t) => /zusammen|Gemeinsame|zu zweit|durchgezogen/i.test(t)), "und sagt, dass sie zusammen waren");
  ok(gemeinsam.every((t) => /n\u00e4chste|dabei|anschlie\u00dft|mit dir/i.test(t)),
     "jede lädt zum Mitmachen beim nächsten Mal ein");
  ok(new Set(gemeinsam).size >= 5, new Set(gemeinsam).size + " verschiedene Fassungen");
  ok(gemeinsam.every((t) => t.length <= 190), "und alle kurz genug (längste " + Math.max(...gemeinsam.map((t) => t.length)) + ")");
  const zuViert = entryMessage({ who: "A, B, C und D", kind: "workout", sport: "Laufen", crew: 4, seed: 2 });
  ok(/viert|zusammen|Gemeinsame|durchgezogen/i.test(zuViert), "auch zu viert: „" + zuViert + "“");

  // Wer selbst dabei war, braucht keine Einladung - nur die Bestätigung.
  const selbstDabei = [];
  for (let i = 0; i < 9; i++)
    selbstDabei.push(entryMessage({ who: "Franz und Svenja", kind: "workout", sport: "Bouldern", crew: 2, yours: true, seed: i * 3 }));
  ok(selbstDabei.every((t) => /z\u00e4hlt/i.test(t)), "wer dabei war, erfährt, dass es für ihn zählt");
  ok(selbstDabei.every((t) => !/n\u00e4chste Mal dabei|wer schlie\u00dft/i.test(t)),
     "und wird nicht eingeladen, wo er schon war: „" + selbstDabei[0] + "“");
  const gemeinsamHinten = entryMessage({ who: "F und S", kind: "workout", sport: "Schwimmen", crew: 2, behind: 1, seed: 2 });
  ok(/fehl/i.test(gemeinsamHinten) && /\u{1F64C}/u.test(gemeinsamHinten),
     "auch mit Rückstand bleibt die Feier: „" + gemeinsamHinten + "“");
  const hinterher = entryMessage({ who: "Simone", kind: "workout", sport: "Laufen", behind: 1, seed: 3 });
  ok(/fehl/i.test(hinterher) && !/Funke/.test(hinterher),
     "wer hinterherhinkt, wird direkt angesprochen statt allgemein: „" + hinterher + "“");
  ok(/zwei|2/.test(entryMessage({ who: "S", kind: "workout", sport: "Laufen", behind: 2, seed: 1 })),
     "bei zwei fehlenden Einheiten steht die Zahl drin");
  ok(!/war Krafttraining/.test(entryMessage({ who: "A", kind: "workout", sport: "Krafttraining", seed: 4 })),
     "„war Krafttraining“ wird vermieden, „war Laufen“ nicht");

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

  console.log("\n== Wetter ==");
  // workerd loest im Testcontainer keine Namen auf, deshalb hier direkt.
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

  // Aufgezeichnete Antwort: prueft die Auswertung unabhaengig vom Netz.
  const canned = {
    daily: {
      time: ["2026-11-24", "2026-11-25", "2026-11-26", "2026-11-27"],
      weather_code: [61, 3, 1, 71],
      temperature_2m_max: [8.4, 11.2, 14.9, -1.3],
      precipitation_probability_max: [85, 20, 5, 60],
    },
  };
  const canFetch = async () => ({ ok: true, json: async () => canned });
  const days = await forecast(fakeDb, { lat: 48.14, lon: 11.58 }, "Europe/Berlin", canFetch);
  ok(days.length === 4, "vier Tage aus der Antwort gelesen (" + days.length + ")");
  ok(days[0].temp === 8 && days[0].rain === 85 && days[0].code === 61, "Werte des ersten Tages: " + JSON.stringify(days[0]));
  ok(days.every((d) => /^\d{4}-\d{2}-\d{2}$/.test(d.date)), "jeder Tag hat ein brauchbares Datum");

  const nass = buildMessage("start", ctx({}), ["Radfahren", "Krafttraining"], days, 7);
  ok(/Regen|regnet|nass|drinnen|Krafttraining/.test(nass.body), "bei 85 % Regen wird etwas drinnen vorgeschlagen: \u201E" + nass.body + "\u201C");
  const schnee = buildMessage("start", ctx({}), ["Laufen"], days.slice(3), 3);
  ok(/Schnee/.test(schnee.body), "Schneecode wird als Schnee erkannt: \u201E" + schnee.body + "\u201C");
  const trocken = buildMessage("start", ctx({}), ["Radfahren"], days.slice(2), 1);
  ok(/trocken|14\u00b0/.test(trocken.body), "trockener Tag wird auch so genannt: \u201E" + trocken.body + "\u201C");

  ok(await forecast(fakeDb, null, "Europe/Berlin", canFetch) === null, "ohne Ort kein Wetter");
  const kaputt = await forecast({ prepare: fakeDb.prepare }, { lat: 1, lon: 1 }, "Europe/Berlin",
    async () => ({ ok: false, status: 500, json: async () => ({}) }));
  ok(kaputt === null, "eine Stoerung beim Wetterdienst liefert einfach nichts");

  // Stichprobe gegen den echten Dienst - ein Netzfehler ist kein Fehler im Code.
  mem.clear();
  try {
    const geo = await geocode(fakeDb, "M\u00fcnchen");
    const echt = geo && await forecast(fakeDb, geo, "Europe/Berlin");
    if (echt?.length) {
      ok(Math.abs(geo.lat - 48.14) < 0.5, "Stichprobe: Ortssuche liefert M\u00fcnchen (" + geo.lat + ", " + geo.lon + ")");
      ok(Number.isFinite(echt[0].temp), "Stichprobe: echte Vorhersage ist brauchbar (" + JSON.stringify(echt[0]) + ")");
    } else {
      console.log("  \u2013 Stichprobe gegen Open-Meteo \u00fcbersprungen (nicht erreichbar)");
    }
  } catch (e) {
    console.log("  \u2013 Stichprobe gegen Open-Meteo \u00fcbersprungen: " + String(e.message || e));
  }

  console.log("\n== Standardort ==");
  const st0 = (await api("state")).data.settings;
  ok(st0.place === "N\u00fcrnberg", "ohne eigenen Standort rechnet die App mit N\u00fcrnberg (" + st0.place + ")");
  await api("settings", "POST", { place: "" });
  ok((await api("state")).data.settings.place === "N\u00fcrnberg",
     "ein leer gespeicherter Ort hebelt den Standardort nicht aus");

  await api("settings", "POST", { place: "Hier-gibt-es-keinen-Ort-xyz" });
  const noGeo = await api("nudges", "POST", { now: atBerlin(dayB, slotB.hour), force: "start" });
  ok(noGeo.data.nudges.length > 0, "nicht erreichbares Wetter legt die Nachricht nicht lahm");
  await api("settings", "POST", { place: "N\u00fcrnberg" });

  await api("settings", "POST", { nudges: false });
  res = await api("nudges", "POST", { now: atBerlin(dayA, slotA.hour) });
  ok(res.data.nudges.length === 0, "abgeschaltet wird gar nichts verschickt");
  await api("settings", "POST", { nudges: true });

  console.log(`\n${pass} ok, ${fail} fehlgeschlagen\n`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
