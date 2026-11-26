// Zahlen für die Auswertungsseite: persönlich und für die Gruppe.
//
// Die Messwerte stehen als fertiger Text in `meta` ("8,20 km", "44 min").
// Das ist bewusst so - angezeigt wird genau das, was eingetragen wurde.
// Zum Rechnen lesen wir sie hier wieder zurück; die Formate stammen aus
// dieser App, sind also verlässlich.

import { weekOf, addWeeks } from "./stats.js";

export function parseMeta(metaJson) {
  if (!metaJson) return { km: 0, secs: 0, climb: 0, hr: 0, kcal: 0, hasData: false };
  let m;
  try { m = JSON.parse(metaJson); } catch { return { km: 0, secs: 0, climb: 0, hr: 0, kcal: 0, hasData: false }; }

  const num = (s) => parseFloat(String(s ?? "").replace(",", ".")) || 0;
  let secs = 0;
  const d = String(m.Dauer ?? "");
  if (d.includes(":")) {                      // "1:12 h"
    const [h, min] = d.split(":");
    secs = (parseInt(h, 10) || 0) * 3600 + (parseInt(min, 10) || 0) * 60;
  } else if (d) {                             // "44 min"
    secs = (parseInt(d, 10) || 0) * 60;
  }
  const out = {
    km: num(m.Distanz),
    secs,
    climb: parseInt(m.Anstieg, 10) || 0,
    hr: parseInt(m.Puls, 10) || 0,
    kcal: parseInt(m.kcal, 10) || 0,
  };
  out.hasData = !!(out.km || out.secs);
  return out;
}

const EMPTY = () => ({
  sessions: 0, sick: 0, withData: 0, secs: 0, km: 0, climb: 0, kcal: 0,
  hrSum: 0, hrCount: 0,
  sports: new Map(), weekdays: [0, 0, 0, 0, 0, 0, 0], byWeek: new Map(),
  days: new Set(), together: 0, longestKm: null, longestTime: null,
  first: null, last: null,
});

// Bestmarke merken - nur aus dem, was wirklich eingetragen wurde, nie geschätzt.
const mark = (entry, value) => ({ value, sport: entry.sport || null, date: entry.date, member_id: entry.member_id });

function add(acc, entry, m) {
  if (entry.kind === "sick") { acc.sick += entry.units || 1; return; }
  acc.sessions++;
  if (m.hasData) acc.withData++;
  acc.secs += m.secs;
  acc.km += m.km;
  acc.climb += m.climb;
  acc.kcal += m.kcal;
  if (m.hr) { acc.hrSum += m.hr; acc.hrCount++; }

  const sport = entry.sport || "Ohne Angabe";
  const s = acc.sports.get(sport) || { sport, count: 0, secs: 0, km: 0, people: new Set() };
  s.count++; s.secs += m.secs; s.km += m.km; s.people.add(entry.member_id);
  acc.sports.set(sport, s);

  acc.days.add(entry.date);
  if (entry.group_id) acc.together++;
  if (m.km > (acc.longestKm?.value || 0)) acc.longestKm = mark(entry, m.km);
  if (m.secs > (acc.longestTime?.value || 0)) acc.longestTime = mark(entry, m.secs);

  // 0 = Montag
  const day = (new Date(entry.date + "T12:00:00Z").getUTCDay() + 6) % 7;
  acc.weekdays[day]++;

  const w = weekOf(entry.date);
  acc.byWeek.set(w, (acc.byWeek.get(w) || 0) + 1);

  if (!acc.first || entry.date < acc.first) acc.first = entry.date;
  if (!acc.last || entry.date > acc.last) acc.last = entry.date;
}

function finish(acc, weeksBack, memberCount = 1) {
  const sports = [...acc.sports.values()]
    .map(({ people, ...s }) => ({ ...s, people: people.size }))
    .sort((a, b) => b.count - a.count || b.secs - a.secs);
  let bestWeek = null;
  for (const [week, units] of acc.byWeek) {
    if (!bestWeek || units > bestWeek.units || (units === bestWeek.units && week > bestWeek.week)) bestWeek = { week, units };
  }
  return {
    sessions: acc.sessions,
    sick: acc.sick,
    withData: acc.withData,
    hours: Math.round((acc.secs / 3600) * 10) / 10,
    km: Math.round(acc.km * 10) / 10,
    climb: Math.round(acc.climb),
    kcal: acc.kcal,
    avgMinutes: acc.withData ? Math.round(acc.secs / 60 / acc.withData) : 0,
    avgHr: acc.hrCount ? Math.round(acc.hrSum / acc.hrCount) : 0,
    sportCount: sports.filter((s) => s.sport !== "Ohne Angabe").length,
    activeDays: acc.days.size,
    together: acc.together,
    longestKm: acc.longestKm && { ...acc.longestKm, value: Math.round(acc.longestKm.value * 10) / 10 },
    longestTime: acc.longestTime,
    bestWeek,
    sports: sports.slice(0, 8),
    moreSports: Math.max(0, sports.length - 8),
    weekdays: acc.weekdays,
    weeks: weeksBack.map((w) => ({ week: w, units: acc.byWeek.get(w) || 0 })),
    first: acc.first,
    memberCount,
  };
}

/**
 * @param {object} args
 * @param {Array}  args.members  Teilnehmer
 * @param {Array}  args.entries  alle Einträge (ohne Fotos)
 * @param {object} args.settings
 * @param {string} args.today    ISO-Datum
 * @param {number} args.span     wie viele Wochen der Verlauf zeigt
 */
export function report({ members, entries, settings, today, span = 12 }) {
  const cur = weekOf(today);
  const weeksBack = [];
  for (let i = span - 1; i >= 0; i--) weeksBack.push(addWeeks(cur, -i));

  // Gezählt wird erst ab dem Start der Challenge - und je Person erst ab dem
  // Tag, an dem sie dabei ist. Was davor in Strava lag, gehört nicht dazu.
  const teamFrom = weekOf(settings.start || today);
  const memberFrom = new Map(members.map((m) => [
    m.id,
    weekOf(m.joined && m.joined > (settings.start || "") ? m.joined : (settings.start || today)),
  ]));

  const perMember = new Map(members.map((m) => [m.id, EMPTY()]));
  const team = EMPTY();
  const teamWeeks = new Map();            // Woche -> { memberId: Einheiten }
  const groups = new Set();

  for (const e of entries) {
    const w = weekOf(e.date);
    if (w < teamFrom) continue;
    const m = parseMeta(e.meta);
    const acc = (memberFrom.get(e.member_id) ?? teamFrom) <= w ? perMember.get(e.member_id) : null;
    if (acc) add(acc, e, m);
    add(team, e, m);
    if (e.kind !== "sick") {
      const row = teamWeeks.get(w) || {};
      row[e.member_id] = (row[e.member_id] || 0) + 1;
      teamWeeks.set(w, row);
      if (e.group_id) groups.add(e.group_id);
    }
  }

  const out = { weeks: weeksBack, required: Number(settings.required) || 2, members: {} };
  for (const m of members) out.members[m.id] = finish(perMember.get(m.id), weeksBack);
  out.team = {
    ...finish(team, weeksBack, members.length),
    together: groups.size,
    stacked: weeksBack.map((w) => ({ week: w, byMember: teamWeeks.get(w) || {} })),
    perMember: members.map((m) => ({
      id: m.id,
      name: m.name,
      sessions: out.members[m.id].sessions,
      sportCount: out.members[m.id].sportCount,
      hours: out.members[m.id].hours,
      km: out.members[m.id].km,
    })),
  };
  return out;
}
