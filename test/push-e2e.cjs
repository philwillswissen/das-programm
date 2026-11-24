// Ende-zu-Ende: Eintrag anlegen -> Worker verschickt Push an alle anderen Geraete.
// Dafuer laeuft hier ein kleiner Push-Dienst, der die Nachricht wie ein Browser entschluesselt.
const http = require("node:http");
const { webcrypto: c } = require("node:crypto");
const BASE = process.env.BASE || "http://127.0.0.1:8787";
require("../scripts/guard.cjs").requireScratchTarget(BASE);

let pass = 0, fail = 0;
const ok = (x, m) => (x ? (pass++, console.log("  ✓ " + m)) : (fail++, console.log("  ✗ " + m)));
const b64u = { enc: b => Buffer.from(b).toString("base64url"), dec: s => new Uint8Array(Buffer.from(s, "base64url")) };
const PIN = process.env.PIN || "";
const api = (p, method = "GET", body) =>
  fetch(BASE + "/api/" + p, { method, headers: { "content-type": "application/json", "x-pin": PIN }, body: body ? JSON.stringify(body) : undefined })
    .then(async r => ({ status: r.status, data: await r.json().catch(() => null) }));

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

(async () => {
  const received = [];
  let respondWith = 201;
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on("data", d => chunks.push(d));
    req.on("end", () => {
      received.push({ path: req.url, headers: req.headers, body: Buffer.concat(chunks) });
      res.writeHead(respondWith); res.end();
    });
  });
  await new Promise(r => server.listen(8899, "127.0.0.1", r));
  const PUSH = "http://127.0.0.1:8899";

  // Aufraeumen
  const s0 = await api("state");
  for (const m of s0.data.members) await api("member/" + m.id, "DELETE");
  for (const d of ["devAnna", "devBen", "devChris"]) await api("push/unsubscribe", "POST", { device: d });

  const anna = (await api("member", "POST", { name: "Anna" })).data.id;
  const ben = (await api("member", "POST", { name: "Ben" })).data.id;
  const dAnna = await newDevice(), dBen = await newDevice();

  console.log("\n== Anmeldung ==");
  await api("push/subscribe", "POST", { device: "devAnna", member_id: anna, sub: { endpoint: PUSH + "/anna", keys: { p256dh: dAnna.p256dh, auth: dAnna.authB64 } } });
  await api("push/subscribe", "POST", { device: "devBen", member_id: ben, sub: { endpoint: PUSH + "/ben", keys: { p256dh: dBen.p256dh, auth: dBen.authB64 } } });
  ok(true, "zwei Geräte für Push angemeldet");

  console.log("\n== Neue Einheit -> Push an alle anderen ==");
  received.length = 0;
  await api("entry", "POST", { member_id: anna, kind: "workout", date: new Date().toISOString().slice(0, 10), sport: "Laufen", note: "10 km Lauf", device: "devAnna" });
  await new Promise(r => setTimeout(r, 1500));
  ok(received.length === 1, `genau eine Nachricht verschickt (${received.length})`);
  ok(received[0]?.path === "/ben", "Empfänger ist Bens Gerät, nicht das eintragende");
  ok(received[0]?.headers["content-encoding"] === "aes128gcm", "aes128gcm-Verschlüsselung");
  ok(/^vapid t=[\w-]+\.[\w-]+\.[\w-]+, k=[\w-]+$/.test(received[0]?.headers.authorization || ""), "gültiger VAPID-Authorization-Header");
  ok(received[0]?.headers.ttl === "86400", "TTL gesetzt");
  ok(received[0]?.headers.urgency === "high", "sofort ausliefern (Urgency high, nicht normal)");
  const msg = await decrypt(dBen, received[0].body);
  ok(msg.title === "Das Programm", "Titel der Benachrichtigung");
  ok(/Anna/.test(msg.body) && /Laufen/.test(msg.body),
     "Text nennt Person und Sportart: „" + msg.body + "“");
  ok(/\?|schau|zieh|zusammen|funke|fehl/i.test(msg.body), "und lädt zum Mitmachen ein");

  console.log("\n== Krankmeldung ==");
  received.length = 0;
  await api("entry", "POST", { member_id: ben, kind: "sick", units: 2, date: new Date().toISOString().slice(0, 10), device: "devBen" });
  await new Promise(r => setTimeout(r, 1500));
  ok(received.length === 1 && received[0].path === "/anna", "Krankmeldung geht an das andere Gerät");
  const krankText = (await decrypt(dAnna, received[0].body)).body;
  ok(/krankgemeldet/.test(krankText), "Text passt zur Krankmeldung: „" + krankText + "“");
  ok(/Besserung/.test(krankText), "und wünscht gute Besserung statt anzustacheln");

  console.log("\n== Eintrag für jemand anderen ==");
  received.length = 0;
  await api("entry", "POST", { member_id: ben, kind: "workout", date: new Date().toISOString().slice(0, 10), device: "devAnna" });
  await new Promise(r => setTimeout(r, 1500));
  ok(received.length === 1 && received[0].path === "/ben", "Ben wird benachrichtigt, obwohl Anna es eingetragen hat");

  console.log("\n== Abgelaufene Anmeldung wird aufgeräumt ==");
  respondWith = 410;
  received.length = 0;
  await api("entry", "POST", { member_id: anna, kind: "workout", date: new Date().toISOString().slice(0, 10), device: "devAnna" });
  await new Promise(r => setTimeout(r, 1500));
  ok(received.length === 1, "Versuch wurde unternommen");
  respondWith = 201;
  received.length = 0;
  await api("entry", "POST", { member_id: anna, kind: "workout", date: new Date().toISOString().slice(0, 10), device: "devAnna" });
  await new Promise(r => setTimeout(r, 1500));
  ok(received.length === 0, "tote Subscription wurde gelöscht und nicht erneut angefunkt");

  console.log("\n== Testbenachrichtigung ==");
  await api("push/subscribe", "POST", { device: "devBen", member_id: ben, sub: { endpoint: PUSH + "/ben", keys: { p256dh: dBen.p256dh, auth: dBen.authB64 } } });
  received.length = 0;
  const t = await api("push/test", "POST", { device: "devBen" });
  await new Promise(r => setTimeout(r, 800));
  ok(t.status === 200 && received.length === 1, "Testbenachrichtigung aus den Einstellungen funktioniert");
  ok((await decrypt(dBen, received[0].body)).body.includes("funktioniert"), "Testnachricht ist lesbar");

  console.log("\n== Abmelden ==");
  await api("push/unsubscribe", "POST", { device: "devBen" });
  received.length = 0;
  await api("entry", "POST", { member_id: anna, kind: "workout", date: new Date().toISOString().slice(0, 10), device: "devAnna" });
  await new Promise(r => setTimeout(r, 1200));
  ok(received.length === 0, "abgemeldetes Gerät bekommt nichts mehr");

  server.close();
  console.log(`\n${pass} ok, ${fail} fehlgeschlagen\n`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
