require('dotenv').config();
const express = require('express');
const path = require('path');
const crypto = require('crypto');

const {
  getSettings,
  updateSettings,
  getActiveCatalog,
  getOrCreateFan,
  logMessage,
  getRecentHistory,
  recordSale,
  getPurchasedItemIds,
  setFanStatus,
  setFanPaused,
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
  supabase,
} = require('./lib/supabase');
const { runAgentTurn } = require('./lib/claudeAgent');
const { sendMessage, sendMessageWithTypingDelay, setWebhook } = require('./lib/telegram');
const { getLinkForItem } = require('./lib/dropfans');
const { reviewOutgoingText, reviewOfferInput, FALLBACK_MESSAGE } = require('./lib/safetyFilter');

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
    if (!msg || !msg.text) return;
    const fanKey = (msg.from && msg.from.id) || msg.chat.id;
    await runSerializedForFan(fanKey, () => handleIncomingMessage(msg));
  } catch (err) {
    console.error('Erreur traitement message Telegram:', err);
  }
});

async function handleIncomingMessage(msg) {
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

    await logMessage(fan.id, 'fan', msg.text);

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
    const history = await getRecentHistory(fan.id, 20);
    const purchasedItemIds = await getPurchasedItemIds(fan.id);

    const { text, toolCalls } = await runAgentTurn({
      settings,
      catalog,
      history,
      fanMessage: msg.text,
      fan,
      purchasedItemIds,
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
      await replyToFan({ settings, chatId, fan, text: FALLBACK_MESSAGE });
      await maybeAlertAdmin(
        settings,
        `🚨 Alerte sécurité: réponse bloquée pour ${fan.telegram_username || fan.first_name || fan.telegram_user_id}\nRaisons: ${textReview.reasons.join('; ')}\nLa conversation a été mise en PAUSE automatiquement — va voir le dashboard pour reprendre la main.`
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
        await supabase.from('fans').update({ memory_notes: call.input.notes }).eq('id', fan.id);
      }
    }
  } catch (err) {
    console.error('Erreur traitement message fan:', err);
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

// ---------- API Admin: simulateur de conversation (sans Telegram) ----------
app.post('/api/admin/test-chat', requireAdminToken, async (req, res) => {
  try {
    const { message, history } = req.body; // history: [{role:'fan'|'assistant', content}]
    const settings = await getSettings();
    const catalog = await getActiveCatalog();
    const fakeFan = { id: 'test', last_active_at: new Date().toISOString(), memory_notes: '' };
    const { text, toolCalls } = await runAgentTurn({
      settings,
      catalog,
      history: history || [],
      fanMessage: message,
      fan: fakeFan,
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
  const rows = ['id,fan,price,status,dropfans_link,created_at'];
  (data || []).forEach((s) => {
    const fanLabel = s.fans?.telegram_username || s.fans?.first_name || s.fan_id;
    rows.push(
      [s.id, fanLabel, s.price, s.status, s.dropfans_link, s.created_at]
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
