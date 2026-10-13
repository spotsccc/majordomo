import { beforeEach, describe, expect, it, vi } from "vitest";

async function ownerTime(zone: string | undefined) {
  vi.stubEnv("OWNER_TIME_ZONE", zone);
  return import("./owner-time");
}

describe("owner-time", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it("puts 01:00 UTC on the 1st into the previous month in Buenos Aires", async () => {
    const { ownerMonthRange } = await ownerTime(
      "America/Argentina/Buenos_Aires",
    );

    expect(ownerMonthRange(new Date("2026-10-01T01:00:00Z"))).toEqual({
      from: new Date("2026-09-01T03:00:00Z"),
      to: new Date("2026-10-01T03:00:00Z"),
    });
  });

  it("counts in UTC when the zone is not set", async () => {
    const { ownerMonthRange, ownerDayRange } = await ownerTime("");

    expect(ownerMonthRange(new Date("2026-10-01T01:00:00Z"))).toEqual({
      from: new Date("2026-10-01T00:00:00Z"),
      to: new Date("2026-11-01T00:00:00Z"),
    });
    expect(ownerDayRange("2026-12-31")).toEqual({
      from: new Date("2026-12-31T00:00:00Z"),
      to: new Date("2027-01-01T00:00:00Z"),
    });
  });

  it("gives a day from the owner's midnight to the next one", async () => {
    const { ownerDayRange } = await ownerTime("America/Argentina/Buenos_Aires");

    expect(ownerDayRange("2026-09-30")).toEqual({
      from: new Date("2026-09-30T03:00:00Z"),
      to: new Date("2026-10-01T03:00:00Z"),
    });
  });

  it("gives 23 and 25 hours to the days when Berlin changes the clock", async () => {
    const { ownerDayRange } = await ownerTime("Europe/Berlin");

    expect(ownerDayRange("2026-03-29")).toEqual({
      from: new Date("2026-03-28T23:00:00Z"),
      to: new Date("2026-03-29T22:00:00Z"),
    });
    expect(ownerDayRange("2026-10-25")).toEqual({
      from: new Date("2026-10-24T22:00:00Z"),
      to: new Date("2026-10-25T23:00:00Z"),
    });
  });

  it("formats the date, the weekday and the time in the owner's zone", async () => {
    const { formatOwnerDateTime } = await ownerTime(
      "America/Argentina/Buenos_Aires",
    );

    expect(formatOwnerDateTime(new Date("2026-10-12T18:04:00Z"))).toBe(
      "понедельник, 12 октября 2026 г. в 15:04",
    );
  });

  it("gives the owner's time with the zone offset for the prompt", async () => {
    const { ownerIsoDateTime } = await ownerTime(
      "America/Argentina/Buenos_Aires",
    );
    expect(ownerIsoDateTime(new Date("2026-10-12T18:04:05.678Z"))).toBe(
      "2026-10-12T15:04:05-03:00",
    );

    vi.resetModules();
    const { ownerIsoDateTime: inKolkata } = await ownerTime("Asia/Kolkata");
    expect(inKolkata(new Date("2026-10-12T18:04:05Z"))).toBe(
      "2026-10-12T23:34:05+05:30",
    );

    vi.resetModules();
    const { ownerIsoDateTime: inUtc } = await ownerTime("");
    expect(inUtc(new Date("2026-10-12T18:04:05Z"))).toBe(
      "2026-10-12T18:04:05+00:00",
    );
  });

  it("reads a datetime-local value as the owner's wall time, also on a clock change day", async () => {
    const { fromOwnerDateTime } = await ownerTime("Europe/Berlin");

    expect(fromOwnerDateTime("2026-10-12T14:02")).toEqual(
      new Date("2026-10-12T12:02:00Z"),
    );
    expect(fromOwnerDateTime("2026-10-25T05:30")).toEqual(
      new Date("2026-10-25T04:30:00Z"),
    );
    expect(fromOwnerDateTime("2026-03-29T01:30")).toEqual(
      new Date("2026-03-29T00:30:00Z"),
    );
  });

  it("formats a short date and time in the owner's zone", async () => {
    const { formatOwnerShortDateTime } = await ownerTime(
      "America/Argentina/Buenos_Aires",
    );

    expect(formatOwnerShortDateTime(new Date("2026-10-12T18:04:00Z"))).toBe(
      "12 окт. 2026 г., 15:04",
    );
  });

  it("stops the server start on an unknown zone", async () => {
    await expect(ownerTime("Mars/Olympus_Mons")).rejects.toThrow(
      "OWNER_TIME_ZONE",
    );
  });
});
