-- =====================================================================
-- ARGUS — Supabase setup (script único y completo)
-- Pégalo entero en: Supabase → SQL Editor → New query → Run.
-- Idempotente: se puede re-ejecutar sin romper nada.
-- Cubre: tablas, índices, columnas de evidencia, realtime, RLS y storage.
-- =====================================================================

-- ---------- Extensiones ----------
create extension if not exists "uuid-ossp";
create extension if not exists "pgcrypto";
create extension if not exists "vector";

-- ---------------------------------------------------------------------
-- cases: un registro por reporte de persona desaparecida
-- ---------------------------------------------------------------------
create table if not exists public.cases (
  id                       uuid primary key default gen_random_uuid(),
  reporter_phone           text not null,
  reporter_chat_id         text not null,
  reporter_name            text,
  status                   text not null default 'intake',
    -- intake | portrait | searching | match_found | closed
  description              jsonb not null default '{}'::jsonb,
  portrait_url             text,
  embedding                vector(1024),
  -- evidencia / provenance (def/acc)
  evidence_cid             text,
  portrait_sha256          text,
  provenance_manifest_url  text,
  created_at               timestamptz not null default now(),
  updated_at               timestamptz not null default now()
);

create index if not exists idx_cases_phone        on public.cases (reporter_phone);
create index if not exists idx_cases_status       on public.cases (status);
create index if not exists idx_cases_updated      on public.cases (updated_at desc);
create index if not exists idx_cases_evidence_cid on public.cases (evidence_cid) where evidence_cid is not null;

-- ---------------------------------------------------------------------
-- conversation_messages: transcripción del intake (Agente 0)
-- ---------------------------------------------------------------------
create table if not exists public.conversation_messages (
  id          uuid primary key default gen_random_uuid(),
  case_id     uuid not null references public.cases(id) on delete cascade,
  role        text not null check (role in ('user','assistant','system','tool')),
  content     text not null,
  media_type  text default 'text',
  created_at  timestamptz not null default now()
);

create index if not exists idx_msgs_case on public.conversation_messages (case_id, created_at);

-- ---------------------------------------------------------------------
-- media: imágenes/audio asociados a un caso
-- ---------------------------------------------------------------------
create table if not exists public.media (
  id          uuid primary key default gen_random_uuid(),
  case_id     uuid not null references public.cases(id) on delete cascade,
  kind        text not null,  -- input_audio | input_image | portrait | viral_post
  url         text not null,
  meta        jsonb default '{}'::jsonb,
  created_at  timestamptz not null default now()
);

-- ---------------------------------------------------------------------
-- matches: coincidencias producidas por Ghost / agentes (visión + OSINT)
-- ---------------------------------------------------------------------
create table if not exists public.matches (
  id              uuid primary key default gen_random_uuid(),
  case_id         uuid not null references public.cases(id) on delete cascade,
  source_url      text not null,
  source_site     text,
  photo_url       text not null,
  confidence      numeric,
  reasoning       text,
  exif            jsonb default '{}'::jsonb,
  gps_lat         double precision,
  gps_lon         double precision,
  taken_at        timestamptz,
  place_label     text,
  notified        boolean not null default false,
  created_at      timestamptz not null default now()
);

create index if not exists idx_matches_case on public.matches (case_id, created_at desc);

-- ---------------------------------------------------------------------
-- pipeline_events: actividad granular de agentes (dashboard en vivo)
-- ---------------------------------------------------------------------
create table if not exists public.pipeline_events (
  id          uuid primary key default gen_random_uuid(),
  case_id     uuid not null references public.cases(id) on delete cascade,
  agent       text not null,    -- agent0 | atlas | ghost | sentinel | pulse | pipeline | intel.* | echo.*
  event       text not null,    -- start | progress | complete | error | blocked
  payload     jsonb default '{}'::jsonb,
  created_at  timestamptz not null default now()
);

create index if not exists idx_pipeline_events_case on public.pipeline_events (case_id, created_at desc);

-- ---------------------------------------------------------------------
-- viral_posts: copys/banners generados por Echo
-- ---------------------------------------------------------------------
create table if not exists public.viral_posts (
  id          uuid primary key default gen_random_uuid(),
  case_id     uuid not null references public.cases(id) on delete cascade,
  platform    text not null,    -- whatsapp | facebook | twitter | instagram
  copy        text not null,
  image_url   text,
  created_at  timestamptz not null default now()
);

-- ---------------------------------------------------------------------
-- Storage buckets (públicos para servir retratos/banners en el demo)
-- ---------------------------------------------------------------------
insert into storage.buckets (id, name, public)
values
  ('portraits',   'portraits',   true),
  ('viral-posts', 'viral-posts', true),
  ('case-media',  'case-media',  true)
on conflict (id) do nothing;

-- ---------------------------------------------------------------------
-- Realtime: publicar las tablas que el dashboard escucha en vivo
-- ---------------------------------------------------------------------
do $$
begin
  begin alter publication supabase_realtime add table public.cases;           exception when duplicate_object then null; end;
  begin alter publication supabase_realtime add table public.matches;         exception when duplicate_object then null; end;
  begin alter publication supabase_realtime add table public.pipeline_events; exception when duplicate_object then null; end;
end$$;

-- ---------------------------------------------------------------------
-- RLS: lectura abierta (anon + authenticated). Escrituras solo service_role.
--   El servidor de Argus usa SUPABASE_SERVICE_ROLE_KEY (salta RLS), así que
--   no hacen falta policies de INSERT/UPDATE para que escriba.
-- ---------------------------------------------------------------------
alter table public.cases                 enable row level security;
alter table public.conversation_messages enable row level security;
alter table public.media                 enable row level security;
alter table public.matches               enable row level security;
alter table public.pipeline_events       enable row level security;
alter table public.viral_posts           enable row level security;

do $$
declare t text;
begin
  for t in select unnest(array[
    'cases','conversation_messages','media','matches','pipeline_events','viral_posts'
  ]) loop
    execute format('drop policy if exists "argus_anon_read_%1$s" on public.%1$s', t);
    execute format(
      'create policy "argus_anon_read_%1$s" on public.%1$s for select to anon, authenticated using (true)', t
    );
  end loop;
end$$;

-- ---------------------------------------------------------------------
-- Storage: lectura pública de los 3 buckets (las escrituras van por
-- service_role desde /api/upload-photo, que salta RLS).
-- ---------------------------------------------------------------------
do $$
begin
  if not exists (select 1 from pg_policies where policyname = 'public_read_portraits') then
    create policy "public_read_portraits"
      on storage.objects for select
      using (bucket_id in ('portraits','viral-posts','case-media'));
  end if;
end$$;

select 'ARGUS: esquema + realtime + RLS + storage aplicados correctamente.' as status;
