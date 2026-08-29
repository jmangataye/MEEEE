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
  setFanStatus,
  markVipAlerted,
  listFansWithPreview,
  getFanById,
  getFullConversation,
  listAdminTokens,
  isValidAdminToken,
  createAdminToken,
  deleteAdminToken,
  getAnalytics,
  getFansForReengagement,
  markReengaged,
  supabase,
} = require('./lib/supabase');
const { runAgentTurn } = require('./lib/claudeAgent');
const { sendMessage, sendMessageWithTypingDelay, setWebhook } = require('./lib/telegram');
const { getLinkForItem } = require('./lib/dropfans');

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

// Nettoyage défensif : au cas où le modèle utilise quand même ¿/¡, on les
// retire pour garder un style de chat casuel (personne n'écrit "¿cómo estás?"
// sur son téléphone, juste "como estas?").
function stripInvertedPunctuation(text) {
  return text.replace(/¿/g, '').replace(/¡/g, '');
}

async function replyToFan({ settings, chatId, fan, text }) {
  const bubbles = splitIntoBubbles(text).map(stripInvertedPunctuation);
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

// ---------- Webhook Telegram ----------
app.post('/telegram/webhook', async (req, res) => {
  res.sendStatus(200); // répondre vite, traiter ensuite
  try {
    const update = req.body;
    const msg = update.message;
    if (!msg || !msg.text) return;

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

    const catalog = await getActiveCatalog();
    const history = await getRecentHistory(fan.id, 20);

    const { text, toolCalls } = await runAgentTurn({
      settings,
      catalog,
      history,
      fanMessage: msg.text,
      fan,
    });

    if (text) {
      await replyToFan({ settings, chatId, fan, text });
    }

    for (const call of toolCalls) {
      if (call.name === 'send_offer') {
        const item = catalog.find((c) => c.id === call.input.catalog_item_id);
        if (!item) continue;
        const link = await getLinkForItem(item);
        if (!link) {
          const fallback = `Uy, tuve un pequeño problema técnico generando tu enlace — ${settings.creator_name} se va a encargar personalmente, dame un momento 🙏`;
          await replyToFan({ settings, chatId, fan, text: fallback });
          continue;
        }
        const note = call.input.note_pour_le_fan || 'Aquí tienes 😘';
        const offerMsg = `${note}\n${link}`;
        await replyToFan({ settings, chatId, fan, text: offerMsg });

        const updatedFan = await recordSale({
          fan_id: fan.id,
          catalog_item_id: item.id,
          price: call.input.agreed_price,
          dropfans_link: link,
        });

        if (Number(call.input.agreed_price) >= Number(settings.alert_min_sale)) {
          await maybeAlertAdmin(
            settings,
            `💰 Venta: ${item.name} — ${call.input.agreed_price}€ (fan: ${fan.telegram_username || fan.first_name || fan.telegram_user_id})`
          );
        }

        if (updatedFan && Number(updatedFan.total_spent) >= Number(settings.vip_threshold) && !updatedFan.vip_alerted) {
          await markVipAlerted(fan.id);
          await maybeAlertAdmin(
            settings,
            `⭐ Nuevo VIP: ${fan.telegram_username || fan.first_name || fan.telegram_user_id} — total gastado: ${updatedFan.total_spent}€`
          );
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
    console.error('Erreur traitement message Telegram:', err);
  }
});

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
    const bubbles = splitIntoBubbles(text).map(stripInvertedPunctuation);
    res.json({ text, bubbles, toolCalls: toolCalls.map((c) => ({ name: c.name, input: c.input })) });
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
