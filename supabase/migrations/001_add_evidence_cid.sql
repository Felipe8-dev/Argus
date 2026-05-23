-- Argus def/acc — campos para anclaje Filecoin + provenance hash
-- Ejecutar en el SQL editor de tu proyecto Supabase.

alter table public.cases add column if not exists evidence_cid text;
alter table public.cases add column if not exists portrait_sha256 text;
alter table public.cases add column if not exists provenance_manifest_url text;

create index if not exists idx_cases_evidence_cid on public.cases (evidence_cid) where evidence_cid is not null;
