// Prüft die Web-Push-Verschlüsselung gegen den Testvektor aus RFC 8291, Abschnitt 5,
// und die VAPID-JWT-Signatur (RFC 8292). Läuft in Node und (via test/crypto-worker.js) in workerd.
import { sendPush, encrypt, b64u } from "../push.js";

export const VECTOR = {
  plaintext: "When I grow up, I want to be a watermelon",
  ua: {
    p256dh: "BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4",
    auth: "BTBZMqHH6r4Tts7J_aSIgg",
  },
  as: {
    d: "yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw",
    pub: "BP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A8",
  },
  salt: "DGv6ra1nlYgDCS1FRnbzlw",
  expected:
    "DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_yl95bQpu6cVPTpK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN",
};

// Baut eine crypto-Fassade, die statt Zufallswerten die Werte aus dem Testvektor liefert.
async function fixedCrypto(real) {
  const pub = b64u.dec(VECTOR.as.pub);
  const jwk = {
    kty: "EC", crv: "P-256", ext: true, d: VECTOR.as.d,
    x: b64u.enc(pub.slice(1, 33)), y: b64u.enc(pub.slice(33, 65)),
  };
  const priv = await real.subtle.importKey("jwk", jwk, { name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]);
  const { d, ...pubJwk } = jwk;
  const publicKey = await real.subtle.importKey("jwk", pubJwk, { name: "ECDH", namedCurve: "P-256" }, true, []);
  const salt = b64u.dec(VECTOR.salt);
  return {
    subtle: new Proxy(real.subtle, {
      get: (t, k) =>
        k === "generateKey"
          ? async () => ({ privateKey: priv, publicKey })
          : typeof t[k] === "function" ? t[k].bind(t) : t[k],
    }),
    getRandomValues: a => (a.length === 16 ? (a.set(salt), a) : real.getRandomValues(a)),
    randomUUID: () => real.randomUUID(),
  };
}

// Gegenprobe: entschluesselt wie ein Browser mit dem privaten Schluessel des Geraets.
async function decryptBack(body, uaPrivate, auth, uaPublicRaw, c) {
  const buf = new Uint8Array(body);
  const salt = buf.slice(0, 16), idlen = buf[20];
  const asPub = buf.slice(21, 21 + idlen), ct = buf.slice(21 + idlen);
  const asKey = await c.subtle.importKey("raw", asPub, { name: "ECDH", namedCurve: "P-256" }, false, []);
  const shared = new Uint8Array(await c.subtle.deriveBits({ name: "ECDH", public: asKey }, uaPrivate, 256));
  const te = new TextEncoder();
  const cat = (...p) => { const o = new Uint8Array(p.reduce((n, x) => n + x.length, 0)); let i = 0; for (const x of p) { o.set(x, i); i += x.length; } return o; };
  const hk = async (sl, ikm, info, len) => {
    const k = await c.subtle.importKey("raw", ikm, "HKDF", false, ["deriveBits"]);
    return new Uint8Array(await c.subtle.deriveBits({ name: "HKDF", hash: "SHA-256", salt: sl, info }, k, len * 8));
  };
  const ikm = await hk(auth, shared, cat(te.encode("WebPush: info"), new Uint8Array([0]), uaPublicRaw, asPub), 32);
  const cek = await hk(salt, ikm, cat(te.encode("Content-Encoding: aes128gcm"), new Uint8Array([0])), 16);
  const nonce = await hk(salt, ikm, cat(te.encode("Content-Encoding: nonce"), new Uint8Array([0])), 12);
  const key = await c.subtle.importKey("raw", cek, "AES-GCM", false, ["decrypt"]);
  const plain = new Uint8Array(await c.subtle.decrypt({ name: "AES-GCM", iv: nonce }, key, ct));
  let end = plain.length; while (end > 0 && plain[end - 1] === 0) end--;
  return plain.slice(0, end - 1); // 0x02-Delimiter entfernen
}

export async function runPushTests(log) {
  let pass = 0, fail = 0;
  const ok = (c, m) => (c ? (pass++, log("  ✓ " + m)) : (fail++, log("  ✗ " + m)));
  const realCrypto = globalThis.crypto;
  const realFetch = globalThis.fetch;
  const setCrypto = v => Object.defineProperty(globalThis, "crypto", { value: v, configurable: true, writable: true });

  // --- RFC 8291 Testvektor ---
  let captured = null;
  setCrypto(await fixedCrypto(realCrypto));
  globalThis.fetch = async (url, init) => { captured = { url, init }; return new Response("", { status: 201 }); };

  const pair = await realCrypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
  const env = {
    VAPID_PUBLIC: b64u.enc(await realCrypto.subtle.exportKey("raw", pair.publicKey)),
    VAPID_PRIVATE: (await realCrypto.subtle.exportKey("jwk", pair.privateKey)).d,
    VAPID_SUBJECT: "mailto:test@example.com",
  };
  // Verschluesselung direkt gegen den Vektor
  const vec = b64u.enc(await encrypt(VECTOR.ua.p256dh, VECTOR.ua.auth, VECTOR.plaintext));
  ok(vec === VECTOR.expected, "aes128gcm-Payload entspricht dem RFC-8291-Testvektor");
  if (vec !== VECTOR.expected) { log("    erwartet: " + VECTOR.expected); log("    bekommen: " + vec); }

  // Runde durch den ganzen Weg: verschluesseln und wie ein Browser wieder entschluesseln
  const ua = await realCrypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]);
  const uaRaw = new Uint8Array(await realCrypto.subtle.exportKey("raw", ua.publicKey));
  const uaAuth = realCrypto.getRandomValues(new Uint8Array(16));
  const msg = { title: "Das Programm", body: "Anna hat eine Einheit eingetragen.", tag: "entry-7" };
  const status = await sendPush(env, {
    endpoint: "https://push.example.net/push/abc",
    p256dh: b64u.enc(uaRaw), auth: b64u.enc(uaAuth),
  }, msg);

  ok(status === 201, "Status des Push-Dienstes wird durchgereicht");
  const back = new TextDecoder().decode(await decryptBack(captured.init.body, ua.privateKey, uaAuth, uaRaw, realCrypto));
  ok(back === JSON.stringify(msg), "Nachricht lässt sich mit dem Geräteschlüssel wieder entschlüsseln");
  if (back !== JSON.stringify(msg)) log("    bekommen: " + back);

  const h = captured.init.headers;
  ok(h["content-encoding"] === "aes128gcm", "Header content-encoding: aes128gcm");
  ok(h["content-type"] === "application/octet-stream", "Header content-type");
  ok(h.ttl === "86400", "Header TTL");
  ok(h.authorization.startsWith("vapid t=") && h.authorization.includes(", k=" + env.VAPID_PUBLIC), "Authorization: vapid t=…, k=…");

  // --- VAPID-JWT prüfen ---
  setCrypto(realCrypto);
  const jwt = h.authorization.slice("vapid t=".length).split(",")[0];
  const [head, payload, sig] = jwt.split(".");
  const dec = s => JSON.parse(new TextDecoder().decode(b64u.dec(s)));
  ok(dec(head).alg === "ES256" && dec(head).typ === "JWT", "JWT-Header ES256");
  const p = dec(payload);
  ok(p.aud === "https://push.example.net", "JWT aud = Origin des Push-Dienstes");
  ok(p.sub === "mailto:test@example.com", "JWT sub aus VAPID_SUBJECT");
  ok(p.exp > Date.now() / 1000 && p.exp <= Date.now() / 1000 + 24 * 3600, "JWT exp innerhalb von 24 h");

  const raw = b64u.dec(env.VAPID_PUBLIC);
  const verifyKey = await realCrypto.subtle.importKey("jwk",
    { kty: "EC", crv: "P-256", x: b64u.enc(raw.slice(1, 33)), y: b64u.enc(raw.slice(33, 65)) },
    { name: "ECDSA", namedCurve: "P-256" }, false, ["verify"]);
  const valid = await realCrypto.subtle.verify({ name: "ECDSA", hash: "SHA-256" }, verifyKey,
    b64u.dec(sig), new TextEncoder().encode(head + "." + payload));
  ok(valid, "JWT-Signatur ist mit dem VAPID-Public-Key verifizierbar");

  // --- Zufälligkeit: zwei Aufrufe dürfen nie dasselbe ergeben ---
  globalThis.fetch = async (url, init) => { captured = { url, init }; return new Response("", { status: 201 }); };
  const bodies = [];
  for (let i = 0; i < 2; i++) {
    await sendPush(env, { endpoint: "https://push.example.net/x", p256dh: VECTOR.ua.p256dh, auth: VECTOR.ua.auth }, "hallo");
    bodies.push(b64u.enc(new Uint8Array(captured.init.body)));
  }
  ok(bodies[0] !== bodies[1], "jede Nachricht nutzt frischen Schlüssel und Salt");
  ok(new Uint8Array(captured.init.body).length > 86, "Payload enthält Header (21 B) + Schlüssel (65 B) + Ciphertext");

  setCrypto(realCrypto);
  globalThis.fetch = realFetch;
  return { pass, fail };
}

if (typeof process !== "undefined" && process.argv && import.meta.url === "file://" + process.argv[1]) {
  console.log("\n== Web Push (RFC 8291 / 8292) – Node ==");
  const r = await runPushTests(console.log);
  console.log(`\n${r.pass} ok, ${r.fail} fehlgeschlagen\n`);
  process.exit(r.fail ? 1 : 0);
}
