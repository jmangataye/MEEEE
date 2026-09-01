require('dotenv').config();
const express = require('express');
const path = require('path');
const crypto = require('crypto');
const multer = require('multer');
const fetch = require('node-fetch');
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 80 * 1024 * 1024 } });

const {
  getSettings,
  updateSettings,
  getActiveCatalog,
  getOrCreateFan,
  logMessage,
  getRecentHistory,
  recordSale,
  listSales,
  confirmSale,
  getPurchasedItemIds,
  setFanStatus,
  setFanPaused,
  updateFanProfile,
  markVipAlerted,
  listFansWithPreview,
  getFanById,
  getFullConversation,
  listAdminTokens,
  isValidAdminToken,
  createAdminToken,
  deleteAdminToken,
  getAnalytics,
  getDailyTimeseries,
  getFansForReengagement,
  markReengaged,
  logSafetyIncident,
  listSafetyIncidents,
  resolveSafetyIncident,
  dismissStalledFan,
  getFanCountByCountry,
  generateAdminSetupCode,
  tryCaptureAdminChatId,
  setFanAdminNote,
  markLowCreditAlertSent,
  listVaultAssets,
  addVaultAsset,
  deleteVaultAsset,
  getVaultSummary,
  setCatalogItemPreview,
  getSignedUrl,
  getAiUsageSince,
  setAiCreditBalance,
  getLiveOpsStats,
  getStalledConversations,
  getLiveAudiencePulse,
  listSettingsHistory,
  restoreSettingsVersion,
  getVariantsForField,
  getVariantStats,
  getScriptVariantById,
  logVariantEvent,
  createScriptVariant,
  updateScriptVariant,
  getTenantById,
  getTenantByBotToken,
  listActiveTenants,
  createTenant,
  updateTenant,
  supabase,
} = require('./lib/supabase');
const { runAgentTurn, buildSystemPrompt, generateScriptSuggestion } = require('./lib/claudeAgent');
const { rememberFanNoteEmbedding } = require('./lib/embeddings');
const { sendMessage, sendPhoto, sendMessageWithTypingDelay, setWebhook } = require('./lib/telegram');
const { getLinkForItem } = require('./lib/dropfans');
const {
  reviewOutgoingText,
  reviewOfferInput,
  FALLBACK_MESSAGE,
  PAYMENT_ALT_FALLBACK_MESSAGE,
  isPaymentAlternativeOnly,
} = require('./lib/safetyFilter');
const stripeBilling = require('./lib/stripe');

// ---------- Multi-tenant : identifiant du tenant historique "Meely" ----------
// Ce projet a démarré avec UNE seule créatrice avant de devenir un SaaS
// multi-créatrices (30/08/2026) — voir migration `create_tenants_table_and_seed_default`.
// Le webhook Telegram déjà configuré chez Telegram pour Meely pointe vers
// l'URL historique `/telegram/webhook` (sans tenant_id dans le chemin) : plutôt
// que de devoir reconfigurer ce webhook en prod (risque inutile pour un bot
// déjà en activité), on fait pointer cette route historique vers ce tenant
// précis en dur, et on ajoute une route `/telegram/webhook/:tenantId` pour
// toute nouvelle créatrice inscrite en self-service (voir POST /api/signup).
const MEELY_TENANT_ID = '8d7e2c7d-ad86-459a-b8c3-ac957e55935c';

// ---------- Filet de sécurité global : une seule promesse rejetée sans
// .catch() n'importe où dans le code (même dans une dépendance) fait, PAR
// DÉFAUT, planter tout le process Node — ce qui coupe instantanément TOUTES
// les conversations de TOUS les fans en cours, sans aucune trace claire dans
// les logs (juste un redémarrage). Repéré le 29/08 en constatant un crash
// réel ("UnhandledPromiseRejection") quelques dizaines de secondes après un
// déploiement, causé par un `.then()` sans `.catch()` dans lib/supabase.js
// (corrigé). Ces deux handlers ne remplacent pas la correction du bug root
// cause à chaque fois qu'on en trouve un — mais ils empêchent qu'UN SEUL bug
// oublié quelque part ne mette tout le bot à genoux d'un coup.
process.on('unhandledRejection', (reason) => {
  console.error('⚠️ UnhandledPromiseRejection (process maintenu en vie):', reason);
});
process.on('uncaughtException', (err) => {
  console.error('⚠️ UncaughtException (process maintenu en vie):', err);
});

const app = express();
// IMPORTANT : le webhook Stripe a besoin du corps BRUT (Buffer) de la requête
// pour vérifier sa signature (voir lib/stripe.js) — il doit donc être monté
// AVANT express.json() global, sur son chemin exact uniquement. Express
// marque req._body une fois le corps lu ; express.json() plus bas voit ce
// marqueur sur CE chemin précis et ne retente pas de le re-parser en JSON.
app.use('/api/webhooks/stripe', express.raw({ type: 'application/json' }));
app.use(express.json());
app.use('/landing', express.static(path.join(__dirname, 'public/landing')));
app.use('/admin', express.static(path.join(__dirname, 'public/admin')));
app.use('/signup', express.static(path.join(__dirname, 'public/signup')));

// ---------- Sécurité admin (multi-token, vérifié en base) ----------
// MISE À JOUR 30/08/2026 (multi-tenant) — isValidAdminToken() renvoie
// maintenant { ok, tenant_id } au lieu d'un simple booléen : chaque token
// admin appartient à UN tenant précis (une créatrice), et req.tenantId est
// posé ici une fois pour toutes pour que chaque route admin sache
// automatiquement de quel compte elle doit lire/écrire les données — sans ça,
// toutes les fonctions de lib/supabase.js qui exigent désormais un tenant_id
// explicite (garde-fou anti-mélange de données entre créatrices) échoueraient.
async function requireAdminToken(req, res, next) {
  const token = req.headers['x-admin-token'] || req.query.token;
  const result = await isValidAdminToken(token).catch(() => ({ ok: false, tenant_id: null }));
  if (!result || !result.ok) return res.status(401).json({ error: 'unauthorized' });
  req.tenantId = result.tenant_id;
  next();
}

// Coupe la réponse en plusieurs "bulles" (séparées par une ligne vide) envoyées
// l'une après l'autre, comme le ferait vraiment quelqu'un qui tape plusieurs
// messages à la suite — plutôt qu'un seul gros pavé de texte qui sonne robotique.
function splitIntoBubbles(text) {
  return text
    .split(/\n\s*\n+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

// Filet de sécurité anti-spam : même si le modèle génère trop de blocs séparés,
// on ne laisse jamais partir plus de MAX_BUBBLES messages Telegram distincts
// pour une seule réponse — le reste est recollé au dernier bloc (une seule
// bulle peut avoir plusieurs lignes, ça reste un seul message Telegram).
// MISE À JOUR 30/08/2026 — cette limite était figée en dur à 2 ; elle suit
// maintenant "max_message_bubbles" (dashboard, Persona & Script → Rythme &
// alertes), la même valeur qui pilote déjà l'instruction correspondante dans
// le prompt (voir lib/claudeAgent.js). Le "2" reste le filet de sécurité par
// défaut si le réglage est absent/invalide.
const DEFAULT_MAX_BUBBLES = 2;
function capBubbles(bubbles, max = DEFAULT_MAX_BUBBLES) {
  if (bubbles.length <= max) return bubbles;
  const kept = bubbles.slice(0, max - 1);
  const rest = bubbles.slice(max - 1).join('\n');
  kept.push(rest);
  return kept;
}

// Nettoyage défensif : au cas où le modèle utilise quand même ¿/¡, on les
// retire pour garder un style de chat casuel (personne n'écrit "¿cómo estás?"
// sur son téléphone, juste "como estas?").
function stripInvertedPunctuation(text) {
  return text.replace(/¿/g, '').replace(/¡/g, '');
}

async function replyToFan({ settings, chatId, fan, text }) {
  const maxBubbles = Number(settings.max_message_bubbles) || DEFAULT_MAX_BUBBLES;
  const bubbles = capBubbles(splitIntoBubbles(text), maxBubbles).map(stripInvertedPunctuation);
  for (const bubble of bubbles) {
    await sendMessageWithTypingDelay(settings.telegram_bot_token, chatId, bubble, {
      minSeconds: settings.response_delay_min_seconds,
      maxSeconds: settings.response_delay_max_seconds,
    });
    // `fan.tenant_id` : le fan (venant de getOrCreateFan/getFanById) porte
    // déjà sa propre colonne tenant_id — plus simple et plus sûr que de faire
    // remonter tenantId depuis chaque appelant de replyToFan().
    await logMessage(fan.id, 'assistant', bubble, false, fan.tenant_id);
  }
}

async function maybeAlertAdmin(settings, text) {
  if (!settings.admin_telegram_chat_id) return;
  try {
    await sendMessage(settings.telegram_bot_token, settings.admin_telegram_chat_id, text);
  } catch (err) {
    console.error('Erreur envoi alerte admin:', err.message);
  }
}

// MISE À JOUR 01/09/2026 — trouvé en croisant les logs Render avec les vraies
// conversations : le compte Anthropic a manqué de crédit à 3 reprises depuis
// le 30/08 (dont une pendant ~35 min ce soir même, 04h36-05h12 UTC), et à
// chaque fois les fans ne recevaient QUE le message de repli générique ("uy se
// me trabo un momentico...") sans que Bryan ne soit prévenu autrement qu'en
// épluchant le dashboard ou les logs après coup. On alerte maintenant sur
// Telegram (si admin_telegram_chat_id est configuré) dès qu'un vrai échec de
// traitement se produit — avec un anti-spam par tenant (une alerte au plus
// toutes les 10 minutes) pour ne pas inonder Bryan d'un message par fan
// pendant une panne qui touche tout le monde en même temps.
const lastProcessingErrorAlertAt = new Map(); // tenantId -> timestamp ms
const PROCESSING_ERROR_ALERT_COOLDOWN_MS = 10 * 60 * 1000;
async function maybeAlertAdminOfProcessingError(settings, tenantId, err) {
  const now = Date.now();
  const last = lastProcessingErrorAlertAt.get(tenantId) || 0;
  if (now - last < PROCESSING_ERROR_ALERT_COOLDOWN_MS) return;
  lastProcessingErrorAlertAt.set(tenantId, now);
  const detail = (err && err.message ? err.message : String(err)).slice(0, 200);
  const isCredit = /credit balance/i.test(detail);
  const text = isCredit
    ? `🔴 Le bot ne peut plus répondre aux fans — crédit Anthropic épuisé (recharge sur console.anthropic.com). Les fans reçoivent le message de repli en attendant.`
    : `🔴 Le bot a un problème pour répondre à un fan (message de repli envoyé à la place) : ${detail}`;
  await maybeAlertAdmin(settings, text);
}

// ---------- Anti-doublon : Telegram peut renvoyer la même mise à jour plusieurs
// fois (retry) si notre service met trop de temps à répondre — typiquement
// après une mise en veille du plan gratuit Render ("cold start"). Sans ce
// garde-fou, un même message de fan peut être traité deux ou trois fois en
// parallèle, ce qui produisait exactement le genre de réponses dupliquées /
// incohérentes observées dans les conversations (même phrase envoyée deux
// fois, prix différents donnés à la suite, etc).
const processedUpdateIds = new Set();
const MAX_PROCESSED_IDS = 5000;
function alreadyProcessed(updateId) {
  if (updateId === undefined || updateId === null) return false;
  if (processedUpdateIds.has(updateId)) return true;
  processedUpdateIds.add(updateId);
  if (processedUpdateIds.size > MAX_PROCESSED_IDS) {
    processedUpdateIds.delete(processedUpdateIds.values().next().value);
  }
  return false;
}

// ---------- Sérialisation par fan : si deux messages du même fan arrivent
// coup sur coup (très fréquent — les gens envoient souvent 2-3 messages courts
// à la suite), on les traite l'un après l'autre plutôt que de lancer deux
// appels à Claude en parallèle qui ne se voient pas l'un l'autre et produisent
// des réponses en double ou contradictoires.
const fanQueues = new Map();
function runSerializedForFan(fanKey, task) {
  const previous = fanQueues.get(fanKey) || Promise.resolve();
  const next = previous.then(task, task).finally(() => {
    if (fanQueues.get(fanKey) === next) fanQueues.delete(fanKey);
  });
  fanQueues.set(fanKey, next);
  return next;
}

// ---------- Messages non-textuels (photo/vocal/sticker/vidéo/document) ----------
// Avant: un fan qui envoie autre chose que du texte pur tombait dans un
// silence total (aucune réponse, aucune trace) — repéré en creusant le 29/08.
// On détecte maintenant le type, on journalise l'événement (jamais le fichier
// lui-même, juste la trace qu'il est arrivé) et on répond par un message fixe
// adapté — sans appeler Claude pour ça, ce serait un coût inutile pour une
// réponse toujours identique.
const MEDIA_TYPE_REPLIES = {
  photo: { log: '[foto recibida]', reply: 'uy no puedo ver fotos por aquí todavía, cuéntame con palabras que tienes en mente 😉' },
  video: { log: '[video recibido]', reply: 'no puedo ver videos por aquí todavía, cuéntame con palabras que buscas 😊' },
  video_note: { log: '[video recibido]', reply: 'no puedo ver videos por aquí todavía, cuéntame con palabras que buscas 😊' },
  voice: { log: '[audio recibido]', reply: 'no puedo escuchar audios aquí todavía, cuéntamelo con palabras 😉' },
  audio: { log: '[audio recibido]', reply: 'no puedo escuchar audios aquí todavía, cuéntamelo con palabras 😉' },
  sticker: { log: '[sticker recibido]', reply: 'jajaja me encanta, pero cuéntame con palabras que tienes en mente 😏' },
  document: { log: '[archivo recibido]', reply: 'no puedo abrir archivos por aquí, cuéntame con palabras 😉' },
};

function detectMediaType(msg) {
  if (msg.photo) return 'photo';
  if (msg.voice) return 'voice';
  if (msg.video_note) return 'video_note';
  if (msg.video) return 'video';
  if (msg.sticker) return 'sticker';
  if (msg.audio) return 'audio';
  if (msg.document) return 'document';
  return null;
}

async function handleNonTextMessage(msg, mediaType, tenantId) {
  try {
    const chatId = msg.chat.id;
    const settings = await getSettings(tenantId);
    const fan = await getOrCreateFan({
      telegram_user_id: msg.from.id,
      telegram_username: msg.from.username,
      first_name: msg.from.first_name,
      tenant_id: tenantId,
    });
    const meta = MEDIA_TYPE_REPLIES[mediaType] || MEDIA_TYPE_REPLIES.document;
    await logMessage(fan.id, 'fan', meta.log, false, tenantId);

    // MISE À JOUR 30/08/2026 — pause globale (dashboard, Vue d'ensemble), à ne
    // pas confondre avec la pause par fan juste en dessous : ici RIEN ne
    // répond à PERSONNE tant que Bryan n'a pas réactivé depuis le dashboard.
    // Le message reste journalisé (rien n'est perdu), seule la réponse auto
    // est coupée.
    if (settings.bot_globally_paused) {
      console.log(`Bot en pause globale — média (${mediaType}) reçu de fan ${fan.id}, pas de réponse automatique.`);
      return;
    }

    // Même règle que pour le texte : si la conversation est en pause, on
    // journalise mais on ne répond pas automatiquement.
    if (fan.paused) {
      console.log(`Fan ${fan.id} en pause — média (${mediaType}) reçu, pas de réponse automatique.`);
      return;
    }
    await replyToFan({ settings, chatId, fan, text: meta.reply });
  } catch (err) {
    console.error('Erreur traitement média fan:', err);
  }
}

// ---------- Regroupement des messages rapprochés (anti-spam / anti-fragmentation) ----------
// Avant: chaque message texte d'un fan déclenchait immédiatement son propre
// appel à Claude — un fan qui tape 3-4 messages coup sur coup (très courant)
// coûtait 3-4 appels API et pouvait produire des réponses fragmentées. On met
// maintenant chaque message en attente quelques secondes par fan : s'il en
// arrive un autre entre-temps, on l'ajoute au même lot et on relance le
// compte à rebours. Un seul appel à Claude est fait avec tous les messages du
// lot regroupés en un seul "tour", une fois le silence atteint — avec un
// plafond dur pour ne jamais faire attendre indéfiniment un fan qui écrit en
// continu. Chaque message brut reste journalisé immédiatement à sa réception
// (le fil du dashboard reste temps réel) — seul le déclenchement de l'appel
// IA est retardé et regroupé.
const pendingBatches = new Map(); // fanKey -> { fanPromise, fan, from, chatId, texts, firstAt, timer }
// 6000ms plutôt que 4000 : repéré le 29/08 qu'un fan envoyant deux messages
// liés à ~5s d'intervalle (juste au-dessus de l'ancienne fenêtre de 4s)
// déclenchait DEUX lots séparés au lieu d'un seul — deux appels à Claude qui
// ne se voient pas, produisant deux réponses différentes (ex: deux pitchs de
// prix contradictoires envoyés à 11s d'intervalle). Une fenêtre plus large
// réduit ce risque, sans trop retarder les fans qui écrivent normalement.
const BATCH_DEBOUNCE_MS = 6000;
const BATCH_MAX_WAIT_MS = 15000;

async function enqueueFanMessage(fanKey, msg, tenantId) {
  // MISE À JOUR 30/08/2026 — bug trouvé en analysant le "flood" de messages
  // (10-15+ bulles envoyées en rafale pour ce qui semblait être UN seul tour
  // de fan) : la version précédente faisait `pendingBatches.get(fanKey)` puis,
  // si absent, un `await getOrCreateFan(...)` AVANT de poser le nouveau lot
  // dans la Map. Deux messages Telegram arrivant à quelques millisecondes
  // d'écart (très courant : deux webhooks traités en parallèle) passaient
  // TOUS LES DEUX le test "lot absent" avant que le premier ait fini de créer
  // son fan/lot — créant deux lots parallèles pour le même fan, donc deux
  // appels Claude indépendants qui ne se voient pas, donc deux réponses quasi
  // dupliquées envoyées coup sur coup. C'est exactement le "bug du double
  // pitch" déjà repéré sur la conversation d'Adriano (voir audit, 21:51:36 et
  // 21:51:45) — la fenêtre de debounce ne pouvait rien y faire puisque la
  // course se jouait AVANT même la pose du minuteur. Fix : réserver la place
  // dans `pendingBatches` de façon 100% synchrone (aucun `await` entre le
  // test et le `.set`), et ne faire l'appel réseau `getOrCreateFan` qu'APRÈS,
  // en gardant sa promesse sur le lot pour que tout message suivant attende
  // la même résolution au lieu d'en déclencher une deuxième.
  let batch = pendingBatches.get(fanKey);
  if (!batch) {
    batch = { fanPromise: null, fan: null, from: msg.from, chatId: msg.chat.id, texts: [], firstAt: Date.now(), timer: null, tenantId };
    batch.fanPromise = getOrCreateFan({
      telegram_user_id: msg.from.id,
      telegram_username: msg.from.username,
      first_name: msg.from.first_name,
      tenant_id: tenantId,
    }).then((fan) => {
      batch.fan = fan;
      return fan;
    });
    pendingBatches.set(fanKey, batch);
  }

  const fan = await batch.fanPromise;
  await logMessage(fan.id, 'fan', msg.text, false, tenantId);
  batch.texts.push(msg.text);

  if (batch.timer) clearTimeout(batch.timer);
  const elapsed = Date.now() - batch.firstAt;
  const wait = Math.max(0, Math.min(BATCH_DEBOUNCE_MS, BATCH_MAX_WAIT_MS - elapsed));
  batch.timer = setTimeout(() => {
    pendingBatches.delete(fanKey);
    runSerializedForFan(fanKey, async () => {
      // MISE À JOUR 30/08/2026 — bug trouvé en analysant une vraie conversation
      // (fan "Adriano") : l'historique était avant capturé au moment de la
      // CRÉATION du lot (juste au-dessus), pas au moment où ce tour s'exécute
      // réellement. Comme l'exécution est sérialisée par fan (voir
      // runSerializedForFan), un fan qui relançait juste après avoir reçu une
      // première réponse (mais avant qu'elle soit visible dans l'historique,
      // à cause du délai de frappe simulé) déclenchait un DEUXIÈME lot dont
      // l'historique pré-capturé ne contenait PAS la réponse qu'on venait tout
      // juste de lui envoyer — l'IA répondait donc deux fois la même chose
      // sans le savoir. On récupère maintenant l'historique ICI, une fois que
      // c'est vraiment le tour sérialisé de ce fan (donc après qu'un tour
      // précédent encore "en vol" ait fini d'envoyer/journaliser ses
      // réponses) — en excluant les messages de CE lot (déjà journalisés
      // ci-dessus, ils sont fournis séparément comme "fanMessage") via le
      // filtre sur `firstAt`.
      const raw = await getRecentHistory(batch.fan.id, 20 + batch.texts.length + 5);
      const history = raw.filter((m) => new Date(m.created_at).getTime() < batch.firstAt).slice(-20);
      return handleIncomingMessage(
        { chat: { id: batch.chatId }, from: batch.from, text: batch.texts.join('\n') },
        { skipLogging: true, historyOverride: history, tenantId: batch.tenantId }
      );
    }).catch((err) => console.error('Erreur traitement lot de messages fan:', err));
  }, wait);
}

// ---------- Webhook Telegram (multi-tenant) ----------
// MISE À JOUR 30/08/2026 — une seule fonction de traitement partagée, montée
// sur DEUX routes : l'URL historique `/telegram/webhook` (déjà configurée
// côté Telegram pour Meely, jamais retouchée pour éviter tout risque sur le
// bot déjà en prod) résolue en dur vers MEELY_TENANT_ID, et une nouvelle URL
// `/telegram/webhook/:tenantId` utilisée pour toute créatrice inscrite via
// POST /api/signup (voir setWebhook à cet endroit).
async function processTelegramUpdate(req, res, tenantId) {
  res.sendStatus(200); // répondre vite, traiter ensuite
  try {
    if (!tenantId) {
      console.error('Webhook Telegram reçu sans tenant_id résolu — ignoré.');
      return;
    }
    const update = req.body;
    // Le compteur update_id de Telegram est propre à CHAQUE bot — deux
    // créatrices différentes peuvent tout à fait avoir un update_id=42 en même
    // temps sur leurs bots respectifs. Sans le préfixe tenant_id ici, le
    // message de l'une pourrait être ignoré à tort comme "déjà traité" à cause
    // du message de l'autre (faux positif inter-tenant).
    const dedupeKey = `${tenantId}:${update.update_id}`;
    if (alreadyProcessed(dedupeKey)) {
      console.warn('Update Telegram déjà traité, ignoré:', dedupeKey);
      return;
    }
    const msg = update.message;
    if (!msg || !msg.from) return;
    // Même logique pour fanKey : un même utilisateur Telegram réel peut être
    // fan de PLUSIEURS créatrices (bots différents) — sans le préfixe
    // tenant_id, leurs conversations indépendantes seraient à tort
    // sérialisées/regroupées ensemble comme si c'était un seul et même fil.
    const fanKey = `${tenantId}:${(msg.from && msg.from.id) || msg.chat.id}`;

    if (msg.text) {
      if (msg.text.startsWith('/start')) {
        await runSerializedForFan(fanKey, () => handleIncomingMessage(msg, { tenantId }));
        return;
      }
      // ---------- Capture automatique du chat_id admin ----------
      // Voir lib/supabase.js (tryCaptureAdminChatId) : Bryan (ou toute autre
      // créatrice) génère un code depuis SON dashboard puis s'envoie lui-même
      // "/admin_CODE" sur Telegram — jamais journalisé comme message de fan,
      // ne crée pas de fan, ne passe jamais par le lot/l'IA.
      if (msg.text.startsWith('/admin_')) {
        const code = msg.text.slice('/admin_'.length).trim();
        try {
          const captured = await tryCaptureAdminChatId(code, msg.chat.id, tenantId);
          const settings = await getSettings(tenantId);
          await sendMessage(
            settings.telegram_bot_token,
            msg.chat.id,
            captured
              ? '✅ Alertes Telegram activées — tu recevras ici les ventes VIP et les incidents de sécurité.'
              : '❌ Code invalide ou expiré — régénère un code depuis le dashboard (Réglages → Rythme & alertes) et réessaie.'
          );
        } catch (err) {
          console.error('Erreur capture chat_id admin:', err);
        }
        return;
      }
      await enqueueFanMessage(fanKey, msg, tenantId);
      return;
    }

    const mediaType = detectMediaType(msg);
    if (mediaType) {
      await runSerializedForFan(fanKey, () => handleNonTextMessage(msg, mediaType, tenantId));
    }
  } catch (err) {
    console.error('Erreur traitement message Telegram:', err);
  }
}

app.post('/telegram/webhook', (req, res) => processTelegramUpdate(req, res, MEELY_TENANT_ID));
app.post('/telegram/webhook/:tenantId', (req, res) => processTelegramUpdate(req, res, req.params.tenantId));

async function handleIncomingMessage(msg, opts = {}) {
  const { skipLogging = false, historyOverride = null, tenantId } = opts;
  try {
    const chatId = msg.chat.id;
    const settings = await getSettings(tenantId);

    // MISE À JOUR 30/08/2026 — pause globale (dashboard, Vue d'ensemble).
    // Différent de la pause par fan plus bas : ici on journalise quand même le
    // message reçu (pour ne rien perdre) mais on ne répond à AUCUN fan tant
    // que ce n'est pas réactivé — utile si Bryan veut couper les réponses
    // automatiques le temps de vérifier/ajuster quelque chose sans risquer
    // qu'un fan reçoive une réponse pendant ce temps.
    if (settings.bot_globally_paused) {
      if (!skipLogging) {
        try {
          const fan = await getOrCreateFan({
            telegram_user_id: msg.from.id,
            telegram_username: msg.from.username,
            first_name: msg.from.first_name,
            tenant_id: tenantId,
          });
          await logMessage(fan.id, 'fan', msg.text, false, tenantId);
        } catch (logErr) {
          console.error('Erreur journalisation pendant pause globale:', logErr.message);
        }
      }
      console.log('Bot en pause globale — message reçu, pas de réponse automatique.');
      return;
    }

    if (msg.text.startsWith('/start')) {
      const parts = msg.text.split(' ');
      const sourceToken = parts[1] || null;
      const fan = await getOrCreateFan({
        telegram_user_id: msg.from.id,
        telegram_username: msg.from.username,
        first_name: msg.from.first_name,
        source_token: sourceToken,
        tenant_id: tenantId,
      });

      // MISE À JOUR 30/08/2026 — bug trouvé en revoyant des conversations
      // réelles : un fan qui recliquait son lien Telegram (deep link, souvent
      // repartagé ou recliqué par erreur) redéclenchait TOUJOURS l'intro
      // complète, même si la conversation existait déjà depuis longtemps —
      // un fan engagé ou même déjà client recevait donc, sans aucune raison
      // apparente, exactement le même message d'accueil qu'un inconnu qui
      // découvre le bot, ce qui casse la conversation en cours et paraît
      // buggé. On vérifie maintenant s'il a déjà un historique avant d'envoyer
      // l'intro complète — et, comme pour un message normal, on respecte une
      // conversation mise en pause (l'IA ne doit pas reprendre la main toute
      // seule juste parce que le fan a retapé /start).
      if (fan.paused) {
        console.log(`Fan ${fan.id} en pause — /start reçu, pas de réponse automatique.`);
        return;
      }
      const priorHistory = await getRecentHistory(fan.id, 1);
      if (priorHistory.length > 0) {
        const welcomeBack = 'hola de nuevo! en que te ayudo hoy 😊';
        await replyToFan({ settings, chatId, fan, text: welcomeBack });
        return;
      }

      // MISE À JOUR 30/08/2026 — le message d'accueil vient maintenant du
      // système de variantes + bandit (voir lib/supabase.js, getOrCreateFan)
      // quand au moins une variante 'intro_message' existe en base : la
      // variante a déjà été assignée à ce fan à sa création
      // (fan.variant_assignments.intro_message). On ne relit pas la variante
      // "gagnante" au moment du /start — on utilise celle assignée à CE fan
      // précisément, pour que le bandit compare des groupes stables. Si aucune
      // variante n'est configurée (aucune ligne dans script_variants), on
      // retombe exactement sur l'ancien comportement (settings.intro_message /
      // intro_message_b) — aucun changement pour une installation qui n'a pas
      // encore créé de variante depuis le nouveau panneau du dashboard.
      const assignedVariantId = fan.variant_assignments && fan.variant_assignments.intro_message;
      let introTemplate = null;
      if (assignedVariantId) {
        try {
          const variant = await getScriptVariantById(assignedVariantId);
          if (variant && variant.content) introTemplate = variant.content;
        } catch (err) {
          console.error('Erreur lecture variante intro assignée (non bloquant):', err.message);
        }
      }
      if (!introTemplate) {
        introTemplate =
          fan.ab_variant === 'B' && settings.intro_message_b ? settings.intro_message_b : settings.intro_message;
      }
      const intro = introTemplate
        .replace('{persona_name}', settings.persona_name)
        .replace('{creator_name}', settings.creator_name);
      await replyToFan({ settings, chatId, fan, text: intro });

      // Expose l'événement seulement maintenant (au vrai envoi), pas à la
      // création du fan — c'est le moment où l'exposition est réelle.
      if (assignedVariantId) {
        logVariantEvent(assignedVariantId, fan.id, 'exposed', tenantId).catch((err) =>
          console.error('Erreur log exposition variante (non bloquant):', err.message)
        );
      }
      return;
    }

    const fan = await getOrCreateFan({
      telegram_user_id: msg.from.id,
      telegram_username: msg.from.username,
      first_name: msg.from.first_name,
      tenant_id: tenantId,
    });

    // `skipLogging` : ce message a déjà été journalisé au moment de sa
    // réception par enqueueFanMessage (voir plus haut) — ne pas le dupliquer.
    if (!skipLogging) {
      await logMessage(fan.id, 'fan', msg.text, false, tenantId);
    }

    // ---------- Pause par conversation ----------
    // Si l'admin (ou le filtre de sécurité ci-dessous, lors d'un incident
    // précédent) a mis cette conversation en pause, on continue à recevoir et
    // journaliser les messages du fan (ci-dessus) mais on ne fait plus
    // répondre l'IA automatiquement — Bryan/Meely reprend la main via le
    // dashboard (envoi manuel) jusqu'à ce qu'il réactive l'IA pour ce fan.
    if (fan.paused) {
      console.log(`Fan ${fan.id} en pause — message reçu, pas de réponse automatique.`);
      return;
    }

    const catalog = await getActiveCatalog(tenantId);
    // `historyOverride` : lot de messages regroupés (voir enqueueFanMessage) —
    // l'historique a déjà été capturé avant ce lot pour éviter de le
    // dupliquer avec le contenu de "fanMessage" ci-dessous.
    const history = historyOverride || (await getRecentHistory(fan.id, 20));
    const purchasedItemIds = await getPurchasedItemIds(fan.id);
    const vaultSummary = await getVaultSummary(tenantId);

    const { text, toolCalls } = await runAgentTurn({
      settings,
      catalog,
      history,
      fanMessage: msg.text,
      fan,
      purchasedItemIds,
      vaultSummary,
    });

    // ---------- Filtre de sécurité serveur (voir lib/safetyFilter.js) ----------
    // Les règles du prompt ne suffisent pas toujours face à un fan insistant
    // (constaté en prod le 29/08/2026 : contenu explicite + prix inventés
    // générés APRÈS le déploiement d'une règle de prompt censée l'empêcher).
    // Ici on vérifie le texte réellement généré avant de l'envoyer : si un
    // problème est détecté, on n'envoie JAMAIS ce texte — on envoie un message
    // de repli fixe, on journalise l'incident, on met la conversation en pause
    // automatiquement, et on alerte l'admin pour qu'il reprenne la main.
    const textReview = reviewOutgoingText({ text, catalog, settings, fanText: msg.text });
    if (!textReview.ok) {
      console.error(`⚠️ Filtre de sécurité (texte) déclenché pour fan ${fan.id}:`, textReview.reasons, '| texte bloqué:', text);
      await logSafetyIncident({ fan_id: fan.id, reasons: textReview.reasons, flagged_text: text, tenant_id: tenantId });
      await setFanPaused(fan.id, true);

      // Cas particulier : le fan demande juste un moyen de paiement alternatif
      // (Yape, Nequi, etc.) — ce n'est pas un incident grave comme du contenu
      // inventé, c'est une piste de vente à vérifier manuellement. On envoie un
      // message de repli plus adapté et une alerte moins alarmiste — voir le
      // circuit de paiement alternatif documenté dans le projet.
      const isPaymentAlt = isPaymentAlternativeOnly(textReview.reasons);
      await replyToFan({ settings, chatId, fan, text: isPaymentAlt ? PAYMENT_ALT_FALLBACK_MESSAGE : FALLBACK_MESSAGE });
      await maybeAlertAdmin(
        settings,
        isPaymentAlt
          ? `💳 ${fan.telegram_username || fan.first_name || fan.telegram_user_id} demande un moyen de paiement alternatif (Yape/Nequi/autre) — conversation mise en PAUSE, vérifie et confirme manuellement depuis le dashboard si le paiement arrive vraiment.`
          : `🚨 Alerte sécurité: réponse bloquée pour ${fan.telegram_username || fan.first_name || fan.telegram_user_id}\nRaisons: ${textReview.reasons.join('; ')}\nLa conversation a été mise en PAUSE automatiquement — va voir le dashboard pour reprendre la main.`
      );
      return;
    }

    if (text) {
      await replyToFan({ settings, chatId, fan, text });
    }

    // Le prompt demande à l'IA de ne jamais envoyer deux articles différents en
    // réponse à un seul message du fan — mais rien n'empêchait structurellement
    // le modèle d'appeler "send_offer" deux fois dans le même tour s'il décidait
    // d'ignorer cette règle (le même problème, au fond, que celui qui a motivé
    // le filtre ci-dessus). On l'impose donc aussi ici, côté serveur : au plus
    // une offre traitée par tour, qu'elle soit valide ou bloquée.
    let offerHandledThisTurn = false;

    // MISE À JOUR 01/09/2026 — bug trouvé en relisant de vraies conversations
    // (ex: fan "Alonso", deux fois "[📸 foto de aperçu enviada: Part 2]" à 4
    // secondes d'écart) : contrairement à "send_offer" juste au-dessus,
    // "send_preview" n'avait AUCUN garde-fou — si le modèle appelait l'outil
    // deux fois pour le même article dans un seul tour, la photo partait
    // réellement deux fois sur Telegram. Repéré sur au moins 6 fans différents
    // le soir du 31/08 (grep sur les messages assistant en double envoyés à
    // quelques secondes d'écart). On garde ici la trace des articles déjà
    // prévisualisés dans CE tour — un même article ne peut plus être envoyé
    // deux fois, mais deux articles différents restent possibles si le modèle
    // veut vraiment montrer deux aperçus distincts.
    const previewedItemIdsThisTurn = new Set();

    for (const call of toolCalls) {
      if (call.name === 'send_offer') {
        if (offerHandledThisTurn) {
          console.warn(`Deuxième "send_offer" ignoré dans le même tour pour fan ${fan.id} — jamais plus d'une offre par message.`);
          continue;
        }
        offerHandledThisTurn = true;

        const item = catalog.find((c) => c.id === call.input.catalog_item_id);
        if (!item) continue;

        // Même filet de sécurité, appliqué au prix réellement accordé par le
        // modèle avant de générer/envoyer le lien de paiement — indépendant
        // de ce que le texte disait, car un prix invalide peut arriver même
        // si le texte libre était propre.
        const offerReview = reviewOfferInput({ item, agreedPrice: call.input.agreed_price, settings });
        if (!offerReview.ok) {
          console.error(`⚠️ Filtre de sécurité (offre) déclenché pour fan ${fan.id}:`, offerReview.reasons);
          await logSafetyIncident({
            fan_id: fan.id,
            reasons: offerReview.reasons,
            flagged_text: `send_offer ${JSON.stringify(call.input)}`,
            tenant_id: tenantId,
          });
          await setFanPaused(fan.id, true);
          await replyToFan({ settings, chatId, fan, text: FALLBACK_MESSAGE });
          await maybeAlertAdmin(
            settings,
            `🚨 Alerte sécurité: offre bloquée pour ${fan.telegram_username || fan.first_name || fan.telegram_user_id}\nRaisons: ${offerReview.reasons.join('; ')}\nLa conversation a été mise en PAUSE automatiquement — va voir le dashboard pour reprendre la main.`
          );
          continue;
        }

        // On ne bloque plus le renvoi d'un lien déjà envoyé : on n'a aucune
        // confirmation réelle de paiement côté Dropp.fans (pas de webhook), donc
        // "déjà dans purchasedItemIds" veut juste dire "déjà envoyé une fois" —
        // bloquer ici empêchait des fans réellement intéressés de recevoir leur
        // lien une seconde fois (ex: ils redemandent, ont eu un souci de paiement).
        const alreadyOffered = purchasedItemIds.includes(item.id);

        const link = await getLinkForItem(item);
        if (!link) {
          const fallback = `Uy, tuve un pequeño problema técnico generando tu enlace — ${settings.creator_name} se va a encargar personalmente, dame un momento 🙏`;
          await replyToFan({ settings, chatId, fan, text: fallback });
          continue;
        }
        const note = call.input.note_pour_le_fan || 'Aquí tienes 😘';
        const offerMsg = `${note}\n${link}`;
        await replyToFan({ settings, chatId, fan, text: offerMsg });

        // On ne compte une "vente" (et on n'augmente total_spent / le statut
        // VIP) que la première fois qu'on envoie ce lien à ce fan — sinon un
        // simple renvoi gonflerait artificiellement les chiffres alors qu'aucun
        // paiement supplémentaire n'a eu lieu.
        if (!alreadyOffered) {
          const updatedFan = await recordSale({
            fan_id: fan.id,
            catalog_item_id: item.id,
            price: call.input.agreed_price,
            dropfans_link: link,
            tenant_id: tenantId,
          });

          if (Number(call.input.agreed_price) >= Number(settings.alert_min_sale)) {
            await maybeAlertAdmin(
              settings,
              `💰 Lien envoyé: ${item.name} — ${settings.currency_symbol || '$'}${call.input.agreed_price} (fan: ${fan.telegram_username || fan.first_name || fan.telegram_user_id})`
            );
          }

          if (updatedFan && Number(updatedFan.total_spent) >= Number(settings.vip_threshold) && !updatedFan.vip_alerted) {
            await markVipAlerted(fan.id);
            await maybeAlertAdmin(
              settings,
              `⭐ Nuevo VIP: ${fan.telegram_username || fan.first_name || fan.telegram_user_id} — total gastado: ${settings.currency_symbol || '$'}${updatedFan.total_spent}`
            );
          }
        }
      }
      // ---------- Photo d'aperçu visible par le fan (nouveau, 30/08/2026) ----------
      // Contrairement au coffre de contenu interne (jamais montré à personne),
      // cette photo est réellement envoyée sur Telegram — Bryan veut pouvoir
      // donner un vrai avant-goût visuel avant de vendre, pas juste du texte.
      // On envoie via une URL signée temporaire (voir getSignedUrl) : le
      // fichier reste dans un bucket privé, jamais rendu public en permanence.
      if (call.name === 'send_preview') {
        const item = catalog.find((c) => c.id === call.input.catalog_item_id);
        if (!item || !item.preview_image_path) {
          console.warn(`"send_preview" appelé sans aperçu disponible pour l'article demandé (fan ${fan.id}) — ignoré.`);
          continue;
        }
        if (previewedItemIdsThisTurn.has(item.id)) {
          console.warn(`"send_preview" ignoré pour fan ${fan.id} — aperçu de "${item.name}" déjà envoyé dans ce même tour.`);
          continue;
        }
        previewedItemIdsThisTurn.add(item.id);
        const previewUrl = await getSignedUrl(item.preview_image_path, 3600);
        if (!previewUrl) continue;
        try {
          await sendPhoto(settings.telegram_bot_token, chatId, previewUrl, call.input.caption || undefined);
          // Journalisé comme un message assistant classique pour que ça reste
          // visible dans l'historique du dashboard (et dans le contexte donné
          // à l'IA au tour suivant) — le contenu réel de la photo n'a pas
          // besoin d'être stocké, juste la trace qu'elle a été envoyée.
          await logMessage(fan.id, 'assistant', `[📸 foto de aperçu enviada: ${item.name}]`, false, tenantId);
        } catch (err) {
          console.error('Erreur envoi photo d\'aperçu:', err);
        }
      }
      if (call.name === 'update_fan_status') {
        await setFanStatus(fan.id, call.input.status);
      }
      if (call.name === 'remember_about_fan') {
        // Seuls les champs réellement fournis par le modèle sont mis à jour —
        // "notes" (général) est toujours réécrit en entier, les champs
        // structurés (potentiel, budget, intérêts, objections, alertes) ne
        // changent que si le modèle a détecté une nouveauté sur ce point-là.
        const patch = { memory_notes: call.input.notes };
        if (call.input.potential) patch.potential = call.input.potential;
        if (call.input.budget_notes) patch.budget_notes = call.input.budget_notes;
        if (call.input.interests_notes) patch.interests_notes = call.input.interests_notes;
        if (call.input.objections_notes) patch.objections_notes = call.input.objections_notes;
        if (call.input.red_flags_notes) patch.red_flags_notes = call.input.red_flags_notes;
        if (call.input.country) patch.country = call.input.country;
        await updateFanProfile(fan.id, patch);

        // MISE À JOUR 30/08/2026 — mémoire vectorielle (pgvector), premier
        // étage : chaque réécriture de la note générale est aussi enregistrée
        // comme embedding (voir lib/embeddings.js), pour un rappel sémantique
        // plus tard même si cette note a depuis été réécrite. Fire-and-forget
        // volontaire : ne doit jamais ralentir la réponse au fan, et est un
        // no-op silencieux tant qu'OPENAI_API_KEY n'est pas configurée.
        if (call.input.notes) {
          rememberFanNoteEmbedding(fan.id, call.input.notes, fan.tenant_id).catch((err) =>
            console.error('Erreur embedding mémoire fan (non bloquant):', err.message)
          );
        }
      }
    }
  } catch (err) {
    console.error('Erreur traitement message fan:', err);
    // Avant : en cas d'erreur (ex: appel Anthropic qui expire), le fan
    // n'avait ABSOLUMENT aucune réponse et rien ne le distinguait d'un fan
    // qui n'a simplement pas encore été traité — silence total, découvert en
    // creusant le 29/08. On tente maintenant un message de repli minimal
    // (best-effort : si même ça échoue, on abandonne sans relancer d'erreur)
    // — et le panneau "En attente de révision" du dashboard (voir
    // getStalledConversations) reste le filet de sécurité si même ce message
    // de repli ne part pas.
    try {
      const fallbackSettings = await getSettings(tenantId).catch(() => null);
      if (fallbackSettings && msg && msg.chat && msg.chat.id) {
        const fallbackText = 'uy se me trabo un momentico, ya te respondo 🙏';
        await sendMessage(fallbackSettings.telegram_bot_token, msg.chat.id, fallbackText);
        // MISE À JOUR 30/08/2026 — bug trouvé en croisant les horaires d'une
        // vraie panne de crédit Anthropic avec la conversation d'un fan
        // ("Darikson") : ce message de repli partait bien sur Telegram, mais
        // n'était JAMAIS journalisé dans `conversation_messages` (contrairement
        // à tous les autres envois, qui passent par `replyToFan`/`logMessage`).
        // Résultat : côté dashboard, rien ne distinguait "le fan attend une
        // réponse" de "tout va bien" — la panne de plusieurs heures était
        // invisible. On journalise maintenant ce repli comme n'importe quel
        // autre message assistant, même si `fan` n'a pas pu être résolu plus
        // haut (dans ce cas on ne peut rien journaliser, mais c'est rarissime :
        // `getOrCreateFan` est justement la première chose qui échouerait).
        //
        // MISE À JOUR 30/08/2026 (v2, audit) — journaliser le repli ne suffisait
        // pas : `get_stalled_conversations` ne regardait que `role = 'fan'`
        // pour décider qu'une conversation attend une réponse. Ce repli étant
        // loggé en `role: 'assistant'`, le fan redevenait invisible du panneau
        // "En attente de révision" alors qu'il n'a JAMAIS eu de vraie réponse —
        // exactement pendant une panne de crédit comme celle du 30/08, le
        // moment où ce filet de sécurité est le plus utile. `is_fallback: true`
        // dit à la fonction SQL de continuer à traiter ce fan comme "en attente".
        try {
          const fallbackFan = await getOrCreateFan({
            telegram_user_id: msg.from.id,
            telegram_username: msg.from.username,
            first_name: msg.from.first_name,
            tenant_id: tenantId,
          });
          await logMessage(fallbackFan.id, 'assistant', fallbackText, true, tenantId);
        } catch (logErr) {
          console.error('Erreur journalisation message de repli:', logErr);
        }

        // MISE À JOUR 01/09/2026 — voir maybeAlertAdminOfProcessingError : Bryan
        // doit être prévenu en temps réel (pas seulement via le dashboard) quand
        // le bot ne peut plus répondre — fire-and-forget, ne doit jamais faire
        // planter ce chemin de repli qui est déjà le dernier filet de sécurité.
        maybeAlertAdminOfProcessingError(fallbackSettings, tenantId, err).catch((alertErr) =>
          console.error('Erreur alerte admin (échec de traitement):', alertErr.message)
        );
      }
    } catch (fallbackErr) {
      console.error('Erreur envoi message de repli après échec de traitement:', fallbackErr);
    }
  }
}

// ---------- Génération de lien traçable (depuis la landing page) ----------
// `tenant_id` optionnel dans le corps : retombe sur Meely (comportement
// historique) si absent, pour ne rien casser sur la landing page existante —
// une future landing page par créatrice pourra passer son propre tenant_id.
app.post('/api/tracking-link', async (req, res) => {
  try {
    const { campaign_label, tenant_id } = req.body;
    const resolvedTenantId = tenant_id || MEELY_TENANT_ID;
    const settings = await getSettings(resolvedTenantId);
    const token = crypto.randomBytes(6).toString('hex');
    const { error } = await supabase
      .from('tracking_links')
      .insert({ source_token: token, campaign_label, tenant_id: resolvedTenantId });
    if (error) throw error;
    const link = `https://t.me/${settings.telegram_bot_username}?start=${token}`;
    res.json({ link, token });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'internal_error' });
  }
});

// ---------- Inscription self-service (SaaS ouvert à tous) ----------
// MISE À JOUR 30/08/2026 — Meeli devient une plateforme ouverte : n'importe
// quelle créatrice/entreprise peut créer son compte ici (voir public/signup),
// pas seulement les créatrices déjà recrutées par Bryan. Route volontairement
// PUBLIQUE (pas de requireAdminToken) puisque personne n'a encore de token à
// ce stade — createTenant() (lib/supabase.js) crée le tenant + ses réglages
// par défaut + un premier token admin ; on tente ensuite de configurer le
// webhook Telegram de ce nouveau bot, en best-effort (une erreur ici ne doit
// pas empêcher la créatrice de récupérer son compte — elle pourra relancer
// "Configurer le webhook" depuis son dashboard, voir /api/admin/setup-webhook).
app.post('/api/signup', async (req, res) => {
  try {
    const { name, owner_email, telegram_bot_token, telegram_bot_username } = req.body || {};
    if (!name || !name.trim() || !telegram_bot_token || !telegram_bot_token.trim()) {
      return res.status(400).json({ error: 'name et telegram_bot_token sont obligatoires.' });
    }
    const { tenant, adminToken } = await createTenant({
      name: name.trim(),
      owner_email: owner_email ? owner_email.trim() : null,
      telegram_bot_token: telegram_bot_token.trim(),
      telegram_bot_username: telegram_bot_username ? telegram_bot_username.trim() : null,
    });

    const base = process.env.PUBLIC_BASE_URL;
    let webhookResult = null;
    if (base) {
      try {
        webhookResult = await setWebhook(tenant.telegram_bot_token, `${base}/telegram/webhook/${tenant.id}`);
      } catch (whErr) {
        console.error(`Erreur configuration webhook Telegram pour nouveau tenant ${tenant.id}:`, whErr.message);
      }
    }

    res.json({
      ok: true,
      tenant_id: tenant.id,
      admin_token: adminToken.token,
      dashboard_url: '/admin/',
      webhook_configured: !!(webhookResult && webhookResult.ok !== false),
    });
  } catch (err) {
    console.error('Erreur inscription tenant:', err.message);
    res.status(400).json({ error: err.message });
  }
});

// ---------- Facturation Stripe (squelette — voir lib/stripe.js) ----------
// IMPORTANT : aucun produit/prix Stripe n'est créé automatiquement ici — c'est
// une décision business qui revient à Bryan. Tant que STRIPE_SECRET_KEY /
// STRIPE_PRICE_ID ne sont pas configurées sur Render, cette route renvoie une
// erreur claire plutôt que de planter, et l'inscription self-service
// ci-dessus continue de fonctionner normalement en statut "trial" sans elle.
app.post('/api/admin/billing/checkout', requireAdminToken, async (req, res) => {
  try {
    if (!stripeBilling.available) {
      return res.status(400).json({ error: 'Facturation Stripe non configurée côté serveur pour le moment.' });
    }
    const tenant = await getTenantById(req.tenantId);
    if (!tenant) return res.status(404).json({ error: 'tenant introuvable' });
    const base = process.env.PUBLIC_BASE_URL || '';
    const session = await stripeBilling.createCheckoutSession({
      tenantId: tenant.id,
      customerEmail: tenant.owner_email || undefined,
      successUrl: `${base}/admin/?billing=success`,
      cancelUrl: `${base}/admin/?billing=cancel`,
    });
    res.json({ url: session.url });
  } catch (err) {
    console.error('Erreur création session Stripe Checkout:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// Webhook Stripe — corps BRUT (voir express.raw() monté plus haut, avant
// express.json()). Deux événements suffisent pour gérer le cycle de vie
// basique d'un abonnement : activation à la 1ère facture payée, suspension si
// l'abonnement est annulé/résilié. `metadata.tenant_id` a été posé lors de la
// création de la session Checkout ci-dessus.
app.post('/api/webhooks/stripe', async (req, res) => {
  try {
    const signature = req.headers['stripe-signature'];
    stripeBilling.verifyWebhookSignature(req.body, signature);
    const event = JSON.parse(req.body.toString('utf8'));

    if (event.type === 'checkout.session.completed') {
      const session = event.data.object;
      const tenantId = session.metadata && session.metadata.tenant_id;
      if (tenantId) {
        await updateTenant(tenantId, {
          status: 'active',
          stripe_customer_id: session.customer || null,
          stripe_subscription_id: session.subscription || null,
        });
      }
    } else if (event.type === 'customer.subscription.deleted') {
      const subscription = event.data.object;
      const tenantId = subscription.metadata && subscription.metadata.tenant_id;
      if (tenantId) {
        await updateTenant(tenantId, { status: 'canceled' });
      }
    } else if (event.type === 'invoice.payment_failed') {
      const invoice = event.data.object;
      const tenantId = invoice.subscription_details?.metadata?.tenant_id;
      if (tenantId) {
        await updateTenant(tenantId, { status: 'suspended' });
      }
    }

    res.json({ received: true });
  } catch (err) {
    console.error('Erreur webhook Stripe:', err.message);
    res.status(400).json({ error: err.message });
  }
});

// ---------- API Admin: settings ----------
app.get('/api/admin/settings', requireAdminToken, async (req, res) => {
  try {
    res.json(await getSettings(req.tenantId));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// IMPORTANT : sans try/catch ici, une erreur dans updateSettings() (ex: le
// bug bigint corrigé dans lib/supabase.js) ne renvoyait JAMAIS de réponse au
// dashboard — la requête restait bloquée côté navigateur indéfiniment. Le
// bouton "Enregistrer" restait donc coincé sur "Enregistrement..." pour
// toujours, sans succès NI message d'erreur — exactement le symptôme
// rapporté ("ça n'enregistre pas"). Repéré le 29/08 via les logs serveur.
app.put('/api/admin/settings', requireAdminToken, async (req, res) => {
  try {
    res.json(await updateSettings(req.body, req.tenantId));
  } catch (err) {
    console.error('Erreur mise à jour réglages:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ---------- API Admin: pause/reprise globale du bot ----------
// MISE À JOUR 30/08/2026 — bouton demandé par Bryan pour couper toute réponse
// automatique en un clic (Vue d'ensemble), sans passer par le formulaire
// complet des réglages. Route dédiée et minimale (un seul booléen) plutôt que
// de réutiliser PUT /api/admin/settings avec un payload partiel, pour éviter
// tout risque d'écraser d'autres champs par erreur depuis ce bouton rapide.
app.post('/api/admin/bot-pause', requireAdminToken, async (req, res) => {
  try {
    const paused = req.body.paused === true;
    const updated = await updateSettings({ bot_globally_paused: paused }, req.tenantId);
    res.json({ bot_globally_paused: updated.bot_globally_paused });
  } catch (err) {
    console.error('Erreur pause globale du bot:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ---------- API Admin: génération IA d'une suggestion de script de vente ----------
// MISE À JOUR 30/08/2026 — bouton "Générer une suggestion" dans Persona & Script.
// Appel ponctuel (pas d'agent, pas d'outils) qui propose un jeu de textes cohérent
// avec la persona et le catalogue actuels. Ne sauvegarde jamais automatiquement :
// le front pré-remplit les champs et Bryan doit cliquer "Enregistrer" lui-même.
app.post('/api/admin/generate-script-suggestion', requireAdminToken, async (req, res) => {
  try {
    const settings = await getSettings(req.tenantId);
    const catalog = await getActiveCatalog(req.tenantId);
    const suggestion = await generateScriptSuggestion({ settings, catalog });
    res.json(suggestion);
  } catch (err) {
    console.error('Erreur génération suggestion de script:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ---------- API Admin: variantes de script + bandit (voir lib/supabase.js et
// lib/banditMath.js) ----------
// MISE À JOUR 30/08/2026 — remplace/généralise l'ancien A/B figé
// (settings.intro_message / intro_message_b, tirage 50/50). `field_key`
// identifie le champ de script concerné ('intro_message' est le seul câblé
// de bout en bout côté /start pour l'instant — voir handleIncomingMessage).
app.get('/api/admin/script-variants', requireAdminToken, async (req, res) => {
  try {
    const field_key = typeof req.query.field_key === 'string' && req.query.field_key ? req.query.field_key : 'intro_message';
    const variants = await getVariantStats(field_key, req.tenantId);
    res.json(variants);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/admin/script-variants', requireAdminToken, async (req, res) => {
  try {
    const { field_key, label, content } = req.body || {};
    if (!field_key || !content || !content.trim()) {
      return res.status(400).json({ error: 'field_key et content sont obligatoires.' });
    }
    const variant = await createScriptVariant({ field_key, label, content: content.trim(), tenant_id: req.tenantId });
    res.json(variant);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.patch('/api/admin/script-variants/:id', requireAdminToken, async (req, res) => {
  try {
    const variant = await updateScriptVariant(req.params.id, req.body || {});
    res.json(variant);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ---------- API Admin: historique des versions du Persona & Script ----------
// MISE À JOUR 30/08/2026 — chaque sauvegarde réussie de "settings" prend
// désormais une photo dans settings_history (voir snapshotSettings, appelé
// depuis updateSettings). Ces deux routes permettent au dashboard de lister
// les versions passées et d'en restaurer une.
app.get('/api/admin/settings/history', requireAdminToken, async (req, res) => {
  try {
    const limit = Math.min(100, Math.max(1, Number(req.query.limit) || 20));
    res.json(await listSettingsHistory(req.tenantId, limit));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/admin/settings/history/:id/restore', requireAdminToken, async (req, res) => {
  try {
    res.json(await restoreSettingsVersion(req.params.id, req.tenantId));
  } catch (err) {
    console.error('Erreur restauration réglages:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ---------- API Admin: connexion des alertes Telegram ----------
// Voir lib/supabase.js (tryCaptureAdminChatId) et le webhook Telegram
// ci-dessous ("/admin_CODE") : évite à Bryan de devoir trouver son chat_id à
// la main (jamais fait en pratique — c'est pour ça qu'aucune alerte ne
// partait jamais avant le 30/08/2026).
app.post('/api/admin/generate-setup-code', requireAdminToken, async (req, res) => {
  try {
    const code = await generateAdminSetupCode(req.tenantId);
    const settings = await getSettings(req.tenantId);
    res.json({ code, botUsername: settings.telegram_bot_username || null });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/admin/test-alert', requireAdminToken, async (req, res) => {
  try {
    const settings = await getSettings(req.tenantId);
    if (!settings.admin_telegram_chat_id) {
      return res.status(400).json({ error: 'Aucun chat_id enregistré — connecte les alertes ci-dessus d\'abord.' });
    }
    await sendMessage(settings.telegram_bot_token, settings.admin_telegram_chat_id, '🔔 Test réussi — les alertes Meeli arrivent bien ici.');
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ---------- API Admin: catalogue ----------
app.get('/api/admin/catalog', requireAdminToken, async (req, res) => {
  const { data, error } = await supabase
    .from('catalog_items')
    .select('*')
    .eq('tenant_id', req.tenantId)
    .order('sort_order');
  if (error) return res.status(500).json({ error: error.message });
  // Ajoute une URL signée temporaire pour la photo d'aperçu visible-fan de
  // chaque article (si elle existe) — pour que le dashboard (Assistant
  // magique, Catalogue) puisse l'afficher sans exposer le bucket publiquement.
  const withPreviews = await Promise.all(
    (data || []).map(async (it) => ({
      ...it,
      preview_url: it.preview_image_path ? await getSignedUrl(it.preview_image_path, 3600) : null,
    }))
  );
  res.json(withPreviews);
});

app.post('/api/admin/catalog', requireAdminToken, async (req, res) => {
  // On retire un éventuel tenant_id envoyé par erreur depuis le front avant
  // de forcer le vrai (celui du token admin authentifié) — même garde-fou
  // que côté lib/supabase.js pour les autres inserts.
  const payload = { ...req.body, tenant_id: req.tenantId };
  const { data, error } = await supabase.from('catalog_items').insert(payload).select().single();
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

app.put('/api/admin/catalog/:id', requireAdminToken, async (req, res) => {
  const payload = { ...req.body };
  delete payload.tenant_id;
  const { data, error } = await supabase
    .from('catalog_items')
    .update(payload)
    .eq('id', req.params.id)
    .eq('tenant_id', req.tenantId)
    .select()
    .single();
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

app.delete('/api/admin/catalog/:id', requireAdminToken, async (req, res) => {
  const { error } = await supabase
    .from('catalog_items')
    .delete()
    .eq('id', req.params.id)
    .eq('tenant_id', req.tenantId);
  if (error) {
    // MISE À JOUR 31/08/2026 — bug trouvé lors de l'audit : "supprimer" ne
    // marchait pour AUCUN article réel du catalogue de Bryan, car chacun a
    // déjà des ventes enregistrées (table `sales`, contrainte de clé étrangère
    // catalog_item_id en ON DELETE NO ACTION — volontaire, pour ne jamais
    // perdre l'historique des ventes). Supabase renvoyait donc une erreur SQL
    // brute (code 23503) que l'admin ne pouvait pas comprendre ("ça ne marche
    // pas" côté Bryan). On détecte ce cas précis pour répondre avec un message
    // clair, et on ne touche PAS à la contrainte elle-même : l'historique des
    // ventes doit rester intact, "Désactiver" (déjà dans le menu ⋯) est le bon
    // geste pour retirer un article de la vente sans perdre cet historique.
    if (error.code === '23503') {
      return res.status(409).json({
        error: "Impossible de supprimer : cet article a déjà des ventes enregistrées (l'historique des ventes est protégé). Utilise plutôt \"Désactiver\" dans le menu ⋯ pour le retirer de la vente sans rien perdre.",
      });
    }
    return res.status(500).json({ error: error.message });
  }
  res.json({ ok: true });
});

// ---------- API Admin: photo d'aperçu VISIBLE PAR LE FAN d'un article ----------
// Utilisé par l'Assistant magique (dashboard) — différent de l'upload du
// coffre de contenu (/api/admin/vault/upload), qui reste interne à l'IA et
// n'est jamais envoyé sur Telegram. Voir "send_preview" plus haut.
app.post('/api/admin/catalog/:id/preview', requireAdminToken, upload.single('file'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'aucun fichier reçu' });
    const ext = (req.file.originalname.split('.').pop() || 'jpg').toLowerCase().replace(/[^a-z0-9]/g, '') || 'jpg';
    const storagePath = `previews/${req.params.id}-${crypto.randomUUID()}.${ext}`;
    const { error: uploadErr } = await supabase.storage
      .from('content-vault')
      .upload(storagePath, req.file.buffer, { contentType: req.file.mimetype });
    if (uploadErr) throw uploadErr;
    const updated = await setCatalogItemPreview(req.params.id, storagePath);
    const previewUrl = await getSignedUrl(storagePath, 3600);
    res.json({ ok: true, item: updated, previewUrl });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/admin/catalog/:id/preview', requireAdminToken, async (req, res) => {
  try {
    const updated = await setCatalogItemPreview(req.params.id, null);
    res.json({ ok: true, item: updated });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ---------- API Admin: fans en direct + conversations ----------
app.get('/api/admin/fans', requireAdminToken, async (req, res) => {
  try {
    // MISE À JOUR 30/08/2026 — plafond relevé (200 -> 2000) : maintenant que
    // listFansWithPreview() découpe son .in() en petits lots, une limite plus
    // large ne risque plus de reproduire le bug d'URL trop longue. `search`/
    // `status` sont transmis pour filtrer côté serveur sur toute la table,
    // pas seulement sur la page déjà chargée (voir listFansWithPreview).
    const limit = Math.min(Number(req.query.limit) || 50, 2000);
    const search = typeof req.query.search === 'string' ? req.query.search : '';
    const status = typeof req.query.status === 'string' ? req.query.status : '';
    const fans = await listFansWithPreview({ tenant_id: req.tenantId, limit, search, status });
    res.json(fans);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/admin/fans/:id/messages', requireAdminToken, async (req, res) => {
  try {
    const [fan, messages] = await Promise.all([
      getFanById(req.params.id),
      getFullConversation(req.params.id),
    ]);
    res.json({ fan, messages });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ---------- API Admin: pause / reprise de l'IA sur UNE conversation précise ----------
app.put('/api/admin/fans/:id/pause', requireAdminToken, async (req, res) => {
  try {
    const paused = !!req.body.paused;
    await setFanPaused(req.params.id, paused);
    res.json({ ok: true, paused });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ---------- API Admin: envoi manuel d'un message par Bryan/Meely, via l'identité
// Telegram du bot — pensé pour être utilisé pendant qu'une conversation est en
// pause, pour reprendre la main personnellement sur un cas intéressant/sensible.
app.post('/api/admin/fans/:id/message', requireAdminToken, async (req, res) => {
  try {
    const text = (req.body.text || '').trim();
    if (!text) return res.status(400).json({ error: 'texte manquant' });
    const [fan, settings] = await Promise.all([getFanById(req.params.id), getSettings(req.tenantId)]);
    if (!fan) return res.status(404).json({ error: 'fan introuvable' });
    await sendMessage(settings.telegram_bot_token, fan.telegram_user_id, text);
    await logMessage(fan.id, 'assistant', text, false, fan.tenant_id);
    // Optionnel : reprendre l'IA dans la foulée (case à cocher côté dashboard)
    // — pratique quand l'admin vient de débloquer une situation à la main et
    // veut que l'IA reprenne automatiquement sur le prochain message du fan.
    if (req.body.unpause) await setFanPaused(fan.id, false);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ---------- API Admin: note manuelle libre sur un fan (distincte des notes
// écrites par l'IA) — voir lib/supabase.js:setFanAdminNote.
app.put('/api/admin/fans/:id/note', requireAdminToken, async (req, res) => {
  try {
    await setFanAdminNote(req.params.id, req.body.note || '');
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ---------- API Admin: incidents de sécurité (texte/offre bloqués automatiquement
// par le filtre serveur — voir lib/safetyFilter.js) ----------
app.get('/api/admin/safety-incidents', requireAdminToken, async (req, res) => {
  try {
    res.json(await listSafetyIncidents(req.tenantId, 50));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// "Dépiler" un incident traité — disparaît du panneau (reste en base pour
// l'historique, juste marqué résolu).
app.put('/api/admin/safety-incidents/:id/resolve', requireAdminToken, async (req, res) => {
  try {
    await resolveSafetyIncident(req.params.id);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ---------- API Admin: "En attente de révision" — conversations où le fan a
// écrit en dernier, l'IA n'est pas en pause, et pourtant rien n'a été
// renvoyé depuis plus de quelques minutes (voir getStalledConversations).
// Sert d'alerte visible sur le dashboard pour que Bryan/Meely puisse
// intervenir manuellement quand le bot "arrête de répondre" pour x ou y
// raison — peu importe la cause exacte.
app.get('/api/admin/stalled-conversations', requireAdminToken, async (req, res) => {
  try {
    const minutes = Math.max(1, Number(req.query.minutes) || 5);
    res.json(await getStalledConversations(req.tenantId, minutes));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// "Dépiler" une conversation bloquée — disparaît du panneau tant que le fan
// n'a pas écrit de nouveau message depuis (voir dismissStalledFan).
app.put('/api/admin/stalled-conversations/:fanId/dismiss', requireAdminToken, async (req, res) => {
  try {
    await dismissStalledFan(req.params.fanId, req.tenantId);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ---------- API Admin: fans par pays (carte interactive Vue d'ensemble) ----------
// MISE À JOUR 30/08/2026 — alimente la carte demandée par Bryan. Renvoie un
// simple objet { "Colombia": 12, "México": 5, ... } : le pays est celui que
// l'IA a enregistré via remember_about_fan quand le fan l'a mentionné.
app.get('/api/admin/analytics/geo', requireAdminToken, async (req, res) => {
  try {
    res.json(await getFanCountByCountry(req.tenantId));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ---------- API Admin: pouls de l'audience en temps réel ----------
// MISE À JOUR 31/08/2026 — demandé par Bryan : un panneau qui se réactualise
// toutes les 1 min avec des indicateurs "chauds" (conversations chaudes,
// potentiel de revenu, ce que les fans demandent) — voir
// getLiveAudiencePulse() dans lib/supabase.js pour le détail de chaque calcul
// et pourquoi certaines métriques évidentes (ex: "confirmé aujourd'hui")
// n'existent volontairement pas.
app.get('/api/admin/analytics/live-pulse', requireAdminToken, async (req, res) => {
  try {
    res.json(await getLiveAudiencePulse(req.tenantId));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ---------- API Admin: simulateur de conversation (sans Telegram) ----------
// MISE À JOUR 30/08/2026 — "aperçu vivant" (dashboard, Persona & Script) :
// le simulateur accepte maintenant un `settingsOverride` optionnel, fusionné
// PAR-DESSUS les vrais réglages venant de la BDD, uniquement pour cet appel —
// rien n'est jamais sauvegardé ici. Ça permet à Bryan de voir tout de suite
// l'effet d'un changement (ton, script, politique appel vidéo, etc.) avant
// de cliquer sur "Enregistrer", sans jamais toucher aux vrais réglages en
// prod tant qu'il n'a pas validé. Déclenché uniquement par un clic explicite
// côté dashboard (jamais à chaque frappe) pour ne pas multiplier les appels
// Claude facturés — voir l'incident de crédit épuisé du 29/08.
app.post('/api/admin/test-chat', requireAdminToken, async (req, res) => {
  try {
    const { message, history, settingsOverride } = req.body; // history: [{role:'fan'|'assistant', content}]
    const realSettings = await getSettings(req.tenantId);
    const settings =
      settingsOverride && typeof settingsOverride === 'object'
        ? { ...realSettings, ...settingsOverride }
        : realSettings;
    const catalog = await getActiveCatalog(req.tenantId);
    const vaultSummary = await getVaultSummary(req.tenantId);
    const fakeFan = { id: 'test', last_active_at: new Date().toISOString(), memory_notes: '' };
    const { text, toolCalls } = await runAgentTurn({
      settings,
      catalog,
      history: history || [],
      fanMessage: message,
      fan: fakeFan,
      vaultSummary,
    });
    const maxBubbles = Number(settings.max_message_bubbles) || DEFAULT_MAX_BUBBLES;
    const bubbles = capBubbles(splitIntoBubbles(text), maxBubbles).map(stripInvertedPunctuation);

    // Même filtre de sécurité qu'en prod (voir handleIncomingMessage), mais en
    // mode "aperçu" seulement : rien n'est bloqué ni mis en pause ici, ça sert
    // juste à tester/ajuster le script sans attendre qu'un vrai fan tombe dessus.
    const safety = reviewOutgoingText({ text, catalog, settings, fanText: message });
    const reasons = [...safety.reasons];
    toolCalls.forEach((c) => {
      if (c.name !== 'send_offer') return;
      const item = catalog.find((i) => i.id === c.input.catalog_item_id);
      if (!item) return;
      const offerReview = reviewOfferInput({ item, agreedPrice: c.input.agreed_price, settings });
      if (!offerReview.ok) reasons.push(...offerReview.reasons);
    });

    res.json({
      text,
      bubbles,
      toolCalls: toolCalls.map((c) => ({ name: c.name, input: c.input })),
      safety: { ok: reasons.length === 0, reasons },
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// ---------- API Admin: gestion des accès admin ----------
app.get('/api/admin/admins', requireAdminToken, async (req, res) => {
  const tokens = await listAdminTokens(req.tenantId);
  res.json(tokens);
});

app.post('/api/admin/admins', requireAdminToken, async (req, res) => {
  const created = await createAdminToken(req.body.label || 'Sans nom', req.tenantId);
  res.json(created);
});

app.delete('/api/admin/admins/:id', requireAdminToken, async (req, res) => {
  await deleteAdminToken(req.params.id, req.tenantId);
  res.json({ ok: true });
});

// ---------- API Admin: analytics ----------
app.get('/api/admin/analytics', requireAdminToken, async (req, res) => {
  res.json(await getAnalytics(req.tenantId));
});

app.get('/api/admin/analytics/timeseries', requireAdminToken, async (req, res) => {
  try {
    const days = Math.min(Number(req.query.days) || 30, 90);
    res.json(await getDailyTimeseries(req.tenantId, days));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ---------- API Admin: ventes (distinguer "envoyé" vs "payé confirmé") ----------
// Rappel : sans webhook Dropp.fans, rien ne confirme automatiquement qu'un
// paiement a vraiment eu lieu. Ces routes servent à ce que Bryan/Meely le
// constatent eux-mêmes (wallet Dropp, ou preuve Yape/Nequi) et le déclarent.
app.get('/api/admin/sales', requireAdminToken, async (req, res) => {
  try {
    const limit = Math.min(Number(req.query.limit) || 100, 300);
    res.json(await listSales(req.tenantId, limit));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.put('/api/admin/sales/:id/confirm', requireAdminToken, async (req, res) => {
  try {
    const updated = await confirmSale(req.params.id, { payment_method: req.body.payment_method });
    res.json(updated);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Enregistre une vente qui n'est jamais passée par "send_offer" (ex: paiement
// Yape/Nequi vérifié à la main par l'admin) — crée directement une ligne déjà
// marquée "payée" et met à jour le total dépensé du fan.
// ---------- API Admin: coffre de contenu (organisation par catégorie) ----------
// Les fichiers réels sont stockés dans Supabase Storage (bucket privé
// "content-vault"), jamais exposés publiquement — seul ce serveur (clé
// service_role) y accède. L'IA ne reçoit jamais ces fichiers, seulement un
// résumé par catégorie (voir getVaultSummary / lib/claudeAgent.js).
app.get('/api/admin/vault', requireAdminToken, async (req, res) => {
  try {
    const assets = await listVaultAssets(req.tenantId);
    const withUrls = await Promise.all(
      assets.map(async (a) => {
        const { data } = await supabase.storage.from('content-vault').createSignedUrl(a.storage_path, 3600);
        return { ...a, url: data?.signedUrl || null };
      })
    );
    res.json(withUrls);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/admin/vault/upload', requireAdminToken, upload.array('files', 20), async (req, res) => {
  try {
    const { category, catalog_item_id } = req.body;
    if (!category) return res.status(400).json({ error: 'category manquante' });
    if (!req.files || !req.files.length) return res.status(400).json({ error: 'aucun fichier reçu' });

    const saved = [];
    for (const file of req.files) {
      const ext = (file.originalname.split('.').pop() || 'bin').toLowerCase().replace(/[^a-z0-9]/g, '') || 'bin';
      const storagePath = `${category}/${crypto.randomUUID()}.${ext}`;
      const { error: uploadErr } = await supabase.storage
        .from('content-vault')
        .upload(storagePath, file.buffer, { contentType: file.mimetype });
      if (uploadErr) throw uploadErr;
      const media_type = file.mimetype.startsWith('video/') ? 'video' : 'photo';
      saved.push(await addVaultAsset({ category, media_type, storage_path: storagePath, catalog_item_id: catalog_item_id || null, tenant_id: req.tenantId }));
    }
    res.json({ ok: true, uploaded: saved.length });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/admin/vault/:id', requireAdminToken, async (req, res) => {
  try {
    await deleteVaultAsset(req.params.id);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ---------- API Admin: "Live Ops" — métriques temps réel pour le panneau en
// haut de la Vue d'ensemble. Combine des compteurs base de données (chats
// actifs, pauses, messages/incidents du jour) avec des métriques en mémoire
// du process (fanQueues, uptime) et une ESTIMATION du crédit IA restant.
//
// Important sur le crédit IA : Anthropic n'expose aucune API de solde en
// temps réel (vérifié — seule une API d'historique d'usage/coût existe, avec
// des identifiants "Admin API" différents de la clé utilisée par le bot). Ce
// qui suit est donc une ESTIMATION : solde saisi manuellement par l'admin à
// chaque recharge, moins le coût des tokens réellement consommés (journalisés
// à chaque appel Claude — voir lib/claudeAgent.js) depuis cette date, au tarif
// standard du modèle utilisé (claude-sonnet-4-5 : $3/M tokens en entrée, $15/M
// tokens en sortie — tarifs vérifiés sur platform.claude.com le 29/08/2026).
const AI_INPUT_PRICE_PER_MTOK = 3;
const AI_OUTPUT_PRICE_PER_MTOK = 15;

app.get('/api/admin/live-stats', requireAdminToken, async (req, res) => {
  try {
    const settings = await getSettings(req.tenantId);
    const [dbStats, usage, stalled] = await Promise.all([
      getLiveOpsStats(req.tenantId),
      getAiUsageSince(settings.ai_credit_balance_updated_at || null, req.tenantId),
      getStalledConversations(req.tenantId, 5).catch((err) => {
        console.error('Erreur calcul conversations en attente de révision:', err.message);
        return [];
      }),
    ]);
    const spentUsd =
      (usage.input / 1e6) * AI_INPUT_PRICE_PER_MTOK + (usage.output / 1e6) * AI_OUTPUT_PRICE_PER_MTOK;
    const balance = settings.ai_credit_balance != null ? Number(settings.ai_credit_balance) : null;
    const estimatedRemaining = balance != null ? Math.max(0, balance - spentUsd) : null;

    // ---------- Alerte crédit IA bas ----------
    // Avant : aucune alerte n'existait — le bot est déjà tombé en panne une
    // fois pour crédit épuisé sans que personne ne le sache avant qu'un fan ne
    // s'en plaigne (voir l'audit). Le solde n'étant qu'une estimation vérifiée
    // à chaque chargement du dashboard (pas de webhook Anthropic), l'alerte se
    // déclenche ici au lieu d'un vrai cron — suffisant tant que le dashboard
    // est consulté régulièrement, et sans coût technique supplémentaire.
    const threshold = settings.low_credit_alert_threshold != null ? Number(settings.low_credit_alert_threshold) : 10;
    if (estimatedRemaining != null && estimatedRemaining <= threshold && !settings.low_credit_alert_sent) {
      await markLowCreditAlertSent(req.tenantId);
      await maybeAlertAdmin(
        settings,
        `🪫 Crédit IA bas: il reste environ $${estimatedRemaining.toFixed(2)} (estimation). Recharge chez Anthropic puis mets à jour le solde dans le dashboard pour ne pas couper le bot.`
      );
    }

    res.json({
      ...dbStats,
      stalledCount: stalled.length,
      // Ne compte que les files d'attente de CE tenant — fanQueues est
      // partagé entre toutes les créatrices depuis le passage multi-tenant
      // (voir fanKey = `${tenantId}:${telegram_user_id}`).
      queueSize: [...fanQueues.keys()].filter((k) => k.startsWith(`${req.tenantId}:`)).length,
      uptimeSeconds: Math.floor(process.uptime()),
      botGloballyPaused: !!settings.bot_globally_paused,
      aiCredit: {
        balance,
        balanceUpdatedAt: settings.ai_credit_balance_updated_at || null,
        estimatedSpentSinceReset: Math.round(spentUsd * 100) / 100,
        estimatedRemaining: estimatedRemaining != null ? Math.round(estimatedRemaining * 100) / 100 : null,
        tokensSinceReset: usage,
      },
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Saisie manuelle du solde de crédit IA (ex: juste après une recharge chez
// Anthropic) — repart de zéro pour l'estimation ci-dessus.
app.put('/api/admin/ai-credit-balance', requireAdminToken, async (req, res) => {
  try {
    const amount = Number(req.body.amount);
    if (Number.isNaN(amount) || amount < 0) return res.status(400).json({ error: 'montant invalide' });
    const updated = await setAiCreditBalance(amount, req.tenantId);
    res.json({ ok: true, balance: updated.ai_credit_balance, updatedAt: updated.ai_credit_balance_updated_at });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ---------- API Admin: aperçu du prompt système actuel (débogage/transparence) ----------
app.get('/api/admin/system-prompt-preview', requireAdminToken, async (req, res) => {
  try {
    const settings = await getSettings(req.tenantId);
    const catalog = await getActiveCatalog(req.tenantId);
    const vaultSummary = await getVaultSummary(req.tenantId);
    const fakeFan = {
      id: 'preview',
      last_active_at: new Date().toISOString(),
      memory_notes: '(exemple) Le gusta hablar de fitness, prefiere que le digan "bebé".',
      potential: 'potencial',
      budget_notes: '',
      interests_notes: '',
      objections_notes: '',
      red_flags_notes: '',
    };
    const prompt = buildSystemPrompt({ settings, catalog, fan: fakeFan, purchasedItemIds: [], vaultSummary });
    res.json({ prompt });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ---------- API Admin: export CSV ----------
app.get('/api/admin/export/fans.csv', requireAdminToken, async (req, res) => {
  const { data } = await supabase.from('fans').select('*').eq('tenant_id', req.tenantId).order('created_at');
  const rows = ['id,telegram_username,first_name,status,total_spent,ab_variant,source_token,created_at'];
  (data || []).forEach((f) => {
    rows.push(
      [f.id, f.telegram_username, f.first_name, f.status, f.total_spent, f.ab_variant, f.source_token, f.created_at]
        .map((v) => `"${(v ?? '').toString().replace(/"/g, '""')}"`)
        .join(',')
    );
  });
  res.setHeader('Content-Type', 'text/csv');
  res.setHeader('Content-Disposition', 'attachment; filename="fans.csv"');
  res.send(rows.join('\n'));
});

app.get('/api/admin/export/sales.csv', requireAdminToken, async (req, res) => {
  const { data } = await supabase
    .from('sales')
    .select('*, fans(telegram_username, first_name)')
    .eq('tenant_id', req.tenantId)
    .order('created_at');
  const rows = ['id,fan,price,status,payment_method,dropfans_link,created_at'];
  (data || []).forEach((s) => {
    const fanLabel = s.fans?.telegram_username || s.fans?.first_name || s.fan_id;
    rows.push(
      [s.id, fanLabel, s.price, s.status, s.payment_method, s.dropfans_link, s.created_at]
        .map((v) => `"${(v ?? '').toString().replace(/"/g, '""')}"`)
        .join(',')
    );
  });
  res.setHeader('Content-Type', 'text/csv');
  res.setHeader('Content-Disposition', 'attachment; filename="sales.csv"');
  res.send(rows.join('\n'));
});

// ---------- Setup webhook Telegram (à appeler une fois après déploiement) ----------
// MISE À JOUR 30/08/2026 (multi-tenant) — Meely (tenant fondateur) garde son
// URL de webhook historique sans tenant_id dans le chemin (voir
// MEELY_TENANT_ID plus haut) ; toute autre créatrice reçoit l'URL avec son
// propre tenant_id, celle utilisée par processTelegramUpdate() pour router
// correctement chaque message vers le bon compte.
app.post('/api/admin/setup-webhook', requireAdminToken, async (req, res) => {
  const settings = await getSettings(req.tenantId);
  const base = process.env.PUBLIC_BASE_URL;
  const path = req.tenantId === MEELY_TENANT_ID ? '/telegram/webhook' : `/telegram/webhook/${req.tenantId}`;
  const result = await setWebhook(settings.telegram_bot_token, `${base}${path}`);
  res.json(result);
});

// ---------- Relance des fans inactifs ----------
// Le plan gratuit Render n'offre pas de Cron Job gratuit : cette route est
// pensée pour être appelée périodiquement par un service gratuit externe
// (ex: cron-job.org) sur /api/cron/reengagement?key=CRON_SECRET.
// Ça a aussi l'avantage de garder le service réveillé sur le plan free.
// MISE À JOUR 30/08/2026 (multi-tenant) — boucle maintenant sur TOUTES les
// créatrices actives (listActiveTenants), chacune avec son propre bot Telegram
// et ses propres réglages (reengagement_hours, reengagement_message) — avant
// cette route ne connaissait qu'un seul compte (Meely) codé en dur via
// getSettings() sans argument.
app.get('/api/cron/reengagement', async (req, res) => {
  if (!process.env.CRON_SECRET || req.query.key !== process.env.CRON_SECRET) {
    return res.status(401).json({ error: 'unauthorized' });
  }
  try {
    const tenants = await listActiveTenants();
    let totalCandidates = 0;
    let totalSent = 0;
    for (const tenant of tenants) {
      try {
        const settings = await getSettings(tenant.id);
        const fans = await getFansForReengagement(tenant.id, settings.reengagement_hours);
        totalCandidates += fans.length;
        for (const fan of fans) {
          await sendMessage(settings.telegram_bot_token, fan.telegram_user_id, settings.reengagement_message);
          await logMessage(fan.id, 'assistant', settings.reengagement_message, false, tenant.id);
          await markReengaged(fan.id);
          totalSent++;
        }
      } catch (tenantErr) {
        // Un problème sur UNE créatrice (ex: bot_token invalide) ne doit pas
        // empêcher la relance de tourner pour toutes les autres.
        console.error(`Erreur relance pour tenant ${tenant.id} (${tenant.name}):`, tenantErr.message);
      }
    }
    res.json({ ok: true, tenants: tenants.length, candidates: totalCandidates, sent: totalSent });
  } catch (err) {
    console.error('Erreur relance:', err);
    res.status(500).json({ error: err.message });
  }
});

app.get('/health', (req, res) => res.json({ ok: true }));

// ---------- Garde-fou anti-veille (cold start Render) ----------
// MISE À JOUR 31/08/2026 — demandé par Bryan : que le bot "se réveille de
// manière automatisée" sans dépendre d'un service externe (cron-job.org /
// UptimeRobot) qu'il faudrait configurer à la main. Le plan gratuit Render
// met le service en veille après ~15 min SANS TRAFIC HTTP ENTRANT (un
// setInterval interne ne compte pas comme trafic, donc inutile pour éviter la
// veille — en revanche, un appel sortant vers notre PROPRE URL publique, lui,
// arrive bien comme une requête HTTP entrante classique et compte). On
// s'auto-ping donc toutes les 10 minutes (< 15 min) tant que le process
// tourne : ça ne peut évidemment pas réveiller le service une fois VRAIMENT
// endormi (le process serait alors arrêté, plus personne pour lancer le
// ping) — mais ça empêche le service de s'endormir en premier lieu tant
// qu'il a déjà été réveillé une fois (ex: par un message Telegram ou une
// visite du dashboard). RENDER_EXTERNAL_URL est fourni automatiquement par
// Render sur tout service web — ce bloc est un no-op silencieux en local/dev.
const SELF_PING_URL = process.env.RENDER_EXTERNAL_URL;
if (SELF_PING_URL) {
  const SELF_PING_INTERVAL_MS = 10 * 60 * 1000;
  setInterval(() => {
    fetch(`${SELF_PING_URL}/health`).catch((err) => {
      console.error('Garde-fou anti-veille: self-ping échoué (non bloquant):', err.message);
    });
  }, SELF_PING_INTERVAL_MS);
  console.log(`Garde-fou anti-veille actif : self-ping toutes les 10 min vers ${SELF_PING_URL}/health`);
} else {
  console.log('Garde-fou anti-veille inactif (RENDER_EXTERNAL_URL absent — normal en local/dev).');
}

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Meeli bot server running on port ${PORT}`));
