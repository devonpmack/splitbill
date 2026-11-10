-- Optional daily job for the recurring engine. pg_cron is an extension some
-- projects do not offer; when it is not available this does nothing, and the app
-- creates due occurrences when someone opens it (materialise_my_recurring).
-- Occurrences are created up to 48 hours ahead, so one run a day is enough.
-- Running it again replaces the job rather than adding a second one.

do $$
begin
  if exists (select 1 from pg_available_extensions where name = 'pg_cron') then
    create extension if not exists pg_cron with schema pg_catalog;

    if exists (select 1 from cron.job where jobname = 'evenpot-materialise-recurring') then
      perform cron.unschedule('evenpot-materialise-recurring');
    end if;

    perform cron.schedule(
      'evenpot-materialise-recurring',
      '0 5 * * *',
      $cmd$select public._materialise_recurring()$cmd$
    );
  end if;
end $$;
