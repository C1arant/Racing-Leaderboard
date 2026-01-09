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

// ---- Static + routes ----
app.use(express.static(path.join(__dirname, "public")));

app.get("/", (req, res) => res.sendFile(path.join(__dirname, "public", "display.html")));
app.get("/admin", (req, res) => res.sendFile(path.join(__dirname, "public", "admin.html")));
app.get("/fullscreen", (req, res) => res.sendFile(path.join(__dirname, "public", "fullscreen.html")));

app.get("/api/scores", (req, res) => res.json(scores));
app.get("/api/settings", (req, res) => res.json(settings));

// ---- Files ----
const DATA_FILE = path.join(__dirname, "scores.json");
const SETTINGS_FILE = path.join(__dirname, "settings.json");

// Set this at work:
// PowerShell: setx ADMIN_PIN "4321"   (then reopen terminal)
// Default if unset:
const ADMIN_PIN = process.env.ADMIN_PIN || "1234";

// ---- Persistence helpers ----
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

// ---- State ----
let scores = loadJson(DATA_FILE, []);
let settings = loadJson(SETTINGS_FILE, {
  eventName: "Open Practice",
  bestPerDriver: true,      // display mode (clients can still decide, but we broadcast it)
  tvCycleEnabled: false,
  tvCycleRateMs: 15000,
  demoEnabled: false,
  demoRateMs: 4000
});

function saveScores() { saveJson(DATA_FILE, scores); }
function saveSettings() { saveJson(SETTINGS_FILE, settings); }

function isAdmin(pin) {
  return String(pin || "") === String(ADMIN_PIN);
}

function makeId() {
  // Node 22+ has crypto.randomUUID available globally
  return (globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(16).slice(2)}`);
}

// ---- Time parsing ----
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

// ---- Score sanitise ----
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
    event: String(data.event || settings.eventName).trim() || settings.eventName,
    createdAt: data.createdAt || new Date().toISOString(),
  };

  if (!score.first || !score.last || !score.time || !score.track || !score.game) return null;
  if (score.game !== "Assetto Corsa" && score.game !== "F1 25") return null;

  return score;
}

// Bucket rule: one row per person per game+track+event
function makeKey(s) {
  const first = String(s.first || "").trim().toLowerCase();
  const last  = String(s.last || "").trim().toLowerCase();
  const game  = String(s.game || "").trim();
  const track = String(s.track || "").trim().toLowerCase();
  const event = String(s.event || "").trim();
  return `${first}|${last}|${game}|${track}|${event}`;
}

// Duplicate guard: identical submits within 60 seconds
function isDuplicate(candidate) {
  const now = Date.now();
  return scores.some(s => {
    const dt = Math.abs(now - new Date(s.createdAt).getTime());
    return dt < 60_000 &&
      s.first.toLowerCase() === candidate.first.toLowerCase() &&
      s.last.toLowerCase() === candidate.last.toLowerCase() &&
      s.game === candidate.game &&
      s.track.toLowerCase() === candidate.track.toLowerCase() &&
      s.time === candidate.time &&
      s.event === candidate.event;
  });
}

function broadcastCounts() {
  const map = {};
  for (const s of scores) map[s.event] = (map[s.event] || 0) + 1;
  io.emit("eventCounts", map);
}

// ---- Core behavior: upsert best (no duplicate names) ----
function upsertBestScore(rawScore) {
  const clean = sanitiseScore(rawScore);
  if (!clean) return { ok: false, reason: "invalid" };

  if (isDuplicate(clean)) return { ok: false, reason: "duplicate" };

  const key = makeKey(clean);
  const idx = scores.findIndex(s => makeKey(s) === key);

  if (idx === -1) {
    scores.push(clean);
    saveScores();
    io.emit("scoreUpdate", clean); // new row
    broadcastCounts();
    return { ok: true, mode: "added" };
  }

  const old = scores[idx];

  // Replace only if better
  if (timeToMs(clean.time) < timeToMs(old.time)) {
    clean.id = old.id; // keep same id for replace
    scores[idx] = clean;
    saveScores();
    io.emit("scoreReplace", clean); // replace row
    broadcastCounts();
    return { ok: true, mode: "replaced" };
  }

  // Not better -> ignore (keeps board clean)
  return { ok: false, reason: "not_better" };
}

// ---- Admin actions ----
function clearScoresForEvent(eventName) {
  const before = scores.length;
  scores = scores.filter(s => s.event !== eventName);
  const removed = before - scores.length;
  saveScores();
  io.emit("clearEvent", { eventName });
  broadcastCounts();
  return removed;
}

function clearAllScores() {
  const removed = scores.length;
  scores = [];
  saveScores();
  io.emit("clearAll");
  broadcastCounts();
  return removed;
}

function deleteScoreById(id) {
  const before = scores.length;
  scores = scores.filter(s => s.id !== id);
  const removed = before - scores.length;
  saveScores();
  if (removed) io.emit("deleteScore", { id });
  broadcastCounts();
  return removed;
}

// ---- Demo + TV cycle ----
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
  if (game === "Assetto Corsa") {
    const m = 1 + Math.floor(Math.random() * 2);
    const s = 10 + Math.floor(Math.random() * 50);
    const ms = Math.floor(Math.random() * 1000).toString().padStart(3, "0");
    return `${m}:${String(s).padStart(2, "0")}.${ms}`;
  } else {
    const m = 1;
    const s = 15 + Math.floor(Math.random() * 40);
    const ms = Math.floor(Math.random() * 1000).toString().padStart(3, "0");
    return `${m}:${String(s).padStart(2, "0")}.${ms}`;
  }
}

function pushDemoOne() {
  const game = Math.random() < 0.5 ? "Assetto Corsa" : "F1 25";
  const [first, last] = rand(demoDrivers);

  upsertBestScore({
    first, last,
    time: genLapTime(game),
    day: new Date().toLocaleDateString("en-GB", { weekday: "short" }),
    game,
    car: game === "Assetto Corsa" ? rand(acCars) : rand(f1Cars),
    track: game === "Assetto Corsa" ? rand(acTracks) : rand(f1Tracks),
    cohort: rand(cohorts),
    course: rand(courses),
    event: settings.eventName,
    createdAt: new Date().toISOString()
  });
}

function setDemo(enabled, rateMs = 4000, seed = false) {
  settings.demoEnabled = !!enabled;
  settings.demoRateMs = Number(rateMs || 4000);
  saveSettings();

  if (demoInterval) clearInterval(demoInterval);
  demoInterval = null;

  if (enabled) {
    if (seed) for (let i = 0; i < 18; i++) pushDemoOne();
    demoInterval = setInterval(pushDemoOne, settings.demoRateMs);
  }

  io.emit("settingsUpdate", settings);
}

function setTvCycle(enabled, rateMs = 15000) {
  settings.tvCycleEnabled = !!enabled;
  settings.tvCycleRateMs = Number(rateMs || 15000);
  saveSettings();

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

  io.emit("settingsUpdate", settings);
}

// Restore intervals on boot
if (settings.demoEnabled) setDemo(true, settings.demoRateMs, false);
if (settings.tvCycleEnabled) setTvCycle(true, settings.tvCycleRateMs);

// ---- Socket.IO ----
io.on("connection", (socket) => {
  socket.emit("loadScores", scores);
  socket.emit("settingsUpdate", settings);
  broadcastCounts();

  // Student/staff submission
  socket.on("newScore", (data) => {
    const result = upsertBestScore(data);
    socket.emit("submitResult", result);
  });

  // PIN validation
  socket.on("adminPing", ({ pin }) => {
    socket.emit("adminPingResult", { ok: isAdmin(pin) });
  });

  // Settings update
  socket.on("adminUpdateSettings", ({ pin, patch }) => {
    if (!isAdmin(pin)) return socket.emit("adminResult", { ok: false, action: "updateSettings", reason: "denied" });

    if (typeof patch?.eventName === "string") settings.eventName = patch.eventName.trim() || "Open Practice";
    if (typeof patch?.bestPerDriver === "boolean") settings.bestPerDriver = patch.bestPerDriver;

    saveSettings();
    io.emit("settingsUpdate", settings);
    socket.emit("adminResult", { ok: true, action: "updateSettings" });
  });

  // Demo
  socket.on("adminDemo", ({ pin, enabled, seed, rateMs }) => {
    if (!isAdmin(pin)) return socket.emit("adminResult", { ok: false, action: "demo", reason: "denied" });
    setDemo(!!enabled, Number(rateMs || 4000), !!seed);
    socket.emit("adminResult", { ok: true, action: "demo" });
  });

  // TV cycle
  socket.on("adminTvCycle", ({ pin, enabled, rateMs }) => {
    if (!isAdmin(pin)) return socket.emit("adminResult", { ok: false, action: "tv", reason: "denied" });
    setTvCycle(!!enabled, Number(rateMs || 15000));
    socket.emit("adminResult", { ok: true, action: "tv" });
  });

  // Clear event
  socket.on("adminClearEvent", ({ pin, eventName }) => {
    if (!isAdmin(pin)) return socket.emit("adminResult", { ok: false, action: "clearEvent", reason: "denied" });
    const removed = clearScoresForEvent(String(eventName || settings.eventName));
    socket.emit("adminResult", { ok: true, action: "clearEvent", removed });
  });

  // Clear all
  socket.on("adminClearAll", ({ pin }) => {
    if (!isAdmin(pin)) return socket.emit("adminResult", { ok: false, action: "clearAll", reason: "denied" });
    const removed = clearAllScores();
    socket.emit("adminResult", { ok: true, action: "clearAll", removed });
  });

  // Delete one score
  socket.on("adminDeleteScore", ({ pin, id }) => {
    if (!isAdmin(pin)) return socket.emit("adminResult", { ok: false, action: "deleteScore", reason: "denied" });
    const removed = deleteScoreById(String(id || ""));
    socket.emit("adminResult", { ok: true, action: "deleteScore", removed });
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Server running: http://localhost:${PORT}`));
// ---- Static + routes ----