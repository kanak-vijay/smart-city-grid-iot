const { TELEGRAM_TOKEN, TELEGRAM_CHAT_ID } = require('./config');

async function sendTelegram(text) {
  try {
    const r = await fetch(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: TELEGRAM_CHAT_ID, text }),
    });
    const d = await r.json();
    if (!d.ok) console.log('Telegram error:', d.description);
  } catch (e) {
    console.log('Telegram network error:', e.message);
  }
}

module.exports = { sendTelegram };