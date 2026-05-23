-- =====================================================================
-- Argus — RLS policies para la demo def/acc
-- =====================================================================
-- Por defecto Supabase activa RLS en proyectos nuevos. Como la demo
-- requiere que el cliente del navegador (anon) lea cases + pipeline_events
-- + matches en tiempo real, dejamos SELECT abierto para anon.
-- Los WRITES siguen siendo solo via service_role (server-side Argus).
--
-- Para un deploy de producción real con datos sensibles, reemplazar
-- estas policies por reglas que filtren por operador autenticado.
-- =====================================================================

-- Asegurar que RLS esté ON (Supabase ya lo trae por default en proyectos nuevos)
alter table public.cases               enable row level security;
alter table public.conversation_messages enable row level security;
alter table public.media               enable row level security;
alter table public.matches             enable row level security;
alter table public.pipeline_events     enable row level security;
alter table public.viral_posts         enable row level security;

-- ---- SELECT abierto para anon + authenticated ----
do $$
declare
  t text;
begin
  for t in select unnest(array[
    'cases','conversation_messages','media','matches','pipeline_events','viral_posts'
  ]) loop
    execute format(
      'drop policy if exists "argus_anon_read_%1$s" on public.%1$s', t
    );
    execute format(
      'create policy "argus_anon_read_%1$s" on public.%1$s for select to anon, authenticated using (true)',
      t
    );
  end loop;
end$$;

-- ---- INSERT/UPDATE/DELETE: solo service_role (default behavior).
--      No agregamos policies, así anon no puede modificar nada.

-- ---- Realtime: asegurar que las tablas estén publicadas ----
do $$
begin
  begin alter publication supabase_realtime add table public.cases; exception when duplicate_object then null; end;
  begin alter publication supabase_realtime add table public.pipeline_events; exception when duplicate_object then null; end;
  begin alter publication supabase_realtime add table public.matches; exception when duplicate_object then null; end;
end$$;

-- ---- Storage: ya está abierto el read para los 3 buckets. Verificar:
do $$
begin
  if not exists (select 1 from pg_policies where policyname = 'public_read_portraits') then
    create policy "public_read_portraits"
      on storage.objects for select
      using (bucket_id in ('portraits','viral-posts','case-media'));
  end if;
end$$;

-- Confirmación
select 'Argus RLS policies aplicadas. anon puede SELECT en 6 tables.' as status;
