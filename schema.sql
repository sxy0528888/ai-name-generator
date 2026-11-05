-- ============================================
-- Supabase 建表 SQL：AI 起名记录
-- 在 Supabase SQL Editor 中执行
-- ============================================

create table if not exists public.name_generations (
  id uuid primary key default gen_random_uuid(),
  user_input text not null,
  result text not null,
  model text not null,
  created_at timestamptz not null default now()
);

-- 按创建时间倒序索引，方便查询历史记录
create index if not exists idx_name_generations_created_at
  on public.name_generations (created_at desc);

-- 开启 RLS（Row Level Security）
alter table public.name_generations enable row level security;

-- 因为我们用 service_role_key 在后端写入，service_role 默认绕过 RLS，
-- 前端 anon key 不允许读/写这张表，保证安全。
-- 如需让前端查询历史记录，再单独加 policy 即可。
