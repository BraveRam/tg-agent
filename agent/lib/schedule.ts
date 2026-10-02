import { DateTime } from "luxon";
import type { Schedule } from "./types";
export function nextDue(schedule: Schedule, after: number): number {
  if (schedule.kind === "interval") return after + schedule.minutes * 60000;
  const base = DateTime.fromMillis(after, { zone: schedule.timezone });
  if (!base.isValid) throw new Error("Invalid schedule timezone");
  for (let offset = 0; offset < 9; offset++) {
    const day = base.startOf("day").plus({ days: offset });
    if (schedule.weekdays && !schedule.weekdays.includes(day.weekday)) continue;
    const candidates = schedule.times
      .map((t) => {
        const [hour, minute] = t.split(":").map(Number);
        return day.set({ hour, minute, second: 0, millisecond: 0 }).toMillis();
      })
      .filter((t) => t > after)
      .sort((a, b) => a - b);
    if (candidates.length) return candidates[0];
  }
  throw new Error("Schedule has no next occurrence");
}
