import { config } from '../config.js';

const OPENAI_CHAT_URL = 'https://api.openai.com/v1/chat/completions';

export const streamChatCompletion = async ({
  system,
  user,
  onDelta,
  temperature = 0.2,
  maxTokens = 900
} = {}) => {
  if (config.llmProvider !== 'openai' || !config.openaiApiKey) {
    return null;
  }
  const response = await fetch(OPENAI_CHAT_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${config.openaiApiKey}`
    },
    body: JSON.stringify({
      model: config.llmModel,
      messages: [
        { role: 'system', content: system || 'Return only valid JSON.' },
        { role: 'user', content: user || '' }
      ],
      temperature,
      max_tokens: maxTokens,
      stream: true
    })
  });
  if (!response.ok) {
    const text = await response.text().catch(() => null);
    throw new Error(`OpenAI chat completion failed: ${response.status} ${text || response.statusText}`);
  }
  if (!response.body) {
    throw new Error('OpenAI chat completion response body missing');
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let output = '';
  let done = false;

  const handleDelta = (delta) => {
    if (!delta) return;
    output += delta;
    if (onDelta) {
      try {
        onDelta(delta);
      } catch {
        // ignore delta handler errors
      }
    }
  };

  while (!done) {
    const { value, done: readerDone } = await reader.read();
    if (readerDone) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop() || '';
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed.startsWith('data:')) continue;
      const data = trimmed.slice(5).trim();
      if (!data) continue;
      if (data === '[DONE]') {
        done = true;
        break;
      }
      try {
        const payload = JSON.parse(data);
        const delta = payload?.choices?.[0]?.delta?.content
          || payload?.choices?.[0]?.message?.content
          || '';
        handleDelta(delta);
      } catch {
        // ignore parse errors
      }
    }
  }

  return output;
};
