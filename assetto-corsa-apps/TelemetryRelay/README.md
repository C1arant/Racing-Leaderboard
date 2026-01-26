# Telemetry Relay (Assetto Corsa Python App)

This is a minimal Assetto Corsa Python app that sends live telemetry to the Racing Leaderboard server via UDP.

## Install
Copy this folder into your Assetto Corsa install:

```
<Assetto Corsa>\apps\python\TelemetryRelay
```

Enable **TelemetryRelay** in Content Manager or the in-game Apps list.

## Configure
Open `app.py` and set:

```
UDP_HOST = "YOUR_SERVER_IP"
UDP_PORT = 41234
SEND_INTERVAL = 0.1  # seconds (10 Hz)
```

`UDP_HOST` should be the IP address of the machine running the Node server.

## Payload
The app emits JSON packets like:

```json
{
  "track": "spa",
  "driver": "First Last",
  "car": "BMW M4 GT3",
  "lap": 3,
  "lastLap": "2:18.442",
  "delta": "+0.120",
  "speed": 276,
  "throttle": 81,
  "brake": 0,
  "x": 320,
  "y": 410
}
```

Coordinates `x` and `y` are world-position values mapped to the top-down track map. You can
customize scaling inside `app.py` if you want tighter alignment.
