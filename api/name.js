import { createClient } from '@supabase/supabase-js';

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { user_input } = req.body || {};
  if (!user_input || typeof user_input !== 'string') {
    return res.status(400).json({ error: 'user_input is required' });
  }

  // 从环境变量读取密钥，不写死
  const DEEPSEEK_API_KEY = process.env.DEEPSEEK_API_KEY;
  const DEEPSEEK_BASE_URL = process.env.DEEPSEEK_BASE_URL || 'https://api.deepseek.com';
  const MODEL = process.env.DEEPSEEK_MODEL || 'deepseek-chat';
  const SUPABASE_URL = process.env.SUPABASE_URL;
  const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!DEEPSEEK_API_KEY) {
    return res.status(500).json({ error: 'DEEPSEEK_API_KEY 环境变量未配置' });
  }

  // 构造 prompt：要求输出 3 组名字 + 寓意
  const systemPrompt = `你是一位资深的起名专家。根据用户的需求，给出 3 组名字方案，每组名字都要附带简短的寓意解释。

输出要求：
1. 严格输出 3 组方案，不要多也不要少。
2. 每组方案用 Markdown 格式，包含：名字（加粗）、拼音、寓意解释（1-2 句话）。
3. 整体风格贴合用户的需求，不要输出无关内容。
4. 直接开始输出名字方案，不要寒暄。`;

  const deepseekPayload = {
    model: MODEL,
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: user_input }
    ],
    max_tokens: 1024,
    temperature: 0.8,
    stream: true
  };

  // 调用 DeepSeek 流式接口
  const deepseekRes = await fetch(`${DEEPSEEK_BASE_URL}/chat/completions`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${DEEPSEEK_API_KEY}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(deepseekPayload)
  });

  if (!deepseekRes.ok) {
    const errText = await deepseekRes.text().catch(() => '');
    return res.status(502).json({ error: 'DeepSeek API 调用失败', detail: errText });
  }

  // 设置 SSE 流式响应头
  res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders?.();

  const reader = deepseekRes.body.getReader();
  const decoder = new TextDecoder('utf-8');
  let fullText = '';

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      const chunk = decoder.decode(value, { stream: true });
      // DeepSeek 返回 SSE 格式：每行 "data: {...}"
      const lines = chunk.split('\n');
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed.startsWith('data:')) continue;
        const data = trimmed.slice(5).trim();
        if (data === '[DONE]') continue;

        try {
          const json = JSON.parse(data);
          const delta = json.choices?.[0]?.delta?.content || '';
          if (delta) {
            fullText += delta;
            // 向前端转发增量
            res.write(`data: ${JSON.stringify({ delta })}\n\n`);
          }
        } catch (parseErr) {
          // 心跳或空行，忽略
        }
      }
    }
  } catch (streamErr) {
    res.write(`data: ${JSON.stringify({ error: '流式读取中断' })}\n\n`);
  }

  // 流结束后，把记录写入 Supabase（异步，不阻塞响应）
  if (SUPABASE_URL && SUPABASE_SERVICE_KEY && fullText) {
    try {
      const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);
      await supabase.from('name_generations').insert({
        user_input: user_input,
        result: fullText,
        model: MODEL
      });
    } catch (dbErr) {
      console.error('Supabase 写入失败:', dbErr);
    }
  }

  res.write('data: [DONE]\n\n');
  res.end();
}
