// The server-side exchange-rate source for foreign-currency recurring schedules:
// the exchange_rates table (nobody but the service role and SECURITY DEFINER
// functions touches it), _schedule_rate (the rate an occurrence converts at),
// and the two-step refresh (_refresh_exchange_rates_fire asks pg_net to fetch,
// _refresh_exchange_rates_store validates and upserts the response it recorded
// for that request id). PGlite has
// neither pg_net nor pg_cron, so the checks build a stub `net` schema and a stub
// `cron` schema themselves; the real extensions are not exercised here.

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const migrationFile = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "supabase",
  "migrations",
  "20261109203000_exchange_rates.sql"
);

export default async function exchangeRates({ db, asUser, signUp, check }) {
  const amy = await signUp("xr-amy@example.com", "Amy");
  const ben = await signUp("xr-ben@example.com", "Ben");
  const cat = await signUp("xr-cat@example.com", "Cat");
  const dev = await signUp("xr-dev@example.com", "Dev");
  const eli = await signUp("xr-eli@example.com", "Eli");

  const q = async (sql, params) => (await db.query(sql, params)).rows;
  const code = async (fn) => {
    try {
      await fn();
      return "(no error)";
    } catch (error) {
      return error.code ?? error.message;
    }
  };
  const near = (a, b, tolerance = 1e-12) => Math.abs(Number(a) - b) < tolerance;
  const sorted = (value) =>
    value && typeof value === "object" && !Array.isArray(value)
      ? Object.fromEntries(Object.keys(value).sort().map((k) => [k, value[k]]))
      : value;
  const same = (a, b) => JSON.stringify(sorted(a)) === JSON.stringify(sorted(b));

  const makeGroup = (name, emails, currency) =>
    asUser(amy, async () => {
      const { rows } = await db.query(
        `select * from public.create_group_with_members($1, $2::text[], $3)`,
        [name, emails, currency]
      );
      return rows[0].id;
    });
  const usdGroup = await makeGroup("XR usd", ["xr-ben@example.com"], "USD");
  const gbpGroup = await makeGroup("XR gbp", ["xr-ben@example.com"], "GBP");
  const chfGroup = await makeGroup("XR chf", ["xr-ben@example.com"], "CHF");
  const leaveGroup = await makeGroup("XR leaver", ["xr-ben@example.com", "xr-cat@example.com"], "USD");

  await asUser(dev, () => db.query(`select public.send_contact_request('xr-eli@example.com')`));
  const [req] = await q(`select id from public.contact_requests where requester_id = $1`, [dev]);
  await asUser(eli, () => db.query(`select public.respond_contact_request($1, true)`, [req.id]));
  const [lo, hi] = dev < eli ? [dev, eli] : [eli, dev];

  const half = (a, b, amount = 5) => [
    { userId: a, amount, baseAmount: amount },
    { userId: b, amount, baseAmount: amount },
  ];
  const mk = async (fields = {}) => {
    const row = {
      kind: "group", group_id: usdGroup, created_by: amy, paid_by: amy, description: "Subscription",
      amount: 10, currency: "EUR", last_exchange_rate: "1.4", split_type: "equal",
      splits: JSON.stringify(half(amy, ben)), start_date: "2030-01-01", tz: "UTC",
      frequency: "monthly", ...fields,
    };
    const cols = Object.keys(row);
    const { rows } = await db.query(
      `insert into public.recurring_schedules (${cols.join(", ")})
       values (${cols.map((_, i) => `$${i + 1}`).join(", ")}) returning id`,
      Object.values(row)
    );
    return rows[0].id;
  };
  const mkContact = (fields = {}) =>
    mk({
      kind: "contact", group_id: null, user_lo: lo, user_hi: hi, created_by: dev, paid_by: eli,
      splits: JSON.stringify(half(dev, eli)), ...fields,
    });

  const rateOf = async (id) =>
    (await q(`select public._schedule_rate(s) as r from public.recurring_schedules s where id = $1`, [id]))[0].r;
  const sched = async (id) => (await q(`select * from public.recurring_schedules where id = $1`, [id]))[0];
  const expensesOf = (id, table = "expenses") =>
    q(
      `select exchange_rate, base_amount, currency from public.${table}
       where schedule_id = $1 order by occurrence_date`,
      [id]
    );
  const one = async (id, horizon) =>
    (await q(`select public._materialise_one($1::uuid, $2::timestamptz) as n`, [id, horizon]))[0].n;

  const clearRates = () => db.query(`delete from public.exchange_rates`);
  const putRates = (dayOffset, rates) =>
    db.query(
      `insert into public.exchange_rates (day, rates)
       values ((now() at time zone 'UTC')::date + $1::int, $2::jsonb)
       on conflict (day) do update set rates = excluded.rates`,
      [dayOffset, JSON.stringify(rates)]
    );
  const ratesOn = async (dayOffset) =>
    (await q(`select rates from public.exchange_rates where day = (now() at time zone 'UTC')::date + $1::int`, [dayOffset]))[0]?.rates;
  const rowCount = async () => (await q(`select count(*)::int as n from public.exchange_rates`))[0].n;

  const REFRESH_FNS = ["_schedule_rate", "_refresh_exchange_rates_fire", "_refresh_exchange_rates_store"];

  // ---- The functions exist without pg_net ---------------------------------------------
  const { rows: fns } = await db.query(`
    select p.proname, count(*)::int as n, bool_and(p.prosecdef) as secdef,
      bool_and(coalesce(p.proconfig::text, '') like '%search_path=public, pg_temp%') as pinned
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = any($1) group by 1 order by 1
  `, [REFRESH_FNS]);
  check(
    fns.length === 3 && fns.every((r) => r.n === 1),
    `the rate functions exist exactly once each (${fns.map((r) => r.proname).join(", ")})`
  );
  check(
    fns.every((r) => r.pinned) &&
      fns.filter((r) => r.proname.startsWith("_refresh")).every((r) => r.secdef),
    "the rate functions pin search_path = public, pg_temp and the refresh functions are SECURITY DEFINER"
  );
  const { rows: noNet } = await db.query(`select to_regnamespace('net') as net`);
  check(noNet[0].net === null, "(setup) this database has no pg_net, as on a project without it");
  check(
    (await q(`select public._refresh_exchange_rates_fire() as id`))[0].id === null,
    "_refresh_exchange_rates_fire does nothing, and does not raise, when pg_net is absent"
  );
  check(
    (await q(`select public._refresh_exchange_rates_store() as r`))[0].r === "pg_net is not available" && (await rowCount()) === 0,
    "_refresh_exchange_rates_store does nothing, and does not raise, when pg_net is absent"
  );
  check(
    (await q(`select relrowsecurity as rls from pg_class where oid = 'public.exchange_rates'::regclass`))[0].rls === true,
    "exchange_rates has row-level security on"
  );
  check(
    (await q(`select count(*)::int as n from pg_policies where tablename = 'exchange_rates'`))[0].n === 0,
    "exchange_rates has no policy at all (only definer functions and the service role read it)"
  );

  // ---- Direction: base units per 1 unit of the expense currency ------------------------
  // rates are units per 1 USD (open.er-api.com). USD -> EUR 0.8 means 1 EUR = 1.25 USD,
  // so a EUR expense in a USD group converts at rates[USD] / rates[EUR] = 1.25, the
  // client's getRate(from = EUR, to = USD) = rates[to] / rates[from].
  const eurInUsd = await mk({ description: "EUR in a USD group" });
  check(
    Number(await rateOf(eurInUsd)) === 1.4,
    "with no exchange_rates row _schedule_rate falls back to last_exchange_rate"
  );
  await putRates(0, { USD: 1, EUR: 0.8, GBP: 0.75, JPY: 150, CAD: 1.25, CHF: 0.5 });
  check(
    Number(await rateOf(eurInUsd)) === 1.25,
    "direction: 1 EUR is 1.25 USD when USD -> EUR is 0.8 (rates[base] / rates[currency], not the inverse 0.8)"
  );
  const eurInGbp = await mk({ group_id: gbpGroup, description: "EUR in a GBP group" });
  check(
    Number(await rateOf(eurInGbp)) === 0.9375,
    "cross rate: 1 EUR is 0.9375 GBP (1.25 USD at 0.75 GBP per USD)"
  );
  const gbpInUsd = await mk({ currency: "GBP", description: "GBP in a USD group" });
  check(near(await rateOf(gbpInUsd), 1 / 0.75), "a GBP expense in a USD group converts at 1 / 0.75");
  const yen = await mk({ currency: "JPY", description: "JPY in a USD group" });
  check(near(await rateOf(yen), 1 / 150), "the rate is not rounded (1 JPY is 1/150 USD)");
  const cadContact = await mkContact({ currency: "CAD", description: "CAD in a contact pair with no setting" });
  check(Number(await rateOf(cadContact)) === 0.8, "a contact pair with no currency setting converts into USD (1 CAD = 0.8 USD)");
  await db.query(`insert into public.contact_pair_settings (user_lo, user_hi, currency) values ($1, $2, 'CAD')`, [lo, hi]);
  const eurInCad = await mkContact({ description: "EUR in a CAD contact pair" });
  check(Number(await rateOf(eurInCad)) === 1.5625, "a contact pair's own base currency is the target (1 EUR = 1.5625 CAD)");
  const cadInCad = await mkContact({ currency: "CAD", last_exchange_rate: "1.9", description: "CAD in a CAD pair" });
  check(Number(await rateOf(cadInCad)) === 1, "same currency as the pair's base is rate 1");
  const sameUsd = await mk({ currency: "usd", last_exchange_rate: "1.7", description: "Same currency" });
  check(Number(await rateOf(sameUsd)) === 1, "same currency as the group's base is rate 1 (case-insensitive), whatever last_exchange_rate holds");

  // ---- Falling back --------------------------------------------------------------------
  const unknown = await mk({ currency: "XYZ", last_exchange_rate: "2.5", description: "Unlisted currency" });
  check(Number(await rateOf(unknown)) === 2.5, "a currency missing from the row falls back to last_exchange_rate");
  const unknownBase = await mk({ group_id: chfGroup, currency: "EUR", last_exchange_rate: "0.9", description: "Base missing" });
  await putRates(0, { USD: 1, EUR: 0.8 });
  check(Number(await rateOf(unknownBase)) === 0.9, "a base currency missing from the row falls back to last_exchange_rate");
  await putRates(0, { USD: 1, EUR: 0.8, GBP: 0.75, JPY: 150, CAD: 1.25, CHF: 0.5 });
  check(
    (await q(`select public._schedule_rate(null::public.recurring_schedules) as r`))[0].r === null,
    "_schedule_rate never raises, even for a null schedule"
  );

  for (const [label, value] of [
    ["a non-numeric rate", '"abc"'], ["a zero rate", "0"], ["a negative rate", "-0.8"],
    ["a null rate", "null"], ["an absurdly small rate (pair rate too large for the column)", "1e-30"],
    ["an absurdly large rate (pair rate too small for the column)", "1e30"],
  ]) {
    await db.query(
      `update public.exchange_rates set rates = jsonb_set(rates, '{EUR}', $1::jsonb) where day = (now() at time zone 'UTC')::date`,
      [value]
    );
    let result;
    try {
      result = Number(await rateOf(eurInUsd));
    } catch (error) {
      result = `raised ${error.message}`;
    }
    check(result === 1.4, `${label} in the stored row falls back to last_exchange_rate instead of raising (got ${result})`);
  }
  await db.query(
    `update public.exchange_rates set rates = '{"USD": 1e100000, "EUR": 1e-10000}'::jsonb where day = (now() at time zone 'UTC')::date`
  );
  check(
    Number(await rateOf(eurInUsd)) === 1.4,
    "a row with absurd exponents falls back at once instead of dividing huge numbers"
  );
  await db.query(
    `update public.exchange_rates set rates = '{"USD": 1e130000, "EUR": 1e-10000}'::jsonb where day = (now() at time zone 'UTC')::date`
  );
  let overflow;
  try {
    overflow = Number(await rateOf(eurInUsd));
  } catch (error) {
    overflow = `raised ${error.code} ${error.message}`;
  }
  check(
    overflow === 1.4,
    `a hand-inserted row whose pair rate overflows numeric falls back instead of raising (got ${overflow})`
  );
  await putRates(0, { USD: 1, EUR: 0.8, GBP: 0.75, JPY: 150, CAD: 1.25, CHF: 0.5 });

  // ---- Which row is used: the latest with day <= today and at most 7 days old ----------
  await clearRates();
  await putRates(-8, { USD: 1, EUR: 0.5 });
  check(Number(await rateOf(eurInUsd)) === 1.4, "a row 8 days old is ignored (falls back)");
  await putRates(-7, { USD: 1, EUR: 0.5 });
  check(Number(await rateOf(eurInUsd)) === 2, "a row exactly 7 days old is still used");
  await clearRates();
  await putRates(1, { USD: 1, EUR: 0.5 });
  check(Number(await rateOf(eurInUsd)) === 1.4, "a row dated tomorrow is ignored");
  await putRates(-3, { USD: 1, EUR: 0.5 });
  await putRates(-1, { USD: 1, EUR: 0.4 });
  check(Number(await rateOf(eurInUsd)) === 2.5, "the latest row with day <= today wins over older ones");
  await putRates(0, { USD: 1, EUR: 0.8 });
  check(Number(await rateOf(eurInUsd)) === 1.25, "today's row wins over yesterday's");

  // ---- Engine integration --------------------------------------------------------------
  await clearRates();
  const integ = await mk({ description: "Integration", currency: "EUR", last_exchange_rate: "1.13" });
  await putRates(0, { USD: 1, EUR: 0.8 });
  check((await one(integ, "2030-01-15T00:00:00Z")) === 1, "(setup) one occurrence is materialised");
  const [first] = await expensesOf(integ);
  check(
    Number(first.exchange_rate) === 1.25 && Number(first.base_amount) === 12.5 && first.currency === "EUR",
    `a materialised occurrence converts at the server rate (10 EUR at 1.25 = 12.50 USD, got ${first.exchange_rate} / ${first.base_amount})`
  );
  check(Number((await sched(integ)).last_exchange_rate) === 1.25, "last_exchange_rate follows the rate the occurrence converted at");

  await putRates(0, { USD: 1, EUR: 0.5 });
  await one(integ, "2030-02-15T00:00:00Z");
  const rows = await expensesOf(integ);
  check(
    rows.length === 2 && Number(rows[0].exchange_rate) === 1.25 && Number(rows[1].exchange_rate) === 2 && Number(rows[1].base_amount) === 20,
    "the next occurrence uses the rate of its own materialisation day; the earlier expense keeps its rate"
  );

  await clearRates();
  const noRow = await mk({ description: "No row", currency: "EUR", last_exchange_rate: "1.13" });
  await one(noRow, "2030-01-15T00:00:00Z");
  const [fallbackRow] = await expensesOf(noRow);
  check(
    Number(fallbackRow.exchange_rate) === 1.13 && Number(fallbackRow.base_amount) === 11.3 &&
      Number((await sched(noRow)).last_exchange_rate) === 1.13,
    "with no exchange_rates row an occurrence converts at last_exchange_rate and keeps it"
  );

  await putRates(0, { USD: 1, EUR: 0.8 });
  const early = await mk({ description: "Not due", currency: "EUR", last_exchange_rate: "1.13", start_date: "2031-01-01" });
  check(
    (await one(early, "2030-01-15T00:00:00Z")) === 0 && Number((await sched(early)).last_exchange_rate) === 1.13,
    "a run that creates nothing leaves last_exchange_rate alone, even with a server rate"
  );

  const leaver = await mk({
    description: "Member gone", currency: "EUR", last_exchange_rate: "1.13", group_id: leaveGroup,
    splits: JSON.stringify(half(amy, cat)),
  });
  await db.query(`delete from public.group_members where group_id = $1 and user_id = $2`, [leaveGroup, cat]);
  check(
    (await code(() => one(leaver, "2030-01-15T00:00:00Z"))) === "EVNTM" &&
      Number((await sched(leaver)).last_exchange_rate) === 1.13 && (await expensesOf(leaver)).length === 0,
    "a failed run does not move last_exchange_rate (it changes only after a successful conversion)"
  );

  const contactInteg = await mkContact({ description: "Contact integration", currency: "EUR", last_exchange_rate: "1.13" });
  await db.query(`delete from public.contact_pair_settings where user_lo = $1 and user_hi = $2`, [lo, hi]);
  await one(contactInteg, "2030-01-15T00:00:00Z");
  const [contactRow] = await expensesOf(contactInteg, "contact_expenses");
  check(
    Number(contactRow.exchange_rate) === 1.25 && Number(contactRow.base_amount) === 12.5,
    "a contact occurrence converts at the server rate into the pair's base (USD by default)"
  );

  // ---- create_recurring_schedule: the server rate wins over the client's -------------------
  const todayUtc = (await q(`select to_char(now() at time zone 'UTC', 'YYYY-MM-DD') as d`))[0].d;
  const createAs = (clientRate, description) =>
    asUser(amy, async () => {
      const { rows } = await db.query(
        `select * from public.create_recurring_schedule($1, null, $2, 10, $3, null, 'equal', $4::jsonb, 'EUR', $5, $6::date, 'UTC', 'monthly')`,
        [usdGroup, amy, description, JSON.stringify(half(amy, ben)), clientRate, todayUtc]
      );
      return rows[0].id;
    });
  await clearRates();
  await putRates(-5, { USD: 1, EUR: 0.8 });
  const withRow = await createAs(1.5, "Client 1.5, server row 0.8");
  const [withRowFirst] = await expensesOf(withRow);
  check(
    withRowFirst && Number(withRowFirst.exchange_rate) === 1.25 && Number(withRowFirst.base_amount) === 12.5 &&
      Number((await sched(withRow)).last_exchange_rate) === 1.25,
    `a usable server row beats the client's rate for the first occurrence (client 1.5, 5-day-old row EUR 0.8 books at 1.25, got ${withRowFirst?.exchange_rate}) and last_exchange_rate follows`
  );
  await clearRates();
  const noRowCreate = await createAs(1.5, "Client 1.5, no server row");
  const [noRowFirst] = await expensesOf(noRowCreate);
  check(
    noRowFirst && Number(noRowFirst.exchange_rate) === 1.5 && Number(noRowFirst.base_amount) === 15 &&
      Number((await sched(noRowCreate)).last_exchange_rate) === 1.5,
    `with no server row the client's rate is used (and seeds last_exchange_rate): ${noRowFirst?.exchange_rate}`
  );
  await putRates(-8, { USD: 1, EUR: 0.8 });
  const staleCreate = await createAs(1.5, "Client 1.5, stale server row");
  check(
    Number((await expensesOf(staleCreate))[0]?.exchange_rate) === 1.5,
    "a server row older than 7 days does not override the client's rate"
  );
  await clearRates();

  // ---- A stub pg_net so the refresh functions can be driven ----------------------------
  await clearRates();
  await db.exec(`
    create schema net;
    create table net._http_response (
      id bigint primary key,
      status_code integer,
      content_type text,
      headers jsonb,
      content text,
      timed_out boolean,
      error_msg text,
      created timestamptz not null default now()
    );
    create table net._requests (id bigserial primary key, url text, timeout_ms integer);
    create function net.http_get(
      url text,
      params jsonb default '{}'::jsonb,
      headers jsonb default '{"Content-Type": "application/json"}'::jsonb,
      timeout_milliseconds integer default 5000
    ) returns bigint language sql as $$
      insert into net._requests (url, timeout_ms) values (url, timeout_milliseconds) returning id
    $$;
  `);
  const request = async (minutesAgo = 0) => {
    const id = (await q(`select public._refresh_exchange_rates_fire() as id`))[0].id;
    await db.query(
      `update public.exchange_rate_requests set requested_at = now() - make_interval(mins => $2) where id = $1`,
      [id, minutesAgo]
    );
    return id;
  };
  const respondTo = (id, status, content, extra = {}) =>
    db.query(
      `insert into net._http_response (id, status_code, content, timed_out, error_msg, created)
       values ($1, $2, $3, $4, $5, now())`,
      [id, status, content === null || typeof content === "string" ? content : JSON.stringify(content), extra.timedOut ?? false, extra.error ?? null]
    );
  const respond = async (status, content, minutesAgo = 0) => respondTo(await request(minutesAgo), status, content);
  const clearResponses = async () => {
    await db.query(`delete from net._http_response`);
    await db.query(`delete from public.exchange_rate_requests`);
  };
  const body = (rates, extra = {}) => ({ result: "success", base_code: "USD", rates, ...extra });
  let notices = [];
  const store = async () => {
    notices = [];
    const { rows } = await db.query(`select public._refresh_exchange_rates_store() as r`, [], {
      onNotice: (n) => notices.push(n),
    });
    return rows[0].r;
  };
  const warned = () =>
    notices.some((n) => n.severity === "WARNING" && /^exchange rates not stored/.test(n.message)) &&
    notices.every((n) => !/[{}"]/.test(n.message));
  const GOOD = { USD: 1, EUR: 0.8, GBP: 0.75, JPY: 150 };

  const fired = (await q(`select public._refresh_exchange_rates_fire() as id`))[0].id;
  check(
    fired !== null && same((await q(`select url from net._requests`)).map((r) => r.url), ["https://open.er-api.com/v6/latest/USD"]),
    "_refresh_exchange_rates_fire asks pg_net to GET the same URL the app uses and returns the request id"
  );
  check(
    (await q(`select timeout_ms from net._requests where id = $1`, [fired]))[0].timeout_ms === 10000,
    "the request passes timeout_milliseconds := 10000"
  );
  check(
    same((await q(`select id::text as id from public.exchange_rate_requests`)).map((r) => r.id), [String(fired)]),
    "fire records the request id it got back from pg_net"
  );
  await db.query(
    `insert into public.exchange_rate_requests (id, requested_at) values (700001, now() - interval '8 days'), (700002, now() - interval '6 days')`
  );
  await q(`select public._refresh_exchange_rates_fire()`);
  check(
    same((await q(`select id::int as id from public.exchange_rate_requests where id in (700001, 700002)`)).map((r) => r.id), [700002]),
    "fire prunes recorded requests older than 7 days and keeps newer ones"
  );
  await clearResponses();

  // ---- store: validation --------------------------------------------------------------
  check(
    (await store()).startsWith("not stored") && (await rowCount()) === 0 && warned(),
    "with no request there is nothing to store, and it says so with a generic warning"
  );
  const pending = await request();
  check(
    (await store()).startsWith("not stored") && (await rowCount()) === 0 && warned(),
    "a request with no response yet stores nothing and warns"
  );
  await db.query(
    `insert into net._http_response (id, status_code, content, created) values (990001, 200, $1, now() + interval '1 second')`,
    [JSON.stringify(body({ ...GOOD, EUR: 0.95 }))]
  );
  check(
    (await store()).startsWith("not stored") && (await rowCount()) === 0 && warned(),
    "a newer, plausible response that no recorded request owns is ignored (nothing stored, warning)"
  );
  await respondTo(pending, 200, body({ ...GOOD, EUR: 0.7 }));
  check(
    (await store()) === "stored" && (await ratesOn(0)).EUR === 0.7 && notices.length === 0,
    "with the real response present, the correlated body is stored and the unrelated newer one is not (EUR 0.7, not 0.95), with no warning"
  );
  await clearResponses();
  await clearRates();

  await respond(200, body(GOOD));
  check((await store()) === "stored", "a valid response is stored");
  check(
    same(await ratesOn(0), GOOD) &&
      (await q(`select fetched_at > now() - interval '1 minute' as fresh from public.exchange_rates`))[0].fresh === true,
    "today's row (UTC day) holds the rates and a fresh fetched_at"
  );
  check(Number(await rateOf(integ)) === 1.25, "(end to end) the stored row is what _schedule_rate reads");

  check((await store()) === "stored" && (await rowCount()) === 1, "storing the same response twice leaves one row (idempotent upsert)");
  await clearResponses();
  await respond(200, body({ ...GOOD, EUR: 0.9 }));
  check(
    (await store()) === "stored" && (await rowCount()) === 1 && (await ratesOn(0)).EUR === 0.9,
    "a later run the same day replaces today's row rather than adding one"
  );

  await respond(200, body(GOOD));
  await store();
  const rejects = [
    ["a non-200 status", () => respond(500, body({ ...GOOD, EUR: 0.85 }))],
    ["a 404", () => respond(404, body({ ...GOOD, EUR: 0.85 }))],
    ["result other than success", () => respond(200, { result: "error", base_code: "USD", rates: { ...GOOD, EUR: 0.85 } })],
    ["no result field", () => respond(200, { rates: { ...GOOD, EUR: 0.85 } })],
    ["a zero rate", () => respond(200, body({ ...GOOD, EUR: 0 }))],
    ["a negative rate", () => respond(200, body({ ...GOOD, EUR: -0.8 }))],
    ["a null rate", () => respond(200, body({ ...GOOD, EUR: null }))],
    ["a NaN rate (as a string)", () => respond(200, body({ ...GOOD, EUR: "NaN" }))],
    ["a numeric string rate", () => respond(200, body({ ...GOOD, EUR: "0.85" }))],
    ["a rate above the sane range (1e12)", () => respond(200, body({ ...GOOD, EUR: 1e12 }))],
    ["a rate below the sane range (1e-12)", () => respond(200, body({ ...GOOD, EUR: 1e-12 }))],
    ["an absurd exponent", () => respond(200, '{"result":"success","rates":{"USD":1,"EUR":1e100000}}')],
    ["a boolean rate", () => respond(200, body({ ...GOOD, EUR: true }))],
    ["rates that are an array", () => respond(200, { result: "success", rates: [1, 2] })],
    ["empty rates", () => respond(200, body({}))],
    ["a missing USD rate", () => respond(200, body({ EUR: 0.85, GBP: 0.75 }))],
    ["a USD rate other than 1", () => respond(200, body({ ...GOOD, USD: 1.2 }))],
    ["a non-numeric USD rate", () => respond(200, body({ ...GOOD, USD: "1" }))],
  ];
  const before = await ratesOn(0);
  for (const [label, put] of rejects) {
    await clearResponses();
    await put();
    const result = await store();
    check(
      result !== "stored" && same(await ratesOn(0), before) && (await rowCount()) === 1 && warned(),
      `${label} is rejected with a generic warning and the existing row is kept (${result})`
    );
  }

  for (const [label, content] of [
    ["a body that is not JSON", "this is not json"], ["an empty body", ""], ["a null body", "null"], ["an array body", "[]"],
  ]) {
    await clearResponses();
    await respond(200, content);
    const result = await store();
    check(
      result !== "stored" && same(await ratesOn(0), before) && warned(),
      `${label} is rejected with a generic warning (${result})`
    );
  }
  await clearResponses();
  await respondTo(await request(), null, null, { timedOut: true, error: "Timeout of 10000 ms reached" });
  const timedOut = await store();
  check(
    timedOut !== "stored" && same(await ratesOn(0), before) && warned() && notices.every((n) => !/Timeout/.test(n.message)),
    `a timed-out fetch is rejected with a generic warning that does not repeat the error text (${timedOut})`
  );
  await clearResponses();
  await respond(200, body({ ...GOOD, EUR: 0.6 }), 10);
  await respond(500, body({ ...GOOD, EUR: 0.65 }), 0);
  check(
    (await store()) !== "stored" && same(await ratesOn(0), before) && warned(),
    "the latest request decides: a newer failure is not papered over by an older success"
  );
  await clearResponses();
  await respond(200, body({ ...GOOD, EUR: 0.6 }), 120);
  check(
    (await store()) !== "stored" && same(await ratesOn(0), before) && warned(),
    "a request older than an hour is not today's fetch and is ignored"
  );
  await clearResponses();

  // ---- store: the movement bound --------------------------------------------------------
  await clearRates();
  await clearResponses();
  await putRates(-1, { USD: 1, EUR: 0.8, GBP: 0.75, JPY: 150 });
  for (const [label, rates] of [
    ["a currency up by more than 50%", { ...GOOD, EUR: 1.3 }],
    ["a currency down by more than 50%", { ...GOOD, JPY: 60 }],
    ["one currency moving while all the others are fine", { ...GOOD, GBP: 1.2 }],
  ]) {
    await clearResponses();
    await respond(200, body(rates));
    const result = await store();
    check(
      result !== "stored" && (await ratesOn(0)) === undefined && same(await ratesOn(-1), { USD: 1, EUR: 0.8, GBP: 0.75, JPY: 150 }) && warned(),
      `${label} is rejected with a generic warning, today gets no row and the previous day's row is kept (${result})`
    );
  }
  check(Number(await rateOf(integ)) === 1.25, "(end to end) after a rejected refresh _schedule_rate still reads the previous day's row");
  await clearResponses();
  await respond(200, body({ USD: 1, EUR: 1.2, GBP: 0.375, JPY: 150 }));
  check(
    (await store()) === "stored",
    "a move of exactly 50% in either direction is accepted (EUR 0.8 -> 1.2, GBP 0.75 -> 0.375)"
  );
  await clearResponses();
  await respond(200, body({ USD: 1, EUR: 2.4, JPY: 150 }));
  check(
    (await store()) !== "stored" && (await ratesOn(0)).EUR === 1.2 && warned(),
    "the bound compares with the previous day, not with the row being replaced: a same-day re-run cannot ratchet past it"
  );
  await clearRates();
  await clearResponses();
  await putRates(-8, { USD: 1, EUR: 0.8, GBP: 0.75, JPY: 150 });
  await respond(200, body({ USD: 1, EUR: 1.9, GBP: 0.75, JPY: 150 }));
  check(
    (await store()) === "stored",
    "a previous row more than 7 days old is no baseline (a real move cannot lock the refresh out for good)"
  );
  await clearRates();
  await clearResponses();
  await respond(200, body({ USD: 1, EUR: 1.9, XYZ: 7 }));
  check((await store()) === "stored", "with no previous row at all the first fetch is accepted");

  // ---- Security ------------------------------------------------------------------------
  const clientDenied = [];
  for (const [label, sql] of [
    ["select", `select * from public.exchange_rates`],
    ["insert", `insert into public.exchange_rates (day, rates) values (current_date + 40, '{"USD":1}')`],
    ["update", `update public.exchange_rates set rates = '{"USD":1}'`],
    ["delete", `delete from public.exchange_rates`],
    ["truncate", `truncate public.exchange_rates`],
  ]) {
    const asAuthed = await asUser(amy, () => code(() => db.query(sql)));
    await db.exec("set role anon");
    const asAnon = await code(() => db.query(sql));
    await db.exec("reset role");
    if (asAuthed !== "42501" || asAnon !== "42501") clientDenied.push(`${label}: ${asAuthed}/${asAnon}`);
  }
  check(clientDenied.length === 0, `clients (authenticated and anon) get permission denied to read or write exchange_rates${clientDenied.length ? `: ${clientDenied.join("; ")}` : ""}`);
  const { rows: privs } = await db.query(`
    select r.rolname, p.priv, has_table_privilege(r.rolname, 'public.exchange_rates', p.priv) as held
    from (values ('anon'), ('authenticated')) r(rolname)
    cross join (values ('SELECT'), ('INSERT'), ('UPDATE'), ('DELETE'), ('TRUNCATE'), ('REFERENCES'), ('TRIGGER')) p(priv)
    where has_table_privilege(r.rolname, 'public.exchange_rates', p.priv)
  `);
  check(privs.length === 0, `anon and authenticated hold no privilege at all on exchange_rates${privs.length ? `: ${privs.map((p) => p.rolname + " " + p.priv).join(", ")}` : ""}`);
  check(
    (await q(`select has_table_privilege('service_role', 'public.exchange_rates', 'SELECT') and has_table_privilege('service_role', 'public.exchange_rates', 'INSERT') as ok`))[0].ok === true,
    "the service role keeps full access to exchange_rates"
  );

  const clientDeniedRequests = [];
  for (const [label, sql] of [
    ["select", `select * from public.exchange_rate_requests`],
    ["insert", `insert into public.exchange_rate_requests (id) values (5)`],
    ["update", `update public.exchange_rate_requests set requested_at = now()`],
    ["delete", `delete from public.exchange_rate_requests`],
    ["truncate", `truncate public.exchange_rate_requests`],
  ]) {
    const asAuthed = await asUser(amy, () => code(() => db.query(sql)));
    await db.exec("set role anon");
    const asAnon = await code(() => db.query(sql));
    await db.exec("reset role");
    if (asAuthed !== "42501" || asAnon !== "42501") clientDeniedRequests.push(`${label}: ${asAuthed}/${asAnon}`);
  }
  check(
    clientDeniedRequests.length === 0,
    `clients get permission denied to read or write exchange_rate_requests${clientDeniedRequests.length ? `: ${clientDeniedRequests.join("; ")}` : ""}`
  );
  const { rows: reqState } = await db.query(`
    select c.relrowsecurity as rls,
      (select count(*)::int from pg_policies where tablename = 'exchange_rate_requests') as policies,
      has_table_privilege('service_role', c.oid, 'INSERT') as svc
    from pg_class c where c.oid = 'public.exchange_rate_requests'::regclass
  `);
  check(
    reqState[0].rls === true && reqState[0].policies === 0 && reqState[0].svc === true,
    "exchange_rate_requests has RLS on, no policy, and the service role keeps access"
  );

  const calls = [
    `select public._schedule_rate(null::public.recurring_schedules)`,
    `select public._refresh_exchange_rates_fire()`,
    `select public._refresh_exchange_rates_store()`,
  ];
  let deniedAuthed = 0;
  let deniedAnon = 0;
  for (const sql of calls) {
    if ((await asUser(amy, () => code(() => db.query(sql)))) === "42501") deniedAuthed += 1;
    await db.exec("set role anon");
    if ((await code(() => db.query(sql))) === "42501") deniedAnon += 1;
    await db.exec("reset role");
  }
  check(
    deniedAuthed === calls.length && deniedAnon === calls.length,
    "clients (authenticated and anon) get permission denied on every rate function"
  );
  const { rows: acl } = await db.query(`
    select p.proname, coalesce(p.proacl::text, '') ~ '(^\\{|,)=X' as public_exec
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = any($1)
  `, [REFRESH_FNS]);
  check(acl.length === 3 && acl.every((r) => !r.public_exec), "no rate function is executable by PUBLIC");

  // ---- The cron job registration -------------------------------------------------------
  const migration = readFileSync(migrationFile, "utf8");
  const block = migration.match(/do \$\$[\s\S]*?end \$\$;/i)?.[0] ?? "";
  check(
    /pg_available_extensions[\s\S]*'pg_cron'/.test(block) && /pg_available_extensions[\s\S]*'pg_net'/.test(block) &&
      /cron\.unschedule/.test(block) && /cron\.schedule/.test(block),
    "the cron block is guarded on both pg_cron and pg_net and unschedules before it schedules"
  );
  const fireSchedule = block.match(/'evenpot-exchange-rates-fire',\s*'([^']+)'/)?.[1];
  const storeSchedule = block.match(/'evenpot-exchange-rates-store',\s*'([^']+)'/)?.[1];
  check(
    fireSchedule === "50 4 * * *" && storeSchedule === "55 4 * * *",
    `the fetch fires at 04:50 UTC and the store runs at 04:55, before the 05:00 materialise job (${fireSchedule} / ${storeSchedule})`
  );
  const engineCron = readFileSync(
    join(dirname(migrationFile), "20261109195000_recurring_cron.sql"),
    "utf8"
  );
  check(/'0 5 \* \* \*'/.test(engineCron), "(setup) the materialise job still runs at 05:00");

  await db.exec(`drop schema net cascade`);
  const noop = await code(() => db.exec(block));
  check(
    noop === "(no error)" && (await q(`select to_regnamespace('cron') as c`))[0].c === null,
    `the cron block does nothing where pg_cron and pg_net are unavailable${noop === "(no error)" ? "" : `: ${noop}`}`
  );

  const without = (pattern) =>
    block
      .split("\n")
      .filter((line) => !pattern.test(line))
      .join("\n");
  const stubbed = without(/^\s*create extension/i);
  check(stubbed.length < block.length, "(setup) the block creates the extensions itself (those lines are stubbed out below)");
  await db.exec(`
    create schema cron;
    create table cron.job (jobid bigserial primary key, jobname text unique, schedule text, command text);
    create function cron.schedule(job_name text, schedule text, command text) returns bigint language sql as
      $$ insert into cron.job (jobname, schedule, command) values (job_name, schedule, command) returning jobid $$;
    create function cron.unschedule(job_name text) returns boolean language sql as
      $$ with d as (delete from cron.job where jobname = job_name returning 1) select count(*) > 0 from d $$;
  `);
  const withExtensions = async (names, sql = stubbed) => {
    const seen = [];
    await db.exec(
      `create temp view pg_available_extensions as select name::name from unnest(array[${names
        .map((n) => `'${n}'`)
        .join(", ")}]::text[]) as name`
    );
    await db.exec(`set search_path = pg_temp, pg_catalog, public`);
    try {
      await db.query(sql, [], { onNotice: (n) => seen.push(n) });
    } finally {
      await db.exec(`reset search_path; drop view pg_temp.pg_available_extensions`);
    }
    return seen;
  };
  const jobs = () => q(`select jobname, schedule, command from cron.job order by jobname`);

  await withExtensions(["pg_cron"]);
  check((await jobs()).length === 0, "with pg_cron but no pg_net the block schedules nothing");
  await withExtensions(["pg_net"]);
  check((await jobs()).length === 0, "with pg_net but no pg_cron the block schedules nothing");
  const firstRun = await withExtensions(["pg_cron", "pg_net"]);
  const secondRun = await withExtensions(["pg_cron", "pg_net"]);
  check(
    firstRun.length === 0 && secondRun.length === 0,
    "both runs of the block complete without the guard having to swallow anything (a duplicate job would be swallowed silently otherwise)"
  );
  const scheduled = await jobs();
  check(
    same(scheduled.map((j) => [j.jobname, j.schedule, j.command]), [
      ["evenpot-exchange-rates-fire", "50 4 * * *", "select public._refresh_exchange_rates_fire()"],
      ["evenpot-exchange-rates-store", "55 4 * * *", "select public._refresh_exchange_rates_store()"],
    ]),
    `with both available the two jobs are scheduled, and running the block twice leaves exactly two (${scheduled.length})`
  );

  // Both extensions are listed but one cannot be created, or the scheduler refuses:
  // the migration must carry on (a missing job must never block every later migration).
  const generic = (seen) =>
    seen.length === 1 && /^exchange-rate refresh jobs not scheduled: [0-9A-Z]{5}$/.test(seen[0].message);
  let netError = "";
  let netSeen = [];
  try {
    netSeen = await withExtensions(["pg_cron", "pg_net"], without(/^\s*create extension if not exists pg_cron/i));
  } catch (error) {
    netError = error.message;
  }
  check(
    netError === "" && generic(netSeen),
    `a failing create extension pg_net is swallowed with a generic notice, not raised${netError ? `: ${netError}` : ""}`
  );
  await db.exec(`
    create or replace function cron.schedule(job_name text, schedule text, command text) returns bigint language plpgsql as
      $$ begin raise exception 'scheduling refused: secret detail' using errcode = '42883'; end $$;
  `);
  let schedError = "";
  let schedSeen = [];
  try {
    schedSeen = await withExtensions(["pg_cron", "pg_net"]);
  } catch (error) {
    schedError = error.message;
  }
  check(
    schedError === "" && generic(schedSeen) && schedSeen[0].message.endsWith("42883") && !/secret/.test(schedSeen[0].message),
    `a failing cron.schedule is swallowed with a generic notice (sqlstate only), not raised${schedError ? `: ${schedError}` : ""}`
  );
  check(
    /exception when others then\s+raise notice 'exchange-rate refresh jobs not scheduled: %', sqlstate;/.test(block) && !/sqlerrm/i.test(block),
    "the guard reports the sqlstate only, never the error text"
  );

  await db.exec(`drop schema cron cascade`);
  await clearRates();
  await db.query(`update public.recurring_schedules set stopped_at = now(), stop_reason = 'completed' where stopped_at is null`);
}
