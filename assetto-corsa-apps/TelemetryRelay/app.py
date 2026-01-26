import ac
import acsys
import json
import socket
import time

APP_NAME = "TelemetryRelay"

UDP_HOST = "127.0.0.1"
UDP_PORT = 41234
SEND_INTERVAL = 0.1

_sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
_last_send = 0.0
_label = None


def _format_lap_time(seconds):
    if seconds is None or seconds <= 0:
        return ""
    minutes = int(seconds // 60)
    remainder = seconds - minutes * 60
    return "%d:%06.3f" % (minutes, remainder)


def _get_track_name():
    try:
        return ac.getTrackName(0)
    except Exception:
        return ""


def _get_driver_name():
    try:
        return ac.getDriverName(0)
    except Exception:
        return ""


def _get_car_name():
    try:
        return ac.getCarName(0)
    except Exception:
        return ""


def acMain(ac_version):
    global _label
    app = ac.newApp(APP_NAME)
    ac.setTitle(app, APP_NAME)
    ac.setSize(app, 320, 80)
    ac.drawBorder(app, 0)
    ac.setIconPosition(app, 0, -10000)
    _label = ac.addLabel(app, "Sending telemetry to %s:%s" % (UDP_HOST, UDP_PORT))
    ac.setPosition(_label, 12, 32)
    return APP_NAME


def acUpdate(delta_t):
    global _last_send
    now = time.time()
    if now - _last_send < SEND_INTERVAL:
        return
    _last_send = now

    try:
        speed = ac.getCarState(0, acsys.CS.SpeedKMH)
        throttle = ac.getCarState(0, acsys.CS.Gas)
        brake = ac.getCarState(0, acsys.CS.Brake)
        lap = ac.getCarState(0, acsys.CS.LapCount)
        last_lap = ac.getCarState(0, acsys.CS.LastLap)
        pos = ac.getCarState(0, acsys.CS.WorldPosition)
        x = pos[0] if len(pos) > 0 else 0
        y = pos[2] if len(pos) > 2 else 0

        payload = {
            "track": _get_track_name().lower(),
            "driver": _get_driver_name(),
            "car": _get_car_name(),
            "lap": int(lap) if lap is not None else 0,
            "lastLap": _format_lap_time(last_lap),
            "delta": "",
            "speed": int(speed) if speed is not None else 0,
            "throttle": int((throttle or 0) * 100),
            "brake": int((brake or 0) * 100),
            "x": x,
            "y": y
        }

        _sock.sendto(json.dumps(payload).encode("utf-8"), (UDP_HOST, UDP_PORT))
    except Exception as err:
        if _label:
            ac.setText(_label, "Telemetry error: %s" % err)
