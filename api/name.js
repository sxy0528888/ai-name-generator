import { createClient } from '@supabase/supabase-js';

/**
 * 模型配置表：新增/删除模型只改这里，调用逻辑不用动。
 * 四个厂商都兼容 OpenAI 的 /chat/completions 协议，所以能共用一套调用代码。
 * 密钥全部从环境变量读取，代码里不出现任何明文 key。
 */
const modelConfigMap = {
  deepseek: {
    label: 'DeepSeek',
    baseUrl: process.env.DEEPSEEK_BASE_URL || 'https://api.deepseek.com',
    apiKey: process.env.DEEPSEEK_API_KEY,
    apiKeyName: 'DEEPSEEK_API_KEY',
    model: process.env.DEEPSEEK_MODEL || 'deepseek-chat',
    // DeepSeek 专属参数：关闭深度思考，起名这种轻任务不需要
    extraBody: { thinking: { type: 'disabled' } }
  },
  doubao: {
    label: '豆包',
    baseUrl: process.env.DOUBAO_BASE_URL || 'https://ark.cn-beijing.volces.com/api/v3',
    apiKey: process.env.ARK_API_KEY,
    apiKeyName: 'ARK_API_KEY',
    // 火山方舟的 model 填「推理接入点 ID」，形如 ep-2024xxxxxx，不是模型名
    model: process.env.DOUBAO_MODEL,
    extraBody: {}
  },
  qwen: {
    label: '通义千问',
    baseUrl: process.env.QWEN_BASE_URL || 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    apiKey: process.env.DASHSCOPE_API_KEY,
    apiKeyName: 'DASHSCOPE_API_KEY',
    model: process.env.QWEN_MODEL || 'qwen-plus',
    extraBody: {}
  },
  kimi: {
    label: 'Kimi',
    baseUrl: process.env.KIMI_BASE_URL || 'https://api.moonshot.cn/v1',
    apiKey: process.env.MOONSHOT_API_KEY,
    apiKeyName: 'MOONSHOT_API_KEY',
    model: process.env.KIMI_MODEL || 'moonshot-v1-8k',
    extraBody: {}
  }
};

const DEFAULT_PROVIDER = 'deepseek';

/** 判断某个模型是否可用于调用：密钥和 model 都齐了才算 */
function isReady(config) {
  return Boolean(config && config.apiKey && config.model);
}

const SYSTEM_PROMPT = `你是一位资深的起名专家。根据用户的需求，给出 3 组名字方案，每组名字都要附带简短的寓意解释。

输出要求：
1. 严格输出 3 组方案，不要多也不要少。
2. 每组方案的格式固定为：
**1. 名字**
拼音：xxx
寓意：一句话说明
3. 整体风格贴合用户的需求，不要输出无关内容。
4. 直接开始输出名字方案，不要寒暄。`;

/**
 * 共用调用代码：所有厂商都走这一个函数。
 * 差异全部收敛在 modelConfigMap 里（baseUrl / apiKey / model / extraBody）。
 */
async function callModelStream(config, userInput) {
  const url = `${config.baseUrl.replace(/\/$/, '')}/chat/completions`;

  const payload = {
    model: config.model,
    messages: [
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user', content: userInput }
    ],
    max_tokens: 1024,
    temperature: 0.8,
    stream: true,
    ...config.extraBody
  };

  return fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${config.apiKey}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(payload)
  });
}

/**
 * 共用流解析器：把 OpenAI 格式的 SSE 逐条切出来，产出增量文本。
 * DeepSeek / 豆包 / 通义 / Kimi 返回结构一致，所以能共用。
 */
async function* readStreamDeltas(responseBody) {
  const reader = responseBody.getReader();
  const decoder = new TextDecoder('utf-8');
  let buffer = '';

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });

    // SSE 事件之间用空行分隔；最后一段可能不完整，留在 buffer 等下一片
    const events = buffer.split('\n\n');
    buffer = events.pop();

    for (const event of events) {
      for (const line of event.split('\n')) {
        const trimmed = line.trim();
        if (!trimmed.startsWith('data:')) continue;

        const data = trimmed.slice(5).trim();
        if (!data || data === '[DONE]') continue;

        try {
          const json = JSON.parse(data);
          const delta = json.choices?.[0]?.delta?.content || '';
          if (delta) yield delta;
        } catch {
          // 心跳帧或非 JSON 数据，跳过
        }
      }
    }
  }
}

export default async function handler(req, res) {
  // GET：给前端探测哪些模型可用（有没有配密钥）
  if (req.method === 'GET') {
    const providers = Object.entries(modelConfigMap).map(([id, config]) => ({
      id,
      label: config.label,
      model: config.model || null,
      available: isReady(config)
    }));
    return res.status(200).json({ defaultProvider: DEFAULT_PROVIDER, providers });
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { user_input, provider = DEFAULT_PROVIDER } = req.body || {};

  if (!user_input || typeof user_input !== 'string' || !user_input.trim()) {
    return res.status(400).json({ error: 'user_input is required' });
  }

  // 校验模型标识
  const config = modelConfigMap[provider];
  if (!config) {
    return res.status(400).json({
      error: `未知的模型标识：${provider}`,
      availableProviders: Object.keys(modelConfigMap)
    });
  }

  if (!config.apiKey) {
    return res.status(500).json({ error: `${config.apiKeyName} 环境变量未配置` });
  }
  if (!config.model) {
    return res.status(500).json({
      error: provider === 'doubao'
        ? 'DOUBAO_MODEL 环境变量未配置（需填火山方舟的推理接入点 ID，形如 ep-2024xxxx）'
        : `${provider.toUpperCase()}_MODEL 环境变量未配置`
    });
  }

  // ---- 调用模型 ----
  let upstream;
  try {
    upstream = await callModelStream(config, user_input.trim());
  } catch (err) {
    return res.status(502).json({ error: `${config.label} 请求失败`, detail: err.message });
  }

  if (!upstream.ok || !upstream.body) {
    const detail = await upstream.text().catch(() => '');
    return res.status(502).json({
      error: `${config.label} 返回错误（HTTP ${upstream.status}）`,
      detail: detail.slice(0, 500)
    });
  }

  // ---- 流式转发给浏览器 ----
  res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders?.();

  let fullText = '';
  let clientGone = false;
  req.on('close', () => { clientGone = true; });

  try {
    for await (const delta of readStreamDeltas(upstream.body)) {
      fullText += delta;
      if (!clientGone) res.write(`data: ${JSON.stringify({ delta })}\n\n`);
    }
  } catch {
    if (!clientGone) {
      res.write(`data: ${JSON.stringify({ error: '流式读取中断' })}\n\n`);
    }
  }

  // ---- 落库：流结束后统一写入，失败不影响前端已展示的内容 ----
  const SUPABASE_URL = process.env.SUPABASE_URL;
  const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (SUPABASE_URL && SUPABASE_SERVICE_KEY && fullText) {
    try {
      const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);
      await supabase.from('name_generations').insert({
        user_input: user_input.trim(),
        result: fullText,
        provider,
        model: config.model
      });
      if (!clientGone) res.write(`data: ${JSON.stringify({ saved: true })}\n\n`);
    } catch (err) {
      console.error('Supabase 写入失败:', err);
      if (!clientGone) {
        res.write(`data: ${JSON.stringify({ saveError: err.message })}\n\n`);
      }
    }
  }

  if (!clientGone) {
    res.write('data: [DONE]\n\n');
    res.end();
  }
}
