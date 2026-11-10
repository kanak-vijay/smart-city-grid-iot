const mqtt = require('mqtt');
const fs = require('fs');
const { DB_URL } = require('./config');

const TRIALS = 10;
const TIMEOUT = 10000;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const DATA_TOPIC = 'scg-bmu26/zone/C/data';
const critical = JSON.stringify({ zone: 'C', state: 'critical', gas: 3000, fire: 0, water: 20, gas_alert: 1, fire_alert: 0, flood_alert: 0 });
const normal = JSON.stringify({ zone: 'C', state: 'normal', gas: 900, fire: 0, water: 20, gas_alert: 0, fire_alert: 0, flood_alert: 0 });

const client = mqtt.connect('mqtt://broker.hivemq.com:1883', {
  clientId: 'scg-latency-' + Math.random().toString(16).slice(2, 8),
});

let waiter = null;
client.on('message', (topic, payload) => {
  if (topic !== 'scg-bmu26/zone/B/status' || !waiter) return;
  try {
    const s = JSON.parse(payload.toString());
    if (waiter.pred(s)) {
      const done = waiter.done;
      waiter = null;
      done(performance.now());
    }
  } catch (e) {}
});

function waitMqtt(pred, timeout) {
  return new Promise((resolve) => {
    const timer = setTimeout(() => { waiter = null; resolve(null); }, timeout);
    waiter = { pred, done: (t) => { clearTimeout(timer); resolve(t); } };
  });
}

async function waitFirebase(pred, timeout) {
  const end = performance.now() + timeout;
  while (performance.now() < end) {
    try {
      const s = await (await fetch(`${DB_URL}/status/B.json`)).json();
      if (s && pred(s)) return performance.now();
    } catch (e) {}
    await sleep(50);
  }
  return null;
}

function stats(arr) {
  const a = arr.filter((x) => x !== null).sort((x, y) => x - y);
  if (!a.length) return null;
  const mean = a.reduce((s, x) => s + x, 0) / a.length;
  const median = a.length % 2 ? a[(a.length - 1) / 2] : (a[a.length / 2 - 1] + a[a.length / 2]) / 2;
  return { n: a.length, min: a[0], median, mean: Math.round(mean), max: a[a.length - 1] };
}

async function main() {
  await new Promise((r) => client.on('connect', r));
  client.subscribe('scg-bmu26/zone/B/status');
  await sleep(1500);

  const rows = [];
  for (let i = 1; i <= TRIALS; i++) {
    client.publish(DATA_TOPIC, normal);
    await waitFirebase((s) => s.status !== 'warning', 15000);
    await sleep(1000);

    const t0 = performance.now();
    const pm = waitMqtt((s) => s.status === 'warning', TIMEOUT);
    const pf = waitFirebase((s) => s.status === 'warning', TIMEOUT);
    client.publish(DATA_TOPIC, critical);
    const [tm, tf] = await Promise.all([pm, pf]);

    const row = {
      trial: i,
      mqtt_ms: tm ? Math.round(tm - t0) : null,
      firebase_ms: tf ? Math.round(tf - t0) : null,
    };
    rows.push(row);
    console.log(`Trial ${i}: MQTT ${row.mqtt_ms} ms | Firebase ${row.firebase_ms} ms`);
  }

  console.log('\nMQTT cascade latency (ms):');
  console.table(stats(rows.map((r) => r.mqtt_ms)));
  console.log('Firebase cascade latency (ms):');
  console.table(stats(rows.map((r) => r.firebase_ms)));

  const csv = 'trial,mqtt_ms,firebase_ms\n' + rows.map((r) => `${r.trial},${r.mqtt_ms},${r.firebase_ms}`).join('\n');
  fs.writeFileSync('latency-results.csv', csv);
  console.log('Saved: latency-results.csv');

  client.publish(DATA_TOPIC, normal);
  await sleep(500);
  client.end();
  process.exit(0);
}

main();