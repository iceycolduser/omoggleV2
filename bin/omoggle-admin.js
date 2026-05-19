#!/usr/bin/env node
// omoggle v2 — admin CLI.
// Run on the VPS where the database lives. Works while the server is running
// (better-sqlite3 + WAL handle concurrent access).
//
//   node bin/omoggle-admin.js <command> [args]
//
//   reports [--all] [--limit=50]    list reports (unresolved by default)
//   resolve <reportId>              mark a report resolved
//   bans                            list all IP bans
//   ban-ip <ip> [reason]            permanently ban an IP
//   unban-ip <ip>                   lift an IP ban
//   ban-player <id|handle> [reason] ban the player's last-known IP
//   reset <id|handle>               wipe their stats (keeps handle + id)
//   delete <id|handle>              fully delete the player + their pfp
//   player <id|handle>              show a player's full record
//   tail-reports                    live-follow new reports until ctrl-c

'use strict';

const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
const DB_PATH  = path.join(DATA_DIR, 'omoggle.db');
const PFP_DIR  = path.join(DATA_DIR, 'pfps');

if (!fs.existsSync(DB_PATH)) {
  console.error(`database not found at ${DB_PATH}`);
  console.error('set DATA_DIR or run from the project root');
  process.exit(2);
}

const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('busy_timeout = 5000');

// ---------- helpers ----------
function shortId(id) { return id ? id.slice(0, 10) : '—'; }
function whenAgo(ts) {
  if (!ts) return '—';
  const s = Math.floor((Date.now() - ts) / 1000);
  if (s < 60) return s + 's ago';
  if (s < 3600) return Math.floor(s / 60) + 'm ago';
  if (s < 86400) return Math.floor(s / 3600) + 'h ago';
  return Math.floor(s / 86400) + 'd ago';
}
function findPlayer(idOrHandle) {
  if (!idOrHandle) return null;
  // handle is unique (case-insensitive); id is the random nanoid
  let p = db.prepare('SELECT * FROM players WHERE id = ?').get(idOrHandle);
  if (p) return p;
  p = db.prepare('SELECT * FROM players WHERE handle_lower = ?').get(idOrHandle.toLowerCase());
  return p || null;
}
function ensurePlayer(idOrHandle) {
  const p = findPlayer(idOrHandle);
  if (!p) { console.error(`no player matching "${idOrHandle}"`); process.exit(1); }
  return p;
}
function table(rows, columns) {
  if (!rows.length) { console.log('(none)'); return; }
  const widths = columns.map((c) => Math.max(c.label.length, ...rows.map((r) => String(c.get(r) ?? '').length)));
  const fmt = (vals) => vals.map((v, i) => String(v ?? '').padEnd(widths[i])).join('  ');
  console.log(fmt(columns.map((c) => c.label.toUpperCase())));
  console.log(fmt(widths.map((w) => '-'.repeat(w))));
  for (const r of rows) console.log(fmt(columns.map((c) => c.get(r))));
}
function parseFlags(argv) {
  const flags = {}; const rest = [];
  for (const a of argv) {
    if (a.startsWith('--')) {
      const [k, v] = a.slice(2).split('=');
      flags[k] = v === undefined ? true : v;
    } else rest.push(a);
  }
  return { flags, rest };
}

// ---------- commands ----------
const cmds = {};

cmds.reports = (args) => {
  const { flags } = parseFlags(args);
  const limit = parseInt(flags.limit, 10) || 50;
  const where = flags.all ? '' : 'WHERE resolved = 0';
  const rows = db.prepare(`
    SELECT r.id, r.reporter_id, r.target_id, r.match_id, r.reason,
           r.reporter_ip, r.target_ip, r.ts, r.resolved,
           rp.handle AS reporter_handle, tp.handle AS target_handle
      FROM reports r
      LEFT JOIN players rp ON rp.id = r.reporter_id
      LEFT JOIN players tp ON tp.id = r.target_id
     ${where}
     ORDER BY r.ts DESC
     LIMIT ?`).all(limit);
  table(rows, [
    { label: 'id',       get: (r) => r.id },
    { label: 'when',     get: (r) => whenAgo(r.ts) },
    { label: 'reporter', get: (r) => r.reporter_handle || shortId(r.reporter_id) },
    { label: 'target',   get: (r) => r.target_handle   || shortId(r.target_id) },
    { label: 'target ip',get: (r) => r.target_ip || '—' },
    { label: 'reason',   get: (r) => (r.reason || '').slice(0, 60) },
    { label: 'status',   get: (r) => r.resolved ? 'resolved' : 'open' },
  ]);
};

cmds.resolve = (args) => {
  const id = parseInt(args[0], 10);
  if (!id) { console.error('usage: resolve <reportId>'); process.exit(1); }
  const r = db.prepare('UPDATE reports SET resolved = 1 WHERE id = ?').run(id);
  console.log(r.changes ? `resolved report #${id}` : `no report #${id}`);
};

cmds.bans = () => {
  const rows = db.prepare('SELECT ip, reason, banned_at FROM bans ORDER BY banned_at DESC').all();
  table(rows, [
    { label: 'ip',     get: (r) => r.ip },
    { label: 'when',   get: (r) => whenAgo(r.banned_at) },
    { label: 'reason', get: (r) => r.reason || '—' },
  ]);
};

cmds['ban-ip'] = (args) => {
  const ip = args[0];
  if (!ip) { console.error('usage: ban-ip <ip> [reason]'); process.exit(1); }
  const reason = args.slice(1).join(' ') || null;
  db.prepare(`INSERT INTO bans (ip, reason, banned_at) VALUES (?, ?, ?)
              ON CONFLICT(ip) DO UPDATE SET reason = excluded.reason, banned_at = excluded.banned_at`)
    .run(ip, reason, Date.now());
  // count players that hit it
  const n = db.prepare('SELECT COUNT(*) AS n FROM players WHERE last_ip = ? OR created_ip = ?').get(ip, ip);
  console.log(`banned ${ip}${reason ? ' — ' + reason : ''}`);
  console.log(`(${n.n} player(s) have used this ip)`);
};

cmds['unban-ip'] = (args) => {
  const ip = args[0];
  if (!ip) { console.error('usage: unban-ip <ip>'); process.exit(1); }
  const r = db.prepare('DELETE FROM bans WHERE ip = ?').run(ip);
  console.log(r.changes ? `unbanned ${ip}` : `${ip} was not banned`);
};

cmds['ban-player'] = (args) => {
  const p = ensurePlayer(args[0]);
  const reason = args.slice(1).join(' ') || `player:${p.handle}`;
  const ips = [p.last_ip, p.created_ip].filter(Boolean);
  if (!ips.length) {
    console.error(`no recorded ips for ${p.handle}; nothing to ban`);
    process.exit(1);
  }
  const now = Date.now();
  const ins = db.prepare(`INSERT INTO bans (ip, reason, banned_at) VALUES (?, ?, ?)
                          ON CONFLICT(ip) DO UPDATE SET reason = excluded.reason, banned_at = excluded.banned_at`);
  for (const ip of new Set(ips)) ins.run(ip, reason, now);
  console.log(`banned ${ips.length} ip(s) belonging to ${p.handle}: ${[...new Set(ips)].join(', ')}`);
};

cmds.reset = (args) => {
  const p = ensurePlayer(args[0]);
  const r = db.prepare(`
    UPDATE players
       SET elo = 1000, psl = NULL,
           wins = 0, losses = 0, draws = 0, mogs = 0,
           last_seen = ?
     WHERE id = ?`).run(Date.now(), p.id);
  console.log(r.changes
    ? `reset ${p.handle} (${shortId(p.id)}) → elo=1000, stats wiped`
    : `no changes`);
};

cmds.delete = (args) => {
  const p = ensurePlayer(args[0]);
  const tx = db.transaction((id) => {
    db.prepare('DELETE FROM players WHERE id = ?').run(id);
    db.prepare('DELETE FROM matches WHERE a_id = ? OR b_id = ?').run(id, id);
    db.prepare('DELETE FROM reports WHERE reporter_id = ? OR target_id = ?').run(id, id);
  });
  tx(p.id);
  try { fs.unlinkSync(path.join(PFP_DIR, `${p.id}.jpg`)); } catch {}
  console.log(`deleted ${p.handle} (${shortId(p.id)}); handle is now free again`);
};

cmds.player = (args) => {
  const p = ensurePlayer(args[0]);
  console.log(`handle:      ${p.handle}`);
  console.log(`id:          ${p.id}`);
  console.log(`elo:         ${p.elo}`);
  console.log(`psl:         ${p.psl ?? '—'}`);
  console.log(`record:      ${p.wins}W ${p.losses}L ${p.draws}D · ${p.mogs} mogs`);
  console.log(`has pfp:     ${p.has_pfp ? 'yes' : 'no'}`);
  console.log(`last ip:     ${p.last_ip || '—'}`);
  console.log(`created ip:  ${p.created_ip || '—'}`);
  console.log(`created:     ${new Date(p.created_at).toISOString()}`);
  console.log(`last seen:   ${new Date(p.last_seen).toISOString()} (${whenAgo(p.last_seen)})`);
  const reportCount = db.prepare(
    `SELECT
       (SELECT COUNT(*) FROM reports WHERE target_id = ?)   AS against,
       (SELECT COUNT(*) FROM reports WHERE reporter_id = ?) AS by_them`).get(p.id, p.id);
  console.log(`reports:     ${reportCount.against} against · ${reportCount.by_them} by them`);
};

cmds['tail-reports'] = () => {
  let lastId = db.prepare('SELECT COALESCE(MAX(id), 0) AS m FROM reports').get().m;
  console.log(`watching reports table (since id=${lastId})... ctrl-c to stop`);
  setInterval(() => {
    const rows = db.prepare(`
      SELECT r.id, r.ts, r.reason, r.target_ip,
             rp.handle AS reporter_handle, tp.handle AS target_handle
        FROM reports r
        LEFT JOIN players rp ON rp.id = r.reporter_id
        LEFT JOIN players tp ON tp.id = r.target_id
       WHERE r.id > ? ORDER BY r.id ASC`).all(lastId);
    for (const r of rows) {
      lastId = r.id;
      console.log(`#${r.id} ${new Date(r.ts).toISOString()} ${r.reporter_handle || '?'} → ${r.target_handle || '?'} (${r.target_ip || '—'}) "${(r.reason || '').slice(0, 80)}"`);
    }
  }, 1000).unref();
  process.stdin.resume();
};

cmds.help = () => {
  console.log(`omoggle v2 admin CLI

  reports [--all] [--limit=50]    list reports (unresolved by default)
  resolve <reportId>              mark a report resolved
  bans                            list all IP bans
  ban-ip <ip> [reason]            permanently ban an IP
  unban-ip <ip>                   lift an IP ban
  ban-player <id|handle> [reason] ban the player's last-known IP
  reset <id|handle>               wipe their stats (handle + id kept)
  delete <id|handle>              fully delete the player + pfp + their matches
  player <id|handle>              show a player's full record
  tail-reports                    follow new reports live until ctrl-c`);
};

// ---------- dispatch ----------
const [cmdName, ...cmdArgs] = process.argv.slice(2);
if (!cmdName || cmdName === '-h' || cmdName === '--help') { cmds.help(); process.exit(0); }
const fn = cmds[cmdName];
if (!fn) { console.error(`unknown command: ${cmdName}`); cmds.help(); process.exit(1); }
try { fn(cmdArgs); }
catch (e) { console.error('error:', e.message); process.exit(1); }
finally { try { db.close(); } catch {} }
