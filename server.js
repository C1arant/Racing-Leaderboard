// server.js (ESM) — Racing Leaderboard
// Run: npm start
import express from "express";
import http from "http";
import dgram from "dgram";
import { Server } from "socket.io";
import path from "path";
import { fileURLToPath } from "url";
import fs from "fs";
import Database from "better-sqlite3";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(path.join(__dirname, "public")));
app.get("/", (req, res) => res.sendFile(path.join(__dirname, "public", "display.html")));
app.get("/admin", (req, res) => res.sendFile(path.join(__dirname, "public", "admin.html")));
app.get("/fullscreen", (req, res) => res.sendFile(path.join(__dirname, "public", "fullscreen.html")));
app.get("/map", (req, res) => res.sendFile(path.join(__dirname, "public", "map.html")));
app.get("/pitwall", (req, res) => res.sendFile(path.join(__dirname, "public", "pitwall.html")));

const DATA_FILE = path.join(__dirname, "scores.json");
const RATINGS_FILE = path.join(__dirname, "ratings.json");
const DB_FILE = path.join(__dirname, "leaderboard.db");

const ADMIN_PIN = process.env.ADMIN_PIN || "1234";
const TELEMETRY_UDP_PORT = Number(process.env.TELEMETRY_UDP_PORT || "41234");
const TELEMETRY_UDP_HOST = process.env.TELEMETRY_UDP_HOST || "0.0.0.0";

const DEFAULT_RATING = 1350;

// -------------------- Persistence --------------------
function loadJson(file, fallback) {
  try {
    if (fs.existsSync(file)) {
      const raw = fs.readFileSync(file, "utf-8");
      return JSON.parse(raw);
    }
  } catch (e) {
    console.error("Load failed:", file, e);
  }
  return fallback;
}

const db = new Database(DB_FILE);
db.pragma("journal_mode = WAL");

db.exec(`
  CREATE TABLE IF NOT EXISTS scores (
    id TEXT PRIMARY KEY,
    first TEXT NOT NULL,
    last TEXT NOT NULL,
    time TEXT NOT NULL,
    day TEXT,
    game TEXT NOT NULL,
    car TEXT,
    track TEXT NOT NULL,
    cohort TEXT,
    course TEXT,
    createdAt TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS ratings (
    key TEXT PRIMARY KEY,
    rating INTEGER NOT NULL,
    lastChange INTEGER NOT NULL,
    lastPosition INTEGER,
    lastFieldSize INTEGER,
    updatedAt TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );
`);

function getSetting(key, fallback) {
  const row = db.prepare("SELECT value FROM settings WHERE key = ?").get(key);
  if (!row) {
    db.prepare("INSERT INTO settings (key, value) VALUES (?, ?)").run(key, JSON.stringify(fallback));
    return fallback;
  }
  try {
    return JSON.parse(row.value);
  } catch {
    return fallback;
  }
}

function setSetting(key, value) {
  db.prepare("INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
    .run(key, JSON.stringify(value));
}

function migrateJsonIfNeeded() {
  const scoreCount = db.prepare("SELECT COUNT(*) AS count FROM scores").get().count;
  if (scoreCount === 0) {
    const scores = loadJson(DATA_FILE, []).map((row) => ({
      id: row.id || makeId(),
      first: row.first || "",
      last: row.last || "",
      time: row.time || "",
      day: row.day || "",
      game: row.game || "Assetto Corsa",
      car: row.car || "",
      track: row.track || "",
      cohort: row.cohort || "Guest",
      course: row.course || "—",
      createdAt: row.createdAt || new Date().toISOString()
    }));
    const insert = db.prepare(`
      INSERT OR IGNORE INTO scores
      (id, first, last, time, day, game, car, track, cohort, course, createdAt)
      VALUES (@id, @first, @last, @time, @day, @game, @car, @track, @cohort, @course, @createdAt)
    `);
    const insertMany = db.transaction((rows) => {
      rows.forEach((row) => insert.run(row));
    });
    insertMany(scores);
  }

  const ratingCount = db.prepare("SELECT COUNT(*) AS count FROM ratings").get().count;
  if (ratingCount === 0) {
    const ratings = loadJson(RATINGS_FILE, {});
    const insert = db.prepare(`
      INSERT OR REPLACE INTO ratings
      (key, rating, lastChange, lastPosition, lastFieldSize, updatedAt)
      VALUES (@key, @rating, @lastChange, @lastPosition, @lastFieldSize, @updatedAt)
    `);
    const insertMany = db.transaction((rows) => {
      rows.forEach((row) => insert.run(row));
    });
    const rows = Object.entries(ratings).map(([key, value]) => ({
      key,
      rating: value.rating ?? DEFAULT_RATING,
      lastChange: value.lastChange ?? 0,
      lastPosition: value.lastResult?.position ?? null,
      lastFieldSize: value.lastResult?.fieldSize ?? null,
      updatedAt: value.updatedAt || new Date().toISOString()
    }));
    insertMany(rows);
  }
}

migrateJsonIfNeeded();

function loadScoresFromDb() {
  return db.prepare("SELECT * FROM scores").all();
}

function loadRatingsFromDb() {
  const rows = db.prepare("SELECT * FROM ratings").all();
  const out = {};
  for (const row of rows) {
    out[row.key] = {
      rating: row.rating,
      lastChange: row.lastChange,
      lastResult: row.lastPosition ? { position: row.lastPosition, fieldSize: row.lastFieldSize } : null,
      updatedAt: row.updatedAt
    };
  }
  return out;
}

function isAdmin(pin) { return String(pin || "") === String(ADMIN_PIN); }
function makeId() {
  return (globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(16).slice(2)}`);
}

// -------------------- Rating System --------------------
function getRatingKey(game, first, last) {
  return `${String(game).trim()}|${String(first).trim().toLowerCase()}|${String(last).trim().toLowerCase()}`;
}

function getRatingEntry(game, first, last) {
  const key = getRatingKey(game, first, last);
  if (!ratings[key]) {
    ratings[key] = {
      rating: DEFAULT_RATING,
      lastChange: 0,
      lastResult: null,
      updatedAt: new Date().toISOString()
    };
    saveRating(key, ratings[key]);
  }
  return ratings[key];
}

function fieldForEntry(entry) {
  return scores.filter(s =>
    s.game === entry.game &&
    s.track.toLowerCase() === entry.track.toLowerCase()
  );
}

function calculatePositionDelta(entry) {
  const field = fieldForEntry(entry);
  const fieldSize = field.length;

  const myTime = timeToMs(entry.time);
  const position = field
    .map(s => timeToMs(s.time))
    .filter(t => t < myTime).length + 1;

  if (!Number.isFinite(myTime)) {
    return { delta: 0, position, fieldSize };
  }

  const rating = getRatingEntry(entry.game, entry.first, entry.last);
  const lastPosition = rating.lastResult?.position;

  if (!lastPosition || !Number.isFinite(lastPosition)) {
    return { delta: 0, position, fieldSize };
  }

  const delta = (lastPosition - position) * 5;

  return { delta, position, fieldSize };
}

function saveRating(key, rating) {
  db.prepare(`
    INSERT INTO ratings (key, rating, lastChange, lastPosition, lastFieldSize, updatedAt)
    VALUES (@key, @rating, @lastChange, @lastPosition, @lastFieldSize, @updatedAt)
    ON CONFLICT(key) DO UPDATE SET
      rating = excluded.rating,
      lastChange = excluded.lastChange,
      lastPosition = excluded.lastPosition,
      lastFieldSize = excluded.lastFieldSize,
      updatedAt = excluded.updatedAt
  `).run({
    key,
    rating: rating.rating,
    lastChange: rating.lastChange,
    lastPosition: rating.lastResult?.position ?? null,
    lastFieldSize: rating.lastResult?.fieldSize ?? null,
    updatedAt: rating.updatedAt
  });
}

// -------------------- Data --------------------
let scores = loadScoresFromDb();
let ratings = loadRatingsFromDb();

let settings = {
  defaultTrack: getSetting("defaultTrack", "spa")
};

function getPublicSettings() {
  return {
    defaultTrack: settings.defaultTrack
  };
}

// -------------------- Time parsing --------------------
function timeToMs(t) {
  const str = String(t || "").trim();
  if (/^\d+:\d{2}\.\d{3}$/.test(str)) {
    const [m, rest] = str.split(":");
    const [s, ms] = rest.split(".");
    return (parseInt(m, 10) * 60 + parseInt(s, 10)) * 1000 + parseInt(ms, 10);
  }
  if (/^\d+\.\d{3}$/.test(str)) {
    const [s, ms] = str.split(".");
    return parseInt(s, 10) * 1000 + parseInt(ms, 10);
  }
  return Infinity;
}

// -------------------- Normalisation --------------------
function sanitiseScore(data) {
  if (!data) return null;

  const score = {
    id: data.id || makeId(),
    first: String(data.first || "").trim(),
    last: String(data.last || "").trim(),
    time: String(data.time || "").trim(),
    day: String(data.day || "").trim(),
    game: String(data.game || "").trim(),
    car: String(data.car || "").trim(),
    track: String(data.track || "").trim(),
    cohort: String(data.cohort || "").trim() || "Guest",
    course: String(data.course || "").trim() || "—",
    createdAt: data.createdAt || new Date().toISOString()
  };

  if (!score.first || !score.last || !score.time || !score.track || !score.game) return null;
  if (score.game !== "Assetto Corsa") return null;

  return score;
}

// One row per person per game+track
function makeKey(s) {
  const first = String(s.first || "").trim().toLowerCase();
  const last = String(s.last || "").trim().toLowerCase();
  const game = String(s.game || "").trim();
  const track = String(s.track || "").trim().toLowerCase();
  return `${first}|${last}|${game}|${track}`;
}

function insertScore(row) {
  db.prepare(`
    INSERT INTO scores (id, first, last, time, day, game, car, track, cohort, course, createdAt)
    VALUES (@id, @first, @last, @time, @day, @game, @car, @track, @cohort, @course, @createdAt)
  `).run(row);
}

function updateScore(row) {
  db.prepare(`
    UPDATE scores
    SET first=@first, last=@last, time=@time, day=@day, game=@game, car=@car, track=@track, cohort=@cohort, course=@course
    WHERE id=@id
  `).run(row);
}

function applyRatingUpdate(row) {
  const rating = getRatingEntry(row.game, row.first, row.last);
  const { delta, position, fieldSize } = calculatePositionDelta(row);

  rating.rating = Math.max(0, rating.rating + delta);
  rating.lastChange = delta;
  rating.lastResult = fieldSize ? { position, fieldSize } : null;
  rating.updatedAt = new Date().toISOString();

  saveRating(getRatingKey(row.game, row.first, row.last), rating);
  io.emit("ratingsUpdate", ratings);

  return { ratingDelta: delta, rating: rating.rating, position, fieldSize };
}

// -------------------- Core: upsert best --------------------
function submitLap(raw) {
  const clean = sanitiseScore(raw);
  if (!clean) return { ok: false, reason: "invalid" };

  const key = makeKey(clean);
  const idx = scores.findIndex(s => makeKey(s) === key);

  if (idx === -1) {
    const row = { ...clean };
    scores.push(row);
    insertScore(row);
    io.emit("scoreUpdate", row);

    const ratingInfo = applyRatingUpdate(row);
    return { ok: true, mode: "added", ...ratingInfo };
  }

  const old = scores[idx];
  if (timeToMs(clean.time) < timeToMs(old.time)) {
    const row = { ...clean, id: old.id };
    scores[idx] = row;
    updateScore(row);
    io.emit("scoreReplace", row);

    const ratingInfo = applyRatingUpdate(row);
    return { ok: true, mode: "replaced", ...ratingInfo };
  }

  return { ok: false, reason: "not_better" };
}

function deleteLeaderboardRowById(id) {
  const before = scores.length;
  scores = scores.filter(s => s.id !== id);
  const removed = before - scores.length;
  if (removed) {
    db.prepare("DELETE FROM scores WHERE id = ?").run(id);
    io.emit("deleteScore", { id });
  }
  return removed;
}

function normalizeTelemetryPayload(payload) {
  if (!payload || typeof payload !== "object") return null;
  const clean = { ...payload };

  if (typeof clean.x === "number" && typeof clean.y === "number") {
    clean.x = Math.max(0, Math.min(1000, clean.x));
    clean.y = Math.max(0, Math.min(560, clean.y));
  }

  return clean;
}

function startTelemetryUdp() {
  const socket = dgram.createSocket("udp4");

  socket.on("message", (msg) => {
    try {
      const parsed = JSON.parse(msg.toString("utf-8"));
      const payload = normalizeTelemetryPayload(parsed);
      if (payload) io.emit("telemetryUpdate", payload);
    } catch (err) {
      console.warn("Telemetry UDP parse failed:", err.message);
    }
  });

  socket.on("listening", () => {
    const addr = socket.address();
    console.log(`Telemetry UDP listening on ${addr.address}:${addr.port}`);
  });

  socket.bind(TELEMETRY_UDP_PORT, TELEMETRY_UDP_HOST);
}

function updateLeaderboardRow(id, patch) {
  const idx = scores.findIndex(s => s.id === id);
  if (idx === -1) return { ok: false, reason: "not_found" };

  const current = scores[idx];
  const next = {
    ...current,
    first: String(patch.first ?? current.first).trim(),
    last: String(patch.last ?? current.last).trim(),
    time: String(patch.time ?? current.time).trim(),
    day: String(patch.day ?? current.day).trim(),
    game: String(patch.game ?? current.game).trim(),
    car: String(patch.car ?? current.car).trim(),
    track: String(patch.track ?? current.track).trim(),
    cohort: String(patch.cohort ?? current.cohort).trim() || "Guest",
    course: String(patch.course ?? current.course).trim() || "—"
  };

  if (!next.first || !next.last || !next.time || !next.track || !next.game) {
    return { ok: false, reason: "invalid" };
  }
  if (next.game !== "Assetto Corsa") return { ok: false, reason: "invalid_game" };

  const parsed = timeToMs(next.time);
  if (!Number.isFinite(parsed)) return { ok: false, reason: "invalid_time" };

  const key = makeKey(next);
  const dupIdx = scores.findIndex(s => s.id !== id && makeKey(s) === key);
  if (dupIdx !== -1) return { ok: false, reason: "duplicate" };

  scores[idx] = next;
  updateScore(next);
  io.emit("scoreReplace", next);

  const ratingInfo = applyRatingUpdate(next);
  return { ok: true, row: next, ratingInfo };
}

// -------------------- APIs --------------------
app.get("/api/settings", (req, res) => res.json(getPublicSettings()));
app.get("/api/scores", (req, res) => res.json(scores));
app.get("/api/ratings", (req, res) => res.json(ratings));
app.get("/api/tracks", (req, res) => {
  try {
    const tracksDir = path.join(__dirname, "public", "tracks");
    if (!fs.existsSync(tracksDir)) return res.json([]);
    const files = fs.readdirSync(tracksDir).filter((f) => f.endsWith(".json"));
    const list = files.map((file) => {
      const id = file.replace(/\.json$/, "");
      try {
        const raw = fs.readFileSync(path.join(tracksDir, file), "utf-8");
        const data = JSON.parse(raw);
        return { id, name: data.name || id };
      } catch {
        return { id, name: id };
      }
    });
    res.json(list);
  } catch (err) {
    res.json([]);
  }
});

// -------------------- Socket.IO --------------------
io.on("connection", (socket) => {
  socket.emit("loadScores", scores);
  socket.emit("settingsUpdate", getPublicSettings());
  socket.emit("ratingsUpdate", ratings);

  socket.on("newScore", (data) => {
    const result = submitLap(data);
    socket.emit("submitResult", result);
  });

  socket.on("adminPing", ({ pin }) => {
    socket.emit("adminPingResult", { ok: isAdmin(pin) });
  });

  socket.on("adminSetTrack", ({ pin, trackId }) => {
    if (!isAdmin(pin)) return socket.emit("adminResult", { ok: false, action: "setTrack", reason: "denied" });
    const next = String(trackId || "").trim() || "spa";
    settings.defaultTrack = next;
    setSetting("defaultTrack", next);
    io.emit("settingsUpdate", getPublicSettings());
    socket.emit("adminResult", { ok: true, action: "setTrack" });
  });

  socket.on("adminDeleteScore", ({ pin, id }) => {
    if (!isAdmin(pin)) return socket.emit("adminResult", { ok: false, action: "deleteScore", reason: "denied" });
    const removed = deleteLeaderboardRowById(String(id || ""));
    socket.emit("adminResult", { ok: true, action: "deleteScore", removed });
  });

  socket.on("adminUpdateScore", ({ pin, id, ...patch }) => {
    if (!isAdmin(pin)) return socket.emit("adminResult", { ok: false, action: "updateScore", reason: "denied" });
    const result = updateLeaderboardRow(String(id || ""), patch || {});
    if (!result.ok) {
      return socket.emit("adminResult", { ok: false, action: "updateScore", reason: result.reason });
    }
    socket.emit("adminResult", { ok: true, action: "updateScore" });
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Server running: http://localhost:${PORT}`);
  startTelemetryUdp();
});
