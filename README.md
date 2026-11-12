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

## 权限配置（RLS）说明

### 当前方案（已验证可用）

表上已开启 RLS，但**没有给 anon / authenticated 角色开放任何 policy**。写入只由后端 Serverless Function 用 `SUPABASE_SERVICE_ROLE_KEY` 执行，service_role 默认绕过 RLS。

这样做的效果：

| 角色 | 能不能读 | 能不能写 | 说明 |
|---|---|---|---|
| `anon` / `authenticated`（浏览器） | ❌ | ❌ | 没有 policy 即默认拒绝 |
| `service_role`（后端函数） | ✅ | ✅ | 绕过 RLS，密钥只存在于 Vercel 环境变量 |

**安全性要点**：`service_role` 密钥绝不能出现在前端代码或 `NEXT_PUBLIC_` / 浏览器可见变量里，一旦泄露等于整个数据库可写。本项目的 key 只存在于 `api/name.js` 运行时的 `process.env` 中，前端只调用自己的 `/api/name`，不直连 Supabase。

### 调试阶段临时放开（不推荐长期使用）

如果只是想临时让前端直接读表看数据，可以给 anon 开放只读：

```sql
-- 仅调试用：允许匿名只读
create policy "debug read only"
  on public.name_generations
  for select
  to anon
  using (true);
```

调试结束务必删除：`drop policy "debug read only" on public.name_generations;`

### 正式上线：带用户体系的推荐配置

如果后续要「每个用户看自己的历史记录」，不要放开 anon，而是接 Supabase Auth：

1. 建表时加一列记录归属用户：

```sql
alter table public.name_generations
  add column if not exists user_id uuid references auth.users (id) on delete cascade;
```

2. 后端写入时带上当前登录用户（用 anon key + 用户 JWT 的客户端，而不是 service_role）：

```js
const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
  global: { headers: { Authorization: `Bearer ${userJwt}` } }
});
```

3. 只给「本人」开读写权限，RLS 自己完成鉴权：

```sql
create policy "own rows select"
  on public.name_generations for select
  to authenticated
  using (auth.uid() = user_id);

create policy "own rows insert"
  on public.name_generations for insert
  to authenticated
  with check (auth.uid() = user_id);
```

4. 需要公开排行榜之类的场景，再单独用 `security definer` 函数或只读视图暴露聚合结果，不要直接开表。

### 一句话总结（可直接写进报告）

> 数据库层面开启 RLS 且不向匿名角色开放任何策略，所有写入经由后端函数以 service_role 执行，前端仅通过自有 API 间接访问；service_role 密钥只存放在服务端环境变量中。若需支持多用户历史记录，则引入 Supabase Auth，在表中冗余 `user_id`，并基于 `auth.uid()` 编写行级策略，实现最小权限访问。

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
