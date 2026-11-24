// Integrationstest gegen einen laufenden `wrangler dev` (Standard: http://127.0.0.1:8787)
const BASE = process.env.BASE || "http://127.0.0.1:8787";
const { createRequire } = await import("node:module");
createRequire(import.meta.url)("../scripts/guard.cjs").requireScratchTarget(BASE);

let pass = 0, fail = 0;
const ok = (c, m) => (c ? (pass++, console.log("  ✓ " + m)) : (fail++, console.log("  ✗ " + m)));

const PIN = process.env.PIN || "";
const call = async (p, method = "GET", body) => {
  const r = await fetch(BASE + "/api/" + p, {
    method, headers: { "content-type": "application/json", "x-pin": PIN },
    body: body ? JSON.stringify(body) : undefined,
  });
  let data = null;
  try { data = await r.clone().json(); } catch { data = await r.text(); }
  return { status: r.status, data };
};
const state = () => call("state").then(r => r.data);

console.log("\n== Grundgerüst ==");
await call("settings", "POST", { required: 2, fine: 20, currency: "€", sickMax: 2 });
let s = await state();
ok(s.settings.required === 2, "Einheiten pro Woche kommen zurück");
ok(s.settings.fine === 20, "Strafbetrag kommt zurück");
ok(/^\d{4}-\d{2}-\d{2}$/.test(s.settings.start), "Startdatum ist vorbelegt (" + s.settings.start + ")");
ok(Array.isArray(s.members), "Teilnehmerliste vorhanden");
ok(typeof s.vapidPublicKey === "string" && s.vapidPublicKey.length > 80, "VAPID Public Key wird ausgeliefert");

console.log("\n== Teilnehmer ==");
for (const m of s.members) await call("member/" + m.id, "DELETE");
for (const x of s.expenses) await call("expense/" + x.id, "DELETE");
const anna = (await call("member", "POST", { name: "Anna", joined: "2026-01-05" })).data.id;
const ben = (await call("member", "POST", { name: "Ben", joined: "2026-01-05" })).data.id;
ok(anna && ben, "zwei Teilnehmer angelegt");
ok((await call("member", "POST", { name: "   " })).status === 400, "leerer Name wird abgelehnt");
await call("member", "POST", { id: anna, name: "Anna B." });
ok((await state()).members.find(m => m.id === anna).name === "Anna B.", "Umbenennen funktioniert");

console.log("\n== Einstellungen ==");
await call("settings", "POST", { required: 2, fine: 20, currency: "€", start: "2026-01-05", sickMax: 2 });
s = await state();
ok(s.settings.start === "2026-01-05", "Startdatum gespeichert");
await call("settings", "POST", { required: 999 });
ok((await state()).settings.required === 21, "unsinnige Werte werden begrenzt");
await call("settings", "POST", { required: 2 });
ok((await call("settings", "POST", { start: "quatsch" })).status === 200, "ungültiges Datum stürzt nicht ab");
await call("settings", "POST", { start: "2026-01-05" });

console.log("\n== Einträge ==");
const today = new Date().toISOString().slice(0, 10);
ok((await call("entry", "POST", { member_id: 999999, date: today, kind: "workout" })).status === 400, "unbekannter Teilnehmer abgelehnt");
ok((await call("entry", "POST", { date: today, kind: "workout" })).status === 400, "fehlender Teilnehmer abgelehnt");
const e1 = await call("entry", "POST", { member_id: anna, date: today, kind: "workout", note: "8 km Laufen", device: "devA" });
ok(e1.status === 200 && e1.data.id, "Einheit angelegt");
await call("entry", "POST", { member_id: anna, date: today, kind: "workout", meta: { Distanz: "8,02 km", Dauer: "44 min" }, device: "devA" });
await call("entry", "POST", { member_id: ben, date: today, kind: "sick", units: 2, sport: "Laufen", device: "devB" });
s = await state();
ok(s.entries.length === 3, "drei Einträge in der Liste");
const sickEntry = s.entries.find(e => e.kind === "sick");
ok(sickEntry.units === 2, "Krankmeldung zählt 2 Einheiten");
ok(JSON.parse(s.entries.find(e => e.meta).meta).Distanz === "8,02 km", "GPX-Metadaten gespeichert");
ok(s.entries.find(e => e.kind === "sick").sport === null, "Krankmeldung bekommt keine Sportart");
const sporty = await call("entry", "POST", { member_id: anna, date: today, kind: "workout", sport: "Bouldern", device: "devA" });
ok((await state()).entries.find(e => e.id === sporty.data.id).sport === "Bouldern", "Sportart wird gespeichert");
await call("entry/" + sporty.data.id, "DELETE");
const longSport = await call("entry", "POST", { member_id: anna, date: today, kind: "workout", sport: "x".repeat(200), device: "devA" });
ok((await state()).entries.find(e => e.id === longSport.data.id).sport.length === 40, "überlange Sportart wird gekürzt");
await call("entry/" + longSport.data.id, "DELETE");
ok(s.entries.every(e => e.hasPhoto === 0 || e.hasPhoto === false), "ohne Foto kein Foto-Flag");

console.log("\n== Foto ==");
const tiny = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
const ep = await call("entry", "POST", { member_id: anna, date: today, kind: "workout", photo: tiny, device: "devA" });
const withPhoto = (await state()).entries.find(e => e.id === ep.data.id);
ok(!!withPhoto.hasPhoto, "Foto-Flag gesetzt");
const photoRes = await fetch(BASE + "/api/photo/" + ep.data.id, { headers: { "x-pin": PIN } });
ok((await photoRes.text()) === tiny, "Foto wird unverändert zurückgeliefert");
ok((await fetch(BASE + "/api/photo/999999", { headers: { "x-pin": PIN } })).status === 404, "unbekanntes Foto -> 404");
ok((await call("entry", "POST", { member_id: anna, date: today, kind: "workout", photo: "data:image/jpeg;base64," + "A".repeat(800000) })).status === 413, "zu großes Foto abgelehnt");
await call("entry/" + ep.data.id, "DELETE");

console.log("\n== Kasse ==");
await call("expense", "POST", { title: "Grillen", amount: 42.5, date: today });
ok((await state()).expenses[0].amount === 42.5, "Ausgabe gebucht");
ok((await call("expense", "POST", { title: "x", amount: 0 })).status === 400, "Betrag 0 abgelehnt");

console.log("\n== Push ==");
const sub = { endpoint: "https://fcm.googleapis.com/fcm/send/TEST", keys: { p256dh: "BN".padEnd(87, "x"), auth: "abc".padEnd(22, "y") } };
ok((await call("push/subscribe", "POST", { device: "devB", member_id: ben, sub })).status === 200, "Gerät meldet sich für Push an");
ok((await call("push/subscribe", "POST", { device: "devC" })).status === 400, "unvollständige Subscription abgelehnt");
ok((await call("push/test", "POST", { device: "devZ" })).status === 404, "Test für unbekanntes Gerät -> 404");
ok((await call("push/unsubscribe", "POST", { device: "devB" })).status === 200, "Abmelden funktioniert");

console.log("\n== Aufräumen / Fehlerfälle ==");
ok((await call("nichtda")).status === 404, "unbekannter Endpunkt -> 404");
const r = await fetch(BASE + "/api/entry", { method: "POST", headers: { "content-type": "application/json", "x-pin": PIN }, body: "{kaputt" });
ok(r.status === 400, "kaputter JSON-Body -> 400");
await call("member/" + ben, "DELETE");
s = await state();
ok(!s.members.some(m => m.id === ben), "Teilnehmer gelöscht");
ok(!s.entries.some(e => e.member_id === ben), "Einträge des Teilnehmers mit gelöscht");

if (PIN) {
  console.log("\n== Gruppen-PIN ==");
  const noPin = await fetch(BASE + "/api/state", { headers: { "x-pin": "" } });
  ok(noPin.status === 401, "ohne PIN kein Zugriff auf die Daten");
  const wrongPin = await fetch(BASE + "/api/state", { headers: { "x-pin": "falsch" } });
  ok(wrongPin.status === 401, "falsche PIN wird abgewiesen");
  ok((await fetch(BASE + "/")).status === 200, "die App selbst lädt trotzdem (PIN-Abfrage im Browser)");
}

console.log("\n== Statisches / PWA ==");
for (const [p, needle] of [["/", "Das Programm"], ["/manifest.json", "Das Programm"], ["/sw.js", "notificationclick"], ["/icon-192.png", null]]) {
  const res = await fetch(BASE + p);
  const okRes = res.ok && (needle ? (await res.text()).includes(needle) : (await res.arrayBuffer()).byteLength > 500);
  ok(okRes, p + " wird ausgeliefert");
}

console.log(`\n${pass} ok, ${fail} fehlgeschlagen\n`);
process.exit(fail ? 1 : 0);
