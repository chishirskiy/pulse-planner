-- ПУЛЬС 3.0 — выполнить целиком в Supabase -> SQL Editor.
-- Таблица хранит отдельные задачи, привычки, сессии и настройки каждого пользователя.
-- Удаления сохраняются как tombstone (deleted = true), чтобы не возвращались офлайн.

create table if not exists public.pulse_items (
 owner_id uuid not null references auth.users(id) on delete cascade,
 kind text not null check (kind in ('task','habit','focus','settings')),
 item_id text not null check (length(item_id) between 1 and 180),
 payload jsonb not null default '{}'::jsonb,
 deleted boolean not null default false,
 client_changed_at timestamptz not null,
 server_changed_at timestamptz not null default now(),
 primary key (owner_id, kind, item_id)
);

create index if not exists pulse_items_updated_idx
 on public.pulse_items(owner_id, server_changed_at desc);

alter table public.pulse_items enable row level security;
revoke all on table public.pulse_items from anon, authenticated;
grant select, insert, update on table public.pulse_items to authenticated;

-- Every data request is restricted to the signed-in Supabase Auth user.
drop policy if exists "pulse_select_self" on public.pulse_items;
create policy "pulse_select_self" on public.pulse_items
 for select to authenticated using ((select auth.uid()) = owner_id);

drop policy if exists "pulse_insert_self" on public.pulse_items;
create policy "pulse_insert_self" on public.pulse_items
 for insert to authenticated with check ((select auth.uid()) = owner_id);

drop policy if exists "pulse_update_self" on public.pulse_items;
create policy "pulse_update_self" on public.pulse_items
 for update to authenticated using ((select auth.uid()) = owner_id)
 with check ((select auth.uid()) = owner_id);

-- Deletions are logical: tombstones are necessary for offline synchronization.
-- Disallow DELETE from the client: revoked privilege above.

-- Apply an item atomically. The newer client_changed_at wins for the same item;
-- edits to different items never overwrite one another.
-- The function runs with the caller's privileges and respects RLS.
create or replace function public.pulse_apply (
 p_kind text,
 p_item_id text,
 p_payload jsonb,
 p_deleted boolean,
 p_client_changed_at timestamptz
) returns public.pulse_items
language plpgsql
security invoker
set search_path = public
as $$
declare
 result_row public.pulse_items;
begin
 if (select auth.uid()) is null then
   raise exception 'You must be authenticated' using errcode = '28000';
 end if;
 if p_kind not in ('task','habit','focus','settings')
    or length(p_item_id) not between 1 and 180
    or p_payload is null
    or pg_column_size(p_payload) > 100000
    or p_client_changed_at is null then
   raise exception 'Invalid pulse item';
 end if;

 insert into public.pulse_items as existing
     (owner_id,kind,item_id,payload,deleted,client_changed_at,server_changed_at)
 values ((select auth.uid()),p_kind,p_item_id,p_payload,p_deleted,p_client_changed_at,now())
 on conflict (owner_id,kind,item_id) do update
    set payload=excluded.payload,
        deleted=excluded.deleted,
        client_changed_at=excluded.client_changed_at,
        server_changed_at=now()
    where existing.client_changed_at <= excluded.client_changed_at
 returning * into result_row;

 if result_row is null then
    select * into result_row
      from public.pulse_items
      where owner_id=(select auth.uid()) and kind=p_kind and item_id=p_item_id;
 end if;
 return result_row;
end;
$$;

revoke all on function public.pulse_apply(text,text,jsonb,boolean,timestamptz) from public,anon;
grant execute on function public.pulse_apply(text,text,jsonb,boolean,timestamptz) to authenticated;

-- Пульс 3.0 автоматически опрашивает изменения каждые 15 секунд.
-- Realtime publication НЕ требуется, поэтому скрипт не меняет публикации проекта.
