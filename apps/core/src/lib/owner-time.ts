import { config } from "./config";

const parts = new Intl.DateTimeFormat("en-US", {
  timeZone: config.OWNER_TIME_ZONE,
  year: "numeric",
  month: "numeric",
  day: "numeric",
  hour: "numeric",
  minute: "numeric",
  second: "numeric",
  hourCycle: "h23",
});

const display = new Intl.DateTimeFormat("ru-RU", {
  timeZone: config.OWNER_TIME_ZONE,
  weekday: "long",
  year: "numeric",
  month: "long",
  day: "numeric",
  hour: "2-digit",
  minute: "2-digit",
});

const short = new Intl.DateTimeFormat("ru-RU", {
  timeZone: config.OWNER_TIME_ZONE,
  year: "numeric",
  month: "short",
  day: "numeric",
  hour: "2-digit",
  minute: "2-digit",
});

export type Range = { from: Date; to: Date };

export function formatOwnerDateTime(instant: Date): string {
  return display.format(instant);
}

export function formatOwnerShortDateTime(instant: Date): string {
  return short.format(instant);
}

/** Reads the `YYYY-MM-DDTHH:mm` of a `datetime-local` input as the owner's wall time. */
export function fromOwnerDateTime(value: string): Date {
  const [year = NaN, month = NaN, day = NaN, hour = NaN, minute = NaN] = value
    .split(/[-T:]/)
    .map(Number);
  return ownerWallInstant(year, month, day, hour, minute);
}

export function ownerIsoDateTime(instant: Date): string {
  const second = Math.floor(instant.getTime() / 1000) * 1000;
  const offset = ownerUtcOffsetMs(second);
  const wall = new Date(second + offset).toISOString().slice(0, 19);
  const minutes = Math.abs(offset) / 60_000;
  const hh = String(Math.floor(minutes / 60)).padStart(2, "0");
  const mm = String(minutes % 60).padStart(2, "0");
  return `${wall}${offset < 0 ? "-" : "+"}${hh}:${mm}`;
}

export function ownerIsoDate(instant: Date): string {
  return ownerIsoDateTime(instant).slice(0, 10);
}

/** A last day `YYYY-MM-DD` is stored as the start of the owner's next day (`ownerDayRange(day).to`). */
export function ownerLastDay(end: Date): string {
  return ownerIsoDate(new Date(end.getTime() - 1));
}

export function ownerDayRange(date: string): Range {
  const year = Number(date.slice(0, 4));
  const month = Number(date.slice(5, 7));
  const day = Number(date.slice(8, 10));
  return {
    from: ownerWallInstant(year, month, day),
    to: ownerWallInstant(year, month, day + 1),
  };
}

export function ownerMonthRange(instant: Date): Range {
  const { year, month } = ownerFields(instant);
  return {
    from: ownerWallInstant(year, month, 1),
    to: ownerWallInstant(year, month + 1, 1),
  };
}

function ownerFields(instant: Date) {
  const list = parts.formatToParts(instant);
  const field = (type: Intl.DateTimeFormatPartTypes) =>
    Number(list.find((part) => part.type === type)?.value);
  return {
    year: field("year"),
    month: field("month"),
    day: field("day"),
    hour: field("hour"),
    minute: field("minute"),
    second: field("second"),
  };
}

function ownerUtcOffsetMs(instant: number): number {
  const f = ownerFields(new Date(instant));
  const wall = Date.UTC(f.year, f.month - 1, f.day, f.hour, f.minute, f.second);
  return wall - Math.floor(instant / 1000) * 1000;
}

/**
 * The offset is measured again at the first guess: on a daylight saving day the offset at the
 * owner's wall time differs from the offset at the same wall time in UTC.
 */
function ownerWallInstant(
  year: number,
  month: number,
  day: number,
  hour = 0,
  minute = 0,
): Date {
  const wall = Date.UTC(year, month - 1, day, hour, minute);
  const guess = wall - ownerUtcOffsetMs(wall);
  return new Date(wall - ownerUtcOffsetMs(guess));
}
