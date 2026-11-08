-- 毛春家庭积分：Supabase 后端
-- 在 Supabase SQL Editor 中完整运行一次本文件，然后在 Authentication > Providers
-- 开启 Anonymous Sign-Ins。前端只能使用 publishable/anon key，不能使用 service_role key。

create extension if not exists pgcrypto;

create table if not exists public.households (
  id uuid primary key default gen_random_uuid(),
  name text not null check (char_length(name) between 1 and 50),
  invite_hash bytea not null unique,
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now()
);

create table if not exists public.household_members (
  household_id uuid not null references public.households(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  display_name text not null check (char_length(display_name) between 1 and 30),
  member_role text not null default 'member' check (member_role in ('owner', 'member')),
  person_role text not null check (person_role in ('chun', 'mao')),
  device_name text not null check (char_length(device_name) between 1 and 50),
  joined_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  primary key (household_id, user_id)
);

create table if not exists public.task_daily_state (
  household_id uuid not null references public.households(id) on delete cascade,
  day date not null,
  task_id text not null check (char_length(task_id) between 1 and 100),
  chun_count integer not null default 0 check (chun_count >= 0),
  mao_count integer not null default 0 check (mao_count >= 0),
  points_per_unit integer not null default 0
    constraint task_daily_state_points_per_unit_check check (points_per_unit between 0 and 100000),
  steal_by text check (steal_by in ('chun', 'mao')),
  version bigint not null default 1,
  updated_at timestamptz not null default now(),
  updated_by uuid references auth.users(id) on delete set null,
  deleted_at timestamptz,
  primary key (household_id, day, task_id)
);

create table if not exists public.audits (
  household_id uuid not null references public.households(id) on delete cascade,
  day date not null,
  subject text not null check (subject in ('chun', 'mao')),
  approved boolean not null default false,
  version bigint not null default 1,
  updated_at timestamptz not null default now(),
  updated_by uuid references auth.users(id) on delete set null,
  primary key (household_id, day, subject)
);

create table if not exists public.redemptions (
  household_id uuid not null references public.households(id) on delete cascade,
  id uuid not null,
  person text not null check (person in ('chun', 'mao')),
  item_name text not null check (char_length(item_name) between 1 and 100),
  points integer not null check (points > 0 and points <= 100000),
  redeemed_on date not null,
  created_at timestamptz not null default now(),
  created_by uuid references auth.users(id) on delete set null,
  cancelled_at timestamptz,
  cancelled_by uuid references auth.users(id) on delete set null,
  primary key (household_id, id)
);

-- Safe to rerun when upgrading a project created with an earlier schema file.
alter table public.task_daily_state
  add column if not exists points_per_unit integer not null default 0;
do $$
begin
  alter table public.task_daily_state
    add constraint task_daily_state_points_per_unit_check
    check (points_per_unit between 0 and 100000);
exception when duplicate_object then null;
end $$;

create table if not exists public.custom_tasks (
  household_id uuid not null references public.households(id) on delete cascade,
  task_id text not null check (char_length(task_id) between 1 and 100),
  definition jsonb not null,
  updated_at timestamptz not null default now(),
  updated_by uuid references auth.users(id) on delete set null,
  deleted_at timestamptz,
  primary key (household_id, task_id)
);

create table if not exists public.applied_operations (
  id uuid primary key,
  household_id uuid not null references public.households(id) on delete cascade,
  device_id uuid not null,
  op_type text not null,
  payload jsonb not null,
  client_created_at timestamptz,
  applied_at timestamptz not null default now(),
  created_by uuid references auth.users(id) on delete set null
);

create index if not exists task_daily_state_household_day_idx
  on public.task_daily_state (household_id, day);
create index if not exists audits_household_day_idx
  on public.audits (household_id, day);
create index if not exists redemptions_household_day_idx
  on public.redemptions (household_id, redeemed_on);

create or replace function public.is_household_member(p_household_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select exists (
    select 1 from public.household_members hm
    where hm.household_id = p_household_id
      and hm.user_id = auth.uid()
  );
$$;

create or replace function public.current_household()
returns table (
  household_id uuid,
  household_name text,
  display_name text,
  member_role text,
  person_role text,
  device_name text
)
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select h.id, h.name, hm.display_name, hm.member_role, hm.person_role, hm.device_name
  from public.household_members hm
  join public.households h on h.id = hm.household_id
  where hm.user_id = auth.uid()
  order by hm.joined_at
  limit 1;
$$;

create or replace function public.create_household(
  p_name text,
  p_display_name text,
  p_person_role text,
  p_device_name text
)
returns table (household_id uuid, invite_token text)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_uid uuid := auth.uid();
  v_id uuid;
  v_token text;
begin
  if v_uid is null then raise exception 'AUTH_REQUIRED'; end if;
  if p_person_role not in ('chun', 'mao') then raise exception 'INVALID_PERSON_ROLE'; end if;
  if char_length(trim(p_name)) not between 1 and 50 then raise exception 'INVALID_FAMILY_NAME'; end if;
  if char_length(trim(p_display_name)) not between 1 and 30 then raise exception 'INVALID_DISPLAY_NAME'; end if;
  if char_length(trim(p_device_name)) not between 1 and 50 then raise exception 'INVALID_DEVICE_NAME'; end if;

  if exists (select 1 from public.household_members where user_id = v_uid) then
    raise exception 'ALREADY_IN_HOUSEHOLD';
  end if;

  -- gen_random_bytes is installed under the extensions schema on some
  -- Supabase projects. PostgreSQL's built-in UUID generator avoids that
  -- schema dependency while preserving the existing 36-character invite format.
  v_token := replace(gen_random_uuid()::text, '-', '')
    || substr(replace(gen_random_uuid()::text, '-', ''), 1, 4);
  insert into public.households(name, invite_hash, created_by)
  values (trim(p_name), digest(v_token, 'sha256'), v_uid)
  returning id into v_id;

  insert into public.household_members(
    household_id, user_id, display_name, member_role, person_role, device_name
  ) values (
    v_id, v_uid, trim(p_display_name), 'owner', p_person_role, trim(p_device_name)
  );

  return query select v_id, v_token;
end;
$$;

create or replace function public.join_household(
  p_invite_token text,
  p_display_name text,
  p_person_role text,
  p_device_name text
)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_uid uuid := auth.uid();
  v_id uuid;
begin
  if v_uid is null then raise exception 'AUTH_REQUIRED'; end if;
  if p_person_role not in ('chun', 'mao') then raise exception 'INVALID_PERSON_ROLE'; end if;
  if char_length(trim(p_invite_token)) <> 36 then raise exception 'INVALID_INVITE'; end if;
  if char_length(trim(p_display_name)) not between 1 and 30 then raise exception 'INVALID_DISPLAY_NAME'; end if;
  if char_length(trim(p_device_name)) not between 1 and 50 then raise exception 'INVALID_DEVICE_NAME'; end if;

  select h.id into v_id
  from public.households h
  where h.invite_hash = digest(trim(p_invite_token), 'sha256');
  if v_id is null then raise exception 'INVALID_INVITE'; end if;

  if exists (select 1 from public.household_members where user_id = v_uid and household_id <> v_id) then
    raise exception 'ALREADY_IN_ANOTHER_HOUSEHOLD';
  end if;

  insert into public.household_members(
    household_id, user_id, display_name, member_role, person_role, device_name
  ) values (
    v_id, v_uid, trim(p_display_name), 'member', p_person_role, trim(p_device_name)
  )
  on conflict (household_id, user_id) do update set
    display_name = excluded.display_name,
    person_role = excluded.person_role,
    device_name = excluded.device_name,
    last_seen_at = now();

  return v_id;
end;
$$;

create or replace function public.apply_operation(
  p_id uuid,
  p_household_id uuid,
  p_device_id uuid,
  p_type text,
  p_payload jsonb,
  p_client_created_at timestamptz default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_inserted integer;
  v_day date;
  v_task_id text;
  v_person text;
  v_owner text;
  v_delta integer;
  v_max_count integer;
  v_points_per_unit integer;
  v_chun_count integer;
  v_mao_count integer;
  v_steal_by text;
  v_subject text;
  v_redemption_id uuid;
  v_points integer;
  v_item_name text;
  v_redeemed_on date;
  v_month_start date;
  v_person_earned bigint;
  v_person_spent bigint;
  v_family_earned bigint;
  v_family_spent bigint;
begin
  if auth.uid() is null then raise exception 'AUTH_REQUIRED'; end if;
  if not public.is_household_member(p_household_id) then raise exception 'NOT_A_MEMBER'; end if;
  if jsonb_typeof(p_payload) <> 'object' then raise exception 'INVALID_PAYLOAD'; end if;

  insert into public.applied_operations(
    id, household_id, device_id, op_type, payload, client_created_at, created_by
  ) values (
    p_id, p_household_id, p_device_id, p_type, p_payload, p_client_created_at, auth.uid()
  ) on conflict (id) do nothing;
  get diagnostics v_inserted = row_count;
  if v_inserted = 0 then
    return jsonb_build_object('ok', true, 'duplicate', true);
  end if;

  if p_type = 'task_delta' then
    v_day := (p_payload->>'day')::date;
    v_task_id := nullif(trim(p_payload->>'task_id'), '');
    v_person := p_payload->>'person';
    v_owner := coalesce(p_payload->>'owner', 'both');
    v_delta := (p_payload->>'delta')::integer;
    v_max_count := nullif(p_payload->>'max_count', '')::integer;
    v_points_per_unit := nullif(p_payload->>'points_per_unit', '')::integer;
    if v_task_id is null or v_person not in ('chun', 'mao') or v_owner not in ('chun', 'mao', 'both')
       or v_delta = 0 or abs(v_delta) > 20 or (v_max_count is not null and v_max_count not between 1 and 1000)
       or v_points_per_unit is null or v_points_per_unit not between 1 and 100000 then
      raise exception 'INVALID_TASK_DELTA';
    end if;

    insert into public.task_daily_state as current(
      household_id, day, task_id, chun_count, mao_count, points_per_unit, updated_by
    ) values (
      p_household_id, v_day, v_task_id,
      case when v_person = 'chun' then
        case when v_max_count is null then greatest(0, v_delta)
          else least(v_max_count, greatest(0, v_delta)) end
        else 0 end,
      case when v_person = 'mao' then
        case when v_max_count is null then greatest(0, v_delta)
          else least(v_max_count, greatest(0, v_delta)) end
        else 0 end,
      v_points_per_unit, auth.uid()
    )
    on conflict (household_id, day, task_id) do update set
      chun_count = case when v_person = 'chun' then
        case when v_max_count is null
          then greatest(0, current.chun_count + v_delta)
          else least(v_max_count, greatest(0, current.chun_count + v_delta)) end
        else current.chun_count end,
      mao_count = case when v_person = 'mao' then
        case when v_max_count is null
          then greatest(0, current.mao_count + v_delta)
          else least(v_max_count, greatest(0, current.mao_count + v_delta)) end
        else current.mao_count end,
      points_per_unit = excluded.points_per_unit,
      deleted_at = null,
      version = current.version + 1,
      updated_at = now(),
      updated_by = auth.uid();

    if v_owner <> 'both' and v_delta > 0 then
      update public.task_daily_state set
        chun_count = case when v_person = 'chun' then chun_count else 0 end,
        mao_count = case when v_person = 'mao' then mao_count else 0 end,
        steal_by = case when v_person = v_owner then null else v_person end,
        version = version + 1,
        updated_at = now(),
        updated_by = auth.uid()
      where household_id = p_household_id and day = v_day and task_id = v_task_id;
    elsif v_owner = 'both' then
      update public.task_daily_state set steal_by = null
      where household_id = p_household_id and day = v_day and task_id = v_task_id;
    else
      update public.task_daily_state set steal_by = null
      where household_id = p_household_id and day = v_day and task_id = v_task_id
        and ((v_person = 'chun' and chun_count = 0 and steal_by = 'chun')
          or (v_person = 'mao' and mao_count = 0 and steal_by = 'mao'));
    end if;

  elsif p_type = 'task_upsert' then
    v_day := (p_payload->>'day')::date;
    v_task_id := nullif(trim(p_payload->>'task_id'), '');
    v_chun_count := (p_payload->>'chun_count')::integer;
    v_mao_count := (p_payload->>'mao_count')::integer;
    v_steal_by := nullif(p_payload->>'steal_by', '');
    v_points_per_unit := nullif(p_payload->>'points_per_unit', '')::integer;
    if v_task_id is null or char_length(v_task_id) > 100
       or v_chun_count not between 0 and 100000 or v_mao_count not between 0 and 100000
       or (v_steal_by is not null and v_steal_by not in ('chun', 'mao'))
       or v_points_per_unit is null or v_points_per_unit not between 1 and 100000 then
      raise exception 'INVALID_TASK';
    end if;
    insert into public.task_daily_state as current(
      household_id, day, task_id, chun_count, mao_count, points_per_unit, steal_by, updated_by
    ) values (
      p_household_id, v_day, v_task_id,
      v_chun_count, v_mao_count, v_points_per_unit, v_steal_by, auth.uid()
    )
    on conflict (household_id, day, task_id) do update set
      chun_count = excluded.chun_count,
      mao_count = excluded.mao_count,
      points_per_unit = excluded.points_per_unit,
      steal_by = excluded.steal_by,
      deleted_at = null,
      version = current.version + 1,
      updated_at = now(),
      updated_by = auth.uid();

  elsif p_type = 'audit_set' then
    v_day := (p_payload->>'day')::date;
    v_subject := p_payload->>'subject';
    if v_subject not in ('chun', 'mao') then raise exception 'INVALID_AUDIT'; end if;
    insert into public.audits as current(household_id, day, subject, approved, updated_by)
    values (p_household_id, v_day, v_subject, (p_payload->>'approved')::boolean, auth.uid())
    on conflict (household_id, day, subject) do update set
      approved = excluded.approved,
      version = current.version + 1,
      updated_at = now(),
      updated_by = auth.uid();

  elsif p_type = 'redemption_create' then
    v_redemption_id := (p_payload->>'redemption_id')::uuid;
    v_person := p_payload->>'person';
    v_points := (p_payload->>'points')::integer;
    v_item_name := trim(coalesce(p_payload->>'item_name', ''));
    v_redeemed_on := (p_payload->>'redeemed_on')::date;
    if v_person not in ('chun', 'mao') or v_points <= 0 or v_points > 100000
       or char_length(v_item_name) not between 1 and 100 then
      raise exception 'INVALID_REDEMPTION';
    end if;

    v_month_start := date_trunc('month', v_redeemed_on)::date;
    perform pg_advisory_xact_lock(
      hashtext(p_household_id::text),
      (extract(year from v_month_start)::integer * 100) + extract(month from v_month_start)::integer
    );

    select
      coalesce(sum(
        (case when v_person = 'chun' then t.chun_count::bigint else t.mao_count::bigint end)
        * t.points_per_unit
      ), 0),
      coalesce(sum((t.chun_count::bigint + t.mao_count::bigint) * t.points_per_unit), 0)
    into v_person_earned, v_family_earned
    from public.task_daily_state t
    where t.household_id = p_household_id
      and t.deleted_at is null
      and t.day >= v_month_start
      and t.day < (v_month_start + interval '1 month')::date;

    select
      coalesce(sum(r.points) filter (where r.person = v_person), 0),
      coalesce(sum(r.points), 0)
    into v_person_spent, v_family_spent
    from public.redemptions r
    where r.household_id = p_household_id
      and r.cancelled_at is null
      and r.redeemed_on >= v_month_start
      and r.redeemed_on < (v_month_start + interval '1 month')::date;

    if v_person_earned - v_person_spent < v_points then
      raise exception 'INSUFFICIENT_PERSON_BALANCE';
    end if;
    if least(3000::bigint, v_family_earned) - v_family_spent < v_points then
      raise exception 'INSUFFICIENT_FAMILY_FUND';
    end if;

    insert into public.redemptions(
      household_id, id, person, item_name, points, redeemed_on, created_by
    ) values (
      p_household_id, v_redemption_id, v_person,
      v_item_name, v_points, v_redeemed_on, auth.uid()
    ) on conflict (household_id, id) do nothing;

  elsif p_type = 'redemption_cancel' then
    v_redemption_id := (p_payload->>'redemption_id')::uuid;
    update public.redemptions set cancelled_at = now(), cancelled_by = auth.uid()
    where household_id = p_household_id and id = v_redemption_id and cancelled_at is null;

  elsif p_type = 'custom_task_upsert' then
    v_task_id := nullif(trim(p_payload->>'task_id'), '');
    if v_task_id is null or jsonb_typeof(p_payload->'definition') <> 'object'
       or octet_length((p_payload->'definition')::text) > 10000 then
      raise exception 'INVALID_CUSTOM_TASK';
    end if;
    insert into public.custom_tasks as current(
      household_id, task_id, definition, updated_by
    ) values (
      p_household_id, v_task_id, p_payload->'definition', auth.uid()
    )
    on conflict (household_id, task_id) do update set
      definition = excluded.definition,
      deleted_at = null,
      updated_at = now(),
      updated_by = auth.uid();

  elsif p_type = 'custom_task_delete' then
    update public.custom_tasks set deleted_at = now(), updated_at = now(), updated_by = auth.uid()
    where household_id = p_household_id and task_id = p_payload->>'task_id' and deleted_at is null;

  elsif p_type = 'clear_day' then
    v_day := (p_payload->>'day')::date;
    update public.task_daily_state set
      chun_count = 0, mao_count = 0, steal_by = null, deleted_at = now(),
      version = version + 1, updated_at = now(), updated_by = auth.uid()
    where household_id = p_household_id and day = v_day;

  elsif p_type = 'reset_all' then
    update public.task_daily_state set deleted_at = now(), updated_at = now(), updated_by = auth.uid()
      where household_id = p_household_id and deleted_at is null;
    update public.audits set approved = false, version = version + 1, updated_at = now(), updated_by = auth.uid()
      where household_id = p_household_id;
    update public.redemptions set cancelled_at = now(), cancelled_by = auth.uid()
      where household_id = p_household_id and cancelled_at is null;
    update public.custom_tasks set deleted_at = now(), updated_at = now(), updated_by = auth.uid()
      where household_id = p_household_id and deleted_at is null;

  else
    raise exception 'UNKNOWN_OPERATION';
  end if;

  update public.household_members set last_seen_at = now()
  where household_id = p_household_id and user_id = auth.uid();
  return jsonb_build_object('ok', true, 'duplicate', false);
end;
$$;

alter table public.households enable row level security;
alter table public.household_members enable row level security;
alter table public.task_daily_state enable row level security;
alter table public.audits enable row level security;
alter table public.redemptions enable row level security;
alter table public.custom_tasks enable row level security;
alter table public.applied_operations enable row level security;

drop policy if exists household_read on public.households;
create policy household_read on public.households for select to authenticated
using (public.is_household_member(id));
drop policy if exists member_read on public.household_members;
create policy member_read on public.household_members for select to authenticated
using (public.is_household_member(household_id));
drop policy if exists task_state_read on public.task_daily_state;
create policy task_state_read on public.task_daily_state for select to authenticated
using (public.is_household_member(household_id));
drop policy if exists audits_read on public.audits;
create policy audits_read on public.audits for select to authenticated
using (public.is_household_member(household_id));
drop policy if exists redemptions_read on public.redemptions;
create policy redemptions_read on public.redemptions for select to authenticated
using (public.is_household_member(household_id));
drop policy if exists custom_tasks_read on public.custom_tasks;
create policy custom_tasks_read on public.custom_tasks for select to authenticated
using (public.is_household_member(household_id));

revoke all on public.households, public.household_members, public.task_daily_state,
  public.audits, public.redemptions, public.custom_tasks, public.applied_operations from anon;
revoke insert, update, delete on public.households, public.household_members,
  public.task_daily_state, public.audits, public.redemptions,
  public.custom_tasks, public.applied_operations from authenticated;
grant select on public.households, public.household_members, public.task_daily_state,
  public.audits, public.redemptions, public.custom_tasks to authenticated;

revoke all on function public.is_household_member(uuid) from public;
revoke all on function public.current_household() from public;
revoke all on function public.create_household(text, text, text, text) from public;
revoke all on function public.join_household(text, text, text, text) from public;
revoke all on function public.apply_operation(uuid, uuid, uuid, text, jsonb, timestamptz) from public;
grant execute on function public.is_household_member(uuid) to authenticated;
grant execute on function public.current_household() to authenticated;
grant execute on function public.create_household(text, text, text, text) to authenticated;
grant execute on function public.join_household(text, text, text, text) to authenticated;
grant execute on function public.apply_operation(uuid, uuid, uuid, text, jsonb, timestamptz) to authenticated;

do $$
begin
  alter publication supabase_realtime add table public.task_daily_state;
exception when duplicate_object then null;
end $$;
do $$
begin
  alter publication supabase_realtime add table public.audits;
exception when duplicate_object then null;
end $$;
do $$
begin
  alter publication supabase_realtime add table public.redemptions;
exception when duplicate_object then null;
end $$;
do $$
begin
  alter publication supabase_realtime add table public.custom_tasks;
exception when duplicate_object then null;
end $$;

