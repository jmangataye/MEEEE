const fetch = require('node-fetch');

function apiUrl(token, method) {
  return `https://api.telegram.org/bot${token}/${method}`;
}

// MISE À JOUR 31/08/2026 — bug de fiabilité trouvé lors de l'audit demandé par
// Bryan ("assure-toi que le bot vend bien les liens") : cette fonction ne
// levait JAMAIS d'erreur quand Telegram refusait l'envoi (bot bloqué par le
// fan, chat_id invalide, rate limit...) — elle se contentait d'un
// console.error et renvoyait quand même `data` (avec `ok:false`) comme si de
// rien n'était. Or server.js (`send_offer` → `replyToFan`) enregistre la
// vente/le lien envoyé (`recordSale`) juste APRÈS avoir attendu cet appel,
// en supposant qu'une absence d'exception = message bien parti. Résultat
// possible : un lien marqué "envoyé" dans Ventes/le catalogue alors que le
// fan ne l'a jamais reçu (silencieusement compté dans les statistiques,
// aggravant l'écart observé entre liens envoyés et ventes confirmées). On
// lève maintenant une vraie erreur sur un échec Telegram réel, pour que tous
// les appelants (déjà protégés par leurs propres try/catch — vérifié un par
// un: replyToFan/send_offer, l'alerte admin, la relance des fans inactifs,
// l'envoi manuel admin, le message de repli, le bouton "Tester les alertes")
// sachent distinguer "vraiment envoyé" de "a échoué" plutôt que de traiter
// les deux cas comme un succès.
async function sendMessage(token, chatId, text, extra = {}) {
  const res = await fetch(apiUrl(token, 'sendMessage'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId, text, ...extra }),
  });
  const data = await res.json();
  if (!data.ok) {
    console.error('Erreur Telegram sendMessage:', data);
    throw new Error(`Telegram sendMessage a échoué: ${data.description || 'erreur inconnue'}`);
  }
  return data;
}

// MISE À JOUR 30/08/2026 — jusqu'ici le bot ne pouvait envoyer QUE du texte.
// Bryan veut maintenant que l'IA puisse envoyer une vraie photo d'aperçu
// (visible par le fan, pour donner envie) avant de proposer un article — voir
// "send_preview" dans lib/claudeAgent.js et son traitement dans server.js.
// `photoUrl` est une URL signée Supabase (valide un temps limité) : Telegram
// va lui-même la télécharger côté serveur, pas besoin que le bucket soit
// public en permanence.
async function sendPhoto(token, chatId, photoUrl, caption) {
  const res = await fetch(apiUrl(token, 'sendPhoto'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId, photo: photoUrl, caption: caption || undefined }),
  });
  const data = await res.json();
  // Même raisonnement que sendMessage ci-dessus : sans ce throw, server.js
  // journalisait "[📸 foto de aperçu enviada]" même quand l'envoi avait
  // réellement échoué côté Telegram (déjà protégé par un try/catch dédié).
  if (!data.ok) {
    console.error('Erreur Telegram sendPhoto:', data);
    throw new Error(`Telegram sendPhoto a échoué: ${data.description || 'erreur inconnue'}`);
  }
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

module.exports = { sendMessage, sendPhoto, setWebhook, sendTyping, sendMessageWithTypingDelay };
