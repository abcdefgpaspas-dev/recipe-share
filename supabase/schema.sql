-- =====================================================================
--  レシピ共有アプリ  スキーマ
--  Supabase ダッシュボード > SQL Editor に貼り付けて実行してください。
--  何度実行しても壊れないように書いてあります（冪等）。
-- =====================================================================

create extension if not exists pgcrypto;

-- ---------------------------------------------------------------------
-- メンバー（＝夫婦2人）。表示名と色。
-- ---------------------------------------------------------------------
create table if not exists public.members (
  id         uuid primary key references auth.users(id) on delete cascade,
  name       text not null default '',
  color      text not null default '#d9633b',
  created_at timestamptz not null default now()
);

-- ---------------------------------------------------------------------
-- レシピ本体
--   ingredients : [{ "name":"玉ねぎ", "amount":"1/2個", "group":"" }, ...]
--   steps       : [{ "text":"玉ねぎを薄切りにする" }, ...]
-- ---------------------------------------------------------------------
create table if not exists public.recipes (
  id            uuid primary key default gen_random_uuid(),
  title         text not null,
  description   text not null default '',
  image_url     text,
  source_type   text not null default 'manual'
                  check (source_type in ('url','image','manual')),
  source_url    text,
  servings      text not null default '',
  prep_minutes  int,
  tags          text[]  not null default '{}',
  ingredients   jsonb   not null default '[]'::jsonb,
  steps         jsonb   not null default '[]'::jsonb,
  memo          text    not null default '',
  favorite      boolean not null default false,
  cook_count    int     not null default 0,
  last_cooked_on date,
  created_by    uuid references auth.users(id) on delete set null,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

create index if not exists recipes_created_at_idx on public.recipes (created_at desc);
create index if not exists recipes_tags_idx       on public.recipes using gin (tags);

-- ---------------------------------------------------------------------
-- 調理ログ（「作った記録」＝蓄積の核。MVPでは1タップ記録のみ使用）
-- ---------------------------------------------------------------------
create table if not exists public.cook_logs (
  id         uuid primary key default gen_random_uuid(),
  recipe_id  uuid not null references public.recipes(id) on delete cascade,
  cooked_on  date not null default current_date,
  cooked_by  uuid references auth.users(id) on delete set null,
  rating     int check (rating between 1 and 5),
  note       text not null default '',
  photo_url  text,
  created_at timestamptz not null default now()
);

create index if not exists cook_logs_recipe_idx on public.cook_logs (recipe_id, cooked_on desc);

-- ---------------------------------------------------------------------
-- updated_at 自動更新
-- ---------------------------------------------------------------------
create or replace function public.touch_updated_at() returns trigger
language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end $$;

drop trigger if exists recipes_touch on public.recipes;
create trigger recipes_touch before update on public.recipes
  for each row execute function public.touch_updated_at();

-- ---------------------------------------------------------------------
-- 調理ログを入れたら recipes.cook_count / last_cooked_on を更新
-- ---------------------------------------------------------------------
create or replace function public.sync_cook_stats() returns trigger
language plpgsql security definer set search_path = public as $$
declare
  rid uuid := coalesce(new.recipe_id, old.recipe_id);
begin
  update public.recipes r set
    cook_count     = (select count(*)        from public.cook_logs l where l.recipe_id = rid),
    last_cooked_on = (select max(l.cooked_on) from public.cook_logs l where l.recipe_id = rid)
  where r.id = rid;
  return null;
end $$;

drop trigger if exists cook_logs_sync on public.cook_logs;
create trigger cook_logs_sync after insert or update or delete on public.cook_logs
  for each row execute function public.sync_cook_stats();

-- =====================================================================
--  RLS ── このプロジェクトにログインできるユーザー（＝2人だけ）に全許可
--  アカウントは Supabase ダッシュボードから手動で2つだけ作るので、
--  「ログイン済みなら読み書き可」で必要十分です。
-- =====================================================================
alter table public.members   enable row level security;
alter table public.recipes   enable row level security;
alter table public.cook_logs enable row level security;

drop policy if exists members_all   on public.members;
drop policy if exists recipes_all   on public.recipes;
drop policy if exists cook_logs_all on public.cook_logs;

create policy members_all   on public.members
  for all to authenticated using (true) with check (true);
create policy recipes_all   on public.recipes
  for all to authenticated using (true) with check (true);
create policy cook_logs_all on public.cook_logs
  for all to authenticated using (true) with check (true);

-- =====================================================================
--  Storage ── レシピ写真用バケット
-- =====================================================================
insert into storage.buckets (id, name, public)
values ('recipe-images', 'recipe-images', true)
on conflict (id) do update set public = true;

drop policy if exists recipe_images_read  on storage.objects;
drop policy if exists recipe_images_write on storage.objects;

-- 公開読み取り（<img src> で直接表示するため）
create policy recipe_images_read on storage.objects
  for select to public
  using (bucket_id = 'recipe-images');

-- 書き換えはログイン済みのみ
create policy recipe_images_write on storage.objects
  for all to authenticated
  using (bucket_id = 'recipe-images')
  with check (bucket_id = 'recipe-images');
