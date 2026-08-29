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

module.exports = { sendMessage, setWebhook };
