import { config } from "../config/index.js";

const DAY_MS = 24 * 60 * 60 * 1000;

export function isWeekend(d: Date): boolean {
  const day = d.getDay(); // 0 = Sun, 6 = Sat
  return day === 0 || day === 6;
}

/** Add N business days (skipping weekends) to a date, preserving time-of-day. */
export function addBusinessDays(start: Date, businessDays: number): Date {
  const d = new Date(start.getTime());
  let remaining = businessDays;
  if (config.sending.sendOnWeekends) {
    return new Date(start.getTime() + businessDays * DAY_MS);
  }
  // Walk forward one calendar day at a time, counting only weekdays.
  while (remaining > 0) {
    d.setDate(d.getDate() + 1);
    if (!isWeekend(d)) remaining--;
  }
  return d;
}

/**
 * Clamp a target datetime into the configured sending window and onto a valid
 * sending day. If the time is before the window, move to the window start; if
 * after the window (or on a skipped weekend), roll to the next valid day's
 * window start. A small random jitter is added so sends don't look robotic.
 */
export function clampToSendWindow(target: Date): Date {
  const { windowStartHour, windowEndHour, sendOnWeekends } = config.sending;
  const d = new Date(target.getTime());

  const rollToNextDayStart = () => {
    d.setDate(d.getDate() + 1);
    d.setHours(windowStartHour, 0, 0, 0);
  };

  // Skip weekends if configured.
  while (!sendOnWeekends && isWeekend(d)) {
    d.setHours(windowStartHour, 0, 0, 0);
    d.setDate(d.getDate() + 1);
  }

  if (d.getHours() < windowStartHour) {
    d.setHours(windowStartHour, 0, 0, 0);
  } else if (d.getHours() >= windowEndHour) {
    rollToNextDayStart();
    while (!sendOnWeekends && isWeekend(d)) {
      d.setDate(d.getDate() + 1);
      d.setHours(windowStartHour, 0, 0, 0);
    }
  }

  // Jitter: 0–55 minutes so each send lands at a human-ish minute.
  const jitterMin = Math.floor(Math.random() * 55);
  d.setMinutes(d.getMinutes() + jitterMin);

  // Re-clamp if jitter pushed us past the window end hour.
  if (d.getHours() >= windowEndHour) {
    d.setHours(windowEndHour - 1, jitterMin % 60, 0, 0);
  }
  return d;
}

/** Compute the scheduled send time for a sequence step from an anchor date. */
export function scheduleFromAnchor(anchor: Date, businessDayOffset: number): Date {
  const base = addBusinessDays(anchor, businessDayOffset);
  return clampToSendWindow(base);
}

export function nowInWindow(d = new Date()): boolean {
  const { windowStartHour, windowEndHour, sendOnWeekends } = config.sending;
  if (!sendOnWeekends && isWeekend(d)) return false;
  const h = d.getHours();
  return h >= windowStartHour && h < windowEndHour;
}
