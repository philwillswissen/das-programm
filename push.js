// Web Push (VAPID + RFC 8188 aes128gcm / RFC 8291) – ohne Abhaengigkeiten, laeuft in Workers.
const te = new TextEncoder();

export const b64u = {
  dec(s) {
    s = String(s).replace(/-/g, "+").replace(/_/g, "/");
    const raw = atob(s + "=".repeat((4 - (s.length % 4)) % 4));
    const a = new Uint8Array(raw.length);
    for (let i = 0; i < raw.length; i++) a[i] = raw.charCodeAt(i);
    return a;
  },
  enc(buf) {
    const a = new Uint8Array(buf);
    let s = "";
    for (let i = 0; i < a.length; i++) s += String.fromCharCode(a[i]);
    return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  },
};

const cat = (...parts) => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
};

const hkdf = async (salt, ikm, info, bytes) => {
  const key = await crypto.subtle.importKey("raw", ikm, "HKDF", false, ["deriveBits"]);
  return new Uint8Array(await crypto.subtle.deriveBits(
    { name: "HKDF", hash: "SHA-256", salt, info }, key, bytes * 8));
};

async function vapidJwt(audience, subject, env) {
  const pub = b64u.dec(env.VAPID_PUBLIC);
  const jwk = {
    kty: "EC", crv: "P-256", ext: true,
    d: env.VAPID_PRIVATE.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, ""),
    x: b64u.enc(pub.slice(1, 33)), y: b64u.enc(pub.slice(33, 65)),
  };
  const key = await crypto.subtle.importKey("jwk", jwk, { name: "ECDSA", namedCurve: "P-256" }, false, ["sign"]);
  const head = b64u.enc(te.encode(JSON.stringify({ typ: "JWT", alg: "ES256" })));
  const body = b64u.enc(te.encode(JSON.stringify({
    aud: audience, exp: Math.floor(Date.now() / 1000) + 12 * 3600, sub: subject,
  })));
  const data = head + "." + body;
  const sig = await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, key, te.encode(data));
  return data + "." + b64u.enc(sig);
}

export async function encrypt(p256dh, auth, plaintext) {
  const ua = b64u.dec(p256dh);
  const as = await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]);
  const asPub = new Uint8Array(await crypto.subtle.exportKey("raw", as.publicKey));
  const uaKey = await crypto.subtle.importKey("raw", ua, { name: "ECDH", namedCurve: "P-256" }, false, []);
  const shared = new Uint8Array(await crypto.subtle.deriveBits({ name: "ECDH", public: uaKey }, as.privateKey, 256));

  const ikm = await hkdf(b64u.dec(auth), shared,
    cat(te.encode("WebPush: info"), new Uint8Array([0]), ua, asPub), 32);
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const cek = await hkdf(salt, ikm, cat(te.encode("Content-Encoding: aes128gcm"), new Uint8Array([0])), 16);
  const nonce = await hkdf(salt, ikm, cat(te.encode("Content-Encoding: nonce"), new Uint8Array([0])), 12);

  const aes = await crypto.subtle.importKey("raw", cek, "AES-GCM", false, ["encrypt"]);
  const padded = cat(te.encode(plaintext), new Uint8Array([2])); // 0x02 = letzter Record
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv: nonce }, aes, padded));

  const header = new Uint8Array(21 + 65);
  header.set(salt, 0);
  new DataView(header.buffer).setUint32(16, 4096);
  header[20] = 65;
  header.set(asPub, 21);
  return cat(header, ct);
}

// Liefert den HTTP-Status des Push-Dienstes (410/404 => Subscription ist tot).
export async function sendPush(env, sub, message) {
  const jwt = await vapidJwt(new URL(sub.endpoint).origin, env.VAPID_SUBJECT || "mailto:push@das-programm.app", env);
  const body = await encrypt(sub.p256dh, sub.auth, JSON.stringify(message));
  const res = await fetch(sub.endpoint, {
    method: "POST",
    headers: {
      "content-encoding": "aes128gcm",
      "content-type": "application/octet-stream",
      ttl: "86400",
      urgency: "normal",
      authorization: `vapid t=${jwt}, k=${env.VAPID_PUBLIC}`,
    },
    body,
  });
  return res.status;
}
