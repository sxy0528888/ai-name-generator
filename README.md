# AI 起名助手

多模型 AI 起名工具，部署在 Vercel。用户描述需求、前端下拉选模型，AI 流式返回 3 组名字方案及寓意，同时把记录写入 Supabase。

支持 DeepSeek / 豆包（火山方舟）/ 通义千问 / Kimi 四家模型，四家均兼容 OpenAI 的 `/chat/completions` 协议，因此共用一套调用与流解析代码。

## 目录结构

```
├── api/name.js            # Serverless Function：模型配置表 + 共用调用/流解析 + 落库
├── index.html             # 前端页面：输入需求、选模型、SSE 流式渲染
├── schema.sql             # Supabase 建表 SQL（含 provider 字段）
├── schema-migration.sql   # 给已有表补 provider 字段的增量 SQL
├── vercel.json            # 函数超时配置（maxDuration 60s）
└── package.json           # 依赖
```

## 模型配置表

所有模型差异集中在 `api/name.js` 顶部的 `modelConfigMap`，新增模型只改这一处：

| provider | 平台 | 密钥环境变量 | 模型环境变量 | 默认模型 / 接入点 |
|---|---|---|---|---|
| `deepseek` | DeepSeek 开放平台 | `DEEPSEEK_API_KEY` | `DEEPSEEK_MODEL` | `deepseek-chat` |
| `doubao` | 火山方舟 Ark | `ARK_API_KEY` | `DOUBAO_MODEL` | 必填推理接入点 ID（`ep-xxxx`） |
| `qwen` | 阿里云百炼 DashScope | `DASHSCOPE_API_KEY` | `QWEN_MODEL` | `qwen-plus` |
| `kimi` | Moonshot | `MOONSHOT_API_KEY` | `KIMI_MODEL` | `moonshot-v1-8k` |

Base URL 均可用环境变量覆盖：`DEEPSEEK_BASE_URL`、`DOUBAO_BASE_URL`、`QWEN_BASE_URL`、`KIMI_BASE_URL`。

## 环境变量

在 Vercel 项目 Settings → Environment Variables 中配置：

| 变量名 | 必填 | 说明 |
|---|---|---|
| `SUPABASE_URL` | 是 | Supabase 项目 URL，形如 `https://xxxx.supabase.co` |
| `SUPABASE_SERVICE_ROLE_KEY` | 是 | Supabase secret key（`sb_secret_` 开头），**不要用 publishable key** |
| `DEEPSEEK_API_KEY` | 否 | 配了 DeepSeek 才可用 |
| `ARK_API_KEY` | 否 | 配了豆包才可用 |
| `DOUBAO_MODEL` | 否 | 火山方舟推理接入点 ID，形如 `ep-2024xxxx` |
| `DASHSCOPE_API_KEY` | 否 | 配了通义千问才可用 |
| `MOONSHOT_API_KEY` | 否 | 配了 Kimi 才可用 |

密钥按需配置：前端会调用 `GET /api/name` 探测可用模型，未配密钥的选项显示「未配置密钥」并置灰。

所有密钥均从环境变量读取，仓库中不含任何硬编码密钥。

## Supabase 建表

新项目：在 SQL Editor 执行 `schema.sql`。

已有 `name_generations` 表的项目：执行 `schema-migration.sql` 补字段。

```sql
create table if not exists public.name_generations (
  id uuid primary key default gen_random_uuid(),
  user_input text not null,
  result text not null,
  provider text not null,
  model text not null,
  created_at timestamptz not null default now()
);

create index if not exists idx_name_generations_created_at
  on public.name_generations (created_at desc);

create index if not exists idx_name_generations_provider
  on public.name_generations (provider);

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
2. 在 Settings → Environment Variables 添加变量。
3. 推送到 `main` 分支或手动 Redeploy 即可上线。

## 接口说明

### `GET /api/name`

返回各模型可用性：

```json
{
  "defaultProvider": "deepseek",
  "providers": [
    { "id": "deepseek", "label": "DeepSeek", "model": "deepseek-chat", "available": true },
    { "id": "doubao", "label": "豆包", "model": null, "available": false }
  ]
}
```

### `POST /api/name`

请求体：

```json
{
  "user_input": "给我家刚出生的女儿起个名字，姓林，希望优雅聪慧",
  "provider": "deepseek"
}
```

`provider` 可省略，默认 `deepseek`。

响应为 `text/event-stream`：

```
data: {"delta":"**1. 林"}

data: {"saved":true}

data: [DONE]
```

流结束后，`user_input`、`result`、`provider`、`model` 四个字段写入 `name_generations` 表。
