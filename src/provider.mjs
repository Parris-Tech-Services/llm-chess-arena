import { streamChat } from './groq.mjs';

const sleep = (ms, signal) => new Promise((resolve, reject) => {
  if (signal?.aborted) return reject(signal.reason || new Error('aborted'));
  const timer = setTimeout(finish, ms);
  function finish() { signal?.removeEventListener('abort', abort); resolve(); }
  function abort() { clearTimeout(timer); signal?.removeEventListener('abort', abort); reject(signal.reason || new Error('aborted')); }
  signal?.addEventListener('abort', abort, { once: true });
});
const isBudgetError = (err) =>
  err?.status === 429 && /max_tokens|request too large|output tokens per minute|OTPM/i.test(err.message || '');

/**
 * Wraps a KeyPool into the generate() interface the arena uses.
 * Rotates keys, honours Retry-After, and shrinks the completion budget when a
 * free-tier account rejects the request size outright.
 */
export function createGroqProvider(pool, { maxAttemptsPerMove = 6 } = {}) {
  return {
    pool,
    async generate({ model, messages, temperature = 0.6, maxTokens = 900, reasoningEffort = null, signal, onDelta }) {
      let lastErr;
      let budget = maxTokens;
      let attempts = 0;
      while (attempts < maxAttemptsPerMove) {
        if (signal?.aborted) throw new Error('aborted');
        let key;
        try {
          key = pool.next();
        } catch (err) {
          const wait = Math.min(err.retryAfterMs ?? 5000, 30_000);
          if (wait <= 0) throw err;
          await sleep(wait, signal);
          lastErr = err;
          attempts += 1;
          continue;
        }
        try {
          const res = await streamChat({ key: key.key, model, messages, temperature, maxTokens: budget, reasoningEffort, signal, onDelta });
          pool.report(key, { status: 'ok', tokens: res.tokens });
          return res;
        } catch (err) {
          if (err.name === 'AbortError' || signal?.aborted) throw err;
          if (isBudgetError(err) && budget > 256) {
            budget = Math.max(256, Math.floor(budget / 2));
            pool.report(key, { status: 'ok' });
            lastErr = err;
            continue;
          }
          pool.report(key, { status: err.kind || 'error', retryAfterMs: err.retryAfterMs, message: err.message });
          lastErr = err;
          attempts += 1;
          await sleep(250 * attempts, signal);
        }
      }
      throw lastErr || new Error('no key could serve the request');
    },
  };
}
