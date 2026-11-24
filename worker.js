import { sendPush, b64u } from "./push.js";
import indexHtml from "./public/index.html";
import swJs from "./public/sw.js";
import manifestJson from "./public/manifest.json";
import iconSvg from "./public/icon.svg";
import icon192 from "./public/icon-192.png";
import icon512 from "./public/icon-512.png";
import iconMaskable from "./public/icon-maskable.png";

const HTML = "text/html; charset=utf-8";
const LONG = "public, max-age=31536000, immutable";
const FRESH = "public, max-age=0, must-revalidate";
const ASSETS = {
  "/index.html": [indexHtml, HTML, FRESH],
  "/sw.js": [swJs, "text/javascript; charset=utf-8", FRESH],
  "/manifest.json": [manifestJson, "application/manifest+json; charset=utf-8", FRESH],
  "/icon.svg": [iconSvg, "image/svg+xml", LONG],
  "/icon-192.png": [icon192, "image/png", LONG],
  "/icon-512.png": [icon512, "image/png", LONG],
  "/icon-maskable.png": [iconMaskable, "image/png", LONG],
};

function serveAsset(path) {
  const hit = ASSETS[path === "/" ? "/index.html" : path] || ASSETS["/index.html"];
  const headers = { "content-type": hit[1], "cache-control": hit[2] };
  if (path === "/sw.js") headers["service-worker-allowed"] = "/";
  return new Response(hit[0], { headers });
}

const SCHEMA = [
  "CREATE TABLE IF NOT EXISTS members(id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, joined TEXT)",
  "CREATE TABLE IF NOT EXISTS entries(id INTEGER PRIMARY KEY AUTOINCREMENT, member_id INTEGER NOT NULL, date TEXT NOT NULL, kind TEXT NOT NULL, units INTEGER DEFAULT 1, note TEXT, meta TEXT, photo TEXT, created TEXT)",
  "CREATE TABLE IF NOT EXISTS expenses(id INTEGER PRIMARY KEY AUTOINCREMENT, date TEXT, title TEXT, amount REAL)",
  "CREATE TABLE IF NOT EXISTS settings(k TEXT PRIMARY KEY, v TEXT)",
  "CREATE TABLE IF NOT EXISTS subs(device TEXT PRIMARY KEY, member_id INTEGER, endpoint TEXT NOT NULL, p256dh TEXT NOT NULL, auth TEXT NOT NULL, created TEXT)",
  "CREATE INDEX IF NOT EXISTS idx_entries_member ON entries(member_id, date)",
];

const DEFAULTS = { required: 2, fine: 20, currency: "€", start: "", sickMax: 2 };
const KINDS = ["workout", "sick"];
const MAX_PHOTO = 700000;

const json = (data, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });

const today = () => new Date().toISOString().slice(0, 10);
const isDate = (s) => typeof s === "string" && /^\d{4}-\d{2}-\d{2}$/.test(s) && !isNaN(Date.parse(s));
const clean = (s, max) => String(s ?? "").replace(/\s+/g, " ").trim().slice(0, max);

let migrated;
async function migrate(db) {
  if (!migrated) {
    migrated = db.batch(SCHEMA.map((s) => db.prepare(s))).catch((e) => {
      migrated = null;
      throw e;
    });
  }
  await migrated;
}

// Montag der Woche (UTC-stabil)
function weekOf(dateStr) {
  const d = new Date(dateStr + "T12:00:00Z");
  d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7));
  return d.toISOString().slice(0, 10);
}

async function notify(env, db, entry, member, fromDevice) {
  if (!env.VAPID_PUBLIC || !env.VAPID_PRIVATE) return;
  const { results } = await db
    .prepare("SELECT * FROM subs WHERE device != ?")
    .bind(fromDevice || "")
    .all();
  if (!results.length) return;

  const body =
    entry.kind === "sick"
      ? `${member} hat sich für diese Woche krankgemeldet.`
      : `${member} hat eine Einheit eingetragen${entry.note ? ": " + entry.note : "."}`;
  const msg = { title: "Das Programm", body, tag: "entry-" + entry.id };

  await Promise.all(
    results.map(async (s) => {
      try {
        const status = await sendPush(env, s, msg);
        if (status === 404 || status === 410) {
          await db.prepare("DELETE FROM subs WHERE device=?").bind(s.device).run();
        }
      } catch (e) {
        console.log("push failed", s.device, String(e));
      }
    })
  );
}

export default {
  async fetch(req, env, ctx) {
    const url = new URL(req.url);
    const path = url.pathname;
    const method = req.method;

    if (!path.startsWith("/api/")) {
      if (method !== "GET" && method !== "HEAD") return new Response("Method not allowed", { status: 405 });
      return serveAsset(path);
    }
    if (!env.DB) return json({ error: "Keine D1-Datenbank gebunden (wrangler.toml)." }, 500);
    if (env.PIN && req.headers.get("x-pin") !== env.PIN) return json({ error: "pin" }, 401);

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
        const settings = { ...DEFAULTS, start: weekOf(today()) };
        for (const row of await all("SELECT k,v FROM settings")) {
          try {
            settings[row.k] = JSON.parse(row.v);
          } catch {}
        }
        const [members, entries, expenses] = await Promise.all([
          all("SELECT id,name,joined FROM members ORDER BY id"),
          all(
            "SELECT id,member_id,date,kind,units,note,meta,created,(photo IS NOT NULL) AS hasPhoto FROM entries ORDER BY date DESC, id DESC"
          ),
          all("SELECT id,date,title,amount FROM expenses ORDER BY date DESC, id DESC"),
        ]);
        return json({
          settings,
          members,
          entries,
          expenses,
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
        const photo = typeof body.photo === "string" && body.photo.startsWith("data:image/") ? body.photo : null;
        if (photo && photo.length > MAX_PHOTO) return json({ error: "Foto zu groß." }, 413);
        let meta = null;
        if (body.meta && typeof body.meta === "object") {
          const picked = {};
          for (const [k, v] of Object.entries(body.meta).slice(0, 8)) picked[clean(k, 24)] = clean(v, 32);
          meta = JSON.stringify(picked);
        }

        const res = await db
          .prepare(
            "INSERT INTO entries(member_id,date,kind,units,note,meta,photo,created) VALUES(?,?,?,?,?,?,?,?)"
          )
          .bind(memberId, date, kind, units, note, meta, photo, new Date().toISOString())
          .run();
        const id = res.meta?.last_row_id;

        ctx.waitUntil(
          notify(env, db, { id, kind, note }, member.name, clean(body.device, 64)).catch((e) =>
            console.log("notify failed", String(e))
          )
        );
        return json({ ok: true, id });
      }

      // --- Loeschen ---
      if ((m = path.match(/^\/api\/(entry|member|expense)\/(\d+)$/)) && method === "DELETE") {
        const table = { entry: "entries", member: "members", expense: "expenses" }[m[1]];
        await db.prepare(`DELETE FROM ${table} WHERE id=?`).bind(m[2]).run();
        if (m[1] === "member") {
          await db.batch([
            db.prepare("DELETE FROM entries WHERE member_id=?").bind(m[2]),
            db.prepare("UPDATE subs SET member_id=NULL WHERE member_id=?").bind(m[2]),
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
      if (path === "/api/expense" && method === "POST") {
        const amount = Number(body.amount);
        if (!isFinite(amount) || amount === 0) return json({ error: "Betrag fehlt." }, 400);
        await db
          .prepare("INSERT INTO expenses(date,title,amount) VALUES(?,?,?)")
          .bind(isDate(body.date) ? body.date : today(), clean(body.title, 60) || "Ausgabe", amount)
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
          else if (key === "start") { if (!isDate(v)) continue; }
          else {
            v = Number(v);
            if (!isFinite(v) || v < 0) continue;
            if (key === "required") v = Math.min(Math.max(Math.round(v), 1), 21);
            if (key === "sickMax") v = Math.min(Math.max(Math.round(v), 0), 21);
          }
          stmts.push(db.prepare("INSERT OR REPLACE INTO settings(k,v) VALUES(?,?)").bind(key, JSON.stringify(v)));
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

      return json({ error: "Unbekannter Endpunkt." }, 404);
    } catch (err) {
      console.log("API-Fehler", path, String(err?.stack || err));
      return json({ error: "Serverfehler: " + String(err?.message || err) }, 500);
    }
  },
};

export { weekOf, b64u };
