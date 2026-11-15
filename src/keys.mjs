import fs from 'node:fs';

/** Pool of API keys with health tracking: round-robin, 429 cooldown, 401 disable. */
export class KeyPool {
  constructor(entries) {
    this.keys = entries.map((e, i) => ({
      name: e.name || `key-${i + 1}`,
      key: e.key,
      requests: 0,
      errors: 0,
      tokens: 0,
      cooldownUntil: 0,
      disabled: false,
      lastError: null,
    }));
    this.cursor = 0;
    if (!this.keys.length) throw new Error('KeyPool requires at least one key');
  }

  static fromFile(file) {
    const text = fs.readFileSync(file, 'utf8');
    const entries = [];
    for (const raw of text.split(/\r?\n/)) {
      const line = raw.trim();
      if (!line || line.startsWith('#')) continue;
      const m = line.match(/^([A-Za-z0-9_.\- ]+)\s*[=:]\s*(\S+)$/);
      if (m) entries.push({ name: m[1].trim(), key: m[2].trim() });
      else entries.push({ key: line });
    }
    return new KeyPool(entries);
  }

  get size() { return this.keys.length; }

  next() {
    const now = Date.now();
    const healthy = this.keys.filter((k) => !k.disabled && k.cooldownUntil <= now);
    if (healthy.length) {
      const k = healthy[this.cursor % healthy.length];
      this.cursor = (this.cursor + 1) % Math.max(healthy.length, 1);
      k.requests += 1;
      return k;
    }
    const alive = this.keys.filter((k) => !k.disabled);
    if (!alive.length) throw new Error('All API keys are disabled (401/403)');
    alive.sort((a, b) => a.cooldownUntil - b.cooldownUntil);
    const waitMs = Math.max(0, alive[0].cooldownUntil - now);
    const err = new Error(`All keys rate-limited; next available in ${Math.ceil(waitMs / 1000)}s`);
    err.retryAfterMs = waitMs;
    err.rateLimited = true;
    throw err;
  }

  report(keyRef, outcome) {
    const k = this.keys.find((x) => x.key === keyRef.key);
    if (!k) return;
    if (outcome.status === 'ok') {
      k.cooldownUntil = 0;
      k.tokens += outcome.tokens || 0;
    } else if (outcome.status === 'rate_limit') {
      k.cooldownUntil = Date.now() + (outcome.retryAfterMs || 20_000);
      k.errors += 1;
      k.lastError = 'rate_limit';
    } else if (outcome.status === 'auth') {
      k.disabled = true;
      k.lastError = 'auth';
    } else {
      k.errors += 1;
      k.lastError = outcome.message || 'error';
      k.cooldownUntil = Date.now() + Math.min(60_000, 2 ** Math.min(k.errors, 5) * 1000);
    }
  }

  stats() {
    const now = Date.now();
    return this.keys.map((k) => ({
      name: k.name,
      requests: k.requests,
      tokens: k.tokens,
      errors: k.errors,
      disabled: k.disabled,
      cooling: k.cooldownUntil > now,
      cooldownMs: Math.max(0, k.cooldownUntil - now),
      lastError: k.lastError,
    }));
  }
}
