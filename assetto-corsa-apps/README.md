# Assetto Corsa Telemetry Apps

This folder is a drop-in place for Assetto Corsa telemetry apps or plugins you want to copy into the game.

## Recommended Structure
Place your app folders here, then copy them into your Assetto Corsa install:

```
<Assetto Corsa>\\apps\\python\\<your_app>
<Assetto Corsa>\\apps\\python\\<your_app>\\app.py
<Assetto Corsa>\\apps\\python\\<your_app>\\ui\\...
```


If the app is a shared-memory or UDP exporter, follow its README for enabling it in Content Manager or the in-game
apps menu. For live pit wall feeds across a network, UDP is usually the best option.

## Next Step (Telemetry Wiring)
To make the `/map` and `/pitwall` pages show live data, use a telemetry exporter that outputs UDP JSON payloads
to the server on port `41234` (or set `TELEMETRY_UDP_PORT`). Example payload shape:

```json
{
  "track": "spa",
  "driver": "A. Example",
  "car": "BMW M4 GT3",
  "lap": 3,
  "lastLap": "2:18.442",
  "delta": "+0.120",
  "speed": 276,
  "throttle": 81,
  "brake": 0,
  "fuel": "18.4 L",
  "tires": "Warm",
  "ers": "N/A",
  "x": 320,
  "y": 410
}
```

Coordinates `x` and `y` map to the SVG viewBox (default `1000x560`). You can set the map track via
`/map?track=spa` or by sending a `track` field in the payload.
