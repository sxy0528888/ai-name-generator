-- ============================================
-- Supabase 建表 SQL：AI 起名记录（多模型版）
-- 在 Supabase SQL Editor 中执行
-- ============================================

create table if not exists public.name_generations (
  id uuid primary key default gen_random_uuid(),
  user_input text not null,          -- 用户输入的起名需求
  result text not null,              -- 模型生成的完整起名方案
  provider text not null,            -- 模型标识：deepseek / doubao / qwen / kimi
  model text not null,               -- 具体模型名或接入点，如 deepseek-chat、ep-2024xxxx
  created_at timestamptz not null default now()
);

-- 按创建时间倒序索引，方便查询历史记录
create index if not exists idx_name_generations_created_at
  on public.name_generations (created_at desc);

-- 按模型筛选历史记录用
create index if not exists idx_name_generations_provider
  on public.name_generations (provider);

-- 开启 RLS（Row Level Security）：
-- 后端用 service_role 写入（默认绕过 RLS），前端 anon key 无法直接读写这张表
alter table public.name_generations enable row level security;
