'use strict';

/* ------------------------------------------------------------------ helpers */
const $ = (id) => document.getElementById(id);
const GLYPH = {
  p: '♟', n: '♞', b: '♝', r: '♜', q: '♛', k: '♚',
  P: '♙', N: '♘', B: '♗', R: '♖', Q: '♕', K: '♔',
};
const FILE = 'abcdefgh';
const prefersReduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

const prefs = {
  theme: 'dark',
  board: 'classic',
  sound: true,
  ...JSON.parse(localStorage.getItem('arena.prefs') || '{}'),
};
function savePrefs() {
  localStorage.setItem('arena.prefs', JSON.stringify(prefs));
  document.documentElement.dataset.theme = prefs.theme;
  document.documentElement.dataset.board = prefs.board;
  $('soundBtn').textContent = prefs.sound ? '🔊' : '🔇';
  $('soundBtn').setAttribute('aria-pressed', String(prefs.sound));
}

const S = {
  config: null,
  state: null,
  feed: [],
  feedGameId: null,
  tab: 'commentary',
  liveReferee: '',
  streams: { w: '', b: '' },
  replay: null,
  viewPly: null, // null follows the newest move; a number freezes the board at that ply
  connected: false,
  finishedHandled: false,
};

/* -------------------------------------------------------------------- sound */
let actx = null;
function blip(kind) {
  if (!prefs.sound) return;
  try {
    actx = actx || new (window.AudioContext || window.webkitAudioContext)();
    const t = actx.currentTime;
    const osc = actx.createOscillator();
    const gain = actx.createGain();
    osc.connect(gain).connect(actx.destination);
    const map = { move: [520, 'sine', 0.05], capture: [190, 'triangle', 0.09], check: [760, 'sine', 0.08], bad: [120, 'sawtooth', 0.09], end: [320, 'sine', 0.25] };
    const [freq, type, dur] = map[kind] || map.move;
    osc.type = type;
    osc.frequency.setValueAtTime(freq, t);
    osc.frequency.exponentialRampToValueAtTime(Math.max(60, freq * 0.7), t + dur);
    gain.gain.setValueAtTime(0.0001, t);
    gain.gain.exponentialRampToValueAtTime(0.16, t + 0.01);
    gain.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    osc.start(t);
    osc.stop(t + dur + 0.02);
  } catch { /* audio is optional */ }
}

/* -------------------------------------------------------------------- board */
function parseFen(fen) {
  const rows = [];
  for (const row of fen.split(' ')[0].split('/')) {
    const out = [];
    for (const ch of row) {
      if (/\d/.test(ch)) out.push(...Array(Number(ch)).fill(null));
      else out.push(ch);
    }
    rows.push(out);
  }
  return rows;
}

function fmtClock(ms) {
  if (ms === null || ms === undefined) return '--:--';
  if (ms <= 0) return '0:00';
  const total = Math.ceil(ms / 1000);
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
}

function findKing(rows, turn) {
  const target = turn === 'w' ? 'K' : 'k';
  for (let r = 0; r < 8; r++) for (let c = 0; c < 8; c++) if (rows[r][c] === target) return FILE[c] + (8 - r);
  return null;
}

function renderBoard(state, animate = false) {
  const board = $('board');
  if (!state) return;
  const rows = parseFen(state.fen);
  const last = state.moves && state.moves.length ? state.moves[state.moves.length - 1] : null;
  const checkSq = state.inCheck ? findKing(rows, state.turn) : null;

  board.innerHTML = '';
  for (let r = 0; r < 8; r++) {
    for (let c = 0; c < 8; c++) {
      const piece = rows[r][c];
      const sq = FILE[c] + (8 - r);
      const el = document.createElement('div');
      el.className = `sq ${(r + c) % 2 === 0 ? 'light' : 'dark'}`;
      el.dataset.sq = sq;
      if (last && (last.from === sq || last.to === sq)) el.classList.add('last');
      if (checkSq === sq) el.classList.add('check');
      if (piece) {
        const span = document.createElement('span');
        span.className = 'pc';
        span.textContent = GLYPH[piece];
        el.appendChild(span);
      }
      if (r === 7) el.insertAdjacentHTML('beforeend', `<span class="coord file">${FILE[c]}</span>`);
      if (c === 0) el.insertAdjacentHTML('beforeend', `<span class="coord rank">${8 - r}</span>`);
      board.appendChild(el);
    }
  }
  board.setAttribute('aria-label', `Chess board, ${state.moves ? state.moves.length : 0} plies played`);
  if (animate && last && !prefersReduced) animateMove(last);
}

function animateMove(move) {
  const board = $('board');
  const from = board.querySelector(`[data-sq="${move.from}"]`);
  const to = board.querySelector(`[data-sq="${move.to}"]`);
  if (!from || !to) return;
  const pieceEl = to.querySelector('.pc');
  if (pieceEl) pieceEl.style.visibility = 'hidden';

  const flyer = document.createElement('div');
  flyer.className = 'sq flyer';
  flyer.style.cssText = `left:${from.offsetLeft}px;top:${from.offsetTop}px;width:${from.offsetWidth}px;height:${from.offsetHeight}px;font-size:${getComputedStyle(from).fontSize}`;
  const glyph = pieceEl ? pieceEl.textContent : '';
  flyer.textContent = glyph || '';
  flyer.style.color = getComputedStyle(to).color;
  board.appendChild(flyer);

  requestAnimationFrame(() => {
    flyer.style.transform = `translate(${to.offsetLeft - from.offsetLeft}px, ${to.offsetTop - from.offsetTop}px)`;
  });
  const done = () => {
    flyer.remove();
    if (pieceEl) pieceEl.style.visibility = '';
  };
  flyer.addEventListener('transitionend', done, { once: true });
  setTimeout(done, 400);
}

/* ------------------------------------------------------------------- render */
function statusInfo(state) {
  if (!state || state.status === 'idle') return { cls: '', text: 'idle' };
  if (state.status === 'playing') return { cls: 'live', text: 'live' };
  if (state.status === 'paused') return { cls: 'paused', text: state.interrupted ? 'interrupted' : 'paused' };
  if (state.status === 'finished') return { cls: 'done', text: state.result === 'aborted' ? 'stopped' : 'finished' };
  return { cls: '', text: state.status };
}

function moveHistory(state) {
  const fens = state?.fens || S.replay?.fens || [];
  const total = state?.moves?.length || 0;
  return { fens, total, available: fens.length >= total + 1 };
}

function viewedPly(state) {
  const { total } = moveHistory(state);
  return S.viewPly === null ? total : Math.max(0, Math.min(total, S.viewPly));
}

// Navigation only changes the spectator's displayed position, never the live game.
function navigateTo(ply) {
  const { total, available } = moveHistory(S.state);
  if (!available) return;
  S.viewPly = ply >= total ? null : Math.max(0, ply);
  renderPosition(false);
  renderMoves(S.state);
}

function renderPosition(animate = false) {
  if (!S.state) return;
  const { fens, total, available } = moveHistory(S.state);
  const index = viewedPly(S.state);
  const moves = S.state.moves || [];
  if (available) {
    const shown = moves.slice(0, index);
    const atEnd = index === total;
    const lastSan = shown.at(-1)?.san || '';
    renderBoard({
      ...S.state,
      fen: fens[index],
      moves: shown,
      turn: index % 2 === 0 ? 'w' : 'b',
      inCheck: atEnd ? S.state.inCheck || /[+#]$/.test(lastSan) : /[+#]$/.test(lastSan),
    }, animate && atEnd);
  } else {
    renderBoard(S.state, animate);
  }
  $('moveSlider').max = String(total);
  $('moveSlider').value = String(index);
  $('moveSlider').disabled = !available || total === 0;
  $('moveBackBtn').disabled = !available || index === 0;
  $('moveForwardBtn').disabled = !available || index >= total;
  $('moveLiveBtn').disabled = !available || S.viewPly === null;
  const last = moves[index - 1];
  const moveLabel = last ? `${Math.floor((index - 1) / 2) + 1}${last.side === 'w' ? '.' : '…'} ${last.san}` : 'Starting position';
  $('movePosition').textContent = `${index} / ${total} · ${moveLabel}${index < total ? ' · LIVE CONTINUES' : ' · Latest'}`;
  $('movePosition').classList.toggle('behind', index < total);
}

function renderStatus(state) {
  const info = statusInfo(state);
  const pill = $('statusPill');
  pill.className = `pill ${info.cls}`;
  pill.textContent = info.text;
}

function renderPlayers(state) {
  const p = state.players || {};
  $('nameW').textContent = p.w?.name || 'White';
  $('nameB').textContent = p.b?.name || 'Black';
  $('avatarW').textContent = initials(p.w?.name || 'White');
  $('avatarB').textContent = initials(p.b?.name || 'Black');
  $('modelW').textContent = p.w?.model || 'not set';
  $('modelB').textContent = p.b?.model || 'not set';
  $('playerW').classList.toggle('active', state.status === 'playing' && state.turn === 'w');
  $('playerB').classList.toggle('active', state.status === 'playing' && state.turn === 'b');
  $('clockW').textContent = state.timeControl?.baseMs ? fmtClock(state.clocks?.w) : '∞';
  $('clockB').textContent = state.timeControl?.baseMs ? fmtClock(state.clocks?.b) : '∞';
  $('clockW').classList.toggle('low', !!state.timeControl?.baseMs && state.clocks?.w < 20000);
  $('clockB').classList.toggle('low', !!state.timeControl?.baseMs && state.clocks?.b < 20000);
}

function initials(name) {
  return String(name).replace(/[^A-Za-z0-9 ]/g, ' ').trim().split(/\s+/).slice(0, 2).map((w) => w[0]).join('').toUpperCase() || 'AI';
}

function renderFeed() {
  const feed = $('feed');
  const empty = $('commentaryEmpty');
  if (!S.feed.length) {
    empty.hidden = false;
    feed.innerHTML = '';
    return;
  }
  empty.hidden = true;
  const nearBottom = true;
  feed.innerHTML = S.feed.slice(-120).map((row) => {
    const tagCls = row.tagClass || '';
    return `<div class="row">
      <div class="tag ${tagCls}">${row.tag}</div>
      <div>
        <div class="txt ${row.dim ? 'dim' : ''}">${esc(row.text)}</div>
        ${row.meta ? `<div class="meta">${esc(row.meta)}</div>` : ''}
      </div>
    </div>`;
  }).join('');
  if (nearBottom) document.getElementById('tabCommentary').scrollTop = 1e6;
}

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function rebuildFeed(state) {
  S.feed = [];
  const moves = state.moves || [];
  const refs = state.refereeLog || [];
  const rej = state.rejections || [];
  const items = [];
  moves.forEach((m, i) => items.push({ at: i * 2, kind: 'move', m }));
  refs.forEach((r) => items.push({ at: (r.moveNumber || 1) * 2 - 1, kind: 'ref', r }));
  rej.forEach((r) => items.push({ at: (r.moveNumber || 1) * 2 - 0.5, kind: 'rej', r }));
  items.sort((a, b) => a.at - b.at);
  for (const it of items) {
    if (it.kind === 'move') {
      S.feed.push({
        tag: it.m.side === 'w' ? 'W' : 'B',
        tagClass: it.m.side,
        text: it.m.think || it.m.san,
        meta: `${Math.floor((it.m.n - 1) / 2) + 1}${it.m.side === 'w' ? '.' : '…'} ${it.m.san}${it.m.ms ? ` · ${(it.m.ms / 1000).toFixed(1)}s` : ''}`,
      });
    } else if (it.kind === 'ref') {
      S.feed.push({ tag: 'REF', tagClass: 'ref', text: it.r.text, meta: it.r.kind === 'ruling' ? 'ruling' : `move ${it.r.moveNumber}` });
    } else {
      S.feed.push({ tag: '!', tagClass: 'bad', text: it.r.reason, meta: `${it.r.side === 'w' ? 'White' : 'Black'} attempt rejected` });
    }
  }
  renderFeed();
}

function pushFeed(row) {
  S.feed.push(row);
  renderFeed();
}

function renderMoves(state) {
  const box = $('movelist');
  const moves = state?.moves || [];
  if (!moves.length) {
    box.innerHTML = '<div class="empty">No moves yet.</div>';
    return;
  }
  const selected = viewedPly(state);
  box.innerHTML = moves.map((m, i) => `<div class="mv${i + 1 === selected ? ' viewed' : ''}" data-ply="${i + 1}">
      <span class="no">${m.side === 'w' ? Math.floor(i / 2) + 1 + '.' : ''}</span>
      <span class="san">${esc(m.san)}</span>
      <span class="why" title="${esc(m.think || '')}">${esc(m.think || '')}</span>
    </div>`).join('');
}

function updateControls(state) {
  const playing = state.status === 'playing';
  const paused = state.status === 'paused';
  const idle = state.status === 'idle';
  const over = state.status === 'finished';
  const busy = playing || paused;
  $('startBtn').disabled = busy;
  $('startBtn').hidden = busy;
  $('pauseBtn').disabled = !playing;
  $('pauseBtn').hidden = !playing;
  $('resumeBtn').disabled = !paused;
  $('resumeBtn').hidden = !paused;
  $('stopBtn').disabled = !busy;
  $('stopBtn').hidden = !busy;
  $('rematchBtn').disabled = !over || !state.players.w.model;
  $('newBtn').disabled = idle;
  document.querySelectorAll('#setupCard select').forEach((s) => { s.disabled = busy; });
}

function renderVerdict(state) {
  const card = $('resultCard');
  const finished = state.status === 'finished' && state.result && state.result !== 'aborted';
  if (!finished) { card.hidden = true; return; }
  card.hidden = false;
  const label = state.result === 'draw' ? 'Draw'
    : state.result === 'w-wins' ? `${state.players.w.name} wins`
    : state.result === 'b-wins' ? `${state.players.b.name} wins`
    : state.result;
  $('resultBig').textContent = label;
  $('resultReason').textContent = state.reason || '';
  const v = state.verdict;
  const parts = [];
  if (v?.summary) parts.push(`<div>${esc(v.summary)}</div>`);
  if (v?.note) parts.push(`<div>${esc(v.note)}</div>`);
  if (v?.playerOfMatch) parts.push(`<div class="potm">★ Player of the match: ${esc(v.playerOfMatch)}</div>`);
  if (v?.mismatch) parts.push('<div style="color:var(--warn)">Referee disagreed with the rules engine — the engine result stands.</div>');
  if (v?.conduct && v.conduct !== 'clean') parts.push(`<div>Conduct: ${esc(v.conduct)}</div>`);
  $('resultVerdict').innerHTML = parts.join('') || '<div class="empty">Referee is preparing the summary…</div>';

  const pgn = state.pgn || '';
  const blob = new Blob([pgn], { type: 'application/x-chess-pgn' });
  const url = URL.createObjectURL(blob);
  const link = $('pgnLink');
  if (link.dataset.url) URL.revokeObjectURL(link.dataset.url);
  link.href = url;
  link.dataset.url = url;
  link.download = `llm-chess-${state.id || 'game'}.pgn`;
}

function renderAll(animate = false) {
  const state = S.state;
  if (!state) return;
  renderStatus(state);
  renderPlayers(state);
  renderPosition(animate);
  renderMoves(state);
  updateControls(state);
  renderVerdict(state);
}

/* --------------------------------------------------------------------- tabs */
function setTab(tab) {
  S.tab = tab;
  document.querySelectorAll('.tab').forEach((t) => t.setAttribute('aria-selected', String(t.dataset.tab === tab)));
  for (const name of ['commentary', 'moves', 'standings', 'games']) {
    $(`tab${name[0].toUpperCase()}${name.slice(1)}`).hidden = name !== tab;
  }
  if (tab === 'standings') loadStandings();
  if (tab === 'games') loadGames();
}

/* --------------------------------------------------------------------- data */
async function fetchJson(url, opts) {
  const res = await fetch(url, opts);
  if (!res.ok) {
    let msg = `${res.status}`;
    try { msg = (await res.json()).error || msg; } catch { /* ignore */ }
    throw new Error(msg);
  }
  return res.json();
}

async function loadConfig() {
  try {
    S.config = await fetchJson('/api/config');
    const models = S.config.models || [];
    const fill = (sel, value) => {
      sel.innerHTML = models.map((m) => `<option value="${esc(m.id)}">${esc(m.id)}</option>`).join('')
        || '<option value="mock">mock</option>';
      if (value && models.some((m) => m.id === value)) sel.value = value;
    };
    fill($('whiteModel'), S.config.defaults.white);
    fill($('blackModel'), S.config.defaults.black);
    fill($('refereeModel'), S.config.defaults.referee);
    refreshKeys();
  } catch (err) {
    showBanner(`Could not load model catalogue: ${err.message}`);
    $('keyText').textContent = 'provider unavailable';
    $('keyLed').className = 'led bad';
  }
}

async function refreshKeys() {
  try {
    const k = await fetchJson('/api/keys');
    const led = $('keyLed');
    if (k.mode === 'cloudflare-ai') {
      led.className = 'led';
      $('keyText').textContent = 'Cloudflare AI · hosted live models';
      return;
    }
    if (k.mode === 'mock') {
      led.className = 'led mock';
      $('keyText').textContent = 'mock mode — random legal bots';
      return;
    }
    led.className = k.available > 0 ? 'led' : 'led bad';
    $('keyText').textContent = `${k.available}/${k.total} keys ready${k.cooling ? ` · ${k.cooling} cooling` : ''}${k.disabled ? ` · ${k.disabled} disabled` : ''}`;
  } catch { /* non-fatal */ }
}

async function loadStandings() {
  const box = $('standings');
  try {
    const s = await fetchJson('/api/standings');
    if (!s.rows.length) {
      box.innerHTML = '<div class="empty">No completed games yet. Ratings are calculated only from real results.</div>';
      return;
    }
    box.innerHTML = `<table class="tbl">
      <thead><tr><th>#</th><th>Model</th><th>Elo</th><th>G</th><th>W</th><th>D</th><th>L</th><th>Legal</th><th>ms</th></tr></thead>
      <tbody>${s.rows.map((r, i) => `<tr>
        <td>${i + 1}</td>
        <td class="model" title="${esc(r.model)}">${esc(r.model)}</td>
        <td>${r.rating}</td>
        <td>${r.games}</td>
        <td>${r.wins}</td>
        <td>${r.draws}</td>
        <td>${r.losses}</td>
        <td>${r.legalMoveRate === null ? '—' : r.legalMoveRate + '%'}</td>
        <td>${r.avgLatencyMs ?? '—'}</td>
      </tr>`).join('')}</tbody></table>
      <p class="hint" style="margin-top:10px">${s.totalGames} completed game${s.totalGames === 1 ? '' : 's'} · Elo K=24, start 1200.</p>`;
  } catch (err) {
    box.innerHTML = `<div class="empty">Could not load standings: ${esc(err.message)}</div>`;
  }
}

async function loadGames() {
  const box = $('games');
  try {
    const { games } = await fetchJson('/api/games');
    if (!games.length) {
      box.innerHTML = '<div class="empty">No completed games yet.</div>';
      return;
    }
    box.innerHTML = `<table class="tbl"><thead><tr><th>Match</th><th>Result</th><th></th></tr></thead><tbody>
      ${games.map((g) => `<tr>
        <td class="model">${esc(short(g.players.w.model))}<br><span style="color:var(--faint)">vs</span> ${esc(short(g.players.b.model))}</td>
        <td>${esc(g.result || g.status)}<br><span style="color:var(--faint);font-size:11px">${g.plies} plies</span></td>
        <td><a href="/g/${esc(g.id)}">watch</a></td>
      </tr>`).join('')}</tbody></table>`;
  } catch (err) {
    box.innerHTML = `<div class="empty">Could not load games: ${esc(err.message)}</div>`;
  }
}

const short = (m) => String(m || '').split('/').pop();

function showBanner(text) {
  const b = $('banner');
  b.textContent = text;
  b.classList.toggle('show', Boolean(text));
}

function toast(text) {
  const t = $('toast');
  t.textContent = text;
  t.classList.add('show');
  clearTimeout(t._timer);
  t._timer = setTimeout(() => t.classList.remove('show'), 2600);
}

/* ---------------------------------------------------------------------- SSE */
let es = null;
let pollTimer = null;
let lastEventAt = 0;
let watchdog = null;

/**
 * SSE is the fast path, but some proxies buffer event streams completely.
 * If nothing arrives quickly, fall back to state polling so the arena still
 * works everywhere (moves, clocks, commentary and referee arrive per poll).
 */
function startPolling() {
  if (pollTimer) return;
  if (es) { es.close(); es = null; }
  S.connected = true;
  S.polling = true;
  showBanner('');
  const tick = async () => {
    try {
      const state = await fetchJson('/api/state');
      handleEvent({ type: 'state', state });
    } catch {
      showBanner('Connection lost — retrying…');
    }
  };
  tick();
  pollTimer = setInterval(tick, 1500);
}

function connect() {
  if (es) es.close();
  lastEventAt = Date.now();
  es = new EventSource('/events');
  es.onopen = () => {
    S.connected = true;
    if (!S.polling) showBanner('');
  };
  es.onerror = () => {
    S.connected = false;
    if (!S.polling) showBanner('Connection lost — reconnecting…');
    // Repeated failures: switch transport rather than spin.
    if (Date.now() - lastEventAt > 8000) startPolling();
  };
  es.onmessage = (msg) => {
    lastEventAt = Date.now();
    if (S.polling) return;
    let e;
    try { e = JSON.parse(msg.data); } catch { return; }
    handleEvent(e);
  };
  clearTimeout(watchdog);
  watchdog = setTimeout(() => {
    if (Date.now() - lastEventAt > 4500 && !S.polling) startPolling();
  }, 5000);
}

function handleEvent(e) {
  if (e.type === 'state') {
    const prev = S.state;
    S.state = e.state;
    const isNewGame = !prev || prev.id !== e.state.id;
    // Polling transports deliver moves inside the snapshot rather than as
    // 'move' events, so keep the feed and sound in sync from state alone.
    if (!isNewGame && prev && e.state.moves.length !== prev.moves.length) {
      const grew = e.state.moves.length > prev.moves.length;
      if (grew) {
        const m = e.state.moves[e.state.moves.length - 1];
        blip(m.captured ? 'capture' : m.san.includes('+') || m.san.includes('#') ? 'check' : 'move');
      }
      rebuildFeed(e.state);
      renderMoves(e.state);
      if (e.state.status === 'playing') {
        const modelEl = e.state.turn === 'w' ? $('modelW') : $('modelB');
        if (modelEl) modelEl.textContent = e.state.players[e.state.turn]?.model || '';
      }
    }
    if (isNewGame) {
      S.viewPly = null;
      S.feed = [];
      S.finishedHandled = false;
      rebuildFeed(e.state);
      $('resultCard').hidden = true;
    }
    renderAll(Boolean(prev && prev.moves.length < e.state.moves.length));
    if (e.state.status === 'finished' && !S.finishedHandled) {
      S.finishedHandled = true;
      blip('end');
      if (e.state.result !== 'aborted') {
        loadStandings();
        loadGames();
      }
    }
    return;
  }
  if (e.type === 'tick') {
    $('clockW').textContent = S.state?.timeControl?.baseMs ? fmtClock(e.clocks.w) : '∞';
    $('clockB').textContent = S.state?.timeControl?.baseMs ? fmtClock(e.clocks.b) : '∞';
    return;
  }
  if (e.type === 'turn') {
    const el = e.side === 'w' ? $('playerW') : $('playerB');
    document.querySelectorAll('.player').forEach((p) => p.classList.remove('active'));
    el.classList.add('active');
    const modelEl = e.side === 'w' ? $('modelW') : $('modelB');
    modelEl.textContent = 'thinking…';
    modelEl.style.color = 'var(--accent)';
    return;
  }
  if (e.type === 'stream') {
    if (e.kind === 'commentary') {
      const modelEl = e.side === 'w' ? $('modelW') : $('modelB');
      modelEl.textContent = (e.full || '').replace(/\s+/g, ' ').slice(-90);
    } else if (e.kind === 'referee') {
      S.liveReferee = e.full || '';
      let row = document.getElementById('liveRefRow');
      if (!row) {
        row = document.createElement('div');
        row.id = 'liveRefRow';
        row.className = 'row';
        row.innerHTML = '<div class="tag ref">REF</div><div><div class="txt dim" id="liveRefText"></div></div>';
        $('feed').prepend(row);
        $('commentaryEmpty').hidden = true;
      }
      $('liveRefText').textContent = S.liveReferee;
    }
    return;
  }
  if (e.type === 'move') {
    S.state = e.state;
    const p = e.move.side === 'w' ? $('modelW') : $('modelB');
    p.textContent = S.state.players[e.move.side]?.model || '';
    p.style.color = '';
    renderAll(true);
    if (e.move.captured) blip('capture');
    else if (e.move.san.includes('+') || e.move.san.includes('#')) blip('check');
    else blip('move');
    pushFeed({
      tag: e.move.side === 'w' ? 'W' : 'B',
      tagClass: e.move.side,
      text: e.move.think || e.move.san,
      meta: `${Math.floor((e.move.n - 1) / 2) + 1}${e.move.side === 'w' ? '.' : '…'} ${e.move.san}${e.move.ms ? ` · ${(e.move.ms / 1000).toFixed(1)}s` : ''}`,
    });
    return;
  }
  if (e.type === 'rejection') {
    blip('bad');
    pushFeed({ tag: '!', tagClass: 'bad', text: e.reason, meta: `${e.side === 'w' ? 'White' : 'Black'} attempt rejected` });
    showBanner(`Rejected move: ${e.reason}`);
    setTimeout(() => showBanner(''), 4000);
    return;
  }
  if (e.type === 'referee') {
    const row = document.getElementById('liveRefRow');
    if (row) row.remove();
    pushFeed({ tag: 'REF', tagClass: 'ref', text: e.entry.text, meta: e.entry.kind === 'ruling' ? 'ruling' : `move ${e.entry.moveNumber}` });
    return;
  }
  if (e.type === 'verdict') {
    if (S.state) { S.state.verdict = e.verdict; renderVerdict(S.state); }
    return;
  }
  if (e.type === 'log') {
    pushFeed({ tag: '·', tagClass: '', text: e.text, dim: true });
    return;
  }
}

/* ------------------------------------------------------------------ actions */
async function post(url, body) {
  try {
    const res = await fetchJson(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined,
    });
    return res;
  } catch (err) {
    toast(err.message);
    return null;
  }
}

function currentSetup() {
  const [base, inc] = $('clockSel').value.split(',').map(Number);
  return {
    white: { model: $('whiteModel').value, name: short($('whiteModel').value) },
    black: { model: $('blackModel').value, name: short($('blackModel').value) },
    referee: { model: $('refereeModel').value, name: short($('refereeModel').value) },
    timeControl: { baseMs: base, incrementMs: inc },
    pace: Number($('paceSel').value),
  };
}

$('startBtn').onclick = async () => {
  $('resultCard').hidden = true;
  showBanner('');
  const r = await post('/api/start', currentSetup());
  if (r) toast(`Match started · ${short(r.white.model)} vs ${short(r.black.model)}`);
};
$('pauseBtn').onclick = () => post('/api/pause');
$('resumeBtn').onclick = async () => {
  const r = await post('/api/resume');
  if (r && !r.resumed) await post('/api/resume-interrupted');
};
$('stopBtn').onclick = () => post('/api/stop');
$('rematchBtn').onclick = async () => {
  const r = await post('/api/rematch');
  if (r) toast('Rematch — colours swapped');
};
$('newBtn').onclick = async () => {
  await post('/api/new');
  S.feed = [];
  rebuildFeed({ moves: [], refereeLog: [], rejections: [] });
  $('resultCard').hidden = true;
  toast('Ready for a new match');
};

$('themeBtn').onclick = () => {
  prefs.theme = prefs.theme === 'dark' ? 'light' : 'dark';
  savePrefs();
};
$('soundBtn').onclick = () => {
  prefs.sound = !prefs.sound;
  savePrefs();
  if (prefs.sound) blip('move');
};
$('fullBtn').onclick = () => {
  if (document.fullscreenElement) document.exitFullscreen();
  else document.documentElement.requestFullscreen?.().catch(() => toast('Fullscreen not available'));
};
$('shareBtn').onclick = async () => {
  const id = S.state?.id;
  const url = id ? `${location.origin}/g/${id}` : location.href;
  try {
    await navigator.clipboard.writeText(url);
    toast('Share link copied');
  } catch {
    toast(url);
  }
};
$('moveBackBtn').onclick = () => navigateTo(viewedPly(S.state) - 1);
$('moveForwardBtn').onclick = () => navigateTo(viewedPly(S.state) + 1);
$('moveLiveBtn').onclick = () => navigateTo(moveHistory(S.state).total);
$('moveSlider').oninput = () => navigateTo(Number($('moveSlider').value));
$('movelist').onclick = (e) => {
  const row = e.target.closest('[data-ply]');
  if (row) navigateTo(Number(row.dataset.ply));
};
$('boardSel').onchange = () => { prefs.board = $('boardSel').value; savePrefs(); };
document.querySelectorAll('.tab').forEach((t) => { t.onclick = () => setTab(t.dataset.tab); });

/* -------------------------------------------------------------------- replay */
async function initReplay(id) {
  $('setupCard').hidden = true;
  $('controls').innerHTML = '';
  try {
    const game = await fetchJson(`/api/games/${id}`);
    S.replay = game;
    S.viewPly = null;
    S.state = {
      status: 'finished',
      fen: game.fen,
      pgn: game.pgn,
      moves: game.moves,
      fens: game.fens,
      players: game.players,
      result: game.result,
      reason: game.reason,
      verdict: game.verdict,
      refereeLog: game.refereeLog,
      rejections: game.rejections,
      clocks: game.clocks,
      timeControl: game.timeControl,
      turn: 'w',
      inCheck: false,
      id: game.id,
    };
    rebuildFeed(S.state);
    renderStatus(S.state);
    renderPlayers(S.state);
    renderMoves(S.state);
    renderVerdict(S.state);
    renderPosition(false);
    $('statusPill').className = 'pill done';
    $('statusPill').textContent = 'replay';
  } catch (err) {
    $('board').innerHTML = `<div class="empty" style="grid-column:1/9;align-self:center">Could not load game ${esc(id)}: ${esc(err.message)}</div>`;
  }
}

/* ---------------------------------------------------------------------- boot */
savePrefs();
$('boardSel').value = prefs.board;
if (location.pathname.startsWith('/g/')) {
  initReplay(location.pathname.slice(3).replace(/\/$/, ''));
} else {
  loadConfig();
  connect();
  setInterval(refreshKeys, 20000);
}
window.addEventListener('beforeunload', () => {
  if (es) es.close();
  if (pollTimer) clearInterval(pollTimer);
});
