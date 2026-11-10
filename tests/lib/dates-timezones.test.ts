import { execFileSync } from "node:child_process";
import path from "node:path";

// Node fixes the time zone per process, so each zone runs lib/dates.ts in a
// child process with its own TZ and reports what it sees in that zone.
const DATES_TS = path.join(__dirname, "../../lib/dates.ts");

type Day = [year: number, monthIndex: number, day: number];
type Result = {
  iso: string;
  instantDay: Day;
  minuteBeforeDay: Day;
};

const CHILD = `
const fs = require("fs");
const ts = require("typescript");
const [file, daysJson] = process.argv.slice(1);
const js = ts.transpileModule(fs.readFileSync(file, "utf8"), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
}).outputText;
const mod = { exports: {} };
new Function("module", "exports", "require", js)(mod, mod.exports, require);
const parts = (d) => [d.getFullYear(), d.getMonth(), d.getDate()];
const out = JSON.parse(daysJson).map(([y, m, d]) => {
  const iso = mod.exports.startOfLocalDayISO(new Date(y, m, d, 12));
  const instant = new Date(iso);
  return {
    iso,
    instantDay: parts(instant),
    minuteBeforeDay: parts(new Date(instant.getTime() - 60000)),
  };
});
process.stdout.write(JSON.stringify(out));
`;

function runInZone(tz: string, days: Day[]): Result[] {
  const stdout = execFileSync(
    process.execPath,
    ["-e", CHILD, DATES_TS, JSON.stringify(days)],
    { env: { ...process.env, TZ: tz }, cwd: path.join(__dirname, "../..") }
  );
  return JSON.parse(stdout.toString());
}

function previousDay([y, m, d]: Day): Day {
  const prev = new Date(Date.UTC(y, m, d - 1));
  return [prev.getUTCFullYear(), prev.getUTCMonth(), prev.getUTCDate()];
}

const ZONES: Record<string, Day[]> = {
  // Spring-forward at 02:00, fall-back at 02:00, an ordinary summer day.
  "America/Toronto": [[2026, 2, 8], [2026, 10, 1], [2026, 6, 1]],
  // UTC+13 in summer; fall-back 03:00, spring-forward 02:00.
  "Pacific/Auckland": [[2026, 3, 5], [2026, 8, 27], [2026, 10, 9]],
  // Spring-forward AT midnight (00:00 does not exist), then fall-back.
  "America/Havana": [[2026, 2, 8], [2026, 10, 1], [2026, 5, 15]],
  "America/Santiago": [[2026, 8, 6], [2026, 3, 5]],
  "Africa/Cairo": [[2026, 3, 24], [2026, 9, 30]],
  "Asia/Beirut": [[2026, 2, 29], [2026, 9, 25]],
  UTC: [[2026, 2, 8], [2028, 1, 29]],
};

describe.each(Object.entries(ZONES))("startOfLocalDayISO in %s", (tz, days) => {
  const results = runInZone(tz, days);

  it.each(days.map((day, i) => [day.join("-"), day, i] as const))(
    "is the first instant of local day %s",
    (_label, day, i) => {
      const { iso, instantDay, minuteBeforeDay } = results[i];
      expect(iso).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:00[+-]\d{2}:\d{2}$/);
      expect(instantDay).toEqual(day);
      expect(minuteBeforeDay).toEqual(previousDay(day));
    }
  );
});
