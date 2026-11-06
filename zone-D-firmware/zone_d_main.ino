#include <Wire.h>
#include <LiquidCrystal_I2C.h>
#include <ESP32Servo.h>
#include <WiFi.h>
#include <PubSubClient.h>
#include "secrets.h"

#define MQ2_PIN 34
#define FLAME_PIN 27
#define TRIG_PIN 5
#define ECHO_PIN 18
#define BUZZER_PIN 26
#define SERVO_PIN 13

#define GAS_THRESHOLD 2400
#define FLOOD_THRESHOLD 5.0
#define SAFE_DISTANCE 20.0
#define WINDOW 10
#define CONFIRM_COUNT 3
#define PUBLISH_INTERVAL 2000

const char* MQTT_SERVER = "broker.hivemq.com";
const int MQTT_PORT = 1883;
const char* TOPIC = "scg-bmu26/zone/D/data";

LiquidCrystal_I2C lcd(0x27, 16, 2);
Servo valveServo;
WiFiClient espClient;
PubSubClient mqtt(espClient);

struct Hazard {
  float buf[WINDOW];
  int idx;
  float sum;
  int count;
  bool alert;
};
Hazard gas, fire, flood;
bool lastAlertState = false;
unsigned long lastPublish = 0;
unsigned long lastReconnect = 0;

void initHazard(Hazard &h, float v) {
  for (int i = 0; i < WINDOW; i++) h.buf[i] = v;
  h.sum = v * WINDOW;
  h.idx = 0;
  h.count = 0;
  h.alert = false;
}

float pushValue(Hazard &h, float v) {
  h.sum -= h.buf[h.idx];
  h.buf[h.idx] = v;
  h.sum += v;
  h.idx = (h.idx + 1) % WINDOW;
  return h.sum / WINDOW;
}

void updateAlert(Hazard &h, bool over, bool cleared) {
  if (over) h.count++;
  else h.count = 0;
  if (h.count >= CONFIRM_COUNT) h.alert = true;
  if (cleared) h.alert = false;
}

float getDistance() {
  digitalWrite(TRIG_PIN, LOW);
  delayMicroseconds(5);
  digitalWrite(TRIG_PIN, HIGH);
  delayMicroseconds(10);
  digitalWrite(TRIG_PIN, LOW);
  long duration = pulseIn(ECHO_PIN, HIGH, 30000);
  if (duration == 0) return -1;
  float d = duration * 0.0343 / 2;
  if (d < 2 || d > 100) return -1;
  return d;
}

void moveServo(int angle) {
  valveServo.attach(SERVO_PIN);
  valveServo.write(angle);
  delay(600);
  valveServo.detach();
}

// Non-blocking: safety loop kabhi nahi rukta
void maintainConnection() {
  if (millis() - lastReconnect < 5000) return;
  if (WiFi.status() != WL_CONNECTED) {
    lastReconnect = millis();
    WiFi.disconnect();
    WiFi.begin(WIFI_SSID, WIFI_PASS);
    return;
  }
  if (!mqtt.connected()) {
    lastReconnect = millis();
    String clientId = "zoneD-" + String(random(0xffff), HEX);
    mqtt.connect(clientId.c_str());
  }
}

void publishData(float gasAvg, int fireRaw, float waterAvg, bool anyAlert) {
  if (!mqtt.connected()) return;
  char msg[220];
  snprintf(msg, sizeof(msg),
    "{\"zone\":\"D\",\"state\":\"%s\",\"gas\":%.0f,\"fire\":%d,\"water\":%.1f,"
    "\"gas_alert\":%d,\"fire_alert\":%d,\"flood_alert\":%d}",
    anyAlert ? "critical" : "normal",
    gasAvg, fireRaw, waterAvg,
    gas.alert, fire.alert, flood.alert);
  mqtt.publish(TOPIC, msg);
  Serial.print("MQTT> ");
  Serial.println(msg);
}

void setup() {
  Serial.begin(115200);
  pinMode(BUZZER_PIN, OUTPUT);
  digitalWrite(BUZZER_PIN, LOW);
  pinMode(FLAME_PIN, INPUT);
  pinMode(TRIG_PIN, OUTPUT);
  pinMode(ECHO_PIN, INPUT);

  Wire.begin(21, 22);
  lcd.init();
  lcd.backlight();
  lcd.setCursor(0, 0);
  lcd.print("Zone D starting");

  WiFi.mode(WIFI_STA);
  WiFi.begin(WIFI_SSID, WIFI_PASS);
  unsigned long t = millis();
  while (WiFi.status() != WL_CONNECTED && millis() - t < 10000) delay(250);

  mqtt.setServer(MQTT_SERVER, MQTT_PORT);
  mqtt.setSocketTimeout(2);

  delay(1000);
  moveServo(0);

  initHazard(gas, analogRead(MQ2_PIN));
  initHazard(fire, 0);
  initHazard(flood, SAFE_DISTANCE);
  lcd.clear();
}

void loop() {
  maintainConnection();
  mqtt.loop();

  // 1. raw readings
  int gasRaw = analogRead(MQ2_PIN);
  int fireRaw = (digitalRead(FLAME_PIN) == LOW) ? 1 : 0;
  float dist = getDistance();
  if (dist < 0) dist = SAFE_DISTANCE;

  // 2. moving average
  float gasAvg = pushValue(gas, gasRaw);
  float fireAvg = pushValue(fire, fireRaw);
  float floodAvg = pushValue(flood, dist);

  // 3. threshold + 3 consecutive confirmation
  updateAlert(gas, gasAvg > GAS_THRESHOLD, gasAvg < GAS_THRESHOLD - 200);
  updateAlert(fire, fireAvg > 0.5, fireAvg < 0.2);
  updateAlert(flood, floodAvg < FLOOD_THRESHOLD, floodAvg > FLOOD_THRESHOLD + 3);

  bool anyAlert = gas.alert || fire.alert || flood.alert;

  // 4. local actuators (internet pe depend nahi)
  digitalWrite(BUZZER_PIN, anyAlert ? HIGH : LOW);
  if (anyAlert != lastAlertState) {
    moveServo(anyAlert ? 90 : 0);
    lastAlertState = anyAlert;
    publishData(gasAvg, fireRaw, floodAvg, anyAlert);   // state badalte hi turant bhejo
    lastPublish = millis();
  }

  // 5. LCD
  lcd.setCursor(0, 0);
  if (!anyAlert) {
    lcd.print("Zone D: NORMAL  ");
  } else {
    String s = "ALERT:";
    if (gas.alert) s += " GAS";
    if (fire.alert) s += " FIRE";
    if (flood.alert) s += " FLD";
    while (s.length() < 16) s += " ";
    lcd.print(s);
  }
  lcd.setCursor(0, 1);
  String line2 = "G" + String((int)gasAvg) + " W" + String((int)floodAvg) + " F" + String(fireRaw);
  while (line2.length() < 16) line2 += " ";
  lcd.print(line2);

  // 6. periodic publish
  if (millis() - lastPublish >= PUBLISH_INTERVAL) {
    lastPublish = millis();
    publishData(gasAvg, fireRaw, floodAvg, anyAlert);
  }

  delay(200);
}
