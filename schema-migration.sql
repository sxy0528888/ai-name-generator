-- ============================================
-- 增量迁移：给已存在的表补 provider 字段
-- 适用于之前已经建过 name_generations 表的情况
-- 在 Supabase SQL Editor 中执行一次即可
-- ============================================

alter table public.name_generations
  add column if not exists provider text;

-- 老数据没有 provider，先补一个默认值，避免后续查询出现 null
update public.name_generations
  set provider = 'deepseek'
  where provider is null;

-- 如需强制非空（新表才建议加，老表有存量数据要谨慎）
-- alter table public.name_generations alter column provider set not null;

create index if not exists idx_name_generations_provider
  on public.name_generations (provider);
