const fetch = require('node-fetch');

function apiUrl(token, method) {
  return `https://api.telegram.org/bot${token}/${method}`;
}

async function sendMessage(token, chatId, text, extra = {}) {
  const res = await fetch(apiUrl(token, 'sendMessage'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId, text, ...extra }),
  });
  const data = await res.json();
  if (!data.ok) console.error('Erreur Telegram sendMessage:', data);
  return data;
}

async function setWebhook(token, url) {
  const res = await fetch(apiUrl(token, 'setWebhook'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ url }),
  });
  return res.json();
}

async function sendTyping(token, chatId) {
  try {
    await fetch(apiUrl(token, 'sendChatAction'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, action: 'typing' }),
    });
  } catch (err) {
    console.error('Erreur sendChatAction:', err.message);
  }
}

function randomDelayMs(minSeconds, maxSeconds) {
  const min = Number(minSeconds) || 0;
  const max = Number(maxSeconds) || min;
  const seconds = min + Math.random() * Math.max(0, max - min);
  return Math.round(seconds * 1000);
}

async function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Simule une frappe naturelle avant d'envoyer la réponse : indicateur "typing"
// maintenu pendant un délai aléatoire (borné par les réglages), puis envoi.
async function sendMessageWithTypingDelay(token, chatId, text, { minSeconds = 2, maxSeconds = 7 } = {}) {
  const delay = randomDelayMs(minSeconds, maxSeconds);
  const start = Date.now();
  await sendTyping(token, chatId);
  // Telegram "typing" expire après ~5s, on le rafraîchit si le délai est plus long
  while (Date.now() - start < delay) {
    const chunk = Math.min(4000, delay - (Date.now() - start));
    await sleep(chunk);
    if (Date.now() - start < delay) await sendTyping(token, chatId);
  }
  return sendMessage(token, chatId, text);
}

module.exports = { sendMessage, setWebhook, sendTyping, sendMessageWithTypingDelay };
