# Track Map Definitions

Track map files live here as JSON. Each file describes the SVG path and viewBox for a track.

Example schema:
```json
{
  "id": "spa",
  "name": "Spa-Francorchamps",
  "viewBox": "0 0 1000 560",
  "path": "M140,340 C110,250 130,160 200,120 ..."
}
```

The `/map` page loads these definitions and renders the path. Use the query string to select
another track: `/map?track=spa`.
