// Automatischer Import über intervals.icu.
//
// intervals.icu ist kostenlos und zieht die Einheiten selbst aus Strava,
// Garmin, Wahoo, Polar, Suunto und Co. Damit brauchen wir weder eine
// Entwickler-Anwendung noch ein Bezahlkonto bei einem dieser Dienste.
//
// Jede Person hinterlegt einmal ihre Athleten-ID und ihren API-Schlüssel
// (intervals.icu → Settings → Developer Settings). Danach schaut der
// stündliche Cron-Lauf nach neuen Einheiten.
//
// Schnittstelle laut https://intervals.icu/api/v1/docs:
//   Basic-Auth, Benutzer "API_KEY", Passwort = der Schlüssel
//   GET /api/v1/athlete/{id}/activities?oldest=&newest=

const BASE = "https://intervals.icu/api/v1";

const auth = (key) => "Basic " + btoa("API_KEY:" + key);

const normId = (id) => {
  const v = String(id || "").trim();
  return /^\d+$/.test(v) ? "i" + v : v;   // "123456" und "i123456" sind dasselbe
};

async function call(link, path) {
  let res;
  try {
    res = await fetch(BASE + "/athlete/" + normId(link.athlete_id) + path, {
      headers: { authorization: auth(link.api_key), accept: "application/json" },
    });
  } catch {
    // Einen rohen Netzwerkfehler durchzureichen hilft niemandem weiter.
    throw new Error("intervals.icu ist gerade nicht erreichbar. Später noch einmal versuchen.");
  }
  if (res.status === 401 || res.status === 403) throw new Error("Schlüssel oder Athleten-ID stimmt nicht.");
  if (res.status === 404) throw new Error("Diese Athleten-ID gibt es nicht.");
  if (!res.ok) throw new Error("intervals.icu antwortet mit " + res.status + ".");
  return res.json().catch(() => { throw new Error("Antwort von intervals.icu nicht lesbar."); });
}

/** Prüft Zugangsdaten und liefert den hinterlegten Namen zurück. */
export async function verify(link) {
  // Genau der Aufruf, auf den es später ankommt - der muss klappen.
  await call(link, "/activities?limit=1&oldest=" + new Date().toISOString().slice(0, 10));
  const me = await call(link, "/profile").catch(() => null);
  return String(me?.athlete?.name || me?.name || "").slice(0, 60);
}

export async function activitiesSince(link, oldestDate) {
  const q = new URLSearchParams({ oldest: oldestDate, limit: "50" });
  const list = await call(link, "/activities?" + q);
  return Array.isArray(list) ? list : [];
}

/* ---------- Sportarten ---------- */

// intervals.icu nutzt im Wesentlichen die Strava-Bezeichnungen.
const SPORTS = {
  Run: "Laufen", TrailRun: "Trailrunning", VirtualRun: "Laufband", Treadmill: "Laufband",
  Walk: "Gehen", Hike: "Wandern", Snowshoe: "Schneeschuhwandern",
  Ride: "Radfahren", VirtualRide: "Indoor-Cycling", MountainBikeRide: "Mountainbike",
  GravelRide: "Gravelbike", EBikeRide: "E-Bike", EMountainBikeRide: "E-Bike",
  Swim: "Schwimmen", OpenWaterSwim: "Freiwasserschwimmen",
  WeightTraining: "Krafttraining", Workout: "Krafttraining", Crossfit: "Crossfit",
  HighIntensityIntervalTraining: "HIIT", Elliptical: "Crosstrainer", StairStepper: "Stepper",
  Rowing: "Rudern", VirtualRow: "Ruderergometer", Kayaking: "Kajak", Canoeing: "Kanu",
  StandUpPaddling: "Stand-up-Paddling", Surfing: "Surfen", Kitesurf: "Kitesurfen",
  Sailing: "Segeln", Yoga: "Yoga", Pilates: "Pilates",
  AlpineSki: "Skifahren", BackcountrySki: "Skitour", NordicSki: "Langlauf", Snowboard: "Snowboard",
  IceSkate: "Eislaufen", InlineSkate: "Inlineskaten", Skateboard: "Skateboard",
  RockClimbing: "Klettern", Golf: "Golf", Soccer: "Fußball", Badminton: "Badminton",
  Tennis: "Tennis", TableTennis: "Tischtennis", Squash: "Squash", Handcycle: "Radfahren",
  Wheelchair: "Gehen", HorseRiding: "Reiten", Velomobile: "Radfahren", Other: "",
};

/* ---------- Einheiten: dieselben wie bei einer hochgeladenen Datei ---------- */
// Gegengeprüft in test/icu.cjs, damit Import und Datei-Upload nicht
// auseinanderlaufen.

const AS_KMH = new Set(["Radfahren", "Rennrad", "Mountainbike", "Gravelbike", "E-Bike",
  "Indoor-Cycling", "Spinning", "Skifahren", "Snowboard", "Langlauf", "Skitour", "Rodeln",
  "Inlineskaten", "Skateboard", "Eislaufen", "Reiten", "Segeln", "Kajak", "Kanu",
  "Stand-up-Paddling", "Surfen", "Kitesurfen", "Rudern", "Ruderergometer"]);
const AS_100M = new Set(["Schwimmen", "Freiwasserschwimmen"]);

const pad = (n) => String(n).padStart(2, "0");
const fmtDur = (sec) => (sec >= 3600 ? Math.floor(sec / 3600) + ":" + pad(Math.round((sec % 3600) / 60)) + " h" : Math.round(sec / 60) + " min");
const fmtPace = (sec, km) => { const t = Math.round(sec / km); return Math.floor(t / 60) + ":" + pad(t % 60) + " /km"; };
const fmtPace100 = (sec, km) => { const t = Math.round(sec / (km * 10)); return Math.floor(t / 60) + ":" + pad(t % 60) + " /100 m"; };
const fmtKmh = (sec, km) => (km / (sec / 3600)).toFixed(1).replace(".", ",") + " km/h";

export function speedOf(sec, km, sport) {
  if (!(km > 0.3 && sec > 60)) return null;
  if (AS_100M.has(sport)) return ["Tempo", fmtPace100(sec, km)];
  if (AS_KMH.has(sport)) return ["Schnitt", fmtKmh(sec, km)];
  if (!sport) return km / (sec / 3600) >= 12 ? ["Schnitt", fmtKmh(sec, km)] : ["Tempo", fmtPace(sec, km)];
  return ["Tempo", fmtPace(sec, km)];
}

export function buildMeta({ km = 0, sec = 0, climb = 0, hr = 0, kcal = 0 }, sport) {
  const out = {};
  if (km > 0.05) out.Distanz = km.toFixed(2).replace(".", ",") + " km";
  if (sec > 30) out.Dauer = fmtDur(sec);
  const sp = speedOf(sec, km, sport);
  if (sp) out[sp[0]] = sp[1];
  if (climb >= 20) out["Anstieg"] = Math.round(climb) + " hm";
  if (hr) out.Puls = Math.round(hr) + " bpm";
  if (kcal) out.kcal = String(Math.round(kcal));
  return Object.keys(out).length ? out : null;
}

/** Macht aus einer Aktivität das, was wir eintragen würden. Meter und Sekunden. */
export function mapActivity(act) {
  const sport = SPORTS[act.type] ?? String(act.type || "").slice(0, 40);
  const sec = act.moving_time || act.elapsed_time || 0;
  const raw = {
    km: (act.distance || act.icu_distance || 0) / 1000,
    sec,
    climb: act.total_elevation_gain || 0,
    hr: act.average_heartrate || 0,
    kcal: act.calories || 0,
  };
  return {
    extId: "icu:" + act.id,
    sport,
    minutes: Math.round(sec / 60),
    date: String(act.start_date_local || "").slice(0, 10),
    note: String(act.name || "").trim().slice(0, 300),
    meta: buildMeta(raw, sport),
  };
}
