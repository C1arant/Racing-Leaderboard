// server.js (ESM) — Racing Leaderboard
// Run: npm start
import express from "express";
import http from "http";
import dgram from "dgram";
import { Server } from "socket.io";
import path from "path";
import { fileURLToPath } from "url";
import fs from "fs";

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
const SETTINGS_FILE = path.join(__dirname, "settings.json");

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

function saveJson(file, data) {
  try {
    fs.writeFileSync(file, JSON.stringify(data, null, 2), "utf-8");
  } catch (e) {
    console.error("Save failed:", file, e);
  }
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
  ratings[key] = {
    rating: rating.rating,
    lastChange: rating.lastChange,
    lastResult: rating.lastResult ?? null,
    updatedAt: rating.updatedAt
  };
  saveJson(RATINGS_FILE, ratings);
}

// -------------------- Data --------------------
let scores = loadJson(DATA_FILE, []);
let ratings = loadJson(RATINGS_FILE, {});
let settings = loadJson(SETTINGS_FILE, { defaultTrack: "spa" });
if (!settings || typeof settings !== "object" || Array.isArray(settings)) {
  settings = { defaultTrack: "spa" };
}
if (!settings.defaultTrack) {
  settings.defaultTrack = "spa";
}

function getPublicSettings() {
  return {
    defaultTrack: settings.defaultTrack
  };
}

function saveSettings() {
  saveJson(SETTINGS_FILE, settings);
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

function saveScores() {
  saveJson(DATA_FILE, scores);
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
    saveScores();
    io.emit("scoreUpdate", row);

    const ratingInfo = applyRatingUpdate(row);
    return { ok: true, mode: "added", ...ratingInfo };
  }

  const old = scores[idx];
  if (timeToMs(clean.time) < timeToMs(old.time)) {
    const row = { ...clean, id: old.id };
    scores[idx] = row;
    saveScores();
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
    saveScores();
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
  saveScores();
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
    saveSettings();
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
