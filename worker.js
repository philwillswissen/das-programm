import { sendPush, b64u } from "./push.js";
import { localParts, slotFor, favourites, buildMessage, entryMessage, geocode, forecast, behindHint } from "./nudge.js";
import { settle } from "./stats.js";
import * as icu from "./icu.js";
import { report } from "./report.js";
import indexHtml from "./public/index.html";
import swJs from "./public/sw.js";
import manifestJson from "./public/manifest.json";
import iconSvg from "./public/icon.svg";
import icon192 from "./public/icon-192.png";
import icon512 from "./public/icon-512.png";
import iconMaskable from "./public/icon-maskable.png";

const HTML = "text/html; charset=utf-8";

// Jede Datei bekommt ein ETag aus ihrem Inhalt. Gecacht wird mit Rueckfrage:
// unveraenderte Dateien kosten nur ein 304, geaenderte sind sofort da.
// (Vorher lagen die Icons mit "immutable" ein Jahr im Browsercache - ein
// neues Logo waere bei niemandem angekommen.)
function etagOf(data) {
  const bytes = typeof data === "string" ? new TextEncoder().encode(data) : new Uint8Array(data);
  let a = 2166136261, b = 1099511628;
  for (let i = 0; i < bytes.length; i++) {
    a = Math.imul(a ^ bytes[i], 16777619);
    b = Math.imul((b + bytes[i]) ^ (b >>> 7), 2654435761);
  }
  return `"${(a >>> 0).toString(36)}${(b >>> 0).toString(36)}${bytes.length.toString(36)}"`;
}

// Die Icons werden unter /icon.svg?v=... verlinkt. Aendert sich das Zeichen,
// aendert sich die Adresse - sonst haelt ein Browser, der die alte Datei schon
// als "unveraenderlich" gespeichert hat, sie fuer immer fest.
const ICON_V = etagOf(iconSvg).replace(/"/g, "").slice(0, 10);
const withVersion = (text) => text.split("__V__").join(ICON_V);

const ASSETS = Object.fromEntries(
  Object.entries({
    "/index.html": [withVersion(indexHtml), HTML],
    "/sw.js": [withVersion(swJs), "text/javascript; charset=utf-8"],
    "/manifest.json": [withVersion(manifestJson), "application/manifest+json; charset=utf-8"],
    "/icon.svg": [iconSvg, "image/svg+xml"],
    "/icon-192.png": [icon192, "image/png"],
    "/icon-512.png": [icon512, "image/png"],
    "/icon-maskable.png": [iconMaskable, "image/png"],
  }).map(([path, [body, type]]) => [path, { body, type, etag: etagOf(body) }])
);

function serveAsset(path, req) {
  const hit = ASSETS[path === "/" ? "/index.html" : path] || ASSETS["/index.html"];
  const headers = {
    "content-type": hit.type,
    "cache-control": "no-cache",
    etag: hit.etag,
  };
  if (path === "/sw.js") headers["service-worker-allowed"] = "/";
  // Der Rand komprimiert und schwaecht dabei das ETag ("W/..."), manchmal faellt es ganz weg.
  const asked = (req?.headers.get("if-none-match") || "")
    .split(",").map((t) => t.trim().replace(/^W\//, ""));
  if (asked.includes(hit.etag)) return new Response(null, { status: 304, headers });
  return new Response(hit.body, { headers });
}

const SCHEMA = [
  "CREATE TABLE IF NOT EXISTS members(id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, joined TEXT)",
  "CREATE TABLE IF NOT EXISTS entries(id INTEGER PRIMARY KEY AUTOINCREMENT, member_id INTEGER NOT NULL, date TEXT NOT NULL, kind TEXT NOT NULL, units INTEGER DEFAULT 1, sport TEXT, note TEXT, meta TEXT, photo TEXT, created TEXT)",
  "CREATE TABLE IF NOT EXISTS expenses(id INTEGER PRIMARY KEY AUTOINCREMENT, date TEXT, title TEXT, amount REAL)",
  "CREATE TABLE IF NOT EXISTS settings(k TEXT PRIMARY KEY, v TEXT)",
  "CREATE TABLE IF NOT EXISTS subs(device TEXT PRIMARY KEY, member_id INTEGER, endpoint TEXT NOT NULL, p256dh TEXT NOT NULL, auth TEXT NOT NULL, created TEXT)",
  "CREATE INDEX IF NOT EXISTS idx_entries_member ON entries(member_id, date)",
  "CREATE TABLE IF NOT EXISTS nudges(member_id INTEGER, week TEXT, kind TEXT, sent TEXT, PRIMARY KEY(member_id, week, kind))",
  "CREATE TABLE IF NOT EXISTS cache(k TEXT PRIMARY KEY, v TEXT, exp INTEGER)",
  "CREATE TABLE IF NOT EXISTS plans(id INTEGER PRIMARY KEY AUTOINCREMENT, member_id INTEGER NOT NULL, sport TEXT, date TEXT NOT NULL, time TEXT, note TEXT, created TEXT)",
  "CREATE TABLE IF NOT EXISTS plan_joins(plan_id INTEGER NOT NULL, member_id INTEGER NOT NULL, PRIMARY KEY(plan_id, member_id))",
  "CREATE TABLE IF NOT EXISTS events(id INTEGER PRIMARY KEY AUTOINCREMENT, member_id INTEGER, date TEXT NOT NULL, kind TEXT, text TEXT, created TEXT)",
  // Eine Verbindung je Person. Der Schluessel verlaesst die Datenbank nie.
  "CREATE TABLE IF NOT EXISTS links(member_id INTEGER PRIMARY KEY, athlete_id TEXT NOT NULL, api_key TEXT NOT NULL, name TEXT, last_check TEXT, connected TEXT)",
];

const DEFAULTS = { required: 2, fine: 20, currency: "€", start: "", sickMax: 2, nudges: 1, place: "Nürnberg", tz: "Europe/Berlin", bonus: 0, bonusCost: 3, bonusSince: "" };
const KINDS = ["workout", "sick"];
const MAX_PHOTO = 700000;
// Kürzere Einheiten werden beim automatischen Import übergangen.
const IMPORT_MIN_MINUTES = 20;

const json = (data, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });

const today = () => new Date().toISOString().slice(0, 10);
const isDate = (s) => typeof s === "string" && /^\d{4}-\d{2}-\d{2}$/.test(s) && !isNaN(Date.parse(s));
const clean = (s, max) => String(s ?? "").replace(/\s+/g, " ").trim().slice(0, max);

// Nachträgliche Spalten: SQLite kennt kein ADD COLUMN IF NOT EXISTS,
// ein zweiter Versuch scheitert also und wird bewusst verschluckt.
const ALTERS = [
  "ALTER TABLE entries ADD COLUMN sport TEXT",
  "ALTER TABLE entries ADD COLUMN group_id TEXT",
  "ALTER TABLE entries ADD COLUMN ext_id TEXT",
  "ALTER TABLE expenses ADD COLUMN member_id INTEGER",
  "ALTER TABLE members ADD COLUMN lat REAL",
  "ALTER TABLE members ADD COLUMN lon REAL",
  "CREATE UNIQUE INDEX IF NOT EXISTS idx_entries_ext ON entries(ext_id) WHERE ext_id IS NOT NULL",
];

let migrated;
async function migrate(db) {
  if (!migrated) {
    migrated = db
      .batch(SCHEMA.map((s) => db.prepare(s)))
      .then(() => Promise.all(ALTERS.map((a) => db.prepare(a).run().catch(() => {}))))
      .catch((e) => {
        migrated = null;
        throw e;
      });
  }
  await migrated;
}

async function loadSettings(db) {
  const out = { ...DEFAULTS, start: weekOf(today()) };
  const { results } = await db.prepare("SELECT k,v FROM settings").all();
  for (const row of results) {
    // Abgeschaffte Einstellungen bleiben in der Datenbank liegen - hier enden sie.
    if (!(row.k in DEFAULTS)) continue;
    try { out[row.k] = JSON.parse(row.v); } catch {}
  }
  // Ein leer gespeicherter Ort soll nicht den Standardort aushebeln.
  if (!out.place) out.place = DEFAULTS.place;
  return out;
}

// Montag der Woche (UTC-stabil)
function weekOf(dateStr) {
  const d = new Date(dateStr + "T12:00:00Z");
  d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7));
  return d.toISOString().slice(0, 10);
}

// Wie weit jemand diese Woche ist - fuer den dezenten Zusatz in fremden Meldungen.
async function weekStanding(db) {
  const week = weekOf(today());
  const [settings, rows] = await Promise.all([
    loadSettings(db),
    db.prepare("SELECT member_id,kind,units FROM entries WHERE date >= ?").bind(week).all().then((r) => r.results),
  ]);
  const required = Number(settings.required) || 2;
  const sickMax = settings.sickMax ?? required;
  const per = new Map();
  for (const e of rows) {
    const cur = per.get(e.member_id) || { done: 0, sick: 0 };
    if (e.kind === "sick") cur.sick += e.units || 1; else cur.done++;
    per.set(e.member_id, cur);
  }
  const credit = (id) => { const c = per.get(id) || { done: 0, sick: 0 }; return c.done + Math.min(c.sick, sickMax); };
  return { required, credit };
}

async function notify(env, db, entry, who, fromDevice) {
  if (!env.VAPID_PUBLIC || !env.VAPID_PRIVATE) return;
  const { results } = await db
    .prepare("SELECT * FROM subs WHERE device != ?")
    .bind(fromDevice || "")
    .all();
  if (!results.length) return;

  // Wie weit der Empfänger selbst ist - ab Wochenmitte wird das erwähnt.
  let missing = () => 0;
  if (entry.kind !== "sick") {
    try {
      const { required, credit } = await weekStanding(db);
      const dow = (new Date().getUTCDay() + 6) % 7; // 0 = Montag
      missing = (memberId) =>
        behindHint({ dow, required, credit: credit(memberId), recipientId: memberId, authorId: entry.member_id })
          ? Math.max(0, required - credit(memberId))
          : 0;
    } catch (e) { console.log("Wochenstand nicht lesbar", String(e)); }
  }

  await Promise.all(
    results.map(async (s) => {
      try {
        const status = await sendPush(env, s, {
          title: "Das Programm",
          body: entryMessage({
            who,
            kind: entry.kind,
            sport: entry.sport,
            note: entry.note,
            meta: entry.meta,
            crew: entry.crew || 1,
            yours: !!(entry.crewIds && s.member_id && entry.crewIds.includes(s.member_id)),
            behind: missing(s.member_id),
            // Pro Eintrag und Empfänger ein anderer Text, aber stabil.
            seed: ((entry.id || 0) * 2654435761 + (s.member_id || 0) * 97) >>> 0,
          }),
          tag: "entry-" + entry.id,
          url: "/#feed",
        });
        if (status === 404 || status === 410) {
          await db.prepare("DELETE FROM subs WHERE device=?").bind(s.device).run();
        }
      } catch (e) {
        console.log("push failed", s.device, String(e));
      }
    })
  );
}

// Benachrichtigung zu einem Vorschlag fuer eine gemeinsame Einheit.
async function notifyPlan(env, db, plan, proposer, fromDevice) {
  if (!env.VAPID_PUBLIC || !env.VAPID_PRIVATE) return;
  const { results } = await db.prepare("SELECT * FROM subs WHERE device != ?").bind(fromDevice || "").all();
  const when = plan.time ? `${plan.dateText} um ${plan.time}` : plan.dateText;
  const body = `${proposer} schlägt ${plan.sport || "eine Einheit"} vor – ${when}. Wer ist dabei?`;
  await Promise.all(results.map(async (s) => {
    try {
      const status = await sendPush(env, s, { title: "Das Programm", body, tag: "plan-" + plan.id, url: "/#feed" });
      if (status === 404 || status === 410) await db.prepare("DELETE FROM subs WHERE device=?").bind(s.device).run();
    } catch (e) { console.log("push failed", s.device, String(e)); }
  }));
}

export default {
  // Stuendlich; wer dran ist, entscheidet runNudges anhand der lokalen Zeit.
  async scheduled(event, env, ctx) {
    if (!env.DB) return;
    const when = new Date(event.scheduledTime || Date.now());
    ctx.waitUntil(
      migrate(env.DB)
        .then(async () => {
          const found = await syncAll(env, env.DB, null);
          if (found.length) console.log("Importiert", JSON.stringify(found));
          const sent = await runNudges(env, env.DB, when);
          if (sent.length) console.log("Nudges", JSON.stringify(sent.map((x) => x.member + ": " + x.body)));
          const settings = await env.DB.prepare("SELECT v FROM settings WHERE k='tz'").first().catch(() => null);
          let tz = "Europe/Berlin";
          try { if (settings?.v) tz = JSON.parse(settings.v) || tz; } catch {}
          const here = localParts(when, tz);
          if (here.dow === 0 && here.hour === 20) {
            const books = await bonusReport(env, env.DB, when);
            if (books.length) console.log("Guthaben", JSON.stringify(books.map((x) => x.member)));
          }
        })
        .catch((e) => console.log("Nudge-Lauf fehlgeschlagen", String(e?.stack || e)))
    );
  },

  async fetch(req, env, ctx) {
    const url = new URL(req.url);
    const path = url.pathname;
    const method = req.method;

    if (!path.startsWith("/api/")) {
      if (method !== "GET" && method !== "HEAD") return new Response("Method not allowed", { status: 405 });
      return serveAsset(path, req);
    }
    if (!env.DB) return json({ error: "Keine D1-Datenbank gebunden (wrangler.toml)." }, 500);
    const pinOf = v => String(v || "").trim().toLowerCase();
    if (env.PIN && pinOf(req.headers.get("x-pin")) !== pinOf(env.PIN)) return json({ error: "pin" }, 401);

    const db = env.DB;
    try {
      await migrate(db);
      let body = {};
      if (method === "POST") {
        try {
          body = (await req.json()) || {};
        } catch {
          return json({ error: "Ungültiger Request-Body." }, 400);
        }
      }

      // --- Gesamtzustand ---
      if (path === "/api/state" && method === "GET") {
        const all = (sql) => db.prepare(sql).all().then((r) => r.results);
        const settings = await loadSettings(db);
        const [members, entries, expenses, plans, joins, events, links] = await Promise.all([
          all("SELECT id,name,joined,(lat IS NOT NULL) AS hasGeo FROM members ORDER BY id"),
          all(
            "SELECT id,member_id,date,kind,units,sport,note,meta,created,group_id,(photo IS NOT NULL) AS hasPhoto FROM entries ORDER BY date DESC, id DESC"
          ),
          all("SELECT id,date,title,amount,member_id FROM expenses ORDER BY date DESC, id DESC"),
          all("SELECT id,member_id,sport,date,time,note FROM plans WHERE date >= date('now','-1 day') ORDER BY date, time"),
          all("SELECT plan_id,member_id FROM plan_joins"),
          all("SELECT id,member_id,date,kind,text FROM events ORDER BY date DESC, id DESC LIMIT 60"),
          all("SELECT member_id,name,last_check,connected FROM links"),
        ]);
        return json({
          settings,
          members,
          entries,
          expenses,
          plans: plans.map((p) => ({ ...p, joined: joins.filter((j) => j.plan_id === p.id).map((j) => j.member_id) })),
          events,
          stats: settle({ members, entries, expenses, settings, today: today() }),
          links,
          vapidPublicKey: env.VAPID_PUBLIC || null,
        });
      }

      // --- Foto ---
      let m;
      if ((m = path.match(/^\/api\/photo\/(\d+)$/)) && method === "GET") {
        const row = await db.prepare("SELECT photo FROM entries WHERE id=?").bind(m[1]).first();
        if (!row?.photo) return new Response("", { status: 404 });
        return new Response(row.photo, {
          headers: { "content-type": "text/plain", "cache-control": "private, max-age=31536000" },
        });
      }

      // --- Eintrag anlegen ---
      if (path === "/api/entry" && method === "POST") {
        const memberId = Number(body.member_id);
        if (!Number.isInteger(memberId)) return json({ error: "Teilnehmer fehlt." }, 400);
        const member = await db.prepare("SELECT id,name FROM members WHERE id=?").bind(memberId).first();
        if (!member) return json({ error: "Teilnehmer unbekannt." }, 400);

        const kind = KINDS.includes(body.kind) ? body.kind : "workout";
        const date = isDate(body.date) ? body.date : today();
        const units = kind === "sick" ? Math.min(Math.max(Number(body.units) || 1, 1), 10) : 1;
        const note = clean(body.note, 300);
        const sport = kind === "sick" ? null : clean(body.sport, 40) || null;
        const photo = typeof body.photo === "string" && body.photo.startsWith("data:image/") ? body.photo : null;
        if (photo && photo.length > MAX_PHOTO) return json({ error: "Foto zu groß." }, 413);
        let meta = null;
        if (body.meta && typeof body.meta === "object") {
          const picked = {};
          for (const [k, v] of Object.entries(body.meta).slice(0, 8)) picked[clean(k, 24)] = clean(v, 32);
          meta = JSON.stringify(picked);
        }

        // Mitmacher: einer dokumentiert, alle bekommen ihren Eintrag.
        let withIds = [];
        if (kind !== "sick" && Array.isArray(body.with)) {
          const wanted = [...new Set(body.with.map(Number).filter((n) => Number.isInteger(n) && n !== memberId))].slice(0, 20);
          if (wanted.length) {
            const rows = await db
              .prepare(`SELECT id,name FROM members WHERE id IN (${wanted.map(() => "?").join(",")})`)
              .bind(...wanted).all();
            withIds = rows.results;
          }
        }
        const groupId = withIds.length ? crypto.randomUUID() : null;
        const stamp = new Date().toISOString();

        const res = await db
          .prepare(
            "INSERT INTO entries(member_id,date,kind,units,sport,note,meta,photo,created,group_id) VALUES(?,?,?,?,?,?,?,?,?,?)"
          )
          .bind(memberId, date, kind, units, sport, note, meta, photo, stamp, groupId)
          .run();
        const id = res.meta?.last_row_id;

        if (withIds.length) {
          await db.batch(withIds.map((m) =>
            db.prepare(
              "INSERT INTO entries(member_id,date,kind,units,sport,note,meta,photo,created,group_id) VALUES(?,?,?,?,?,?,?,?,?,?)"
            ).bind(m.id, date, kind, units, sport, note, meta, null, stamp, groupId)
          ));
        }

        const names = [member.name, ...withIds.map((m) => m.name)];
        const who = names.length > 1
          ? names.slice(0, -1).join(", ") + " und " + names[names.length - 1]
          : names[0];

        ctx.waitUntil(
          notify(env, db,
            { id, kind, note, sport, member_id: memberId, meta: meta ? JSON.parse(meta) : null,
              crew: names.length, crewIds: [memberId, ...withIds.map((x) => x.id)] },
            who, clean(body.device, 64)
          ).catch((e) => console.log("notify failed", String(e)))
        );
        return json({ ok: true, id, group: withIds.length + 1 });
      }

      // --- Loeschen ---
      if ((m = path.match(/^\/api\/(entry|member|expense)\/(\d+)$/)) && method === "DELETE") {
        const table = { entry: "entries", member: "members", expense: "expenses" }[m[1]];
        if (m[1] === "entry") {
          const row = await db.prepare("SELECT group_id FROM entries WHERE id=?").bind(m[2]).first();
          if (row?.group_id) {
            await db.prepare("DELETE FROM entries WHERE group_id=?").bind(row.group_id).run();
            return json({ ok: true });
          }
        }
        await db.prepare(`DELETE FROM ${table} WHERE id=?`).bind(m[2]).run();
        if (m[1] === "member") {
          await db.batch([
            db.prepare("DELETE FROM entries WHERE member_id=?").bind(m[2]),
            db.prepare("UPDATE subs SET member_id=NULL WHERE member_id=?").bind(m[2]),
            db.prepare("DELETE FROM plan_joins WHERE member_id=?").bind(m[2]),
            db.prepare("DELETE FROM plans WHERE member_id=?").bind(m[2]),
            db.prepare("DELETE FROM links WHERE member_id=?").bind(m[2]),
            db.prepare("UPDATE expenses SET member_id=NULL WHERE member_id=?").bind(m[2]),
          ]);
        }
        return json({ ok: true });
      }

      // --- Teilnehmer ---
      if (path === "/api/member" && method === "POST") {
        const name = clean(body.name, 40);
        if (!name) return json({ error: "Name fehlt." }, 400);
        if (body.id) {
          const joined = isDate(body.joined) ? body.joined : null;
          await db
            .prepare("UPDATE members SET name=?, joined=COALESCE(?,joined) WHERE id=?")
            .bind(name, joined, Number(body.id))
            .run();
          return json({ ok: true, id: Number(body.id) });
        }
        const res = await db
          .prepare("INSERT INTO members(name,joined) VALUES(?,?)")
          .bind(name, isDate(body.joined) ? body.joined : today())
          .run();
        return json({ ok: true, id: res.meta?.last_row_id });
      }

      // --- Ausgaben ---
      // Standort des Geräts - grob reicht, er dient nur dem Wetterhinweis.
      if ((m = path.match(/^\/api\/member\/(\d+)\/geo$/)) && method === "POST") {
        const lat = Number(body.lat), lon = Number(body.lon);
        if (!isFinite(lat) || !isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180)
          return json({ error: "Koordinaten unbrauchbar." }, 400);
        await db.prepare("UPDATE members SET lat=?, lon=? WHERE id=?")
          .bind(Math.round(lat * 100) / 100, Math.round(lon * 100) / 100, m[1]).run();
        return json({ ok: true });
      }

      // Eintrag ändern. Gehört er zu einer gemeinsamen Einheit, ändert sich
      // die ganze Gruppe mit - es war ja dieselbe Runde.
      if ((m = path.match(/^\/api\/entry\/(\d+)$/)) && method === "POST") {
        const row = await db.prepare("SELECT * FROM entries WHERE id=?").bind(m[1]).first();
        if (!row) return json({ error: "Eintrag unbekannt." }, 404);

        const kind = KINDS.includes(body.kind) ? body.kind : row.kind;
        const date = isDate(body.date) ? body.date : row.date;
        const units = kind === "sick" ? Math.min(Math.max(Number(body.units) || 1, 1), 10) : 1;
        const sport = kind === "sick" ? null : (clean(body.sport, 40) || null);
        const note = clean(body.note, 300);

        const where = row.group_id ? "group_id=?" : "id=?";
        const key = row.group_id || row.id;
        await db.prepare(`UPDATE entries SET date=?, kind=?, units=?, sport=?, note=? WHERE ${where}`)
          .bind(date, kind, units, sport, note, key).run();
        return json({ ok: true, changed: row.group_id ? "gruppe" : "einzeln" });
      }

      // Foto nachträglich anhängen - etwa zu einer automatisch übernommenen Einheit.
      if ((m = path.match(/^\/api\/entry\/(\d+)\/photo$/)) && method === "POST") {
        const photo = typeof body.photo === "string" && body.photo.startsWith("data:image/") ? body.photo : null;
        if (!photo && body.photo !== null) return json({ error: "Kein Bild." }, 400);
        if (photo && photo.length > MAX_PHOTO) return json({ error: "Foto zu groß." }, 413);
        const row = await db.prepare("SELECT id,group_id FROM entries WHERE id=?").bind(m[1]).first();
        if (!row) return json({ error: "Eintrag unbekannt." }, 404);
        await db.prepare("UPDATE entries SET photo=? WHERE id=?").bind(photo, row.id).run();
        return json({ ok: true });
      }

      if (path === "/api/expense" && method === "POST") {
        const amount = Number(body.amount);
        if (!isFinite(amount) || amount === 0) return json({ error: "Betrag fehlt." }, 400);
        const payer = Number(body.member_id);
        const who = Number.isInteger(payer)
          ? await db.prepare("SELECT id FROM members WHERE id=?").bind(payer).first()
          : null;
        await db
          .prepare("INSERT INTO expenses(date,title,amount,member_id) VALUES(?,?,?,?)")
          .bind(isDate(body.date) ? body.date : today(), clean(body.title, 60) || "Ausgabe", amount, who?.id ?? null)
          .run();
        return json({ ok: true });
      }

      // --- Einstellungen ---
      if (path === "/api/settings" && method === "POST") {
        const stmts = [];
        for (const key of Object.keys(DEFAULTS)) {
          if (!(key in body)) continue;
          let v = body[key];
          if (key === "currency") v = clean(v, 4) || "€";
          else if (key === "place") v = clean(v, 60);
          else if (key === "tz") { v = clean(v, 40); if (!v) continue; }
          else if (key === "nudges" || key === "bonus") v = v ? 1 : 0;
          else if (key === "bonusSince") { if (!isDate(v)) continue; }
          else if (key === "start") { if (!isDate(v)) continue; }
          else {
            v = Number(v);
            if (!isFinite(v) || v < 0) continue;
            if (key === "required") v = Math.min(Math.max(Math.round(v), 1), 21);
            if (key === "sickMax") v = Math.min(Math.max(Math.round(v), 0), 21);
            if (key === "bonusCost") v = Math.min(Math.max(Math.round(v), 1), 20);
          }
          stmts.push(db.prepare("INSERT OR REPLACE INTO settings(k,v) VALUES(?,?)").bind(key, JSON.stringify(v)));
        }
        // Beim Einschalten merken wir uns den Tag, ab dem gesammelt wird.
        // Beim Ausschalten vergessen wir ihn wieder: solange die Regel aus ist,
        // gilt sie nicht - auch nicht rueckwirkend, wenn sie spaeter wiederkommt.
        if ("bonus" in body) {
          if (body.bonus) {
            const seen = await db.prepare("SELECT v FROM settings WHERE k='bonusSince'").first();
            if (!seen?.v || seen.v === '""')
              stmts.push(db.prepare("INSERT OR REPLACE INTO settings(k,v) VALUES('bonusSince',?)").bind(JSON.stringify(today())));
          } else {
            stmts.push(db.prepare("DELETE FROM settings WHERE k='bonusSince'"));
          }
        }
        if (stmts.length) await db.batch(stmts);
        return json({ ok: true });
      }

      // --- Push-Anmeldung pro Geraet ---
      if (path === "/api/push/subscribe" && method === "POST") {
        const device = clean(body.device, 64);
        const s = body.sub;
        if (!device || !s?.endpoint || !s?.keys?.p256dh || !s?.keys?.auth)
          return json({ error: "Subscription unvollständig." }, 400);
        await db
          .prepare(
            "INSERT OR REPLACE INTO subs(device,member_id,endpoint,p256dh,auth,created) VALUES(?,?,?,?,?,?)"
          )
          .bind(
            device,
            Number(body.member_id) || null,
            String(s.endpoint).slice(0, 600),
            String(s.keys.p256dh).slice(0, 200),
            String(s.keys.auth).slice(0, 100),
            new Date().toISOString()
          )
          .run();
        return json({ ok: true });
      }

      if (path === "/api/push/unsubscribe" && method === "POST") {
        await db.prepare("DELETE FROM subs WHERE device=?").bind(clean(body.device, 64)).run();
        return json({ ok: true });
      }

      // --- Testbenachrichtigung an dieses Geraet ---
      if (path === "/api/push/test" && method === "POST") {
        const sub = await db.prepare("SELECT * FROM subs WHERE device=?").bind(clean(body.device, 64)).first();
        if (!sub) return json({ error: "Dieses Gerät ist nicht angemeldet." }, 404);
        if (!env.VAPID_PUBLIC) return json({ error: "Keine VAPID-Keys hinterlegt." }, 500);
        const status = await sendPush(env, sub, {
          title: "Das Programm",
          body: "Push funktioniert auf diesem Gerät. 🏃",
          tag: "test",
        });
        if (status === 404 || status === 410) {
          await db.prepare("DELETE FROM subs WHERE device=?").bind(sub.device).run();
          return json({ error: "Subscription abgelaufen – bitte neu aktivieren." }, 410);
        }
        return json({ ok: status < 300, status });
      }

      // Gemeinsame Einheit vorschlagen
      if (path === "/api/plan" && method === "POST") {
        const memberId = Number(body.member_id);
        const proposer = await db.prepare("SELECT id,name FROM members WHERE id=?").bind(memberId).first();
        if (!proposer) return json({ error: "Teilnehmer unbekannt." }, 400);
        if (!isDate(body.date)) return json({ error: "Datum fehlt." }, 400);
        const time = /^\d{2}:\d{2}$/.test(String(body.time || "")) ? body.time : null;
        const res = await db
          .prepare("INSERT INTO plans(member_id,sport,date,time,note,created) VALUES(?,?,?,?,?,?)")
          .bind(memberId, clean(body.sport, 40) || null, body.date, time, clean(body.note, 200), new Date().toISOString())
          .run();
        const id = res.meta?.last_row_id;
        await db.prepare("INSERT OR IGNORE INTO plan_joins(plan_id,member_id) VALUES(?,?)").bind(id, memberId).run();
        ctx.waitUntil(
          notifyPlan(env, db, { id, sport: clean(body.sport, 40), time, dateText: clean(body.dateText, 30) || body.date },
            proposer.name, clean(body.device, 64)).catch((e) => console.log("plan push failed", String(e)))
        );
        return json({ ok: true, id });
      }

      if ((m = path.match(/^\/api\/plan\/(\d+)\/join$/)) && method === "POST") {
        const memberId = Number(body.member_id);
        if (!Number.isInteger(memberId)) return json({ error: "Teilnehmer fehlt." }, 400);
        if (body.leave) await db.prepare("DELETE FROM plan_joins WHERE plan_id=? AND member_id=?").bind(m[1], memberId).run();
        else await db.prepare("INSERT OR IGNORE INTO plan_joins(plan_id,member_id) VALUES(?,?)").bind(m[1], memberId).run();
        return json({ ok: true });
      }

      if ((m = path.match(/^\/api\/plan\/(\d+)$/)) && method === "DELETE") {
        await db.batch([
          db.prepare("DELETE FROM plans WHERE id=?").bind(m[1]),
          db.prepare("DELETE FROM plan_joins WHERE plan_id=?").bind(m[1]),
        ]);
        return json({ ok: true });
      }

      // Zahlen für die Auswertungsseite - eigener Aufruf, damit der
      // Startzustand schlank bleibt.
      if (path === "/api/report" && method === "GET") {
        const all = (sql) => db.prepare(sql).all().then((r) => r.results);
        const settings = await loadSettings(db);
        const [members, entries] = await Promise.all([
          all("SELECT id,name,joined FROM members ORDER BY id"),
          all("SELECT member_id,date,kind,units,sport,meta,group_id FROM entries"),
        ]);
        return json(report({ members, entries, settings, today: today() }));
      }

      /* ---------- Automatischer Import ---------- */

      // Zugangsdaten hinterlegen. Wird sofort gegengeprueft, damit niemand
      // mit einem Tippfehler dasteht und sich wundert, warum nichts kommt.
      if (path === "/api/link" && method === "POST") {
        const memberId = Number(body.member_id);
        const member = await db.prepare("SELECT id,name FROM members WHERE id=?").bind(memberId).first();
        if (!member) return json({ error: "Teilnehmer unbekannt." }, 400);
        const athlete = clean(body.athlete_id, 40);
        const key = String(body.api_key || "").trim().slice(0, 200);
        if (!athlete || !key) return json({ error: "Athleten-ID und Schlüssel werden beide gebraucht." }, 400);

        let name = "";
        try {
          name = await icu.verify({ athlete_id: athlete, api_key: key });
        } catch (e) {
          return json({ error: String(e.message || e) }, 400);
        }
        await db
          .prepare("INSERT OR REPLACE INTO links(member_id,athlete_id,api_key,name,last_check,connected) VALUES(?,?,?,?,NULL,?)")
          .bind(memberId, athlete, key, name || null, new Date().toISOString())
          .run();
        const found = await syncMember(env, db, memberId, ctx);
        return json({ ok: true, name, imported: found });
      }

      if (path === "/api/link/remove" && method === "POST") {
        await db.prepare("DELETE FROM links WHERE member_id=?").bind(Number(body.member_id)).run();
        return json({ ok: true });
      }

      // Jetzt nachsehen - aus den Einstellungen heraus oder stuendlich vom Cron.
      if (path === "/api/link/sync" && method === "POST") {
        const only = body.member_id ? Number(body.member_id) : null;
        return json({ ok: true, imported: await syncAll(env, db, ctx, only) });
      }

      // Guthaben-Meldung ansehen oder ausloesen
      if (path === "/api/bonus-report" && method === "POST") {
        const when = body.now && !isNaN(Date.parse(body.now)) ? new Date(body.now) : new Date();
        return json({ ok: true, reports: await bonusReport(env, db, when, { dry: !body.send }) });
      }

      // Vorschau der faelligen Motivationsnachrichten; mit send=true wirklich schicken.
      if (path === "/api/nudges" && method === "POST") {
        const when = body.now && !isNaN(Date.parse(body.now)) ? new Date(body.now) : new Date();
        const res = await runNudges(env, db, when, {
          dry: !body.send,
          force: ["start", "push", "last"].includes(body.force) ? body.force : null,
        });
        return json({ ok: true, nudges: res });
      }

      return json({ error: "Unbekannter Endpunkt." }, 404);
    } catch (err) {
      console.log("API-Fehler", path, String(err?.stack || err));
      return json({ error: "Serverfehler: " + String(err?.message || err) }, 500);
    }
  },
};


/* ---------- Automatischer Import ---------- */

// Holt die Einheiten einer Person und legt an, was noch fehlt.
async function syncMember(env, db, memberId, ctx) {
  const link = await db.prepare("SELECT * FROM links WHERE member_id=?").bind(memberId).first();
  if (!link) return [];
  const member = await db.prepare("SELECT id,name FROM members WHERE id=?").bind(memberId).first();
  if (!member) return [];

  const minimum = IMPORT_MIN_MINUTES;

  // Beim ersten Mal zwei Wochen zurueck, danach reicht ein Tag Ueberlappung.
  const days = link.last_check ? 2 : 14;
  const oldest = new Date(Date.now() - days * 864e5).toISOString().slice(0, 10);

  let list;
  try {
    list = await icu.activitiesSince(link, oldest);
  } catch (e) {
    console.log("Import für", member.name, "fehlgeschlagen:", String(e.message || e));
    return [];
  }
  await db.prepare("UPDATE links SET last_check=? WHERE member_id=?")
    .bind(new Date().toISOString(), memberId).run();

  const added = [];
  for (const act of list) {
    const m = icu.mapActivity(act);
    if (!isDate(m.date) || m.minutes < minimum) continue;

    const res = await db
      .prepare("INSERT OR IGNORE INTO entries(member_id,date,kind,units,sport,note,meta,photo,created,ext_id) VALUES(?,?,?,1,?,?,?,NULL,?,?)")
      .bind(member.id, m.date, "workout", m.sport || null, m.note || "",
            m.meta ? JSON.stringify(m.meta) : null, new Date().toISOString(), m.extId)
      .run();
    if (!res.meta?.changes) continue;          // kannten wir schon

    added.push({ member: member.name, sport: m.sport, date: m.date, minutes: m.minutes });
    const sending = notify(env, db,
      { id: res.meta.last_row_id, kind: "workout", note: m.note, sport: m.sport, member_id: member.id, meta: m.meta },
      member.name, "import").catch((e) => console.log("notify", String(e)));
    if (ctx) ctx.waitUntil(sending); else await sending;
  }
  return added;
}

async function syncAll(env, db, ctx, only = null) {
  const rows = only
    ? [{ member_id: only }]
    : (await db.prepare("SELECT member_id FROM links").all()).results;
  const out = [];
  for (const r of rows) out.push(...(await syncMember(env, db, r.member_id, ctx)));
  return out;
}

/* ---------- Guthaben: Sonntagsmeldung ---------- */

// Laeuft sonntags um 20 Uhr Ortszeit: wessen Woche nur noch das Guthaben rettet,
// bekommt es als Benachrichtigung und als Eintrag im Feed - einmal pro Woche.
export async function bonusReport(env, db, now, { dry = false } = {}) {
  const out = [];
  const settings = await loadSettings(db);
  if (!settings.bonus) return out;

  const tz = settings.tz || "Europe/Berlin";
  const here = localParts(now, tz);
  const week = weekOf(here.date);

  const [members, entries, subs] = await Promise.all([
    db.prepare("SELECT id,name,joined FROM members").all().then((r) => r.results),
    db.prepare("SELECT member_id,date,kind,units,sport FROM entries").all().then((r) => r.results),
    db.prepare("SELECT * FROM subs WHERE member_id IS NOT NULL").all().then((r) => r.results),
  ]);
  const ledger = settle({ members, entries, settings, today: here.date });

  for (const member of members) {
    const book = ledger[member.id];
    if (!book?.week?.canRescue) continue;

    const text = `Dir fehlt noch ${book.week.left === 1 ? "eine Einheit" : book.week.left + " Einheiten"}. ` +
      `Kommt heute nichts mehr, decken ${book.rescueCost} deiner ${book.credits} Guthaben die Woche ab.`;
    out.push({ member: member.name, member_id: member.id, text });
    if (dry) continue;

    const claim = await db
      .prepare("INSERT OR IGNORE INTO nudges(member_id,week,kind,sent) VALUES(?,?,?,?)")
      .bind(member.id, week, "bonus", new Date().toISOString())
      .run();
    if (!claim.meta?.changes) { out.pop(); continue; }

    await db.prepare("INSERT INTO events(member_id,date,kind,text,created) VALUES(?,?,?,?,?)")
      .bind(member.id, here.date, "bonus", text, new Date().toISOString()).run();

    for (const sub of subs.filter((x) => x.member_id === member.id)) {
      try {
        const status = await sendPush(env, sub, { title: "Das Programm", body: text, tag: "bonus-" + week, url: "/#feed" });
        if (status === 404 || status === 410) await db.prepare("DELETE FROM subs WHERE device=?").bind(sub.device).run();
      } catch (e) { console.log("Guthaben-Meldung fehlgeschlagen", String(e)); }
    }
  }
  return out;
}

/* ---------- Motivationsnachrichten ---------- */

const creditOf = (entries, memberId, week, sickMax) => {
  let done = 0, sickUnits = 0;
  for (const e of entries) {
    if (e.member_id !== memberId || weekOf(e.date) !== week) continue;
    if (e.kind === "sick") sickUnits += e.units || 1;
    else done++;
  }
  return { done, credit: done + Math.min(sickUnits, sickMax) };
};

const streakOf = (entries, member, week, required, sickMax, start) => {
  const from = weekOf(member.joined && member.joined > start ? member.joined : start);
  let streak = 0;
  for (let w = week, i = 0; w >= from && i < 520; i++) {
    const prev = new Date(w + "T12:00:00Z");
    prev.setUTCDate(prev.getUTCDate() - 7);
    const pw = prev.toISOString().slice(0, 10);
    if (w === week) { if (creditOf(entries, member.id, w, sickMax).credit >= required) streak++; }
    else if (creditOf(entries, member.id, w, sickMax).credit >= required) streak++;
    else break;
    w = pw;
  }
  return streak;
};

// Was jetzt gerade anstünde. `dry` liefert es zurück, ohne zu senden.
export async function runNudges(env, db, now, { dry = false, force = null } = {}) {
  const out = [];
  const settings = await loadSettings(db);
  if (!settings.nudges && !force) return out;
  if (!env.VAPID_PUBLIC || !env.VAPID_PRIVATE) return out;

  const tz = settings.tz || "Europe/Berlin";
  const here = localParts(now, tz);
  const week = weekOf(here.date);
  const required = Number(settings.required) || 2;
  const sickMax = settings.sickMax ?? required;

  const [members, entries, subs] = await Promise.all([
    db.prepare("SELECT id,name,joined,lat,lon FROM members").all().then((r) => r.results),
    db.prepare("SELECT member_id,date,kind,units,sport FROM entries WHERE date >= ?")
      .bind(new Date(Date.parse(here.date) - 130 * 864e5).toISOString().slice(0, 10))
      .all().then((r) => r.results),
    db.prepare("SELECT * FROM subs WHERE member_id IS NOT NULL").all().then((r) => r.results),
  ]);
  if (!members.length) return out;

  const daysLeft = 7 - ((here.dow + 6) % 7);
  const standings = new Map(members.map((m) => [m.id, creditOf(entries, m.id, week, sickMax)]));
  const finished = members.filter((m) => standings.get(m.id).credit >= required);
  const ledger = settle({ members, entries, settings, today: here.date });

  // Wetter: der Standort der Person, sonst der in den Einstellungen hinterlegte Ort.
  const geoCache = new Map();
  const weatherFor = async (member) => {
    const key = member.lat != null ? member.lat + "," + member.lon : "place";
    if (geoCache.has(key)) return geoCache.get(key);
    let out = null;
    try {
      const geo = member.lat != null
        ? { lat: member.lat, lon: member.lon }
        : settings.place ? await geocode(db, settings.place) : null;
      out = geo ? await forecast(db, geo, tz) : null;
    } catch (e) { console.log("Wetter nicht abrufbar", String(e)); }
    geoCache.set(key, out);
    return out;
  };

  for (const member of members) {
    const devices = subs.filter((x) => x.member_id === member.id);
    if (!devices.length && !dry) continue;

    const { credit } = standings.get(member.id);
    if (credit >= required) continue;

    const kind = force || (credit === 0 ? "start" : "push");
    const effective = force || (here.dow === 0 && credit < required ? "last" : kind);
    const slot = slotFor(member.id, week, effective);
    if (!force && (here.dow !== slot.dow || here.hour !== slot.hour)) continue;

    if (!dry && !force) {
      const claim = await db
        .prepare("INSERT OR IGNORE INTO nudges(member_id,week,kind,sent) VALUES(?,?,?,?)")
        .bind(member.id, week, effective, new Date().toISOString())
        .run();
      if (!claim.meta?.changes) continue; // in dieser Woche schon geschickt
    }

    const ahead = finished.filter((m) => m.id !== member.id);
    const msg = buildMessage(
      effective,
      {
        name: member.name,
        week,
        dow: here.dow,
        days: daysLeft,
        left: Math.max(1, required - credit),
        required,
        fine: settings.fine,
        currency: settings.currency,
        streak: streakOf(entries, member, week, required, sickMax, settings.start),
        aheadOf: ahead.length ? ahead[0].name : null,
      },
      favourites(entries, member.id, here.date),
      await weatherFor(member),
      (member.id * 2654435761 + Number(week.replace(/-/g, ""))) >>> 0
    );

    const book = ledger[member.id];
    if (settings.bonus && book?.week?.canRescue) {
      msg.body += ` Oder ${book.rescueCost} deiner ${book.credits} Guthaben springen ein.`;
    }

    out.push({ member: member.name, member_id: member.id, kind: effective, devices: devices.length, ...msg });
    if (dry) continue;

    for (const sub of devices) {
      try {
        const status = await sendPush(env, sub, msg);
        if (status === 404 || status === 410)
          await db.prepare("DELETE FROM subs WHERE device=?").bind(sub.device).run();
      } catch (e) { console.log("Nudge fehlgeschlagen", String(e)); }
    }
  }
  return out;
}

export { weekOf, b64u };
