'use strict';

const path = require('path');
const fs = require('fs');
const http = require('http');
const express = require('express');
const compression = require('compression');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const { Server } = require('socket.io');
const Database = require('better-sqlite3');
const { nanoid } = require('nanoid');

const PORT = parseInt(process.env.PORT || '8080', 10);
const HOST = process.env.HOST || '0.0.0.0';
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const DB_PATH = path.join(DATA_DIR, 'omoggle.db');
const PFP_DIR = path.join(DATA_DIR, 'pfps');

if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
if (!fs.existsSync(PFP_DIR)) fs.mkdirSync(PFP_DIR, { recursive: true });

const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('synchronous = NORMAL');

db.exec(`
  CREATE TABLE IF NOT EXISTS players (
    id TEXT PRIMARY KEY,
    handle TEXT NOT NULL,
    elo INTEGER NOT NULL DEFAULT 1000,
    psl REAL,
    wins INTEGER NOT NULL DEFAULT 0,
    losses INTEGER NOT NULL DEFAULT 0,
    draws INTEGER NOT NULL DEFAULT 0,
    mogs INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL,
    last_seen INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_players_elo ON players(elo DESC);
  CREATE INDEX IF NOT EXISTS idx_players_mogs ON players(mogs DESC);

  CREATE TABLE IF NOT EXISTS matches (
    id TEXT PRIMARY KEY,
    a_id TEXT NOT NULL,
    b_id TEXT NOT NULL,
    a_psl REAL,
    b_psl REAL,
    winner TEXT,
    a_elo_delta INTEGER,
    b_elo_delta INTEGER,
    mode TEXT NOT NULL DEFAULT 'ranked',
    started_at INTEGER NOT NULL,
    ended_at INTEGER
  );
  CREATE INDEX IF NOT EXISTS idx_matches_ended ON matches(ended_at DESC);
`);

// migrations — adding columns to a table that may already exist
for (const sql of [
  `ALTER TABLE players ADD COLUMN handle_lower TEXT`,
  `ALTER TABLE players ADD COLUMN has_pfp INTEGER NOT NULL DEFAULT 0`,
  `ALTER TABLE matches ADD COLUMN mode TEXT NOT NULL DEFAULT 'ranked'`,
  `UPDATE players SET handle_lower = LOWER(handle) WHERE handle_lower IS NULL`,
  `CREATE INDEX IF NOT EXISTS idx_players_handle_lower ON players(handle_lower)`,
]) {
  try { db.exec(sql); } catch (e) {
    if (!/duplicate column|already exists/i.test(e.message)) throw e;
  }
}

// ---------- moderation ----------
// Bans the obvious slurs and explicit terms. Far from comprehensive — this is a
// first line, paired with the runtime `match:report` flow for human review.
const BANNED_WORDS = [
  'nigger','nigga','negr0','niqqer','faggot','fagot','tranny','retard','retarded',
  'spic','chink','kike','dyke','gook','wetback','beaner','sandnigger','coon',
  'porn','penis','vagina','dick','cock','cunt','pussy','rape','rapist',
  'pedo','pedophile','molest','molester','incest','bestiality','zoophile',
  'kys','suicide','killyourself',
  'hitler','nazi','heilhitler','kkk','klan','isis','alqaeda',
  'admin','administrator','root','staff','moderator','mod','omoggle','official','support',
];
// build a regex that tolerates basic substitutions (a/@/4, e/3, i/1/!, o/0, s/5/$, etc.)
const LETTER_SUBS = {
  a: '[a@4]', b: '[b8]', e: '[e3]', g: '[g69]', i: '[i1!|]', l: '[l1|]',
  o: '[o0]', s: '[s5$]', t: '[t7]', z: '[z2]',
};
function patternFor(word) {
  let p = '';
  for (const ch of word) {
    const low = ch.toLowerCase();
    p += LETTER_SUBS[low] || (low.match(/[a-z]/) ? low : `\\${ch}`);
    p += '[\\W_]*';  // tolerate separator chars between letters
  }
  return new RegExp(p, 'i');
}
const BANNED_PATTERNS = BANNED_WORDS.map(patternFor);
function isInappropriateHandle(name) {
  for (const re of BANNED_PATTERNS) if (re.test(name)) return true;
  return false;
}

const HANDLE_RE = /^[A-Za-z0-9_\-]{3,20}$/;
function validateHandle(raw) {
  if (typeof raw !== 'string') return { error: 'invalid' };
  const trimmed = raw.trim();
  if (trimmed.length < 3)  return { error: 'too_short' };
  if (trimmed.length > 20) return { error: 'too_long' };
  if (!HANDLE_RE.test(trimmed)) return { error: 'bad_chars' };
  if (isInappropriateHandle(trimmed)) return { error: 'inappropriate' };
  return { ok: true, handle: trimmed };
}

// ---------- rank tiers ----------
// kept server-side so APIs return a canonical tier next to elo
function rankTier(elo) {
  if (elo < 800)  return 'bronze';
  if (elo < 1000) return 'silver';
  if (elo < 1200) return 'gold';
  if (elo < 1400) return 'platinum';
  if (elo < 1600) return 'diamond';
  if (elo < 1800) return 'master';
  return 'state-mogger';
}

// ---------- queries ----------
const queries = {
  getPlayer: db.prepare('SELECT * FROM players WHERE id = ?'),
  getPlayerByHandle: db.prepare('SELECT * FROM players WHERE handle_lower = ?'),
  insertPlayer: db.prepare(`
    INSERT INTO players (id, handle, handle_lower, elo, created_at, last_seen)
    VALUES (@id, @handle, @handle_lower, 1000, @now, @now)
  `),
  setHandle: db.prepare(`
    UPDATE players SET handle = @handle, handle_lower = @handle_lower, last_seen = @now WHERE id = @id
  `),
  touchPlayer: db.prepare(`UPDATE players SET last_seen = @now WHERE id = @id`),
  setHasPfp: db.prepare(`UPDATE players SET has_pfp = @v WHERE id = @id`),
  updatePsl: db.prepare('UPDATE players SET psl = @psl, last_seen = @now WHERE id = @id'),
  applyResult: db.prepare(`
    UPDATE players
       SET elo = elo + @delta,
           wins = wins + @win,
           losses = losses + @loss,
           draws = draws + @draw,
           mogs = mogs + @mog,
           last_seen = @now
     WHERE id = @id
  `),
  insertMatch: db.prepare(`
    INSERT INTO matches (id, a_id, b_id, mode, started_at)
    VALUES (@id, @a, @b, @mode, @now)
  `),
  finishMatch: db.prepare(`
    UPDATE matches
       SET a_psl = @aPsl, b_psl = @bPsl, winner = @winner,
           a_elo_delta = @aDelta, b_elo_delta = @bDelta, ended_at = @now
     WHERE id = @id
  `),
  topElo: db.prepare(`
    SELECT id, handle, elo, psl, wins, losses, draws, mogs, has_pfp
      FROM players
     WHERE wins + losses + draws > 0
     ORDER BY elo DESC, mogs DESC
     LIMIT ?
  `),
  topMogs: db.prepare(`
    SELECT id, handle, elo, psl, mogs, wins, losses, draws, has_pfp
      FROM players
     ORDER BY mogs DESC, elo DESC
     LIMIT ?
  `),
  stats: db.prepare(`
    SELECT
      (SELECT COUNT(*) FROM players) AS players,
      (SELECT COUNT(*) FROM matches WHERE ended_at IS NOT NULL) AS matches
  `),
};

// ---------- http ----------
const app = express();
app.set('trust proxy', 1);
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'", "'unsafe-inline'", "'unsafe-eval'", 'https://cdn.jsdelivr.net'],
      styleSrc: ["'self'", "'unsafe-inline'", 'https://fonts.googleapis.com'],
      fontSrc: ["'self'", 'https://fonts.gstatic.com'],
      imgSrc: ["'self'", 'data:', 'blob:', 'https://cdn.jsdelivr.net'],
      mediaSrc: ["'self'", 'blob:'],
      connectSrc: [
        "'self'", 'wss:', 'ws:',
        'https://cdn.jsdelivr.net',
        'https://justadudewhohacks.github.io',
        'https://model.nsfwjs.com',
        'https://nsfwjs.com',
      ],
      workerSrc: ["'self'", 'blob:'],
      objectSrc: ["'none'"],
    },
  },
  crossOriginEmbedderPolicy: false,
}));
app.use(compression());

// generous JSON limit only for the PFP endpoint; everything else is small.
app.use('/api/pfp', express.json({ limit: '512kb' }));
app.use(express.json({ limit: '32kb' }));

const apiLimiter = rateLimit({ windowMs: 60_000, max: 120, standardHeaders: true, legacyHeaders: false });
const claimLimiter = rateLimit({ windowMs: 60_000, max: 10, standardHeaders: true, legacyHeaders: false });
app.use('/api/', apiLimiter);

app.use(express.static(path.join(__dirname, 'public'), { maxAge: '1h', etag: true }));

app.get('/api/health', (_req, res) => res.json({ ok: true, uptime: process.uptime() }));

app.get('/api/stats', (_req, res) => {
  const s = queries.stats.get();
  res.json({ ...s, online: io.engine.clientsCount, queued: queue.length });
});

app.get('/api/leaderboard', (req, res) => {
  const limit = Math.min(parseInt(req.query.limit, 10) || 50, 200);
  const rows = req.query.board === 'mogs' ? queries.topMogs.all(limit) : queries.topElo.all(limit);
  const board = rows.map((p) => ({ ...p, tier: rankTier(p.elo) }));
  res.json({ board });
});

app.get('/api/me/:id', (req, res) => {
  const p = queries.getPlayer.get(req.params.id);
  if (!p) return res.status(404).json({ error: 'not_found' });
  res.json({ ...p, tier: rankTier(p.elo) });
});

// quick existence check used by the home form for inline feedback
app.get('/api/handle/check', (req, res) => {
  const v = validateHandle(req.query.name);
  if (v.error) return res.json({ ok: false, error: v.error });
  const existing = queries.getPlayerByHandle.get(v.handle.toLowerCase());
  if (existing) return res.json({ ok: false, error: 'taken' });
  res.json({ ok: true });
});

// claim or rename a handle. Returns a player_id (mint on first claim).
app.post('/api/claim', claimLimiter, (req, res) => {
  const { playerId, handle } = req.body || {};
  const v = validateHandle(handle);
  if (v.error) return res.status(400).json({ error: v.error });
  let id = (typeof playerId === 'string' && /^[A-Za-z0-9_-]{8,32}$/.test(playerId)) ? playerId : null;
  const handleLower = v.handle.toLowerCase();
  const taken = queries.getPlayerByHandle.get(handleLower);
  if (taken && taken.id !== id) return res.status(409).json({ error: 'taken' });

  const now = Date.now();
  if (id && queries.getPlayer.get(id)) {
    queries.setHandle.run({ id, handle: v.handle, handle_lower: handleLower, now });
  } else {
    if (!id) id = nanoid(16);
    queries.insertPlayer.run({ id, handle: v.handle, handle_lower: handleLower, now });
  }
  const p = queries.getPlayer.get(id);
  res.json({
    playerId: id, handle: p.handle, elo: p.elo, tier: rankTier(p.elo),
    psl: p.psl, wins: p.wins, losses: p.losses, draws: p.draws, mogs: p.mogs,
    hasPfp: !!p.has_pfp,
  });
});

// PFP upload — JSON body with a data URL. Cap at 100KB after decode.
app.post('/api/pfp', claimLimiter, (req, res) => {
  const { playerId, dataUrl } = req.body || {};
  if (typeof playerId !== 'string' || !/^[A-Za-z0-9_-]{8,32}$/.test(playerId)) {
    return res.status(400).json({ error: 'bad_id' });
  }
  if (typeof dataUrl !== 'string' || dataUrl.length > 400_000) {
    return res.status(400).json({ error: 'bad_image' });
  }
  const m = dataUrl.match(/^data:image\/(jpeg|jpg|png|webp);base64,([A-Za-z0-9+/=]+)$/);
  if (!m) return res.status(400).json({ error: 'bad_format' });
  const buf = Buffer.from(m[2], 'base64');
  if (buf.length === 0 || buf.length > 100 * 1024) return res.status(413).json({ error: 'too_big' });
  const player = queries.getPlayer.get(playerId);
  if (!player) return res.status(404).json({ error: 'not_found' });
  try {
    fs.writeFileSync(path.join(PFP_DIR, `${playerId}.jpg`), buf);
    queries.setHasPfp.run({ id: playerId, v: 1 });
    res.json({ ok: true });
  } catch (e) {
    console.error('pfp write', e);
    res.status(500).json({ error: 'write_failed' });
  }
});

app.delete('/api/pfp/:id', claimLimiter, (req, res) => {
  const id = req.params.id;
  if (!/^[A-Za-z0-9_-]{8,32}$/.test(id)) return res.status(400).end();
  try { fs.unlinkSync(path.join(PFP_DIR, `${id}.jpg`)); } catch {}
  queries.setHasPfp.run({ id, v: 0 });
  res.json({ ok: true });
});

app.get('/pfp/:id', (req, res) => {
  const id = req.params.id;
  if (!/^[A-Za-z0-9_-]{8,32}$/.test(id)) return res.status(400).end();
  const p = path.join(PFP_DIR, `${id}.jpg`);
  if (!fs.existsSync(p)) return res.status(404).end();
  res.setHeader('Cache-Control', 'public, max-age=600');
  res.sendFile(p);
});

const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: false },
  maxHttpBufferSize: 1e6,
  pingInterval: 25_000,
  pingTimeout: 20_000,
});

// ---------- matchmaking ----------
const queue = [];
const sockets = new Map();
const PAIR_BAND_GROW = 60;       // ±elo gained per second of waiting
const PAIR_BAND_MAX  = 1200;
let pairTimer = null;

// Adaptive: when very few people are online, drop the band to "anyone" so
// the queue actually pairs. As the population grows, tighten so ranked
// stays meaningful.
function bandStart() {
  const n = io.engine.clientsCount;
  if (n <= 50)  return PAIR_BAND_MAX;
  if (n <= 200) return 200;
  if (n <= 500) return 120;
  return 80;
}

function eloDelta(rA, rB, score, k = 32) {
  const expected = 1 / (1 + Math.pow(10, (rB - rA) / 400));
  return Math.round(k * (score - expected));
}

function bandFor(entry, now) {
  const waited = Math.max(0, (now - entry.joinedAt) / 1000);
  return Math.min(PAIR_BAND_MAX, bandStart() + waited * PAIR_BAND_GROW);
}

function pairFromQueue() {
  const now = Date.now();
  for (let i = queue.length - 1; i >= 0; i--) {
    if (!sockets.get(queue[i].id)) queue.splice(i, 1);
  }
  for (let i = 0; i < queue.length; i++) {
    const a = queue[i];
    const band = bandFor(a, now);
    let bestJ = -1, bestDiff = Infinity;
    for (let j = i + 1; j < queue.length; j++) {
      const b = queue[j];
      const diff = Math.abs(a.elo - b.elo);
      if (diff <= band && diff < bestDiff) {
        bestDiff = diff; bestJ = j;
        if (diff === 0) break;
      }
    }
    if (bestJ !== -1) {
      const b = queue[bestJ];
      queue.splice(bestJ, 1);
      queue.splice(i, 1);
      const sa = sockets.get(a.id);
      const sb = sockets.get(b.id);
      if (sa && sb) startMatch(sa, sb, { mode: 'ranked' });
      i = -1;
    }
  }
}

function startPairTimer() {
  if (pairTimer) return;
  pairTimer = setInterval(() => {
    if (queue.length >= 2) pairFromQueue();
    if (queue.length === 0) { clearInterval(pairTimer); pairTimer = null; }
  }, 1000);
}

// ---------- private rooms ----------
// rooms map: code -> { hostId, joinedAt }
// 6-character code, unambiguous alphabet.
const rooms = new Map();
const ROOM_ALPHA = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
const ROOM_TTL_MS = 5 * 60 * 1000;

function newRoomCode() {
  for (let attempt = 0; attempt < 8; attempt++) {
    let s = '';
    for (let i = 0; i < 6; i++) s += ROOM_ALPHA[Math.floor(Math.random() * ROOM_ALPHA.length)];
    if (!rooms.has(s)) return s;
  }
  return nanoid(6).toUpperCase();
}

// reap expired rooms once a minute
setInterval(() => {
  const cutoff = Date.now() - ROOM_TTL_MS;
  for (const [code, r] of rooms) if (r.joinedAt < cutoff) rooms.delete(code);
}, 60_000).unref();

// ---------- match flow ----------
function startMatch(sa, sb, opts = {}) {
  const matchId = nanoid(12);
  const mode = opts.mode === 'private' ? 'private' : 'ranked';
  const now = Date.now();
  queries.insertMatch.run({ id: matchId, a: sa.data.playerId, b: sb.data.playerId, mode, now });

  sa.data.matchId = matchId;  sb.data.matchId = matchId;
  sa.data.opponent = sb.id;   sb.data.opponent = sa.id;
  sa.data.matchMode = mode;   sb.data.matchMode = mode;
  sa.join(matchId);           sb.join(matchId);

  const opPayloadForA = {
    handle: sb.data.handle, elo: sb.data.elo, psl: sb.data.psl,
    tier: rankTier(sb.data.elo), playerId: sb.data.playerId,
  };
  const opPayloadForB = {
    handle: sa.data.handle, elo: sa.data.elo, psl: sa.data.psl,
    tier: rankTier(sa.data.elo), playerId: sa.data.playerId,
  };
  sa.emit('match:start', { matchId, role: 'caller', mode, opponent: opPayloadForA });
  sb.emit('match:start', { matchId, role: 'callee', mode, opponent: opPayloadForB });
}

function endMatch(matchId, winnerSocket, loserSocket, draw, payload) {
  if (!matchId) return;
  const room = io.sockets.adapter.rooms.get(matchId);
  if (!room) return;
  const ids = [...room];
  if (ids.length < 2) {
    for (const sid of ids) {
      const s = io.sockets.sockets.get(sid);
      if (s) { s.leave(matchId); s.data.matchId = null; s.data.opponent = null; s.data.matchMode = null; }
    }
    return;
  }
  const [id1, id2] = ids;
  const s1 = io.sockets.sockets.get(id1);
  const s2 = io.sockets.sockets.get(id2);
  if (!s1 || !s2) return;

  const aPsl = payload?.aPsl ?? null;
  const bPsl = payload?.bPsl ?? null;
  const p1 = queries.getPlayer.get(s1.data.playerId);
  const p2 = queries.getPlayer.get(s2.data.playerId);
  if (!p1 || !p2) return;

  let s1Score, s2Score, winnerId;
  if (draw) { s1Score = 0.5; s2Score = 0.5; winnerId = null; }
  else if (winnerSocket && winnerSocket.id === s1.id) { s1Score = 1; s2Score = 0; winnerId = p1.id; }
  else { s1Score = 0; s2Score = 1; winnerId = p2.id; }

  const mode = s1.data.matchMode || 'ranked';
  const ranked = mode === 'ranked';

  // private matches don't affect ELO or win/loss/mog counts. they're for fun.
  let d1 = 0, d2 = 0;
  const now = Date.now();
  if (ranked) {
    d1 = eloDelta(p1.elo, p2.elo, s1Score);
    d2 = eloDelta(p2.elo, p1.elo, s2Score);
    queries.applyResult.run({
      id: p1.id, delta: d1, now,
      win: s1Score === 1 ? 1 : 0, loss: s1Score === 0 ? 1 : 0,
      draw: s1Score === 0.5 ? 1 : 0, mog: s1Score === 1 ? 1 : 0,
    });
    queries.applyResult.run({
      id: p2.id, delta: d2, now,
      win: s2Score === 1 ? 1 : 0, loss: s2Score === 0 ? 1 : 0,
      draw: s2Score === 0.5 ? 1 : 0, mog: s2Score === 1 ? 1 : 0,
    });
  } else {
    queries.touchPlayer.run({ id: p1.id, now });
    queries.touchPlayer.run({ id: p2.id, now });
  }
  queries.finishMatch.run({
    id: matchId,
    aPsl: s1.data.playerId === p1.id ? aPsl : bPsl,
    bPsl: s1.data.playerId === p1.id ? bPsl : aPsl,
    winner: winnerId, aDelta: d1, bDelta: d2, now,
  });

  const e1 = p1.elo + d1, e2 = p2.elo + d2;
  s1.emit('match:result', {
    mode, ranked,
    youWon: s1Score === 1, draw, opponentPsl: bPsl, yourPsl: aPsl,
    eloDelta: d1, newElo: e1, tier: rankTier(e1), opponentEloDelta: d2,
  });
  s2.emit('match:result', {
    mode, ranked,
    youWon: s2Score === 1, draw, opponentPsl: aPsl, yourPsl: bPsl,
    eloDelta: d2, newElo: e2, tier: rankTier(e2), opponentEloDelta: d1,
  });

  s1.data.elo = e1; s2.data.elo = e2;
  s1.leave(matchId); s2.leave(matchId);
  s1.data.matchId = null; s2.data.matchId = null;
  s1.data.opponent = null; s2.data.opponent = null;
  s1.data.matchMode = null; s2.data.matchMode = null;
}

// ---------- sockets ----------
io.on('connection', (socket) => {
  socket.data.playerId = null;
  socket.data.handle = null;
  socket.data.elo = 1000;
  socket.data.psl = null;
  socket.data.matchId = null;
  socket.data.opponent = null;
  socket.data.matchMode = null;
  sockets.set(socket.id, socket);

  // Hello must arrive AFTER /api/claim — the client passes the claimed
  // playerId and handle. We verify they match a real row before letting
  // them queue.
  socket.on('player:hello', ({ playerId, handle }, ack) => {
    if (typeof playerId !== 'string' || !/^[A-Za-z0-9_-]{8,32}$/.test(playerId)) {
      ack?.({ error: 'no_claim' });
      return;
    }
    const p = queries.getPlayer.get(playerId);
    if (!p) { ack?.({ error: 'no_claim' }); return; }
    if (handle && p.handle !== handle) {
      // not fatal — the canonical name is what we stored
    }
    const now = Date.now();
    queries.touchPlayer.run({ id: p.id, now });
    socket.data.playerId = p.id;
    socket.data.handle = p.handle;
    socket.data.elo = p.elo;
    socket.data.psl = p.psl;
    ack?.({
      playerId: p.id, handle: p.handle, elo: p.elo, tier: rankTier(p.elo),
      psl: p.psl, wins: p.wins, losses: p.losses, draws: p.draws, mogs: p.mogs,
      hasPfp: !!p.has_pfp,
    });
  });

  socket.on('player:psl', ({ psl }) => {
    const v = Math.max(0, Math.min(10, parseFloat(psl)));
    if (!Number.isFinite(v) || !socket.data.playerId) return;
    socket.data.psl = v;
    queries.updatePsl.run({ id: socket.data.playerId, psl: v, now: Date.now() });
  });

  socket.on('queue:join', () => {
    if (!socket.data.playerId) return;
    if (socket.data.matchId) return;
    if (queue.some(e => e.id === socket.id)) return;
    queue.push({ id: socket.id, elo: socket.data.elo, joinedAt: Date.now() });
    socket.emit('queue:joined', { position: queue.length });
    pairFromQueue();
    startPairTimer();
  });

  socket.on('queue:leave', () => {
    const i = queue.findIndex(e => e.id === socket.id);
    if (i >= 0) queue.splice(i, 1);
    socket.emit('queue:left');
  });

  // ---- private rooms ----
  socket.on('room:create', (_payload, ack) => {
    if (!socket.data.playerId) return ack?.({ error: 'no_claim' });
    if (socket.data.matchId)   return ack?.({ error: 'in_match' });
    // discard any prior rooms hosted by this socket
    for (const [code, r] of rooms) if (r.hostId === socket.id) rooms.delete(code);
    const code = newRoomCode();
    rooms.set(code, { hostId: socket.id, joinedAt: Date.now() });
    ack?.({ code });
  });

  socket.on('room:cancel', () => {
    for (const [code, r] of rooms) if (r.hostId === socket.id) rooms.delete(code);
  });

  socket.on('room:join', ({ code }, ack) => {
    if (!socket.data.playerId) return ack?.({ error: 'no_claim' });
    if (socket.data.matchId)   return ack?.({ error: 'in_match' });
    const c = (code || '').toString().trim().toUpperCase();
    const r = rooms.get(c);
    if (!r) return ack?.({ error: 'no_room' });
    if (r.hostId === socket.id) return ack?.({ error: 'cant_join_self' });
    const host = io.sockets.sockets.get(r.hostId);
    if (!host) { rooms.delete(c); return ack?.({ error: 'host_gone' }); }
    rooms.delete(c);
    ack?.({ ok: true });
    startMatch(host, socket, { mode: 'private' });
  });

  // ---- webrtc signaling ----
  socket.on('rtc:signal', (payload) => {
    const oppId = socket.data.opponent;
    if (!oppId) return;
    const opp = io.sockets.sockets.get(oppId);
    if (!opp) return;
    opp.emit('rtc:signal', payload);
  });

  socket.on('match:psl', ({ psl }) => {
    const oppId = socket.data.opponent;
    if (!oppId) return;
    const opp = io.sockets.sockets.get(oppId);
    if (!opp) return;
    socket.data.lastPsl = psl;
    opp.emit('match:opponent_psl', { psl });
  });

  socket.on('match:concede', () => {
    const matchId = socket.data.matchId;
    if (!matchId) return;
    const oppId = socket.data.opponent;
    const opp = oppId ? io.sockets.sockets.get(oppId) : null;
    if (opp) {
      endMatch(matchId, opp, socket, false, {
        aPsl: opp.data.lastPsl ?? null,
        bPsl: socket.data.lastPsl ?? null,
      });
    }
  });

  socket.on('match:finish', ({ aPsl, bPsl }) => {
    const matchId = socket.data.matchId;
    if (!matchId) return;
    const oppId = socket.data.opponent;
    const opp = oppId ? io.sockets.sockets.get(oppId) : null;
    if (!opp) return;
    socket.data.finishPayload = { aPsl, bPsl };
    if (opp.data.finishPayload) {
      const oppA = opp.data.finishPayload.bPsl;
      const oppB = opp.data.finishPayload.aPsl;
      const meanA = (aPsl + oppA) / 2;
      const meanB = (bPsl + oppB) / 2;
      let winner = null, draw = false;
      if (Math.abs(meanA - meanB) < 0.05) draw = true;
      else if (meanA > meanB) winner = socket;
      else winner = opp;
      const loser = draw ? null : (winner === socket ? opp : socket);
      endMatch(matchId, winner, loser, draw, { aPsl: meanA, bPsl: meanB });
      socket.data.finishPayload = null;
      opp.data.finishPayload = null;
    }
  });

  socket.on('match:report', ({ reason }) => {
    const oppId = socket.data.opponent;
    const matchId = socket.data.matchId;
    console.warn('[report]', socket.data.playerId, '->', oppId, 'match', matchId, 'reason', String(reason || '').slice(0, 80));
    if (matchId) {
      const opp = oppId ? io.sockets.sockets.get(oppId) : null;
      if (opp) endMatch(matchId, null, null, true, { aPsl: null, bPsl: null });
    }
  });

  socket.on('disconnect', () => {
    sockets.delete(socket.id);
    const i = queue.findIndex(e => e.id === socket.id);
    if (i >= 0) queue.splice(i, 1);
    for (const [code, r] of rooms) if (r.hostId === socket.id) rooms.delete(code);
    const oppId = socket.data.opponent;
    const matchId = socket.data.matchId;
    if (matchId && oppId) {
      const opp = io.sockets.sockets.get(oppId);
      if (opp) {
        endMatch(matchId, opp, null, false, {
          aPsl: opp.data.lastPsl ?? null,
          bPsl: socket.data.lastPsl ?? null,
        });
        opp.emit('match:opponent_left');
      }
    }
  });
});

server.listen(PORT, HOST, () => {
  console.log(`omoggle V2 listening on http://${HOST}:${PORT}`);
});

function shutdown() {
  console.log('shutting down...');
  io.close(() => server.close(() => { db.close(); process.exit(0); }));
  setTimeout(() => process.exit(1), 5000).unref();
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
