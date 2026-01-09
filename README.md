socket.on("settingsUpdate", (settings) => { /* handle */ });
socket.on("ratingsUpdate", (ratings) => { /* handle */ });
socket.on("scoreUpdate", (row) => { /* handle new row */ });
socket.on("scoreReplace", (row) => { /* handle PB */ });
socket.on("adminResult", (result) => { /* handle admin response */ });
# Racing Leaderboard

Racing Leaderboard is a production-focused, in‑building live leaderboard system for Time Trial events, esports, and teaching labs. It uses Node.js + Express + Socket.IO for real-time updates and simple JSON persistence for lightweight deployments.

Key principles:
- Low-friction setup (no build step)
- Reliable local hosting for campus signage
- Privacy-first display options for teaching environments

---

## Highlights
- Real-time leaderboard with best-per-driver logic and attempt history
- ELO-lite driver ratings that reward PB improvements and field position
- Three display modes: Admin, Main Display, Fullscreen (TV)
- Lecturer mode (name anonymization) and other privacy controls
- Rig submission support: local rig PCs can POST laps (with key) and queue offline

---

## Quick Start

Requirements
- Node.js 16+ and npm

Install and run
```powershell
npm install
npm start
```
Open these URLs on your network:
- Admin: `http://<host>:<port>/admin`
- Display: `http://<host>:<port>/`
- Fullscreen (TV): `http://<host>:<port>/fullscreen`
- Rig UI (rig PC): `http://<host>:<port>/rig`

Environment variables
- `ADMIN_PIN` — admin PIN for socket actions (default `1234`)
- `RIG_KEY` — shared secret for rig POST submissions (required for rig POST)
- `PORT` — server port (default `3000`)

Example (PowerShell)
```powershell
$env:ADMIN_PIN = '1234'
$env:RIG_KEY = 'your_rig_key_here'
npm start
```

---

## Architecture & Files

Top-level files
- `server.js` — Express + Socket.IO server (ES module)
- `public/` — UI pages (no build step; Tailwind via CDN)
- `scores.json`, `attempts.json`, `ratings.json`, `settings.json` — runtime data persisted as JSON

Public pages
- `/` — Main searchable display (`public/display.html`)
- `/fullscreen` — Clean fullscreen TV view (`public/fullscreen.html`)
- `/admin` — Control desk with presets and tools (`public/admin.html`)
- `/rig` — Rig session UI for PC rigs (`public/rig.html`)

APIs
- `GET /api/settings` — public settings + live event info
- `GET /api/scores` — leaderboard rows
- `GET /api/attempts` — submission history (queryable)
- `GET /api/ratings` — ratings map
- `POST /api/submit-lap` — rig submission endpoint (requires `X-Rig-Key` header)
- `POST /api/rig/flush` — admin import of queued laps (requires `X-Admin-Pin`)

---

## Rig Integration (Overview)

Rigs (single-PC Assetto Corsa setups) submit laps to `/api/submit-lap` using the `X-Rig-Key` header. The server validates and logs attempts, and applies leaderboard best-per-driver rules. If a rig cannot reach the server, the rig helper queues laps locally and retries later, or an admin can upload a `pending_laps.json` using the admin UI.

Security
- Rig submissions require a matching `RIG_KEY` header and can be enabled/disabled by admins.
- Admin actions require the `ADMIN_PIN`.

---

## Operational Notes

- The UI is designed for in‑building networks; WebSockets power live updates but HTTP POSTs are used for rig submissions to tolerate flaky networks.
- Duplicate attempts within 60s are ignored to reduce accidental spam.
- Time format accepted: `m:ss.mmm` or `s.mmm` (e.g. `1:23.456` or `83.456`).

---

## Contributing

- Create a branch per feature and open a PR with focused changes.
- Keep UI changes within `public/` and logic in `server.js`.

---

If you'd like, I can now apply small visual polish to the three public pages (`admin.html`, `display.html`, `fullscreen.html`) to improve spacing, header consistency, and accessibility.
5. **Driver Profiles** - Per-driver stats and achievement badges
6. **Multiplayer Events** - Cross-track/game tournaments
7. **Mobile Companion** - Responsive mobile interface
8. **Analytics Dashboard** - Event statistics and insights

## Support & Issues

For questions or bugs:
1. Check existing issues on the repository
2. Create a detailed issue with steps to reproduce
3. Include server version (`npm list express socket.io`)
4. Attach relevant JSON file content (anonymized)

## License

[Your License Here]

## Contributors

- **Ciara** - Project founder and maintainer
- Staff collaborators welcome!

---

**Last Updated:** January 9, 2026
**Server Version:** 1.0.0 with Rating System & Display Modes
