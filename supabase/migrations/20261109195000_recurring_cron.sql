-- Optional daily job for the recurring engine. When the project offers pg_cron,
-- this enables it and schedules the job; otherwise it does nothing and the app
-- creates due occurrences when someone opens it (materialise_my_recurring).
-- Occurrences are created up to 48 hours ahead, so one run a day is enough.
-- Running it again replaces the job rather than adding a second one.
-- Anything going wrong here (the extension is listed but cannot be created, the
-- role may not schedule jobs) is swallowed with a generic notice: a missing job
-- must never abort the migration and block every later one.

do $$
begin
  if exists (select 1 from pg_available_extensions where name = 'pg_cron') then
    begin
      create extension if not exists pg_cron with schema pg_catalog;

      if exists (select 1 from cron.job where jobname = 'evenpot-materialise-recurring') then
        perform cron.unschedule('evenpot-materialise-recurring');
      end if;

      perform cron.schedule(
        'evenpot-materialise-recurring',
        '0 5 * * *',
        $cmd$select public._materialise_recurring()$cmd$
      );
    exception when others then
      raise notice 'pg_cron job not scheduled: %', sqlstate;
    end;
  end if;
end $$;
