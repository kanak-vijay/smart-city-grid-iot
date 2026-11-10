# MQTT Contract

This document defines how every part of the system (ESP32 node, Wokwi simulated zones, backend and dashboard) communicates: which topics are used and what each payload looks like.

## Broker
- Host: `broker.hivemq.com`, Port: `1883` (TCP)
- All topics use the prefix `scg-bmu26/`
- Every MQTT client must use a unique `clientId` (for example `zoneA-1a2b`). The broker disconnects an older client that uses the same ID.

## Zones and adjacency map
Zones: A, B, C (Wokwi simulated) and D (real ESP32)

| Zone | Neighbours |
|---|---|
| A | B |
| B | A, C |
| C | B, D |
| D | C |

## 1. Zone data (node to broker)
Topic: `scg-bmu26/zone/<A|B|C|D>/data`

Publish rule: every 2 seconds, and immediately when the node's state changes.

```json
{
  "zone": "D",
  "state": "normal",
  "gas": 900,
  "fire": 0,
  "water": 20.0,
  "gas_alert": 0,
  "fire_alert": 0,
  "flood_alert": 0
}
```

| Field | Type | Meaning |
|---|---|---|
| zone | string | A, B, C or D |
| state | string | `normal` or `critical` (decided locally by the node) |
| gas | number | Moving average of the MQ2 reading, ESP32 ADC scale 0-4095 |
| fire | 0/1 | 1 = flame detected (latest reading) |
| water | number | Distance to the water surface in cm (lower = water is higher) |
| gas_alert, fire_alert, flood_alert | 0/1 | Hazard confirmed after 3 consecutive threshold crossings |

## 2. Detection logic (runs locally on each node)
1. Read the raw sensor value.
2. Compute a moving average over the last 10 readings to remove noise and spikes.
3. Compare the average with the threshold.
4. Confirm the hazard only after 3 consecutive readings cross the threshold, to avoid false alarms.
5. On confirmation, switch on the local actuators (buzzer and servo valve) immediately, without waiting for the network, and publish `state: critical`.

| Hazard | Sensor | Threshold |
|---|---|---|
| Gas leak | MQ2 | Moving average > 1400 (baseline about 900 after warm-up, up to 1800 on cold start) |
| Fire | Flame / IR sensor | Digital LOW = fire |
| Flood | HC-SR04 | Moving average distance < 5 cm (normal about 20 cm) |

Clearing uses hysteresis to prevent the alarm from flickering: gas must drop 100-200 below its threshold, and flood distance must rise 3 cm above its threshold.

## 3. Backend output (cascading logic to broker)
Topic: `scg-bmu26/zone/<X>/status` (retained)

```json
{ "zone": "B", "status": "warning", "reason": "neighbour C critical", "ts": 1760000000000 }
```

`status` is one of `normal`, `warning`, `critical` or `offline`.

Topic: `scg-bmu26/city/status` (retained)

```json
{ "mode": "emergency", "critical_zones": ["C", "D"], "risk_score": 70, "ts": 1760000000000 }
```

`mode` is `normal` or `emergency` (emergency when 2 or more zones are critical).

Rules applied by the backend:
- A zone whose own sensors are critical is `critical`.
- A zone with a critical neighbour (from the adjacency map) becomes `warning`, even if its own sensors are normal.
- Risk score = 30 x critical zones + 10 x warning zones, capped at 100.
- A zone that has sent no data for 45 seconds is marked `offline`.

## 4. Firebase Realtime Database structure
- `zones/<Z>`: latest data from each zone
- `status/<Z>`: latest cascading status of each zone
- `city`: city-wide mode and risk score
- `history/<Z>/<id>`: history used for the graphs
- `incidents/<id>`: events shown in the live incident feed

## Design rules
1. Cascading logic does not run inside the ESP32, because a node only knows its own data. It runs in the central backend.
2. The decision to switch on the buzzer and servo is always made locally by the node, so safety does not depend on the network.
3. WiFi passwords, Firebase URLs and Telegram tokens must never be committed to the repository.
