// Motivationsnachrichten: wer diese Woche hinterherhinkt, bekommt einen Schubs –
// personalisiert nach Serie, bevorzugten Sportarten, Gruppenlage und Wetter.

const DOW = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const DOW_DE = ["Sonntag", "Montag", "Dienstag", "Mittwoch", "Donnerstag", "Freitag", "Samstag"];

// Sportarten, die bei Regen funktionieren – und solche, die ins Freie gehören.
const INDOOR = new Set([
  "Krafttraining", "Gerätetraining", "Fitnessstudio", "Calisthenics", "Functional Training",
  "Zirkeltraining", "HIIT", "Crossfit", "Seilspringen", "Bauch-Beine-Po", "Rudern",
  "Ruderergometer", "Crosstrainer", "Stepper", "Indoor-Cycling", "Spinning", "Laufband",
  "Yoga", "Pilates", "Stretching", "Mobility", "Rückentraining", "Physiotherapie",
  "Tanzen", "Zumba", "Aerobic", "Schwimmen", "Aquafitness", "Bouldern", "Klettern",
  "Boxen", "Kickboxen", "Kampfsport", "Judo", "Karate", "Taekwondo", "Ringen", "Fechten",
  "Turnen", "Tischtennis", "Badminton", "Squash", "Handball", "Basketball", "Volleyball",
  "Eislaufen", "Eishockey", "Tauchen",
]);
const OUTDOOR = new Set([
  "Laufen", "Joggen", "Trailrunning", "Gehen", "Spazieren", "Nordic Walking", "Wandern",
  "Radfahren", "Rennrad", "Mountainbike", "Gravelbike", "E-Bike", "Fußball", "Golf",
  "Reiten", "Surfen", "Stand-up-Paddling", "Kitesurfen", "Segeln", "Kajak", "Kanu",
  "Inlineskaten", "Skateboard", "Skifahren", "Snowboard", "Langlauf", "Skitour",
  "Schneeschuhwandern", "Rodeln", "Freiwasserschwimmen", "Beachvolleyball",
  "Leichtathletik", "Treppensteigen", "Gartenarbeit", "Bogenschießen", "Hockey",
  "Rugby", "Baseball", "Tennis", "Padel",
]);
const FALLBACK_INDOOR = ["Krafttraining", "Yoga", "Schwimmen"];
const FALLBACK_OUTDOOR = ["Laufen", "Radfahren", "ein zügiger Spaziergang"];

// Kleiner deterministischer Hash – gleiche Woche, gleiche Person, gleicher Text.
const hash = (s) => {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return h >>> 0;
};
const pick = (arr, seed) => arr[seed % arr.length];
const cap = (t) => (t ? t[0].toUpperCase() + t.slice(1) : t);

export function localParts(date, tz) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-GB", {
      timeZone: tz, weekday: "short", hour: "2-digit", hour12: false,
      year: "numeric", month: "2-digit", day: "2-digit",
    }).formatToParts(date).map((p) => [p.type, p.value])
  );
  return {
    date: `${parts.year}-${parts.month}-${parts.day}`,
    hour: Number(parts.hour) % 24,
    dow: DOW.indexOf(parts.weekday),
  };
}

export function weekOf(dateStr) {
  const d = new Date(dateStr + "T12:00:00Z");
  d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7));
  return d.toISOString().slice(0, 10);
}

// Wann genau jemand seinen Schubs bekommt: variiert pro Person und Woche.
export function slotFor(memberId, week, kind) {
  const h = hash(memberId + "|" + week + "|" + kind);
  if (kind === "start") return { dow: h & 1 ? 3 : 4, hour: 11 + ((h >>> 1) % 4) };   // Mi oder Do, 11–14 Uhr
  if (kind === "push") return { dow: h & 1 ? 5 : 6, hour: 9 + ((h >>> 1) % 5) };     // Fr oder Sa, 9–13 Uhr
  return { dow: 0, hour: 10 + ((h >>> 1) % 3) };                                      // So, 10–12 Uhr
}

/* ---------- Wetter (Open-Meteo, ohne Schlüssel) ---------- */

async function cached(db, key, ttlSeconds, load) {
  const now = Math.floor(Date.now() / 1000);
  const row = await db.prepare("SELECT v,exp FROM cache WHERE k=?").bind(key).first();
  if (row && row.exp > now) {
    try { return JSON.parse(row.v); } catch {}
  }
  const value = await load();
  if (value !== null && value !== undefined) {
    await db.prepare("INSERT OR REPLACE INTO cache(k,v,exp) VALUES(?,?,?)")
      .bind(key, JSON.stringify(value), now + ttlSeconds).run();
  }
  return value;
}

export async function geocode(db, place, fetchImpl = fetch) {
  if (!place) return null;
  return cached(db, "geo:" + place.toLowerCase(), 30 * 864e2, async () => {
    const url = "https://geocoding-api.open-meteo.com/v1/search?count=1&language=de&format=json&name=" +
      encodeURIComponent(place);
    const res = await fetchImpl(url);
    if (!res.ok) return null;
    const data = await res.json();
    const hit = data?.results?.[0];
    return hit ? { lat: hit.latitude, lon: hit.longitude, name: hit.name } : null;
  });
}

export async function forecast(db, geo, tz, fetchImpl = fetch) {
  if (!geo) return null;
  const key = `wx:${geo.lat.toFixed(2)},${geo.lon.toFixed(2)}`;
  return cached(db, key, 3 * 3600, async () => {
    const url = "https://api.open-meteo.com/v1/forecast?forecast_days=4" +
      `&latitude=${geo.lat}&longitude=${geo.lon}&timezone=${encodeURIComponent(tz)}` +
      "&daily=weather_code,temperature_2m_max,precipitation_probability_max";
    const res = await fetchImpl(url);
    if (!res.ok) return null;
    const d = (await res.json())?.daily;
    if (!d?.time?.length) return null;
    return d.time.map((date, i) => ({
      date,
      code: d.weather_code[i],
      temp: Math.round(d.temperature_2m_max[i]),
      rain: d.precipitation_probability_max[i] ?? 0,
    }));
  });
}

const isWet = (day) => day && (day.rain >= 55 || (day.code >= 51 && day.code <= 99));
const isSnow = (day) => day && day.code >= 71 && day.code <= 77;

/* ---------- Textbausteine ---------- */

// Häufigste Sportarten der Person, neuere Einträge zählen mehr.
export function favourites(entries, memberId, today) {
  const score = new Map();
  for (const e of entries) {
    if (e.member_id !== memberId || e.kind === "sick" || !e.sport) continue;
    const age = Math.max(0, Math.round((Date.parse(today) - Date.parse(e.date)) / 864e5));
    if (age > 120) continue;
    score.set(e.sport, (score.get(e.sport) || 0) + (age <= 28 ? 3 : age <= 70 ? 2 : 1));
  }
  return [...score.entries()].sort((a, b) => b[1] - a[1]).map(([s]) => s);
}

function suggestion(favs, weather, tzDow, seed) {
  const today = weather?.[0];
  const indoorFavs = favs.filter((s) => INDOOR.has(s));
  const outdoorFavs = favs.filter((s) => OUTDOOR.has(s));
  const anyFav = favs[0];
  const take = (list, fallback) => list[0] || (favs.length && !INDOOR.has(anyFav) && !OUTDOOR.has(anyFav) ? anyFav : pick(fallback, seed));

  if (!weather) {
    if (anyFav) return pick([
      `${cap(anyFav)} wie zuletzt?`,
      `${cap(anyFav)} stand dir bisher gut.`,
      `Wie wär's mit ${anyFav}?`,
    ], seed);
    return pick([
      "Schon 30 Minuten zählen.",
      "Ein zügiger Spaziergang zählt auch.",
      "Irgendwas ist besser als nichts.",
    ], seed);
  }

  if (isSnow(today)) {
    const s = take(indoorFavs, FALLBACK_INDOOR);
    return `Draußen Schnee bei ${today.temp}° – ${s} geht trotzdem.`;
  }

  if (isWet(today)) {
    const dry = weather.slice(1).find((d) => !isWet(d));
    const inside = take(indoorFavs, FALLBACK_INDOOR);
    if (dry && outdoorFavs.length) {
      const day = DOW_DE[new Date(dry.date + "T12:00:00Z").getUTCDay()];
      return pick([
        `Heute Regen, ${day} trocken: ${outdoorFavs[0]} dann – oder heute ${inside}.`,
        `Heute nass, ${day} bei ${dry.temp}° trocken. Oder du nimmst ${inside}.`,
      ], seed);
    }
    return pick([
      `Draußen regnet's, drinnen nicht: ${inside}?`,
      `Regen heute. ${inside} macht das wett.`,
    ], seed);
  }

  const out = take(outdoorFavs, FALLBACK_OUTDOOR);
  if (today.temp >= 22) return `${today.temp}° und trocken – ${out} wäre genau richtig.`;
  if (today.temp <= 4) return `${today.temp}°, aber trocken. ${cap(out)} und du bist warm.`;
  return pick([
    `${today.temp}° und trocken – ${out}?`,
    `Trocken heute, ${today.temp}°. Gute Bedingungen für ${out}.`,
    `Kein Regen heute: ${out}.`,
  ], seed);
}

function opener(kind, ctx, seed) {
  const { name, streak, left, days, required, fine, currency, aheadOf } = ctx;
  const unit = (n) => (n === 1 ? "Einheit" : "Einheiten");

  if (kind === "last") {
    return pick([
      `Letzter Tag, ${name}. Noch ${left} ${unit(left)}, sonst sind ${fine} ${currency} weg.`,
      `Heute oder ${fine} ${currency}: noch ${left} ${unit(left)}.`,
      `Sonntag. Noch ${left} ${unit(left)} zwischen dir und ${fine} ${currency}.`,
    ], seed);
  }

  if (kind === "push") {
    const base = [
      `${left} ${unit(left)} fehlt noch, ${name} – dann ist die Woche sauber.`,
      `Fast geschafft: noch ${left} ${unit(left)} in ${days} ${days === 1 ? "Tag" : "Tagen"}.`,
      `Eine hast du. Noch ${left} und die Woche zählt.`,
    ];
    if (streak >= 3) base.push(`${streak} Wochen am Stück – noch ${left} ${unit(left)}, dann sind es ${streak + 1}.`);
    return pick(base, seed);
  }

  const base = [
    `${required} ${unit(required)}, ${days} Tage. Geht noch locker, ${name}.`,
    `Diese Woche steht noch die Null, ${name}.`,
    `Noch ${days} Tage für ${required} ${unit(required)}.`,
  ];
  if (streak >= 2) {
    base.unshift(`🔥 ${streak} Wochen am Stück – und diese Woche noch nichts.`);
    base.unshift(`Deine Serie steht bei ${streak} Wochen. Noch ${days} Tage, um sie zu halten.`);
  }
  if (aheadOf) base.push(`${aheadOf} ist diese Woche schon durch. Du hast noch ${days} Tage.`);
  return pick(base, seed);
}

/* ---------- Meldung über einen neuen Eintrag ---------- */

// Was an der Einheit bemerkenswert ist - kurz, sonst passt es nicht ins Banner.
function detailOf(meta) {
  if (!meta) return "";
  const km = meta.Distanz, dauer = meta.Dauer, hm = meta.Anstieg;
  if (km && dauer) return `${km} in ${dauer}`;
  if (km) return km;
  if (dauer && hm) return `${dauer}, ${hm}`;
  if (dauer) return dauer;
  return hm || "";
}

// "war Laufen" klingt richtig, "war Krafttraining" nicht - deshalb nur bei
// Sportarten, die wie ein Verb gebaut sind.
const verbal = (sport) => /e[nr]$/.test(sport || "");
const zahlwort = (n) => ["null", "allein", "zweit", "dritt", "viert", "fünft", "sechst", "siebt", "acht"][n] || (n + "."); 

/**
 * Die Nachricht, die alle anderen bekommen, wenn jemand etwas einträgt.
 * Soll neugierig machen statt Protokoll zu führen: was war los, was ist
 * dabei herausgekommen, und ein Anstoß, selbst loszuziehen.
 *
 * @param crew    wie viele zusammen unterwegs waren
 * @param yours   war der Empfänger selbst dabei?
 * @param behind  wie viele Einheiten dem Empfänger noch fehlen (0 = keine)
 */
export function entryMessage({ who, kind, sport, note, meta, crew = 1, yours = false, behind = 0, seed = 0 }) {
  if (kind === "sick") {
    return pick([
      `${who} hat sich für diese Woche krankgemeldet. Gute Besserung!`,
      `${who} hat sich diese Woche krankgemeldet – gute Besserung.`,
    ], seed);
  }

  const act = sport || "eine Einheit";
  const detail = detailOf(meta);
  const extra = detail ? ` ${detail}.` : note ? ` „${note.slice(0, 60)}“` : "";

  // Wer selbst dabei war, bekommt eine Bestätigung statt einer Einladung.
  if (yours && crew > 1) {
    return pick([
      `Eure Runde ${act} ist eingetragen – zählt auch für dich. 🙌`,
      `${act} zu ${zahlwort(crew)} ist drin. Zählt für dich mit. 🙌`,
      `Eingetragen: ${act}, gemeinsam.${extra} Zählt auch für dich. 🙌`,
    ], seed);
  }

  // Gemeinsamer Sport ist das Beste, was die Gruppe tun kann - das darf man feiern.
  if (crew > 1) {
    const feier = [
      `🙌 ${who} waren zusammen ${act}!`,
      `Gemeinsame Runde: ${who} waren ${act}. 🙌`,
      `${who} haben ${act} zusammen durchgezogen – so geht das! 🙌`,
      `Zu ${zahlwort(crew)} unterwegs: ${who} waren ${act}. 🙌`,
    ];
    const dazu = behind > 0
      ? [behind === 1 ? "Dir fehlt noch eine – beim nächsten Mal mit?" : `Dir fehlen noch ${behind}. Nächstes Mal mit?`]
      : ["Beim nächsten Mal dabei?",
         "Wer schließt sich das nächste Mal an?",
         "Das nächste Mal zu einem mehr?",
         "Sowas geht auch mit dir."];
    return `${pick(feier, seed)}${extra} ${pick(dazu, seed >>> 3)}`;
  }

  const heads = [`${who} hat ${act} gemacht.`,
                 `${who} hat ${act} abgehakt.`,
                 `Neu von ${who}: ${act}.`,
                 `${act} von ${who} steht im Feed.`];
  if (verbal(act)) heads.push(`${who} war ${act}.`);

  const calls = [
    "Schau rein, vielleicht springt der Funke über.",
    "Na, wer zieht nach?",
    "Lust mitzuziehen?",
    "Macht die nächste doch zusammen.",
    "Schau dir die Runde an – oder plant die nächste gemeinsam.",
    "Zieh nach, dann steht ihr beide gut da.",
  ];
  const nudged = [
    behind === 1 ? "Dir fehlt noch eine – vielleicht heute?" : `Dir fehlen noch ${behind}. Mitziehen?`,
    behind === 1 ? "Eine fehlt dir noch. Wie wär's?" : `Noch ${behind} für dich. Zieh nach.`,
  ];

  const tail = behind > 0 ? pick(nudged, seed >>> 3) : pick(calls, seed >>> 3);
  return `${pick(heads, seed)}${extra} ${tail}`;
}

export function buildMessage(kind, ctx, favs, weather, seed) {
  const head = opener(kind, ctx, seed);
  const tail = suggestion(favs, weather, ctx.dow, seed >>> 5);
  return { title: "Das Programm", body: `${head} ${tail}`, tag: "nudge-" + ctx.week + "-" + kind, url: "/#feed" };
}

// Der kurze Zusatz, den eine fremde Meldung ab Wochenmitte bekommt.
// dow: 0 = Montag. Leer heisst: nichts anhaengen.
export function behindHint({ dow, required, credit, recipientId, authorId }) {
  if (dow < 2) return "";                      // Montag und Dienstag ist es zu frueh
  if (!recipientId || recipientId === authorId) return "";
  const left = required - credit;
  if (left <= 0) return "";                    // wer durch ist, wird in Ruhe gelassen
  if (left === 1) return " Dir fehlt noch eine.";
  return ` Dir fehlen noch ${left}.`;
}
