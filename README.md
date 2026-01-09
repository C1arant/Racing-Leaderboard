# 🏁 Racing Leaderboard

A real-time leaderboard system designed for racing events, driving schools, and esports tournaments. Built with Node.js, Express, and Socket.IO for live updates and dynamic display modes.

## Features

### Core Functionality
- **Live Leaderboard Updates** - Real-time lap submissions and best times
- **Multiple Display Modes** - Leaderboard view, fullscreen, and admin panel
- **Event Management** - Create and manage multiple racing events
- **Demo Mode** - Auto-populate with demo data for testing and marketing

### Driver Engagement
- **ELO-lite Rating System** - Driver ratings based on PB improvements and field position
- **Spotlight Mode** - Highlight individual drivers every N seconds on fullscreen
- **Auto-scroll Broadcasting** - Smooth TV-style crawling of leaderboard
- **Lecturer Mode** - Privacy protection with configurable name anonymization

### Admin Controls
- **Preset Configurations** - One-click setup for Open Day, Tournament, Teaching, and Marketing modes
- **Fullscreen Pinning** - Pin events/games to fullscreen display
- **Session Management** - Follow live event or manual event selection
- **Cleanup Tools** - Archive old data automatically
- **Demo Controls** - Seed demo data and manage demo intervals

## Getting Started

### Prerequisites
- Node.js 16+ 
- npm or yarn
- Environment: Windows/Mac/Linux

### Installation

1. **Clone/navigate to the project:**
```bash
cd Racing-Leaderboard
```

2. **Install dependencies:**
```bash
npm install
```

3. **Start the server:**
```bash
npm start
```

The server will run on `http://localhost:3000`

### Default Credentials
- **Admin PIN:** `1234` (change via `ADMIN_PIN` environment variable)
- **Environment:** Set `PORT=3000` to change port (default: 3000)

```bash
# Custom port
PORT=8080 npm start

# Custom PIN
ADMIN_PIN=5678 npm start
```

## Project Structure

```
Racing-Leaderboard/
├── server.js              # Express + Socket.IO server
├── package.json           # Dependencies
├── scores.json            # Leaderboard data (best times per driver)
├── attempts.json          # All lap submissions (history)
├── ratings.json           # Driver rating system data
├── settings.json          # Configuration and events
├── public/
│   ├── display.html       # Main leaderboard display (searchable)
│   ├── admin.html         # Admin control panel
│   ├── fullscreen.html    # Full-screen display (TV/broadcast)
└── README.md              # This file
```

## Usage

### Display Leaderboard
- **Main Display:** `http://localhost:3000` - Searchable leaderboard with all events
- **Fullscreen:** `http://localhost:3000/fullscreen` - Full-screen TV display
- **Admin Panel:** `http://localhost:3000/admin` - Control dashboard

### Add a Lap (Admin Panel)
1. Go to Admin Panel (`/admin`)
2. Enter your PIN
3. Fill in driver info (first, last name)
4. Enter lap time in format: `m:ss.mmm` (e.g., `1:23.456`)
5. Select game, track, car, and tags
6. Click **Submit**

Result will show:
- ✅ **Added** - New driver on this track
- ✅ **Replaced** - New personal best for this driver
- ⚠️ **Not Better** - Lap was logged but didn't beat PB

### Rating System

Drivers earn rating points on lap submission:

**PB Improvement Points:**
- Formula: `clamp(round(improvement% × 400), 1, 25)`
- Example: 5% improvement = ~20 points

**Field Position Points:**
- Faster than median: +5 to +15 points
- Slower than median: 0 points (no punishment)

**Display Format:**
```
RATING 1142 ↑18    (rating increased by 18)
RATING 1125 ↓8     (rating decreased by 8)
```

### Using Presets

From the Admin Panel, click any preset button:

| Preset | Purpose | Settings |
|--------|---------|----------|
| **Open Day** | Public recruitment events | Lecturer mode ON, Spotlight ON, Auto-scroll ON, Demo OFF |
| **Tournament** | Competitive events | Lecturer mode OFF, Spotlight OFF, Auto-scroll ON, Demo OFF |
| **Teaching** | Educational/training | Lecturer mode ON, Spotlight ON, Auto-scroll OFF, Demo OFF |
| **Marketing** | Demo/attract mode | Lecturer mode ON, Spotlight ON, Auto-scroll ON, Demo ON |

### Lecturer Mode

Activate for privacy-conscious displays:

1. Admin Panel → Lecturer Mode toggle
2. Choose name display:
   - **Full name:** "Alex Turner"
   - **First initial:** "A. Turner"
   - **First + last initial:** "Alex T."
3. Guest cohort members are fully anonymized
4. Apply settings across all displays

### Auto-scroll (Fullscreen)

For TV broadcasts, enables smooth scrolling:

- **Activation:** Auto-scroll ON + Fullscreen display
- **Behavior:** Scrolls down table, pauses at bottom, scrolls back to top
- **Smart pause:** Stops when new lap submitted (15s auto-resume)
- **Customization:** 
  - Scroll rate (default: 15000ms)
  - Pause duration (default: 2000ms)

### Spotlight Mode (Fullscreen)

Highlights individual drivers to boost engagement:

- **Activation:** Spotlight ON + Fullscreen display
- **Update interval:** Default 10 seconds (customizable)
- **Highlight modes:**
  - `recent` - Most recent attempt
  - `random` - Random from top 20
  - `improved` - Most improved (placeholder for enhancement)
- **Visual:** Table dims, spotlight row gets amber highlight + ring

### Demo Mode

Generate realistic lap data automatically:

1. Admin Panel → Demo Mode toggle
2. Optional: Click **Seed 18** to pre-populate
3. New laps appear every N seconds (default: 4000ms)
4. Clear demo data: Click **Clear Demo Data**

Demo drivers are tagged with `demo: true` and can be cleared independently.

## API Endpoints

### Data Retrieval
- `GET /api/settings` - Current settings and events
- `GET /api/scores` - All leaderboard rows (best times)
- `GET /api/attempts` - All lap submissions (history)
  - Query params: `?q=name`, `?eventId=...`, `?game=...`, `?limit=250`
- `GET /api/ratings` - Driver ratings by track

### Example Queries
```bash
# Search for driver
curl "http://localhost:3000/api/attempts?q=alex"

# Get attempts for specific event
curl "http://localhost:3000/api/attempts?eventId=evt_demo&limit=100"

# Filter by game
curl "http://localhost:3000/api/attempts?game=Assetto%20Corsa"
```

## Socket.IO Events

### Client → Server
```javascript
// Submit a lap
socket.emit("newScore", {
  first: "Alex",
  last: "Turner",
  time: "1:23.456",
  game: "Assetto Corsa",
  track: "Spa-Francorchamps",
  car: "BMW M4 GT3",
  cohort: "Staff",
  course: "Games",
  eventId: "evt_default",
  createdAt: new Date().toISOString()
});

// Admin: Check PIN
socket.emit("adminPing", { pin: "1234" });

// Admin: Apply preset
socket.emit("adminPreset", { pin: "1234", preset: "openDay" });

// Admin: Toggle spotlight
socket.emit("adminSpotlight", { 
  pin: "1234", 
  enabled: true, 
  rateMs: 10000, 
  mode: "recent" 
});

// Admin: Toggle auto-scroll
socket.emit("adminAutoScroll", { 
  pin: "1234", 
  enabled: true, 
  rateMs: 15000, 
  pauseMs: 2000 
});
```

### Server → Client
```javascript
socket.on("loadScores", (scores) => { /* handle */ });
socket.on("settingsUpdate", (settings) => { /* handle */ });
socket.on("ratingsUpdate", (ratings) => { /* handle */ });
socket.on("scoreUpdate", (row) => { /* handle new row */ });
socket.on("scoreReplace", (row) => { /* handle PB */ });
socket.on("adminResult", (result) => { /* handle admin response */ });
```

## Data Files

### scores.json
Best time per driver per game/track/event:
```json
[
  {
    "id": "unique-id",
    "first": "Alex",
    "last": "Turner",
    "time": "1:23.456",
    "game": "Assetto Corsa",
    "track": "Spa-Francorchamps",
    "car": "BMW M4 GT3",
    "cohort": "Staff",
    "course": "Games",
    "eventId": "evt_default",
    "createdAt": "2026-01-09T10:00:00Z",
    "demo": false
  }
]
```

### ratings.json
Driver ratings by track:
```json
{
  "Assetto Corsa|spa-francorchamps|alex|turner": {
    "rating": 1042,
    "lastChange": 12,
    "updatedAt": "2026-01-09T10:00:00Z"
  }
}
```

### settings.json
Configuration, events, and display settings:
```json
{
  "events": [
    {
      "id": "evt_default",
      "name": "General Leaderboard",
      "isLive": true,
      "createdAt": "2026-01-09T09:00:00Z"
    }
  ],
  "lecturerMode": false,
  "privacy": { "nameMode": "FULL", "hideCourse": false },
  "autoScroll": false,
  "autoScrollRateMs": 15000,
  "autoScrollPauseMs": 2000,
  "spotlight": false,
  "spotlightRateMs": 10000,
  "spotlightMode": "recent",
  "demoEnabled": false,
  "fullscreen": {
    "eventId": "evt_default",
    "game": "",
    "followLiveEvent": true
  }
}
```

## Development

### File Organization
- **Backend:** `server.js` (all server logic)
- **Frontend:** HTML files with embedded JavaScript (no build step)
- **Data:** JSON files auto-created/updated
- **Dependencies:** Minimal - express, socket.io only

### Making Changes

1. **Rating calculation:** Edit `calculateRatingDelta()` in `server.js`
2. **Display format:** Modify HTML in `public/` files
3. **Event handlers:** Add socket listeners in `server.js`
4. **Styling:** Edit Tailwind CSS classes in HTML (uses CDN)

### Testing Locally

```bash
# Start server with custom PIN for testing
ADMIN_PIN=test123 npm start

# In another terminal, test API
curl http://localhost:3000/api/scores

# Submit test lap via admin panel
# http://localhost:3000/admin
```

## Troubleshooting

### Port Already in Use
```bash
# Kill process on port 3000
taskkill /F /IM node.exe  # Windows
# or
lsof -ti:3000 | xargs kill -9  # Mac/Linux
```

### Server Won't Start
- Check `package.json` exists
- Run `npm install` 
- Check Node version: `node --version` (16+)
- Check file permissions on JSON files

### Data Not Persisting
- Verify write permissions to project directory
- Check JSON files aren't corrupted (valid JSON?)
- Ensure `scores.json`, `attempts.json`, `ratings.json`, `settings.json` exist

### Ratings Not Showing
- Submit a lap first to generate ratings
- Check browser console for errors (F12)
- Verify `ratings.json` has content

## Collaboration Guidelines

### Before Making Changes
1. Create a branch for your feature: `git checkout -b feature/your-feature`
2. Test locally before pushing
3. Keep changes focused on one feature/fix

### Code Style
- Use 2-space indentation
- Follow existing code patterns
- Add comments for complex logic
- Keep functions focused and small

### Commit Messages
- Clear, descriptive messages
- Reference issues if applicable
- Example: `Add lecturer mode display toggle`

### Testing Checklist
- [ ] Server starts without errors
- [ ] Can access all three displays (/, /admin, /fullscreen)
- [ ] Admin PIN works
- [ ] Can submit a lap
- [ ] Ratings display correctly
- [ ] Presets apply settings
- [ ] Demo mode toggles and seeds data

## Future Enhancements

Potential features for development:

1. **Most Improved Tracking** - Enhanced spotlight mode to highlight biggest improvers
2. **Leaderboard History** - Time-based snapshots of rankings
3. **Custom Themes** - Admin-controlled color schemes
4. **API Authentication** - OAuth/token-based access for external integrations
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
