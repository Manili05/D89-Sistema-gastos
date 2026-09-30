select 'create database litellm'
where not exists (select from pg_database where datname = 'litellm')\gexec

-- PostgREST changes into these roles after validating the JWT.  Supabase's
-- managed platform creates them for us; the self-hosted PostgreSQL image does
-- not, so they must exist before Auth, Storage and the application migration.
do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'anon') then
    create role anon nologin noinherit;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'authenticated') then
    create role authenticated nologin noinherit;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'service_role') then
    create role service_role nologin noinherit bypassrls;
  end if;
end
$$;

create schema if not exists auth;
create schema if not exists storage;

grant usage on schema public, auth, storage to anon, authenticated, service_role;
