import { nextUpcomingAt, partitionUpcoming } from "@/lib/upcoming";

const NOW = new Date("2026-11-09T12:00:00.000Z");
const byDate = (row: { date: string }) => row.date;

describe("partitionUpcoming", () => {
  it("splits future rows from past rows", () => {
    const rows = [
      { id: "past", date: "2026-11-01T00:00:00.000Z" },
      { id: "future", date: "2026-12-01T00:00:00.000Z" },
    ];

    const { upcoming, past } = partitionUpcoming(rows, byDate, NOW);

    expect(upcoming.map((r) => r.id)).toEqual(["future"]);
    expect(past.map((r) => r.id)).toEqual(["past"]);
  });

  it("orders upcoming soonest first and past newest first", () => {
    const rows = [
      { id: "f-late", date: "2027-01-01T00:00:00.000Z" },
      { id: "p-old", date: "2026-01-01T00:00:00.000Z" },
      { id: "f-soon", date: "2026-11-10T00:00:00.000Z" },
      { id: "p-new", date: "2026-11-08T00:00:00.000Z" },
    ];

    const { upcoming, past } = partitionUpcoming(rows, byDate, NOW);

    expect(upcoming.map((r) => r.id)).toEqual(["f-soon", "f-late"]);
    expect(past.map((r) => r.id)).toEqual(["p-new", "p-old"]);
  });

  it("treats a row exactly at now as past, and one millisecond later as upcoming", () => {
    const rows = [
      { id: "at-now", date: NOW.toISOString() },
      { id: "just-after", date: new Date(NOW.getTime() + 1).toISOString() },
    ];

    const { upcoming, past } = partitionUpcoming(rows, byDate, NOW);

    expect(upcoming.map((r) => r.id)).toEqual(["just-after"]);
    expect(past.map((r) => r.id)).toEqual(["at-now"]);
  });

  it("does not mutate its input and handles empty input", () => {
    const rows = [
      { id: "a", date: "2026-12-01T00:00:00.000Z" },
      { id: "b", date: "2026-11-20T00:00:00.000Z" },
    ];
    partitionUpcoming(rows, byDate, NOW);

    expect(rows.map((r) => r.id)).toEqual(["a", "b"]);
    expect(partitionUpcoming([], byDate, NOW)).toEqual({
      upcoming: [],
      past: [],
    });
  });
});

describe("nextUpcomingAt", () => {
  it("returns the earliest date strictly after now", () => {
    const next = nextUpcomingAt(
      [
        "2026-01-01T00:00:00.000Z",
        "2026-12-25T00:00:00.000Z",
        "2026-11-20T00:00:00.000Z",
      ],
      NOW
    );

    expect(next).toBe(new Date("2026-11-20T00:00:00.000Z").getTime());
  });

  it("ignores a date exactly at now", () => {
    expect(nextUpcomingAt([NOW.toISOString()], NOW)).toBeUndefined();
  });

  it("is undefined when nothing is upcoming", () => {
    expect(nextUpcomingAt([], NOW)).toBeUndefined();
    expect(nextUpcomingAt(["2020-01-01T00:00:00.000Z"], NOW)).toBeUndefined();
  });
});
