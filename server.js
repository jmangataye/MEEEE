require('dotenv').config();
const express = require('express');
const path = require('path');
const crypto = require('crypto');
const multer = require('multer');
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 80 * 1024 * 1024 } });

const {
  getSettings,
  updateSettings,
  getActiveCatalog,
  getOrCreateFan,
  logMessage,
  getRecentHistory,
  recordSale,
  recordManualSale,
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
  listVaultAssets,
  addVaultAsset,
  deleteVaultAsset,
  getVaultSummary,
  getAiUsageSince,
  setAiCreditBalance,
  getLiveOpsStats,
  getStalledConversations,
  supabase,
} = require('./lib/supabase');
const { runAgentTurn, buildSystemPrompt } = require('./lib/claudeAgent');
const { sendMessage, sendMessageWithTypingDelay, setWebhook } = require('./lib/telegram');
const { getLinkForItem } = require('./lib/dropfans');
const {
  reviewOutgoingText,
  reviewOfferInput,
  FALLBACK_MESSAGE,
  PAYMENT_ALT_FALLBACK_MESSAGE,
  isPaymentAlternativeOnly,
} = require('./lib/safetyFilter');

const app = express();
app.use(express.json());
app.use('/landing', express.static(path.join(__dirname, 'public/landing')));
app.use('/admin', express.static(path.join(__dirname, 'public/admin')));

// ---------- Sécurité admin (multi-token, vérifié en base) ----------
async function requireAdminToken(req, res, next) {
  const token = req.headers['x-admin-token'] || req.query.token;
  const ok = await isValidAdminToken(token).catch(() => false);
  if (!ok) return res.status(401).json({ error: 'unauthorized' });
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
const MAX_BUBBLES = 2;
function capBubbles(bubbles, max = MAX_BUBBLES) {
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
  const bubbles = capBubbles(splitIntoBubbles(text)).map(stripInvertedPunctuation);
  for (const bubble of bubbles) {
    await sendMessageWithTypingDelay(settings.telegram_bot_token, chatId, bubble, {
      minSeconds: settings.response_delay_min_seconds,
      maxSeconds: settings.response_delay_max_seconds,
    });
    await logMessage(fan.id, 'assistant', bubble);
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

async function handleNonTextMessage(msg, mediaType) {
  try {
    const chatId = msg.chat.id;
    const settings = await getSettings();
    const fan = await getOrCreateFan({
      telegram_user_id: msg.from.id,
      telegram_username: msg.from.username,
      first_name: msg.from.first_name,
    });
    const meta = MEDIA_TYPE_REPLIES[mediaType] || MEDIA_TYPE_REPLIES.document;
    await logMessage(fan.id, 'fan', meta.log);

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
const pendingBatches = new Map(); // fanKey -> { fan, from, chatId, history, texts, firstAt, timer }
const BATCH_DEBOUNCE_MS = 4000;
const BATCH_MAX_WAIT_MS = 15000;

async function enqueueFanMessage(fanKey, msg) {
  let batch = pendingBatches.get(fanKey);
  if (!batch) {
    // Fan + historique capturés une seule fois, au premier message du lot —
    // pour que l'appel groupé voie exactement le même contexte qu'un appel
    // normal (l'historique ne doit pas inclure les messages de ce lot, qui
    // seront fournis groupés comme "fanMessage" au moment du traitement).
    const fan = await getOrCreateFan({
      telegram_user_id: msg.from.id,
      telegram_username: msg.from.username,
      first_name: msg.from.first_name,
    });
    const history = await getRecentHistory(fan.id, 20);
    batch = { fan, from: msg.from, chatId: msg.chat.id, history, texts: [], firstAt: Date.now(), timer: null };
    pendingBatches.set(fanKey, batch);
  }

  await logMessage(batch.fan.id, 'fan', msg.text);
  batch.texts.push(msg.text);

  if (batch.timer) clearTimeout(batch.timer);
  const elapsed = Date.now() - batch.firstAt;
  const wait = Math.max(0, Math.min(BATCH_DEBOUNCE_MS, BATCH_MAX_WAIT_MS - elapsed));
  batch.timer = setTimeout(() => {
    pendingBatches.delete(fanKey);
    runSerializedForFan(fanKey, () =>
      handleIncomingMessage(
        { chat: { id: batch.chatId }, from: batch.from, text: batch.texts.join('\n') },
        { skipLogging: true, historyOverride: batch.history }
      )
    ).catch((err) => console.error('Erreur traitement lot de messages fan:', err));
  }, wait);
}

// ---------- Webhook Telegram ----------
app.post('/telegram/webhook', async (req, res) => {
  res.sendStatus(200); // répondre vite, traiter ensuite
  try {
    const update = req.body;
    if (alreadyProcessed(update.update_id)) {
      console.warn('Update Telegram déjà traité, ignoré:', update.update_id);
      return;
    }
    const msg = update.message;
    if (!msg || !msg.from) return;
    const fanKey = (msg.from && msg.from.id) || msg.chat.id;

    if (msg.text) {
      if (msg.text.startsWith('/start')) {
        await runSerializedForFan(fanKey, () => handleIncomingMessage(msg));
        return;
      }
      await enqueueFanMessage(fanKey, msg);
      return;
    }

    const mediaType = detectMediaType(msg);
    if (mediaType) {
      await runSerializedForFan(fanKey, () => handleNonTextMessage(msg, mediaType));
    }
  } catch (err) {
    console.error('Erreur traitement message Telegram:', err);
  }
});

async function handleIncomingMessage(msg, opts = {}) {
  const { skipLogging = false, historyOverride = null } = opts;
  try {
    const chatId = msg.chat.id;
    const settings = await getSettings();

    if (msg.text.startsWith('/start')) {
      const parts = msg.text.split(' ');
      const sourceToken = parts[1] || null;
      const fan = await getOrCreateFan({
        telegram_user_id: msg.from.id,
        telegram_username: msg.from.username,
        first_name: msg.from.first_name,
        source_token: sourceToken,
      });
      const introTemplate =
        fan.ab_variant === 'B' && settings.intro_message_b ? settings.intro_message_b : settings.intro_message;
      const intro = introTemplate
        .replace('{persona_name}', settings.persona_name)
        .replace('{creator_name}', settings.creator_name);
      await replyToFan({ settings, chatId, fan, text: intro });
      return;
    }

    const fan = await getOrCreateFan({
      telegram_user_id: msg.from.id,
      telegram_username: msg.from.username,
      first_name: msg.from.first_name,
    });

    // `skipLogging` : ce message a déjà été journalisé au moment de sa
    // réception par enqueueFanMessage (voir plus haut) — ne pas le dupliquer.
    if (!skipLogging) {
      await logMessage(fan.id, 'fan', msg.text);
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

    const catalog = await getActiveCatalog();
    // `historyOverride` : lot de messages regroupés (voir enqueueFanMessage) —
    // l'historique a déjà été capturé avant ce lot pour éviter de le
    // dupliquer avec le contenu de "fanMessage" ci-dessous.
    const history = historyOverride || (await getRecentHistory(fan.id, 20));
    const purchasedItemIds = await getPurchasedItemIds(fan.id);
    const vaultSummary = await getVaultSummary();

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
    const textReview = reviewOutgoingText({ text, catalog, settings });
    if (!textReview.ok) {
      console.error(`⚠️ Filtre de sécurité (texte) déclenché pour fan ${fan.id}:`, textReview.reasons, '| texte bloqué:', text);
      await logSafetyIncident({ fan_id: fan.id, reasons: textReview.reasons, flagged_text: text });
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
        await updateFanProfile(fan.id, patch);
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
      const fallbackSettings = await getSettings().catch(() => null);
      if (fallbackSettings && msg && msg.chat && msg.chat.id) {
        await sendMessage(
          fallbackSettings.telegram_bot_token,
          msg.chat.id,
          'uy se me trabo un momentico, ya te respondo 🙏'
        );
      }
    } catch (fallbackErr) {
      console.error('Erreur envoi message de repli après échec de traitement:', fallbackErr);
    }
  }
}

// ---------- Génération de lien traçable (depuis la landing page) ----------
app.post('/api/tracking-link', async (req, res) => {
  try {
    const { campaign_label } = req.body;
    const settings = await getSettings();
    const token = crypto.randomBytes(6).toString('hex');
    const { error } = await supabase.from('tracking_links').insert({ source_token: token, campaign_label });
    if (error) throw error;
    const link = `https://t.me/${settings.telegram_bot_username}?start=${token}`;
    res.json({ link, token });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'internal_error' });
  }
});

// ---------- API Admin: settings ----------
app.get('/api/admin/settings', requireAdminToken, async (req, res) => {
  res.json(await getSettings());
});

app.put('/api/admin/settings', requireAdminToken, async (req, res) => {
  res.json(await updateSettings(req.body));
});

// ---------- API Admin: catalogue ----------
app.get('/api/admin/catalog', requireAdminToken, async (req, res) => {
  const { data, error } = await supabase.from('catalog_items').select('*').order('sort_order');
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

app.post('/api/admin/catalog', requireAdminToken, async (req, res) => {
  const { data, error } = await supabase.from('catalog_items').insert(req.body).select().single();
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

app.put('/api/admin/catalog/:id', requireAdminToken, async (req, res) => {
  const { data, error } = await supabase
    .from('catalog_items')
    .update(req.body)
    .eq('id', req.params.id)
    .select()
    .single();
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

app.delete('/api/admin/catalog/:id', requireAdminToken, async (req, res) => {
  const { error } = await supabase.from('catalog_items').delete().eq('id', req.params.id);
  if (error) return res.status(500).json({ error: error.message });
  res.json({ ok: true });
});

// ---------- API Admin: fans en direct + conversations ----------
app.get('/api/admin/fans', requireAdminToken, async (req, res) => {
  try {
    const limit = Math.min(Number(req.query.limit) || 50, 200);
    const fans = await listFansWithPreview({ limit });
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
    const [fan, settings] = await Promise.all([getFanById(req.params.id), getSettings()]);
    if (!fan) return res.status(404).json({ error: 'fan introuvable' });
    await sendMessage(settings.telegram_bot_token, fan.telegram_user_id, text);
    await logMessage(fan.id, 'assistant', text);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ---------- API Admin: incidents de sécurité (texte/offre bloqués automatiquement
// par le filtre serveur — voir lib/safetyFilter.js) ----------
app.get('/api/admin/safety-incidents', requireAdminToken, async (req, res) => {
  try {
    res.json(await listSafetyIncidents(50));
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
    res.json(await getStalledConversations(minutes));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ---------- API Admin: simulateur de conversation (sans Telegram) ----------
app.post('/api/admin/test-chat', requireAdminToken, async (req, res) => {
  try {
    const { message, history } = req.body; // history: [{role:'fan'|'assistant', content}]
    const settings = await getSettings();
    const catalog = await getActiveCatalog();
    const vaultSummary = await getVaultSummary();
    const fakeFan = { id: 'test', last_active_at: new Date().toISOString(), memory_notes: '' };
    const { text, toolCalls } = await runAgentTurn({
      settings,
      catalog,
      history: history || [],
      fanMessage: message,
      fan: fakeFan,
      vaultSummary,
    });
    const bubbles = capBubbles(splitIntoBubbles(text)).map(stripInvertedPunctuation);

    // Même filtre de sécurité qu'en prod (voir handleIncomingMessage), mais en
    // mode "aperçu" seulement : rien n'est bloqué ni mis en pause ici, ça sert
    // juste à tester/ajuster le script sans attendre qu'un vrai fan tombe dessus.
    const safety = reviewOutgoingText({ text, catalog, settings });
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
  const tokens = await listAdminTokens();
  res.json(tokens);
});

app.post('/api/admin/admins', requireAdminToken, async (req, res) => {
  const created = await createAdminToken(req.body.label || 'Sans nom');
  res.json(created);
});

app.delete('/api/admin/admins/:id', requireAdminToken, async (req, res) => {
  await deleteAdminToken(req.params.id);
  res.json({ ok: true });
});

// ---------- API Admin: analytics ----------
app.get('/api/admin/analytics', requireAdminToken, async (req, res) => {
  res.json(await getAnalytics());
});

app.get('/api/admin/analytics/timeseries', requireAdminToken, async (req, res) => {
  try {
    const days = Math.min(Number(req.query.days) || 30, 90);
    res.json(await getDailyTimeseries(days));
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
    res.json(await listSales(limit));
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
app.post('/api/admin/sales/manual', requireAdminToken, async (req, res) => {
  try {
    const { fan_id, catalog_item_id, price, payment_method } = req.body;
    if (!fan_id || !price) return res.status(400).json({ error: 'fan_id et price sont obligatoires' });
    const updatedFan = await recordManualSale({ fan_id, catalog_item_id: catalog_item_id || null, price, payment_method });
    res.json({ ok: true, fan: updatedFan });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ---------- API Admin: coffre de contenu (organisation par catégorie) ----------
// Les fichiers réels sont stockés dans Supabase Storage (bucket privé
// "content-vault"), jamais exposés publiquement — seul ce serveur (clé
// service_role) y accède. L'IA ne reçoit jamais ces fichiers, seulement un
// résumé par catégorie (voir getVaultSummary / lib/claudeAgent.js).
app.get('/api/admin/vault', requireAdminToken, async (req, res) => {
  try {
    const assets = await listVaultAssets();
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
      saved.push(await addVaultAsset({ category, media_type, storage_path: storagePath, catalog_item_id: catalog_item_id || null }));
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
    const settings = await getSettings();
    const [dbStats, usage, stalled] = await Promise.all([
      getLiveOpsStats(),
      getAiUsageSince(settings.ai_credit_balance_updated_at || null),
      getStalledConversations(5).catch((err) => {
        console.error('Erreur calcul conversations en attente de révision:', err.message);
        return [];
      }),
    ]);
    const spentUsd =
      (usage.input / 1e6) * AI_INPUT_PRICE_PER_MTOK + (usage.output / 1e6) * AI_OUTPUT_PRICE_PER_MTOK;
    const balance = settings.ai_credit_balance != null ? Number(settings.ai_credit_balance) : null;
    const estimatedRemaining = balance != null ? Math.max(0, balance - spentUsd) : null;

    res.json({
      ...dbStats,
      stalledCount: stalled.length,
      queueSize: fanQueues.size,
      uptimeSeconds: Math.floor(process.uptime()),
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
    const updated = await setAiCreditBalance(amount);
    res.json({ ok: true, balance: updated.ai_credit_balance, updatedAt: updated.ai_credit_balance_updated_at });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ---------- API Admin: aperçu du prompt système actuel (débogage/transparence) ----------
app.get('/api/admin/system-prompt-preview', requireAdminToken, async (req, res) => {
  try {
    const settings = await getSettings();
    const catalog = await getActiveCatalog();
    const vaultSummary = await getVaultSummary();
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
  const { data } = await supabase.from('fans').select('*').order('created_at');
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
  const { data } = await supabase.from('sales').select('*, fans(telegram_username, first_name)').order('created_at');
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
app.post('/api/admin/setup-webhook', requireAdminToken, async (req, res) => {
  const settings = await getSettings();
  const base = process.env.PUBLIC_BASE_URL;
  const result = await setWebhook(settings.telegram_bot_token, `${base}/telegram/webhook`);
  res.json(result);
});

// ---------- Relance des fans inactifs ----------
// Le plan gratuit Render n'offre pas de Cron Job gratuit : cette route est
// pensée pour être appelée périodiquement par un service gratuit externe
// (ex: cron-job.org) sur /api/cron/reengagement?key=CRON_SECRET.
// Ça a aussi l'avantage de garder le service réveillé sur le plan free.
app.get('/api/cron/reengagement', async (req, res) => {
  if (!process.env.CRON_SECRET || req.query.key !== process.env.CRON_SECRET) {
    return res.status(401).json({ error: 'unauthorized' });
  }
  try {
    const settings = await getSettings();
    const fans = await getFansForReengagement(settings.reengagement_hours);
    let sent = 0;
    for (const fan of fans) {
      await sendMessage(settings.telegram_bot_token, fan.telegram_user_id, settings.reengagement_message);
      await logMessage(fan.id, 'assistant', settings.reengagement_message);
      await markReengaged(fan.id);
      sent++;
    }
    res.json({ ok: true, candidates: fans.length, sent });
  } catch (err) {
    console.error('Erreur relance:', err);
    res.status(500).json({ error: err.message });
  }
});

app.get('/health', (req, res) => res.json({ ok: true }));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Meeli bot server running on port ${PORT}`));
