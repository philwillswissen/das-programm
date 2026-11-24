// Die Abrechnung einer Woche - einmal an einer Stelle, damit App, Push und
// Anstupser nie unterschiedlich rechnen.

export function weekOf(dateStr) {
  const d = new Date(dateStr + "T12:00:00Z");
  d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7));
  return d.toISOString().slice(0, 10);
}
export const addWeeks = (w, n) => {
  const d = new Date(w + "T12:00:00Z");
  d.setUTCDate(d.getUTCDate() + 7 * n);
  return d.toISOString().slice(0, 10);
};

// Was in einer Woche zusammenkommt, bevor Guthaben ins Spiel kommt.
function rawWeek(entries, memberId, week, sickMax) {
  let done = 0, sickUnits = 0;
  for (const e of entries) {
    if (e.member_id !== memberId || weekOf(e.date) !== week) continue;
    if (e.kind === "sick") sickUnits += e.units || 1;
    else done++;
  }
  return { done, sickUnits, base: done + Math.min(sickUnits, sickMax) };
}

/**
 * Rechnet jede Person durch, Woche für Woche in zeitlicher Reihenfolge.
 *
 * Guthaben entsteht nur aus echten Einheiten über dem Wochenziel. Eingesetzt
 * werden sie automatisch und nur dann, wenn die Woche sonst verloren wäre –
 * und auch dann nie für die ganze Woche: mindestens ein eigener Eintrag muss
 * stehen, Sport oder Krankmeldung. Eine komplett leere Woche rettet nichts.
 */
export function settle({ members, entries, settings, today }) {
  const required = Math.max(1, Number(settings.required) || 2);
  const sickMax = Number.isFinite(settings.sickMax) ? settings.sickMax : required;
  const cost = Math.max(1, Number(settings.bonusCost) || 3);
  const bonusOn = !!settings.bonus;
  // Gesammelt wird erst ab dem Tag, an dem die Regel eingeschaltet wurde -
  // sonst gaebe es beim Einschalten rueckwirkend ein Guthaben aus alten Wochen.
  const bonusFrom = bonusOn && settings.bonusSince ? weekOf(settings.bonusSince) : null;
  const cur = weekOf(today);
  const out = {};

  for (const m of members) {
    const from = weekOf(m.joined && m.joined > settings.start ? m.joined : settings.start);
    let credits = 0, missed = 0, weeks = 0, saved = 0, spent = 0;
    const okWeeks = [];

    for (let w = from, i = 0; w < cur && i < 520; w = addWeeks(w, 1), i++) {
      const { done, sickUnits, base } = rawWeek(entries, m.id, w, sickMax);
      weeks++;
      if (base >= required) {
        if (bonusOn && (!bonusFrom || w >= bonusFrom)) credits += Math.max(0, done - required); // nur echte Einheiten über dem Ziel
        okWeeks.push(w);
        continue;
      }
      const need = required - base;
      // Mindestens ein eigener Eintrag muss stehen - Sport oder Krankmeldung.
      const anyEntry = done + sickUnits >= 1;
      const mayCover = bonusOn && anyEntry && need <= required - 1 && credits >= need * cost;
      if (mayCover) {
        credits -= need * cost;
        spent += need * cost;
        saved++;
        okWeeks.push(w);
      } else {
        missed++;
      }
    }

    // Laufende Woche
    const now = rawWeek(entries, m.id, cur, sickMax);
    const left = Math.max(0, required - now.base);
    const pending = Math.max(0, now.done - required);          // Guthaben, das diese Woche entsteht
    const canRescue = bonusOn && now.done + now.sickUnits >= 1 && left > 0 && left <= required - 1 && credits >= left * cost;

    let streak = 0;
    if (now.base >= required) streak++;
    for (let w = addWeeks(cur, -1), i = 0; w >= from && i < 520; w = addWeeks(w, -1), i++) {
      if (okWeeks.includes(w)) streak++;
      else break;
    }

    out[m.id] = {
      sessions: entries.filter((e) => e.member_id === m.id && e.kind !== "sick").length,
      weeks, missed, saved, spent,
      paid: missed * (Number(settings.fine) || 0),
      credits, pending: bonusOn ? pending : 0, streak,
      week: { done: now.done, sick: now.sickUnits, credit: now.base, left, canRescue },
      rescueCost: left * cost,
    };
  }
  return out;
}
