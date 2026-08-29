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
  supabase,
} = require('./lib/supabase');
const { runAgentTurn } = require('./lib/claudeAgent');
const { sendMessage, setWebhook } = require('./lib/telegram');
const { getLinkForItem } = require('./lib/dropfans');

const app = express();
app.use(express.json());
app.use('/landing', express.static(path.join(__dirname, 'public/landing')));
app.use('/admin', express.static(path.join(__dirname, 'public/admin')));

// ---------- Sécurité admin ----------
function requireAdminToken(req, res, next) {
  const token = req.headers['x-admin-token'];
  if (!token || token !== process.env.ADMIN_API_TOKEN) {
    return res.status(401).json({ error: 'unauthorized' });
  }
  next();
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
      const intro = settings.intro_message
        .replace('{persona_name}', settings.persona_name)
        .replace('{creator_name}', settings.creator_name);
      await sendMessage(settings.telegram_bot_token, chatId, intro);
      await logMessage(fan.id, 'assistant', intro);
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
    });

    if (text) {
      await sendMessage(settings.telegram_bot_token, chatId, text);
      await logMessage(fan.id, 'assistant', text);
    }

    for (const call of toolCalls) {
      if (call.name === 'send_offer') {
        const item = catalog.find((c) => c.id === call.input.catalog_item_id);
        if (!item) continue;
        const link = await getLinkForItem(item);
        if (!link) {
          const fallback = `Un tout petit souci technique de mon côté pour te générer le lien — ${settings.creator_name} va s'en occuper personnellement, patience 🙏`;
          await sendMessage(settings.telegram_bot_token, chatId, fallback);
          await logMessage(fan.id, 'assistant', fallback);
          continue;
        }
        const note = call.input.note_pour_le_fan || 'Voilà pour toi 😘';
        const offerMsg = `${note}\n${link}`;
        await sendMessage(settings.telegram_bot_token, chatId, offerMsg);
        await logMessage(fan.id, 'assistant', offerMsg);
        await recordSale({
          fan_id: fan.id,
          catalog_item_id: item.id,
          price: call.input.agreed_price,
          dropfans_link: link,
        });
      }
      if (call.name === 'update_fan_status') {
        await setFanStatus(fan.id, call.input.status);
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

// ---------- API Admin ----------
app.get('/api/admin/settings', requireAdminToken, async (req, res) => {
  res.json(await getSettings());
});

app.put('/api/admin/settings', requireAdminToken, async (req, res) => {
  res.json(await updateSettings(req.body));
});

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

app.get('/api/admin/analytics', requireAdminToken, async (req, res) => {
  const [{ count: fanCount }, { data: sales }, { data: fans }] = await Promise.all([
    supabase.from('fans').select('*', { count: 'exact', head: true }),
    supabase.from('sales').select('price, created_at'),
    supabase.from('fans').select('status'),
  ]);
  const revenue = (sales || []).reduce((sum, s) => sum + Number(s.price), 0);
  const byStatus = {};
  (fans || []).forEach((f) => (byStatus[f.status] = (byStatus[f.status] || 0) + 1));
  res.json({ fanCount, revenue, salesCount: (sales || []).length, byStatus });
});

// ---------- Setup webhook Telegram (à appeler une fois après déploiement) ----------
app.post('/api/admin/setup-webhook', requireAdminToken, async (req, res) => {
  const settings = await getSettings();
  const base = process.env.PUBLIC_BASE_URL;
  const result = await setWebhook(settings.telegram_bot_token, `${base}/telegram/webhook`);
  res.json(result);
});

app.get('/health', (req, res) => res.json({ ok: true }));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Meeli bot server running on port ${PORT}`));
