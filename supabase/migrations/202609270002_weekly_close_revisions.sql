begin;

-- Keep each closed lot intact when a reopened week is closed again.
alter table public.cierre_semanal
  add column if not exists revision integer not null default 1 check (revision > 0);
alter table public.cierre_semanal_gasto
  add column if not exists revision integer not null default 1 check (revision > 0);

do $$
begin
  if not exists (
    select 1
    from pg_constraint c
    join pg_attribute a on a.attrelid = c.conrelid and a.attnum = any (c.conkey)
    where c.conrelid = 'public.cierre_semanal_gasto'::regclass
      and c.contype = 'p' and a.attname = 'revision'
  ) then
    alter table public.cierre_semanal_gasto drop constraint if exists cierre_semanal_gasto_pkey;
    alter table public.cierre_semanal_gasto
      add constraint cierre_semanal_gasto_pkey primary key (cierre_id, revision, gasto_id);
  end if;
end
$$;

commit;
