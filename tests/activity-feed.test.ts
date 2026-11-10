import {
  buildActivityFeed,
  memberDebtBreakdown,
  netDebtsByCounterparty,
  sortByTimestampDesc,
  sortMembersSelfFirst,
} from "@/lib/utils";
import type { DebtEdge } from "@/lib/types";

const edges: DebtEdge[] = [
  { from: "bob", from_name: "Bob", to: "me", to_name: "Me", amount: 10 },
  { from: "me", from_name: "Me", to: "cara", to_name: "Cara", amount: 4 },
  { from: "bob", from_name: "Bob", to: "cara", to_name: "Cara", amount: 7 },
];

describe("sortByTimestampDesc", () => {
  it("orders newest first without mutating the input", () => {
    const items = [{ ts: "2024-01-01" }, { ts: "2024-03-01" }, { ts: "2024-02-01" }];
    const sorted = sortByTimestampDesc(items);

    expect(sorted.map((i) => i.ts)).toEqual([
      "2024-03-01",
      "2024-02-01",
      "2024-01-01",
    ]);
    expect(items[0].ts).toBe("2024-01-01");
  });
});

describe("memberDebtBreakdown", () => {
  it("frames every edge touching the member from their point of view", () => {
    expect(memberDebtBreakdown(edges, "bob")).toEqual([
      { direction: "owes", name: "Me", amount: 10 },
      { direction: "owes", name: "Cara", amount: 7 },
    ]);
    expect(memberDebtBreakdown(edges, "cara")).toEqual([
      { direction: "owed", name: "Me", amount: 4 },
      { direction: "owed", name: "Bob", amount: 7 },
    ]);
  });

  it("returns nothing for a member with no edges", () => {
    expect(memberDebtBreakdown(edges, "nobody")).toEqual([]);
  });
});

describe("netDebtsByCounterparty", () => {
  it("signs amounts from the current user's perspective", () => {
    const net = netDebtsByCounterparty(edges, "me");

    expect(net.get("bob")).toBe(10);
    expect(net.get("cara")).toBe(-4);
    expect(net.has("me")).toBe(false);
  });

  it("nets several edges with the same counterparty", () => {
    const net = netDebtsByCounterparty(
      [
        { from: "bob", from_name: "Bob", to: "me", to_name: "Me", amount: 10 },
        { from: "me", from_name: "Me", to: "bob", to_name: "Bob", amount: 3 },
      ],
      "me"
    );

    expect(net.get("bob")).toBe(7);
  });

  it("is empty when the user has no edges", () => {
    expect(netDebtsByCounterparty(edges, undefined).size).toBe(0);
  });
});

describe("sortMembersSelfFirst", () => {
  it("puts the current user first, then sorts by name", () => {
    const members = [
      { user_id: "cara", profiles: { full_name: "Cara" } },
      { user_id: "me", profiles: { full_name: "Zoe" } },
      { user_id: "bob", profiles: { full_name: "Bob" } },
    ];

    expect(sortMembersSelfFirst(members, "me").map((m) => m.user_id)).toEqual([
      "me",
      "bob",
      "cara",
    ]);
  });

  it("tolerates a missing display name", () => {
    const members = [
      { user_id: "a", profiles: null },
      { user_id: "b", profiles: { full_name: "Bob" } },
    ];

    expect(sortMembersSelfFirst(members, undefined).map((m) => m.user_id)).toEqual(
      ["a", "b"]
    );
  });
});

describe("buildActivityFeed", () => {
  it("merges every source into one newest-first feed", () => {
    const { past: feed } = buildActivityFeed({
      expenses: [{ id: "e1", date: "2024-01-02" }] as never,
      payments: [{ id: "p1", date: "2024-01-05" }] as never,
      contactExpenses: [{ id: "ce1", date: "2024-01-01" }] as never,
      contactPayments: [{ id: "cp1", date: "2024-01-04" }] as never,
      simplifyEvents: [{ id: "s1", created_at: "2024-01-03" }] as never,
    });

    expect(feed.map((item) => item.kind)).toEqual([
      "payment",
      "contact-payment",
      "simplify-debts",
      "expense",
      "contact-expense",
    ]);
    // The uniform id/payload shape is what lets the feed be keyed and sorted
    // without a per-kind branch.
    expect(feed.map((item) => item.id)).toEqual([
      "p1",
      "cp1",
      "s1",
      "e1",
      "ce1",
    ]);
    expect(feed[0].payload).toEqual({ id: "p1", date: "2024-01-05" });
  });

  it("orders payments by their date, not when they were recorded", () => {
    const { past: feed } = buildActivityFeed({
      expenses: [{ id: "e1", date: "2024-01-05" }] as never,
      payments: [
        { id: "p1", created_at: "2024-01-01", date: "2024-01-09" },
      ] as never,
      contactPayments: [
        { id: "cp1", created_at: "2024-01-08", date: "2024-01-02" },
      ] as never,
    });

    expect(feed.map((item) => item.id)).toEqual(["p1", "e1", "cp1"]);
  });

  it("returns an empty feed when every source is missing", () => {
    expect(buildActivityFeed({})).toEqual({ upcoming: [], past: [] });
  });

  describe("upcoming rows", () => {
    const NOW = new Date("2026-11-09T12:00:00.000Z");
    const PAST = "2026-11-01T00:00:00.000Z";
    const FUTURE = "2026-11-20T00:00:00.000Z";

    it.each([
      ["expenses", "expense"],
      ["payments", "payment"],
      ["contactExpenses", "contact-expense"],
      ["contactPayments", "contact-payment"],
    ] as const)("moves a future row in %s to upcoming only", (source, kind) => {
      const feed = buildActivityFeed(
        {
          [source]: [
            { id: "past-row", date: PAST },
            { id: "future-row", date: FUTURE },
          ],
        } as never,
        NOW
      );

      expect(feed.upcoming.map((i) => [i.kind, i.id])).toEqual([
        [kind, "future-row"],
      ]);
      expect(feed.past.map((i) => [i.kind, i.id])).toEqual([[kind, "past-row"]]);
    });

    it("orders upcoming soonest first across sources", () => {
      const feed = buildActivityFeed(
        {
          payments: [{ id: "p", date: "2026-12-01T00:00:00.000Z" }],
          contactExpenses: [{ id: "ce", date: "2026-11-10T00:00:00.000Z" }],
          contactPayments: [{ id: "cp", date: "2026-11-30T00:00:00.000Z" }],
          upcomingExpenses: [{ id: "e", date: "2026-11-15T00:00:00.000Z" }],
        } as never,
        NOW
      );

      expect(feed.upcoming.map((i) => i.id)).toEqual(["ce", "e", "cp", "p"]);
      expect(feed.past).toEqual([]);
    });

    it("takes the upcoming-expenses source as upcoming and drops a duplicate of a past row", () => {
      const feed = buildActivityFeed(
        {
          expenses: [{ id: "e1", date: PAST }],
          upcomingExpenses: [
            { id: "e2", date: FUTURE },
            { id: "e1", date: PAST },
          ],
        } as never,
        NOW
      );

      expect(feed.upcoming.map((i) => i.id)).toEqual(["e2"]);
      expect(feed.past.map((i) => i.id)).toEqual(["e1"]);
    });

    it("moves an upcoming-expenses row to the past once its date has passed", () => {
      const sources = {
        upcomingExpenses: [{ id: "e1", date: FUTURE }],
      } as never;

      expect(buildActivityFeed(sources, NOW).upcoming).toHaveLength(1);

      const later = new Date("2026-11-21T00:00:00.000Z");
      const feed = buildActivityFeed(sources, later);
      expect(feed.upcoming).toEqual([]);
      expect(feed.past.map((i) => i.id)).toEqual(["e1"]);
    });

    it("treats a row exactly at now as past", () => {
      const feed = buildActivityFeed(
        { payments: [{ id: "p", date: NOW.toISOString() }] } as never,
        NOW
      );

      expect(feed.upcoming).toEqual([]);
      expect(feed.past.map((i) => i.id)).toEqual(["p"]);
    });

    it("has no upcoming rows when everything is in the past", () => {
      const feed = buildActivityFeed(
        { expenses: [{ id: "e", date: PAST }] } as never,
        NOW
      );

      expect(feed.upcoming).toEqual([]);
    });
  });
});
