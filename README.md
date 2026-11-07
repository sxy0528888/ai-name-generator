# AI 起名助手

基于 DeepSeek + Supabase 的 AI 起名工具，部署在 Vercel。用户描述需求，AI 流式返回 3 组名字方案及寓意，同时把记录写入 Supabase。

## 目录结构

```
├── api/name.js      # Vercel Serverless Function：调用 DeepSeek 流式接口 + 写入 Supabase
├── index.html       # 前端页面：输入需求，SSE 流式渲染结果
├── schema.sql       # Supabase 建表 SQL
└── package.json     # 依赖
```

## 环境变量

部署前需在 Vercel 项目的 Settings → Environment Variables 中配置：

| 变量名 | 必填 | 说明 |
|---|---|---|
| `DEEPSEEK_API_KEY` | 是 | DeepSeek 开放平台的 API Key（`sk-` 开头） |
| `SUPABASE_URL` | 是 | Supabase 项目 URL，形如 `https://xxxx.supabase.co` |
| `SUPABASE_SERVICE_ROLE_KEY` | 是 | Supabase 的 secret key（`sb_secret_` 开头），**不要用 publishable key** |
| `DEEPSEEK_BASE_URL` | 否 | 默认 `https://api.deepseek.com` |
| `DEEPSEEK_MODEL` | 否 | 默认 `deepseek-chat` |

所有密钥均从环境变量读取，仓库中不含任何硬编码密钥。

## Supabase 建表

在 Supabase 控制台的 SQL Editor 中执行 `schema.sql`：

```sql
create table if not exists public.name_generations (
  id uuid primary key default gen_random_uuid(),
  user_input text not null,
  result text not null,
  model text not null,
  created_at timestamptz not null default now()
);

create index if not exists idx_name_generations_created_at
  on public.name_generations (created_at desc);

alter table public.name_generations enable row level security;
```

## 本地开发

```bash
npm install
# 在项目根目录创建 .env，填入上述环境变量
npx vercel dev
```

访问 `http://localhost:3000`。

## 部署

1. 在 Vercel 导入本仓库，Framework Preset 选 **Other**，Root Directory 保持 `./`。
2. 在 Settings → Environment Variables 添加上述变量。
3. 推送到 `main` 分支或手动 Redeploy 即可上线。

## 接口说明

`POST /api/name`

请求体：

```json
{ "user_input": "给我家刚出生的女儿起个名字，姓林，希望优雅聪慧" }
```

响应为 `text/event-stream`，每条事件形如：

```
data: {"delta":"**林"}

data: [DONE]
```

流结束后，`user_input`、`result`、`model` 三个字段会写入 Supabase 的 `name_generations` 表。
