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
const ATTEMPTS_FILE = path.join(__dirname, "attempts.json");
const SETTINGS_FILE = path.join(__dirname, "settings.json");
const RATINGS_FILE = path.join(__dirname, "ratings.json");

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

function saveScores() { saveJson(DATA_FILE, scores); }
function saveAttempts() { saveJson(ATTEMPTS_FILE, attempts); }
function saveSettings() { saveJson(SETTINGS_FILE, settings); }
function saveRatings() { saveJson(RATINGS_FILE, ratings); }

function isAdmin(pin) { return String(pin || "") === String(ADMIN_PIN); }
function makeId() {
  return (globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(16).slice(2)}`);
}

// -------------------- Rating System (iRacing-style) --------------------
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
  }
  return ratings[key];
}

function expectedScore(myRating, oppRating) {
  return 1 / (1 + Math.pow(10, (oppRating - myRating) / 400));
}

function fieldForEntry(entry) {
  return scores.filter(s =>
    s.eventId === entry.eventId &&
    s.game === entry.game &&
    s.track.toLowerCase() === entry.track.toLowerCase()
  );
}

function calculateIRatingDelta(entry) {
  const field = fieldForEntry(entry);
  const opponents = field.filter(s => s.id !== entry.id);
  const fieldSize = field.length;

  const myTime = timeToMs(entry.time);
  const position = field
    .map(s => timeToMs(s.time))
    .filter(t => t < myTime).length + 1;

  if (!opponents.length || !Number.isFinite(myTime)) {
    return { delta: 0, position, fieldSize };
  }

  const myRating = getRatingEntry(entry.game, entry.first, entry.last).rating;

  let expected = 0;
  let actual = 0;

  for (const opp of opponents) {
    const oppRating = getRatingEntry(opp.game, opp.first, opp.last).rating;
    expected += expectedScore(myRating, oppRating);

    const oppTime = timeToMs(opp.time);
    if (myTime < oppTime) actual += 1;
    else if (myTime > oppTime) actual += 0;
    else actual += 0.5;
  }

  expected /= opponents.length;
  actual /= opponents.length;

  const k = 32 + Math.min(32, (fieldSize - 1) * 4);
  const delta = Math.round((actual - expected) * k);

  return { delta, position, fieldSize };
}

// -------------------- Data --------------------
let scores = loadJson(DATA_FILE, []);
let attempts = loadJson(ATTEMPTS_FILE, []);
let ratings = loadJson(RATINGS_FILE, {});

let settings = loadJson(SETTINGS_FILE, {
  events: [
    { id: "evt_default", name: "Open Day Time Trial", isLive: true, createdAt: new Date().toISOString() }
  ],
  fullscreen: {
    eventId: "evt_default",
    game: "",
    followLiveEvent: true
  }
});

// -------------------- Events helpers --------------------
function getLiveEvent() {
  return settings.events.find(e => e.isLive) || settings.events[0];
}

function getEventById(id) {
  return settings.events.find(e => e.id === id);
}

function getPublicSettings() {
  const live = getLiveEvent();
  return {
    ...settings,
    liveEventId: live?.id,
    liveEventName: live?.name
  };
}

function createEvent(name) {
  const id = `evt_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`;
  const evt = {
    id,
    name: String(name || "").trim() || "Untitled Event",
    isLive: false,
    createdAt: new Date().toISOString()
  };
  settings.events.unshift(evt);
  saveSettings();
  io.emit("settingsUpdate", getPublicSettings());
  return evt;
}

function setLiveEvent(eventId) {
  settings.events = settings.events.map(e => ({ ...e, isLive: e.id === eventId }));
  if (settings.fullscreen?.followLiveEvent) settings.fullscreen.eventId = eventId;
  saveSettings();
  io.emit("settingsUpdate", getPublicSettings());
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

  const live = getLiveEvent();
  const eventIdRaw = String(data.eventId || live?.id || "evt_default").trim() || "evt_default";
  const eventId = getEventById(eventIdRaw) ? eventIdRaw : (live?.id || "evt_default");

  const score = {
    id: data.id || makeId(),
    attemptId: makeId(),

    first: String(data.first || "").trim(),
    last: String(data.last || "").trim(),
    time: String(data.time || "").trim(),
    day: String(data.day || "").trim(),
    game: String(data.game || "").trim(),
    car: String(data.car || "").trim(),
    track: String(data.track || "").trim(),

    cohort: String(data.cohort || "").trim() || "Guest",
    course: String(data.course || "").trim() || "—",

    eventId,
    createdAt: data.createdAt || new Date().toISOString()
  };

  if (!score.first || !score.last || !score.time || !score.track || !score.game) return null;
  if (score.game !== "Assetto Corsa" && score.game !== "F1 25") return null;

  return score;
}

// One row per person per game+track+event
function makeKey(s) {
  const first = String(s.first || "").trim().toLowerCase();
  const last = String(s.last || "").trim().toLowerCase();
  const game = String(s.game || "").trim();
  const track = String(s.track || "").trim().toLowerCase();
  const eventId = String(s.eventId || "").trim();
  return `${first}|${last}|${game}|${track}|${eventId}`;
}

// Duplicate guard: exact same fields within 60s
function isDuplicateAttempt(candidate) {
  const now = Date.now();
  return attempts.some(a => {
    const dt = Math.abs(now - new Date(a.createdAt).getTime());
    return dt < 60_000 &&
      a.first.toLowerCase() === candidate.first.toLowerCase() &&
      a.last.toLowerCase() === candidate.last.toLowerCase() &&
      a.game === candidate.game &&
      a.track.toLowerCase() === candidate.track.toLowerCase() &&
      a.time === candidate.time &&
      a.eventId === candidate.eventId;
  });
}

function broadcastCounts() {
  const map = {};
  for (const s of scores) map[s.eventId] = (map[s.eventId] || 0) + 1;
  io.emit("eventCounts", map);
}

function applyRatingUpdate(row) {
  const rating = getRatingEntry(row.game, row.first, row.last);
  const { delta, position, fieldSize } = calculateIRatingDelta(row);

  rating.rating = Math.max(0, rating.rating + delta);
  rating.lastChange = delta;
  rating.lastResult = fieldSize ? { position, fieldSize } : null;
  rating.updatedAt = new Date().toISOString();

  saveRatings();
  io.emit("ratingsUpdate", ratings);

  return { ratingDelta: delta, rating: rating.rating, position, fieldSize };
}

// -------------------- Core: log attempt + upsert best --------------------
function submitLap(raw) {
  const clean = sanitiseScore(raw);
  if (!clean) return { ok: false, reason: "invalid" };

  if (!isDuplicateAttempt(clean)) {
    attempts.push(clean);
    saveAttempts();
    io.emit("attemptAdded", { attemptId: clean.attemptId });
  }

  const key = makeKey(clean);
  const idx = scores.findIndex(s => makeKey(s) === key);

  if (idx === -1) {
    const row = { ...clean };
    scores.push(row);
    saveScores();
    io.emit("scoreUpdate", row);
    broadcastCounts();

    const ratingInfo = applyRatingUpdate(row);
    return { ok: true, mode: "added", ...ratingInfo };
  }

  const old = scores[idx];
  if (timeToMs(clean.time) < timeToMs(old.time)) {
    const row = { ...clean, id: old.id };
    scores[idx] = row;
    saveScores();
    io.emit("scoreReplace", row);
    broadcastCounts();

    const ratingInfo = applyRatingUpdate(row);
    return { ok: true, mode: "replaced", ...ratingInfo };
  }

  return { ok: false, reason: "not_better" };
}

// -------------------- Admin: resets / deletes --------------------
function resetEvent(eventId) {
  const beforeScores = scores.length;
  const beforeAttempts = attempts.length;

  scores = scores.filter(s => s.eventId !== eventId);
  attempts = attempts.filter(a => a.eventId !== eventId);

  const removedScores = beforeScores - scores.length;
  const removedAttempts = beforeAttempts - attempts.length;

  saveScores();
  saveAttempts();

  io.emit("clearEvent", { eventId });
  broadcastCounts();

  return { removedScores, removedAttempts };
}

function clearAll() {
  const removedScores = scores.length;
  const removedAttempts = attempts.length;

  scores = [];
  attempts = [];

  saveScores();
  saveAttempts();

  io.emit("clearAll");
  broadcastCounts();

  return { removedScores, removedAttempts };
}

function deleteLeaderboardRowById(id) {
  const before = scores.length;
  scores = scores.filter(s => s.id !== id);
  const removed = before - scores.length;
  saveScores();
  if (removed) io.emit("deleteScore", { id });
  broadcastCounts();
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

function updateLeaderboardRowTime(id, nextTime) {
  const idx = scores.findIndex(s => s.id === id);
  if (idx === -1) return { ok: false, reason: "not_found" };

  const parsed = timeToMs(nextTime);
  if (!Number.isFinite(parsed)) return { ok: false, reason: "invalid_time" };

  const row = { ...scores[idx], time: String(nextTime).trim() };
  scores[idx] = row;
  saveScores();
  io.emit("scoreReplace", row);
  broadcastCounts();

  const ratingInfo = applyRatingUpdate(row);
  return { ok: true, row, ratingInfo };
}

// -------------------- APIs --------------------
app.get("/api/settings", (req, res) => res.json(getPublicSettings()));
app.get("/api/scores", (req, res) => res.json(scores));
app.get("/api/events", (req, res) => res.json(settings.events));
app.get("/api/ratings", (req, res) => res.json(ratings));

app.get("/api/attempts", (req, res) => {
  const q = String(req.query.q || "").trim().toLowerCase();
  const limit = Math.min(parseInt(req.query.limit || "250", 10), 2000);

  const eventId = String(req.query.eventId || "").trim();
  const game = String(req.query.game || "").trim();

  let list = attempts;

  if (eventId) list = list.filter(a => a.eventId === eventId);
  if (game) list = list.filter(a => a.game === game);

  if (q) {
    list = list.filter(a => {
      const hay = `${a.first} ${a.last} ${a.track} ${a.car} ${a.game} ${a.course} ${a.cohort}`.toLowerCase();
      return hay.includes(q);
    });
  }

  list = list.slice().sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
  res.json(list.slice(0, limit));
});

// -------------------- Socket.IO --------------------
io.on("connection", (socket) => {
  socket.emit("loadScores", scores);
  socket.emit("settingsUpdate", getPublicSettings());
  socket.emit("ratingsUpdate", ratings);
  broadcastCounts();

  socket.on("newScore", (data) => {
    const result = submitLap(data);
    socket.emit("submitResult", result);
  });

  socket.on("adminPing", ({ pin }) => {
    socket.emit("adminPingResult", { ok: isAdmin(pin) });
  });

  socket.on("adminCreateEvent", ({ pin, name }) => {
    if (!isAdmin(pin)) return socket.emit("adminResult", { ok: false, action: "createEvent", reason: "denied" });
    const evt = createEvent(name);
    socket.emit("adminResult", { ok: true, action: "createEvent", event: evt });
  });

  socket.on("adminSetLiveEvent", ({ pin, eventId }) => {
    if (!isAdmin(pin)) return socket.emit("adminResult", { ok: false, action: "setLiveEvent", reason: "denied" });
    setLiveEvent(String(eventId || ""));
    socket.emit("adminResult", { ok: true, action: "setLiveEvent" });
  });

  socket.on("adminSetFullscreen", ({ pin, patch }) => {
    if (!isAdmin(pin)) return socket.emit("adminResult", { ok: false, action: "setFullscreen", reason: "denied" });

    settings.fullscreen ||= { eventId: "evt_default", game: "", followLiveEvent: true };

    if (typeof patch?.followLiveEvent === "boolean") settings.fullscreen.followLiveEvent = patch.followLiveEvent;
    if (typeof patch?.eventId === "string") settings.fullscreen.eventId = patch.eventId;
    if (typeof patch?.game === "string") settings.fullscreen.game = patch.game;

    if (settings.fullscreen.followLiveEvent) {
      const live = getLiveEvent();
      if (live?.id) settings.fullscreen.eventId = live.id;
    }

    saveSettings();
    io.emit("settingsUpdate", getPublicSettings());
    socket.emit("adminResult", { ok: true, action: "setFullscreen" });
  });

  socket.on("adminResetEventBoard", ({ pin, eventId }) => {
    if (!isAdmin(pin)) return socket.emit("adminResult", { ok: false, action: "resetEventBoard", reason: "denied" });
    const eid = String(eventId || settings.fullscreen?.eventId || getLiveEvent()?.id || "evt_default");
    const r = resetEvent(eid);
    socket.emit("adminResult", { ok: true, action: "resetEventBoard", ...r });
  });

  socket.on("adminClearAll", ({ pin }) => {
    if (!isAdmin(pin)) return socket.emit("adminResult", { ok: false, action: "clearAll", reason: "denied" });
    const r = clearAll();
    socket.emit("adminResult", { ok: true, action: "clearAll", ...r });
  });

  socket.on("adminDeleteScore", ({ pin, id }) => {
    if (!isAdmin(pin)) return socket.emit("adminResult", { ok: false, action: "deleteScore", reason: "denied" });
    const removed = deleteLeaderboardRowById(String(id || ""));
    socket.emit("adminResult", { ok: true, action: "deleteScore", removed });
  });

  socket.on("adminUpdateScore", ({ pin, id, time }) => {
    if (!isAdmin(pin)) return socket.emit("adminResult", { ok: false, action: "updateScore", reason: "denied" });
    const result = updateLeaderboardRowTime(String(id || ""), String(time || ""));
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
