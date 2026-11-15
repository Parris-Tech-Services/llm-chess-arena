import fs from 'node:fs/promises';
import path from 'node:path';

/** Small JSON store with atomic writes. No database, no native deps. */
export class Store {
  constructor(dir) {
    this.dir = dir;
    this.gamesDir = path.join(dir, 'games');
    this.resultsFile = path.join(dir, 'results.json');
    this.results = [];
  }

  async init() {
    await fs.mkdir(this.gamesDir, { recursive: true });
    try {
      this.results = JSON.parse(await fs.readFile(this.resultsFile, 'utf8'));
    } catch {
      this.results = [];
    }
  }

  async atomicWrite(file, data) {
    const tmp = `${file}.${process.pid}.tmp`;
    await fs.writeFile(tmp, data);
    await fs.rename(tmp, file);
  }

  async saveGame(record) {
    await this.atomicWrite(path.join(this.gamesDir, `${record.id}.json`), JSON.stringify(record));
  }

  async getGame(id) {
    if (!/^[a-zA-Z0-9_-]{4,40}$/.test(id)) return null;
    try {
      return JSON.parse(await fs.readFile(path.join(this.gamesDir, `${id}.json`), 'utf8'));
    } catch {
      return null;
    }
  }

  /** Newest first, summaries only (no move lists). */
  async listGames(limit = 60) {
    const files = (await fs.readdir(this.gamesDir)).filter((f) => f.endsWith('.json'));
    const stats = await Promise.all(
      files.map(async (f) => {
        const full = path.join(this.gamesDir, f);
        const st = await fs.stat(full).catch(() => null);
        return st ? { f, mtime: st.mtimeMs } : null;
      }),
    );
    const sorted = stats.filter(Boolean).sort((a, b) => b.mtime - a.mtime).slice(0, limit);
    const out = [];
    for (const { f } of sorted) {
      try {
        const g = JSON.parse(await fs.readFile(path.join(this.gamesDir, f), 'utf8'));
        out.push({
          id: g.id,
          status: g.status,
          result: g.result,
          reason: g.reason,
          players: g.players,
          plies: g.moves?.length || 0,
          startedAt: g.startedAt,
          finishedAt: g.finishedAt,
        });
      } catch { /* skip corrupt */ }
    }
    return out;
  }

  /** The most recent game that was still in progress when the process died. */
  async findInterrupted() {
    const games = await this.listGames(12);
    const live = games.find((g) => g.status === 'playing' || g.status === 'paused');
    return live ? this.getGame(live.id) : null;
  }

  async addResult(record) {
    this.results.push(record);
    await this.atomicWrite(this.resultsFile, JSON.stringify(this.results, null, 0));
  }

  /** Replace the trailing result for a game id (idempotent re-saves). */
  async upsertResult(record) {
    const i = this.results.findIndex((r) => r.gameId === record.gameId);
    if (i >= 0) this.results[i] = record;
    else this.results.push(record);
    await this.atomicWrite(this.resultsFile, JSON.stringify(this.results, null, 0));
  }
}
