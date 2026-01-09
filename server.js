// server.js (ESM) — Racing Leaderboard
// Run: npm start
import express from "express";
import http from "http";
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

const DATA_FILE = path.join(__dirname, "scores.json");        // clean leaderboard rows
const ATTEMPTS_FILE = path.join(__dirname, "attempts.json");  // full history
const SETTINGS_FILE = path.join(__dirname, "settings.json");

const ADMIN_PIN = process.env.ADMIN_PIN || "1234";

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

function isAdmin(pin) { return String(pin || "") === String(ADMIN_PIN); }
function makeId() {
  return (globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(16).slice(2)}`);
}

// -------------------- State --------------------
let scores = loadJson(DATA_FILE, []);
let attempts = loadJson(ATTEMPTS_FILE, []);

let settings = loadJson(SETTINGS_FILE, {
  events: [
    { id: "evt_default", name: "Open Day Time Trial", isLive: true, createdAt: new Date().toISOString() }
  ],
  bestPerDriver: true,

  fullscreen: {
    eventId: "evt_default",
    game: "",               // ""=Mixed, "Assetto Corsa", "F1 25"
    followLiveEvent: true,
    useTvCycle: false
  },

  tvCycleEnabled: false,
  tvCycleRateMs: 15000,

  demoEnabled: false,
  demoRateMs: 4000
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
  const evt = { id, name: String(name || "").trim() || "Untitled Event", isLive: false, createdAt: new Date().toISOString() };
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
    id: data.id || makeId(),        // leaderboard row id
    attemptId: makeId(),            // always unique attempt id

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
    createdAt: data.createdAt || new Date().toISOString(),

    demo: !!data.demo
  };

  if (!score.first || !score.last || !score.time || !score.track || !score.game) return null;
  if (score.game !== "Assetto Corsa" && score.game !== "F1 25") return null;

  return score;
}

// One row per person per game+track+event
function makeKey(s) {
  const first = String(s.first || "").trim().toLowerCase();
  const last  = String(s.last || "").trim().toLowerCase();
  const game  = String(s.game || "").trim();
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

// -------------------- Core: log attempt + upsert best --------------------
function submitLap(raw) {
  const clean = sanitiseScore(raw);
  if (!clean) return { ok: false, reason: "invalid" };

  // Always log attempts for student search (ALL events)
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
    return { ok: true, mode: "added" };
  }

  const old = scores[idx];
  if (timeToMs(clean.time) < timeToMs(old.time)) {
    const row = { ...clean, id: old.id }; // keep row id stable
    scores[idx] = row;
    saveScores();
    io.emit("scoreReplace", row);
    broadcastCounts();
    return { ok: true, mode: "replaced" };
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

function clearDemoData() {
  const beforeScores = scores.length;
  const beforeAttempts = attempts.length;

  scores = scores.filter(s => !s.demo);
  attempts = attempts.filter(a => !a.demo);

  const removedScores = beforeScores - scores.length;
  const removedAttempts = beforeAttempts - attempts.length;

  saveScores();
  saveAttempts();

  io.emit("clearDemo");
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

// -------------------- Cleanup (NEW) --------------------
function cleanupOldData(olderThanDays, alsoScores = false) {
  const days = Number(olderThanDays);
  const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;

  const beforeAttempts = attempts.length;
  attempts = attempts.filter(a => new Date(a.createdAt).getTime() >= cutoff);
  const removedAttempts = beforeAttempts - attempts.length;

  let removedScores = undefined;
  if (alsoScores) {
    const beforeScores = scores.length;
    scores = scores.filter(s => new Date(s.createdAt).getTime() >= cutoff);
    removedScores = beforeScores - scores.length;
    saveScores();
    io.emit("loadScores", scores); // refresh clients
    broadcastCounts();
  }

  saveAttempts();
  return { removedAttempts, removedScores };
}

// -------------------- Demo + TV cycle --------------------
let demoInterval = null;
let tvCycleInterval = null;

const demoDrivers = [
  ["Alex", "Turner"], ["Maya", "Singh"], ["Jordan", "Evans"], ["Sam", "Walker"],
  ["Chris", "Patel"], ["Ellie", "Jones"], ["Noah", "Reed"], ["Priya", "Shah"],
  ["Liam", "Carter"], ["Zoe", "Bennett"], ["Owen", "Clarke"], ["Ava", "Hughes"]
];
const acCars = ["BMW M4 GT3","Ferrari 488 GT3","Porsche 911 GT3 R","McLaren 720S GT3","Audi R8 LMS GT3"];
const acTracks = ["Spa-Francorchamps","Monza","Silverstone GP","Imola","Nürburgring GP"];
const f1Cars = ["Red Bull","Ferrari","Mercedes","McLaren","Aston Martin"];
const f1Tracks = ["Silverstone","Suzuka","Bahrain","Monza","Interlagos"];
const cohorts = ["Staff","Y1","Y2","Y3","Guest"];
const courses = ["Games","Computing","Animation","Esports"];
const rand = (arr) => arr[Math.floor(Math.random() * arr.length)];

function genLapTime(game) {
  const m = 1;
  const s = game === "Assetto Corsa" ? (10 + Math.floor(Math.random() * 50)) : (15 + Math.floor(Math.random() * 40));
  const ms = Math.floor(Math.random() * 1000).toString().padStart(3, "0");
  return `${m}:${String(s).padStart(2, "0")}.${ms}`;
}

function pushDemoOne(seedEventId) {
  const game = Math.random() < 0.5 ? "Assetto Corsa" : "F1 25";
  const [first, last] = rand(demoDrivers);

  submitLap({
    first, last,
    time: genLapTime(game),
    day: new Date().toLocaleDateString("en-GB", { weekday: "short" }),
    game,
    car: game === "Assetto Corsa" ? rand(acCars) : rand(f1Cars),
    track: game === "Assetto Corsa" ? rand(acTracks) : rand(f1Tracks),
    cohort: rand(cohorts),
    course: rand(courses),
    eventId: seedEventId || (getLiveEvent()?.id ?? "evt_default"),
    createdAt: new Date().toISOString(),
    demo: true
  });
}

function setDemo(enabled, rateMs = 4000, seed = false) {
  settings.demoEnabled = !!enabled;
  settings.demoRateMs = Number(rateMs || 4000);
  saveSettings();
  io.emit("settingsUpdate", getPublicSettings());

  if (demoInterval) clearInterval(demoInterval);
  demoInterval = null;

  if (enabled) {
    const targetEventId = getLiveEvent()?.id ?? "evt_default";
    if (seed) for (let i = 0; i < 18; i++) pushDemoOne(targetEventId);
    demoInterval = setInterval(() => pushDemoOne(targetEventId), settings.demoRateMs);
  }
}

function setTvCycle(enabled, rateMs = 15000) {
  settings.tvCycleEnabled = !!enabled;
  settings.tvCycleRateMs = Number(rateMs || 15000);
  saveSettings();
  io.emit("settingsUpdate", getPublicSettings());

  if (tvCycleInterval) clearInterval(tvCycleInterval);
  tvCycleInterval = null;

  if (enabled) {
    const cycle = ["", "Assetto Corsa", "F1 25"];
    let idx = 0;
    tvCycleInterval = setInterval(() => {
      idx = (idx + 1) % cycle.length;
      io.emit("tvCycleStep", { game: cycle[idx] });
    }, settings.tvCycleRateMs);
  }
}

// Restore intervals
if (settings.demoEnabled) setDemo(true, settings.demoRateMs, false);
if (settings.tvCycleEnabled) setTvCycle(true, settings.tvCycleRateMs);

// -------------------- APIs --------------------
app.get("/api/settings", (req, res) => res.json(getPublicSettings()));
app.get("/api/scores", (req, res) => res.json(scores));
app.get("/api/events", (req, res) => res.json(settings.events));

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
  broadcastCounts();

  socket.on("newScore", (data) => {
    const result = submitLap(data);
    socket.emit("submitResult", result);
  });

  socket.on("adminPing", ({ pin }) => {
    socket.emit("adminPingResult", { ok: isAdmin(pin) });
  });

  // Settings
  socket.on("adminUpdateSettings", ({ pin, patch }) => {
    if (!isAdmin(pin)) return socket.emit("adminResult", { ok: false, action: "updateSettings", reason: "denied" });

    if (typeof patch?.bestPerDriver === "boolean") settings.bestPerDriver = patch.bestPerDriver;

    saveSettings();
    io.emit("settingsUpdate", getPublicSettings());
    socket.emit("adminResult", { ok: true, action: "updateSettings" });
  });

  // Events
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

  // Fullscreen pin
  socket.on("adminSetFullscreen", ({ pin, patch }) => {
    if (!isAdmin(pin)) return socket.emit("adminResult", { ok: false, action: "setFullscreen", reason: "denied" });

    settings.fullscreen ||= { eventId: "evt_default", game: "", followLiveEvent: true, useTvCycle: false };

    if (typeof patch?.followLiveEvent === "boolean") settings.fullscreen.followLiveEvent = patch.followLiveEvent;
    if (typeof patch?.useTvCycle === "boolean") settings.fullscreen.useTvCycle = patch.useTvCycle;

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

  // Reset selected event board
  socket.on("adminResetEventBoard", ({ pin, eventId }) => {
    if (!isAdmin(pin)) return socket.emit("adminResult", { ok: false, action: "resetEventBoard", reason: "denied" });
    const eid = String(eventId || settings.fullscreen?.eventId || getLiveEvent()?.id || "evt_default");
    const r = resetEvent(eid);
    socket.emit("adminResult", { ok: true, action: "resetEventBoard", ...r });
  });

  // Cleanup (NEW)
  socket.on("adminCleanup", ({ pin, olderThanDays, alsoScores }) => {
    if (!isAdmin(pin)) return socket.emit("adminResult", { ok: false, action: "cleanup", reason: "denied" });

    const days = Number(olderThanDays || 90);
    if (!Number.isFinite(days) || days <= 0) {
      return socket.emit("adminResult", { ok: false, action: "cleanup", reason: "bad_days" });
    }

    const r = cleanupOldData(days, !!alsoScores);
    socket.emit("adminResult", { ok: true, action: "cleanup", ...r });
  });

  // Clear everything
  socket.on("adminClearAll", ({ pin }) => {
    if (!isAdmin(pin)) return socket.emit("adminResult", { ok: false, action: "clearAll", reason: "denied" });
    const r = clearAll();
    socket.emit("adminResult", { ok: true, action: "clearAll", ...r });
  });

  // Demo controls
  socket.on("adminDemo", ({ pin, enabled, seed, rateMs }) => {
    if (!isAdmin(pin)) return socket.emit("adminResult", { ok: false, action: "demo", reason: "denied" });
    setDemo(!!enabled, Number(rateMs || 4000), !!seed);
    socket.emit("adminResult", { ok: true, action: "demo" });
  });

  socket.on("adminClearDemo", ({ pin }) => {
    if (!isAdmin(pin)) return socket.emit("adminResult", { ok: false, action: "clearDemo", reason: "denied" });
    const r = clearDemoData();
    socket.emit("adminResult", { ok: true, action: "clearDemo", ...r });
  });

  // TV cycle
  socket.on("adminTvCycle", ({ pin, enabled, rateMs }) => {
    if (!isAdmin(pin)) return socket.emit("adminResult", { ok: false, action: "tv", reason: "denied" });
    setTvCycle(!!enabled, Number(rateMs || 15000));
    socket.emit("adminResult", { ok: true, action: "tv" });
  });

  // Delete one leaderboard row
  socket.on("adminDeleteScore", ({ pin, id }) => {
    if (!isAdmin(pin)) return socket.emit("adminResult", { ok: false, action: "deleteScore", reason: "denied" });
    const removed = deleteLeaderboardRowById(String(id || ""));
    socket.emit("adminResult", { ok: true, action: "deleteScore", removed });
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Server running: http://localhost:${PORT}`));
