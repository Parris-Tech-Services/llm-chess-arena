const ENDPOINT = 'https://api.groq.com/openai/v1/chat/completions';
const MODELS = 'https://api.groq.com/openai/v1/models';

export class ProviderError extends Error {
  constructor(message, { status = 0, retryAfterMs = 0 } = {}) {
    super(message);
    this.status = status;
    this.retryAfterMs = retryAfterMs;
  }
}

function retryAfterMs(res) {
  const h = res.headers.get('retry-after');
  if (!h) return 0;
  const secs = Number(h);
  if (Number.isFinite(secs)) return secs * 1000;
  const when = Date.parse(h);
  return Number.isFinite(when) ? Math.max(0, when - Date.now()) : 0;
}

/** Stream one chat completion. Returns { text, tokens, finishReason }. */
export async function streamChat({ key, model, messages, temperature = 0.6, maxTokens = 320, reasoningEffort = null, signal, onDelta }) {
  const res = await fetch(ENDPOINT, {
    method: 'POST',
    signal,
    headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
    body: JSON.stringify({
      model,
      messages,
      temperature,
      max_tokens: maxTokens,
      stream: true,
      ...(reasoningEffort ? { reasoning_effort: reasoningEffort } : {}),
    }),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    const kind = res.status === 401 || res.status === 403 ? 'auth' : res.status === 429 ? 'rate_limit' : 'error';
    const err = new ProviderError(`Groq ${res.status}: ${body.slice(0, 200)}`, {
      status: res.status,
      retryAfterMs: retryAfterMs(res),
    });
    err.kind = kind;
    throw err;
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let text = '';
  let tokens = 0;
  let finishReason = null;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let nl;
    while ((nl = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, nl).trim();
      buffer = buffer.slice(nl + 1);
      if (!line.startsWith('data:')) continue;
      const payload = line.slice(5).trim();
      if (payload === '[DONE]') continue;
      let parsed;
      try { parsed = JSON.parse(payload); } catch { continue; }
      const choice = parsed.choices?.[0];
      const delta = choice?.delta?.content;
      if (delta) {
        text += delta;
        onDelta?.(delta, text);
      }
      if (choice?.finish_reason) finishReason = choice.finish_reason;
      if (parsed.x_groq?.usage) tokens = parsed.x_groq.usage.completion_tokens || tokens;
      else if (parsed.usage) tokens = parsed.usage.completion_tokens || tokens;
    }
  }

  // Reasoning channels are intentionally discarded: private chain-of-thought is
  // never stored or broadcast, only the model's public commentary.
  return { text, tokens, finishReason };
}

export async function listModels(key) {
  const res = await fetch(MODELS, { headers: { authorization: `Bearer ${key}` } });
  if (!res.ok) throw new ProviderError(`Groq models ${res.status}`, { status: res.status });
  const data = await res.json();
  return (data.data || [])
    .map((m) => ({ id: m.id, context: m.context_window || 0, active: m.active !== false }))
    .sort((a, b) => a.id.localeCompare(b.id));
}
