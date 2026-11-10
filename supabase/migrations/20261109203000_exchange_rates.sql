-- A server-side exchange-rate source for foreign-currency recurring schedules.
-- exchange_rates holds one row per UTC day, USD-keyed, in the shape the app's
-- lib/exchange-rates.ts already consumes (open.er-api.com/v6/latest/USD: units of
-- each currency per 1 USD). Nothing reads or writes it from a client: only the
-- SECURITY DEFINER engine and the refresh functions below (and the service role)
-- touch it, so RLS is on with no policy and the client grants are revoked.

create table public.exchange_rates (
  day date primary key,
  rates jsonb not null,
  fetched_at timestamptz not null default now()
);

alter table public.exchange_rates enable row level security;

revoke all on table public.exchange_rates from anon, authenticated;
grant all on table public.exchange_rates to service_role;

-- The rate a recurring occurrence converts at: base units per 1 unit of the
-- schedule's currency, the client's getRate(from = currency, to = base), i.e.
-- rates[base] / rates[currency] from the latest row with day <= today (UTC) that
-- is at most 7 days old. The base is the group's currency, or the contact pair's
-- (USD when it has no setting), as in _materialise_one. Same currency is 1. The
-- rate is not rounded. Anything unusable (no recent row, a currency or the base
-- missing, a non-positive or non-numeric rate, a pair rate the numeric(18,8)
-- exchange_rate column cannot hold) falls back to last_exchange_rate. It never
-- raises: every value is type-checked before it is cast, and the divisor is
-- positive.
create or replace function public._schedule_rate(p_schedule public.recurring_schedules)
returns numeric
language plpgsql
stable
set search_path = public, pg_temp
as $$
declare
  v_base text;
  v_today date := (now() at time zone 'UTC')::date;
  v_rates jsonb;
  v_from numeric;
  v_to numeric;
  v_rate numeric;
begin
  if p_schedule.kind = 'group' then
    select g.currency into v_base from public.groups g where g.id = p_schedule.group_id;
  elsif p_schedule.kind = 'contact' then
    select s.currency into v_base from public.contact_pair_settings s
    where s.user_lo = p_schedule.user_lo and s.user_hi = p_schedule.user_hi;
    v_base := coalesce(v_base, 'USD');
  end if;

  if v_base is null then
    return p_schedule.last_exchange_rate;
  end if;
  if upper(btrim(p_schedule.currency)) = upper(btrim(v_base)) then
    return 1;
  end if;

  select r.rates into v_rates
  from public.exchange_rates r
  where r.day <= v_today and r.day >= v_today - 7
  order by r.day desc
  limit 1;

  if v_rates is not null
    and jsonb_typeof(v_rates -> upper(btrim(p_schedule.currency))) = 'number'
    and jsonb_typeof(v_rates -> upper(btrim(v_base))) = 'number' then
    v_from := (v_rates ->> upper(btrim(p_schedule.currency)))::numeric;
    v_to := (v_rates ->> upper(btrim(v_base)))::numeric;
    if v_from > 0 and v_to > 0 then
      v_rate := v_to / v_from;
      if v_rate >= 0.000001 and v_rate < 1000000000 then
        return v_rate;
      end if;
    end if;
  end if;

  return p_schedule.last_exchange_rate;
end;
$$;

revoke execute on function public._schedule_rate(public.recurring_schedules)
  from public, anon, authenticated;

-- Step one of the refresh: ask pg_net to GET the rates. pg_net is asynchronous
-- (the request runs after this statement's transaction commits and the answer
-- lands in net._http_response), so storing it is a second step. net.* is only
-- referenced through dynamic SQL, so this function can be created, and does
-- nothing, on a project without pg_net. Returns pg_net's request id, or null.
create or replace function public._refresh_exchange_rates_fire()
returns bigint
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  c_url constant text := 'https://open.er-api.com/v6/latest/USD';
  v_id bigint;
begin
  if not exists (
    select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'net' and p.proname = 'http_get'
  ) then
    return null;
  end if;

  execute 'select net.http_get($1)' into v_id using c_url;
  return v_id;
end;
$$;

revoke execute on function public._refresh_exchange_rates_fire()
  from public, anon, authenticated;

-- Step two: take the newest exchange-rate response pg_net has recorded in the
-- last hour (other requests share net._http_response, so a response counts only
-- if its body is a JSON object with a "rates" key), validate it and upsert
-- today's (UTC) row. Rejected, and nothing written, when: the status is not 200;
-- result is not 'success'; rates is not a non-empty object of numbers between
-- 1e-9 and 1e9 (positive and sane: units of a currency per USD);
-- USD is not exactly 1; or any currency moved more than 50% against the latest
-- row from the previous 7 days (a one-off bad payload cannot replace good rates;
-- a baseline older than that is no baseline, so a real devaluation cannot lock
-- the refresh out for good). Returns 'stored' or the reason it did not store;
-- a rejection is also a WARNING in the Postgres log. Returns without raising when
-- pg_net is absent.
create or replace function public._refresh_exchange_rates_store()
returns text
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_today date := (now() at time zone 'UTC')::date;
  v_row record;
  v_body jsonb;
  v_status int;
  v_found boolean := false;
  v_rates jsonb;
  v_prev jsonb;
  v_bad int;
  v_reason text;
begin
  if to_regclass('net._http_response') is null then
    return 'pg_net is not available';
  end if;

  for v_row in execute
    'select status_code, content from net._http_response
     where created > now() - interval ''1 hour'' order by created desc, id desc limit 20'
  loop
    begin
      v_body := v_row.content::jsonb;
    exception when others then
      continue;
    end;
    if jsonb_typeof(v_body) = 'object' and v_body ? 'rates' then
      v_status := v_row.status_code;
      v_found := true;
      exit;
    end if;
  end loop;

  if not v_found then
    return 'no exchange-rate response in the last hour';
  end if;

  v_rates := v_body -> 'rates';
  if v_status is distinct from 200 then
    v_reason := 'rejected: the fetch returned status ' || coalesce(v_status::text, 'none');
  elsif v_body ->> 'result' is distinct from 'success' then
    v_reason := 'rejected: the response is not a success';
  elsif jsonb_typeof(v_rates) is distinct from 'object' or v_rates = '{}'::jsonb then
    v_reason := 'rejected: rates is not a non-empty object';
  else
    select count(*) into v_bad
    from jsonb_each(v_rates) e
    where case when jsonb_typeof(e.value) = 'number'
      then (e.value #>> '{}')::numeric not between 0.000000001 and 1000000000 else true end;
    if v_bad > 0 then
      v_reason := 'rejected: ' || v_bad || ' rate(s) are not numbers between 1e-9 and 1e9';
    elsif jsonb_typeof(v_rates -> 'USD') is distinct from 'number'
      or (v_rates ->> 'USD')::numeric <> 1 then
      v_reason := 'rejected: the USD rate is not 1';
    end if;
  end if;

  if v_reason is null then
    select r.rates into v_prev
    from public.exchange_rates r
    where r.day < v_today and r.day >= v_today - 7
    order by r.day desc
    limit 1;

    if v_prev is not null then
      select count(*) into v_bad
      from jsonb_each(v_rates) n
      join jsonb_each(v_prev) o on o.key = n.key
      where case
        when jsonb_typeof(o.value) = 'number' then
          case
            when (o.value #>> '{}')::numeric > 0
              then abs((n.value #>> '{}')::numeric / (o.value #>> '{}')::numeric - 1) > 0.5
            else false
          end
        else false
      end;
      if v_bad > 0 then
        v_reason := 'rejected: ' || v_bad || ' rate(s) moved more than 50% since the previous day';
      end if;
    end if;
  end if;

  if v_reason is not null then
    raise warning 'exchange rates not stored (%)', v_reason;
    return v_reason;
  end if;

  insert into public.exchange_rates (day, rates, fetched_at)
  values (v_today, v_rates, now())
  on conflict (day) do update set rates = excluded.rates, fetched_at = excluded.fetched_at;

  return 'stored';
end;
$$;

revoke execute on function public._refresh_exchange_rates_store()
  from public, anon, authenticated;

-- Optional daily refresh. It needs both pg_cron (the scheduler) and pg_net (the
-- HTTP client), extensions some projects do not offer; when either is missing this
-- does nothing and recurring foreign-currency items keep using their last known
-- rate. The fetch goes at 04:50 UTC and the store five minutes later, so the
-- 05:00 materialise job (20261109195000_recurring_cron.sql) sees today's rates.
-- Running it again replaces the jobs rather than adding second ones.

do $$
begin
  if exists (select 1 from pg_available_extensions where name = 'pg_cron')
    and exists (select 1 from pg_available_extensions where name = 'pg_net') then
    create extension if not exists pg_cron with schema pg_catalog;
    create extension if not exists pg_net;

    if exists (select 1 from cron.job where jobname = 'evenpot-exchange-rates-fire') then
      perform cron.unschedule('evenpot-exchange-rates-fire');
    end if;
    if exists (select 1 from cron.job where jobname = 'evenpot-exchange-rates-store') then
      perform cron.unschedule('evenpot-exchange-rates-store');
    end if;

    perform cron.schedule(
      'evenpot-exchange-rates-fire',
      '50 4 * * *',
      $cmd$select public._refresh_exchange_rates_fire()$cmd$
    );
    perform cron.schedule(
      'evenpot-exchange-rates-store',
      '55 4 * * *',
      $cmd$select public._refresh_exchange_rates_store()$cmd$
    );
  end if;
end $$;
