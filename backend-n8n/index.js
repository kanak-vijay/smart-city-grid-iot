const mqtt = require('mqtt');
const { DB_URL } = require('./config');
const { sendTelegram } = require('./telegram');

const VALID_ZONES = ['A', 'B', 'C', 'D'];
const ADJACENCY = { A: ['B'], B: ['A', 'C'], C: ['B', 'D'], D: ['C'] };
const STALE_MS = 45000;

async function fb(method, path, data) {
  try {
    const r = await fetch(`${DB_URL}/${path}.json`, {
      method,
      body: JSON.stringify(data),
    });
    if (!r.ok) console.log(`Firebase ${method} ${path} failed:`, r.status);
  } catch (e) {
    console.log('Firebase error:', e.message);
  }
}

// Telegram spam rokne ke liye cooldown
const lastNotify = {};
function notify(key, text, cooldownMs = 30000) {
  const now = Date.now();
  if (lastNotify[key] && now - lastNotify[key] < cooldownMs) return;
  lastNotify[key] = now;
  sendTelegram(text);
}

const client = mqtt.connect('mqtt://broker.hivemq.com:1883', {
  clientId: 'scg-backend-' + Math.random().toString(16).slice(2, 8),
});

const zoneData = {};
const lastState = {};
const lastLog = {};
const prevStatus = {};
let prevKey = '';
let prevMode = 'normal';

function hazardList(z) {
  const d = zoneData[z];
  if (!d) return 'unknown';
  const h = [];
  if (d.gas_alert) h.push('Gas leak');
  if (d.fire_alert) h.push('Fire');
  if (d.flood_alert) h.push('Flood');
  return h.length ? h.join(', ') : 'sensor alert';
}

function computeCascade() {
  const now = Date.now();

  // 1. har zone ki apni state
  const own = {};
  VALID_ZONES.forEach((z) => {
    const d = zoneData[z];
    if (!d || now - d.ts > STALE_MS) own[z] = 'offline';
    else own[z] = d.state === 'critical' ? 'critical' : 'normal';
  });

  // 2. cascading: padosi critical hai toh warning
  const status = {};
  VALID_ZONES.forEach((z) => {
    if (own[z] === 'critical') {
      status[z] = { status: 'critical', reason: 'own sensors' };
    } else {
      const critNeighbours = ADJACENCY[z].filter((n) => own[n] === 'critical');
      if (critNeighbours.length > 0) {
        status[z] = {
          status: 'warning',
          reason: `neighbour ${critNeighbours.join(',')} critical`,
        };
      } else {
        status[z] = { status: own[z] === 'offline' ? 'offline' : 'normal', reason: '' };
      }
    }
  });

  // 3. city-wide mode + risk score
  const criticalZones = VALID_ZONES.filter((z) => status[z].status === 'critical');
  const warningZones = VALID_ZONES.filter((z) => status[z].status === 'warning');
  const mode = criticalZones.length >= 2 ? 'emergency' : 'normal';
  const riskScore = Math.min(100, criticalZones.length * 30 + warningZones.length * 10);

  // 4. sirf badlav pe publish/likho
  const key = JSON.stringify({ status, mode, riskScore });
  if (key === prevKey) return;
  prevKey = key;

  const ts = Date.now();
  const city = { mode, critical_zones: criticalZones, risk_score: riskScore, ts };

  console.log(
    'CASCADE>',
    VALID_ZONES.map((z) => `${z}:${status[z].status}`).join('  '),
    '| mode=' + mode,
    '| risk=' + riskScore
  );

  VALID_ZONES.forEach((z) => {
    const s = { zone: z, ...status[z], ts };
    client.publish(`scg-bmu26/zone/${z}/status`, JSON.stringify(s), { retain: true });
    fb('PUT', `status/${z}`, s);

    const prev = prevStatus[z];
    const cur = status[z].status;

    if (cur === 'warning' && prev !== 'warning') {
      fb('POST', 'incidents', {
        zone: z,
        state: 'warning',
        hazards: [],
        reason: status[z].reason,
        ts,
      });
      notify(
        `warn-${z}`,
        `⚠️ WARNING: Zone ${z}\nReason: ${status[z].reason}\nPrecaution only, this zone's own sensors are normal.`
      );
    }

    if (cur === 'critical' && prev !== 'critical') {
      notify(
        `crit-${z}`,
        `🚨 CRITICAL: Zone ${z}\nHazard: ${hazardList(z)}\nLocal buzzer and valve activated.`
      );
    }

    if (cur === 'normal' && (prev === 'critical' || prev === 'warning')) {
      notify(`ok-${z}`, `✅ Zone ${z} is back to normal.`);
    }

    prevStatus[z] = cur;
  });

  client.publish('scg-bmu26/city/status', JSON.stringify(city), { retain: true });
  fb('PUT', 'city', city);

  if (mode === 'emergency' && prevMode !== 'emergency') {
    fb('POST', 'incidents', {
      zone: 'CITY',
      state: 'emergency',
      hazards: [],
      reason: `critical zones: ${criticalZones.join(',')}`,
      ts,
    });
    notify(
      'city-emergency',
      `🆘 CITY-WIDE EMERGENCY\nCritical zones: ${criticalZones.join(', ')}\nRisk score: ${riskScore}/100`,
      0
    );
  }
  if (mode !== 'emergency' && prevMode === 'emergency') {
    notify('city-clear', '✅ City-wide emergency cleared.', 0);
  }
  prevMode = mode;
}

client.on('connect', () => {
  console.log('Connected to HiveMQ');
  client.subscribe('scg-bmu26/zone/+/data', (err) => {
    if (err) console.log('Subscribe error:', err.message);
    else console.log('Listening on scg-bmu26/zone/+/data ...');
  });
});

client.on('message', (topic, payload) => {
  let data;
  try {
    data = JSON.parse(payload.toString());
  } catch (e) {
    console.log('Bad message on', topic);
    return;
  }

  if (!VALID_ZONES.includes(data.zone)) {
    console.log('Ignored: invalid zone', data.zone);
    return;
  }

  const now = Date.now();
  data.ts = now;
  zoneData[data.zone] = data;

  console.log(
    `[${new Date().toLocaleTimeString()}] Zone ${data.zone} | ${data.state} | gas=${data.gas} fire=${data.fire} water=${data.water}`
  );

  fb('PUT', `zones/${data.zone}`, data);

  const changed = lastState[data.zone] !== data.state;
  if (changed || now - (lastLog[data.zone] || 0) > 10000) {
    fb('POST', `history/${data.zone}`, data);
    lastLog[data.zone] = now;
  }

  if (lastState[data.zone] && changed) {
    const hazards = [];
    if (data.gas_alert) hazards.push('gas');
    if (data.fire_alert) hazards.push('fire');
    if (data.flood_alert) hazards.push('flood');
    fb('POST', 'incidents', { zone: data.zone, state: data.state, hazards, ts: now });
  }
  lastState[data.zone] = data.state;

  computeCascade();
});

setInterval(computeCascade, 2000);

client.on('error', (err) => console.log('MQTT error:', err.message));