alter table public.importacion_neodata
  add column if not exists parser_version integer not null default 1;

alter table public.importacion_neodata
  drop constraint if exists importacion_neodata_obra_id_archivo_sha256_estado_key;

alter table public.importacion_neodata
  add constraint importacion_neodata_obra_sha_parser_estado_uq
  unique (obra_id, archivo_sha256, parser_version, estado);

comment on column public.importacion_neodata.parser_version is
  'Versión de reglas usada para interpretar la jerarquía del archivo sin alterar su SHA-256.';
