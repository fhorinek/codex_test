import type { TaskDates } from './taskDates.js';

export type WorkloadEntry = { people: string[]; dates: TaskDates };
export type PersonWorkload = { person: string; days: Array<{ day: number; count: number }> };

/** Count each assigned task once per calendar day, clipped to the visible window. */
export function buildDailyWorkload(entries: WorkloadEntry[], firstDay: number, lastDay: number, openEnded = true): { people: PersonWorkload[]; peak: number } {
  const counts = new Map<string, Map<number, number>>();
  let peak = 0;
  for (const { people, dates } of entries) {
    if (dates.start === null && dates.end === null) continue;
    const from = Math.max(firstDay, dates.start ?? (openEnded ? firstDay : dates.end!));
    const to = Math.min(lastDay, dates.end ?? (openEnded ? lastDay : dates.start!));
    for (const person of new Set(people)) {
      let days = counts.get(person);
      if (!days) { days = new Map(); counts.set(person, days); }
      for (let day = from; day <= to; day++) {
        const count = (days.get(day) || 0) + 1;
        days.set(day, count); peak = Math.max(peak, count);
      }
    }
  }
  return { people: Array.from(counts, ([person, days]) => ({ person, days: Array.from(days, ([day, count]) => ({ day, count })).sort((a, b) => a.day - b.day) })), peak };
}

/** One task stays small; the largest visible overlap fills the available height. */
export function workloadBoxSize(count: number, peak: number): number {
  if (count <= 0) return 0;
  if (count === 1 || peak <= 1) return 7;
  return 7 + 17 * Math.min(1, (count - 1) / (peak - 1));
}
