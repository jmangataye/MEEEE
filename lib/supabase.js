const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY,
  { auth: { persistSession: false } }
);

async function getSettings() {
  const { data, error } = await supabase.from('settings').select('*').limit(1).single();
  if (error) throw error;
  return data;
}

async function updateSettings(patch) {
  const settings = await getSettings();
  const { data, error } = await supabase
    .from('settings')
    .update({ ...patch, updated_at: new Date().toISOString() })
    .eq('id', settings.id)
    .select()
    .single();
  if (error) throw error;
  return data;
}

async function getActiveCatalog() {
  const { data, error } = await supabase
    .from('catalog_items')
    .select('*')
    .eq('active', true)
    .order('sort_order', { ascending: true });
  if (error) throw error;
  return data;
}

async function getOrCreateFan({ telegram_user_id, telegram_username, first_name, source_token }) {
  const { data: existing, error: findErr } = await supabase
    .from('fans')
    .select('*')
    .eq('telegram_user_id', telegram_user_id)
    .maybeSingle();
  if (findErr) throw findErr;
  if (existing) {
    await supabase
      .from('fans')
      .update({ last_active_at: new Date().toISOString() })
      .eq('id', existing.id);
    return existing;
  }

  const ab_variant = Math.random() < 0.5 ? 'A' : 'B';

  const { data: created, error: createErr } = await supabase
    .from('fans')
    .insert({ telegram_user_id, telegram_username, first_name, source_token, ab_variant })
    .select()
    .single();
  if (createErr) throw createErr;

  if (source_token) {
    const { data: link } = await supabase
      .from('tracking_links')
      .select('id, clicks')
      .eq('source_token', source_token)
      .maybeSingle();
    if (link) {
      await supabase.from('tracking_links').update({ clicks: (link.clicks || 0) + 1 }).eq('id', link.id);
    }
  }
  return created;
}

async function logMessage(fan_id, role, content) {
  const { error } = await supabase.from('conversation_messages').insert({ fan_id, role, content });
  if (error) throw error;
}

async function getRecentHistory(fan_id, limit = 20) {
  const { data, error } = await supabase
    .from('conversation_messages')
    .select('role, content, created_at')
    .eq('fan_id', fan_id)
    .order('created_at', { ascending: false })
    .limit(limit);
  if (error) throw error;
  return data.reverse();
}

// `status`/`payment_method` par défaut correspondent au flux normal (l'IA
// envoie un lien Dropp.fans, on ne sait pas encore si le fan a vraiment payé).
// Le dashboard peut aussi enregistrer directement une vente déjà confirmée
// (ex: paiement Yape vérifié à la main, jamais passé par "send_offer") en
// passant status:'paid' et payment_method:'yape' — voir recordManualSale.
async function recordSale({ fan_id, catalog_item_id, price, dropfans_link, status = 'sent', payment_method = 'dropfans' }) {
  const { error } = await supabase
    .from('sales')
    .insert({ fan_id, catalog_item_id, price, dropfans_link, status, payment_method });
  if (error) throw error;

  const { data: fan } = await supabase.from('fans').select('total_spent, vip_alerted').eq('id', fan_id).single();
  const newTotal = (Number(fan?.total_spent) || 0) + Number(price);
  const { data: updatedFan } = await supabase
    .from('fans')
    .update({ total_spent: newTotal, status: 'customer' })
    .eq('id', fan_id)
    .select()
    .single();
  return updatedFan;
}

// Enregistre une vente déjà payée, constatée manuellement par l'admin (ex:
// preuve de paiement Yape/Nequi vérifiée) — sans passer par "send_offer".
async function recordManualSale({ fan_id, catalog_item_id, price, payment_method }) {
  return recordSale({ fan_id, catalog_item_id, price, dropfans_link: null, status: 'paid', payment_method: payment_method || 'autre' });
}

// ---------- Ventes : distinguer "lien envoyé" (status='sent', valeur par
// défaut posée dès la création) de "payé confirmé" (status='paid'). Rien ne
// confirme jamais automatiquement le paiement (pas de webhook Dropp.fans) —
// listSales/confirmSale servent à ce que l'admin le fasse manuellement depuis
// le dashboard après avoir vérifié le wallet Dropp (ou une preuve Yape/Nequi).
async function listSales(limit = 100) {
  const { data, error } = await supabase
    .from('sales')
    .select('*, fans(telegram_username, first_name), catalog_items(name)')
    .order('created_at', { ascending: false })
    .limit(limit);
  if (error) throw error;
  return data;
}

async function confirmSale(sale_id, { payment_method } = {}) {
  const patch = { status: 'paid' };
  if (payment_method) patch.payment_method = payment_method;
  const { data, error } = await supabase.from('sales').update(patch).eq('id', sale_id).select().single();
  if (error) throw error;
  return data;
}

async function getPurchasedItemIds(fan_id) {
  const { data, error } = await supabase.from('sales').select('catalog_item_id').eq('fan_id', fan_id);
  if (error) throw error;
  return (data || []).map((s) => s.catalog_item_id).filter(Boolean);
}

async function setFanStatus(fan_id, status) {
  const { error } = await supabase.from('fans').update({ status }).eq('id', fan_id);
  if (error) throw error;
}

// ---------- Pause par conversation : permet à l'admin de couper les réponses
// automatiques de l'IA pour UN fan précis (ex: cas sensible qu'il veut gérer
// lui-même), ou de le faire automatiquement quand le filtre de sécurité
// détecte un contenu/prix problématique (voir lib/safetyFilter.js). Les
// messages du fan continuent d'être reçus et journalisés pendant la pause.
async function setFanPaused(fan_id, paused) {
  const { error } = await supabase.from('fans').update({ paused }).eq('id', fan_id);
  if (error) throw error;
}

// ---------- Fiche fan enrichie : au-delà du texte libre "memory_notes",
// permet à l'IA de renseigner des champs structurés (potentiel commercial,
// budget, intérêts, objections, signaux d'alerte) affichés comme des
// étiquettes distinctes dans le dashboard plutôt que noyés dans un paragraphe.
// `patch` ne contient que les champs que l'appelant veut réellement modifier.
async function updateFanProfile(fan_id, patch) {
  const { error } = await supabase.from('fans').update(patch).eq('id', fan_id);
  if (error) throw error;
}

async function markVipAlerted(fan_id) {
  await supabase.from('fans').update({ vip_alerted: true, status: 'vip' }).eq('id', fan_id);
}

// ---------- Dashboard: fans list with last message preview (for the "live" view) ----------
async function listFansWithPreview({ limit = 50, offset = 0 } = {}) {
  const { data: fans, error } = await supabase
    .from('fans')
    .select('*')
    .order('last_active_at', { ascending: false })
    .range(offset, offset + limit - 1);
  if (error) throw error;
  if (!fans.length) return [];

  const ids = fans.map((f) => f.id);
  const { data: lastMessages } = await supabase
    .from('conversation_messages')
    .select('fan_id, role, content, created_at')
    .in('fan_id', ids)
    .order('created_at', { ascending: false });

  const previewByFan = {};
  for (const m of lastMessages || []) {
    if (!previewByFan[m.fan_id]) previewByFan[m.fan_id] = m;
  }

  return fans.map((f) => ({ ...f, last_message: previewByFan[f.id] || null }));
}

async function getFanById(fan_id) {
  const { data, error } = await supabase.from('fans').select('*').eq('id', fan_id).single();
  if (error) throw error;
  return data;
}

async function getFullConversation(fan_id, limit = 200) {
  const { data, error } = await supabase
    .from('conversation_messages')
    .select('role, content, created_at')
    .eq('fan_id', fan_id)
    .order('created_at', { ascending: true })
    .limit(limit);
  if (error) throw error;
  return data;
}

// ---------- Admin tokens (simple multi-admin support) ----------
async function listAdminTokens() {
  const { data, error } = await supabase
    .from('admin_tokens')
    .select('id, label, token, created_at, last_used_at')
    .order('created_at', { ascending: true });
  if (error) throw error;
  return data;
}

async function isValidAdminToken(token) {
  if (!token) return false;
  if (process.env.ADMIN_API_TOKEN && token === process.env.ADMIN_API_TOKEN) return true;
  const { data } = await supabase.from('admin_tokens').select('id').eq('token', token).maybeSingle();
  if (data) {
    supabase.from('admin_tokens').update({ last_used_at: new Date().toISOString() }).eq('id', data.id).then(() => {});
    return true;
  }
  return false;
}

async function createAdminToken(label) {
  const { data, error } = await supabase.from('admin_tokens').insert({ label }).select().single();
  if (error) throw error;
  return data;
}

async function deleteAdminToken(id) {
  const { error } = await supabase.from('admin_tokens').delete().eq('id', id);
  if (error) throw error;
}

// ---------- Analytics ----------
async function getAnalytics() {
  const [{ count: fanCount }, { data: sales }, { data: fans }] = await Promise.all([
    supabase.from('fans').select('*', { count: 'exact', head: true }),
    supabase.from('sales').select('price, created_at, fan_id, status'),
    supabase.from('fans').select('id, status, ab_variant, source_token, total_spent'),
  ]);
  // "revenue" = tous les liens envoyés (comme avant, pour ne pas casser l'existant).
  // "paidRevenue" = seulement ce qui a été confirmé payé manuellement (voir
  // confirmSale) — c'est le chiffre le plus proche de la réalité aujourd'hui.
  const revenue = (sales || []).reduce((sum, s) => sum + Number(s.price), 0);
  const paidRevenue = (sales || []).filter((s) => s.status === 'paid').reduce((sum, s) => sum + Number(s.price), 0);
  const paidSalesCount = (sales || []).filter((s) => s.status === 'paid').length;
  const byStatus = {};
  const byVariant = {};
  (fans || []).forEach((f) => {
    byStatus[f.status] = (byStatus[f.status] || 0) + 1;
    byVariant[f.ab_variant] = byVariant[f.ab_variant] || { fans: 0, revenue: 0 };
    byVariant[f.ab_variant].fans += 1;
  });
  const fanById = {};
  (fans || []).forEach((f) => (fanById[f.id] = f));
  (sales || []).forEach((s) => {
    const f = fanById[s.fan_id];
    if (f) {
      byVariant[f.ab_variant] = byVariant[f.ab_variant] || { fans: 0, revenue: 0 };
      byVariant[f.ab_variant].revenue += Number(s.price);
    }
  });

  const { data: links } = await supabase.from('tracking_links').select('source_token, campaign_label, clicks');
  const byCampaign = (links || []).map((l) => {
    const fansForLink = (fans || []).filter((f) => f.source_token === l.source_token);
    const revenueForLink = fansForLink.reduce((sum, f) => sum + Number(f.total_spent || 0), 0);
    return {
      campaign_label: l.campaign_label,
      clicks: l.clicks,
      fans: fansForLink.length,
      revenue: revenueForLink,
    };
  });

  return {
    fanCount,
    revenue,
    paidRevenue,
    salesCount: (sales || []).length,
    paidSalesCount,
    byStatus,
    byVariant,
    byCampaign,
  };
}

// ---------- Série temporelle pour le graphique du dashboard ----------
async function getDailyTimeseries(days = 30) {
  const since = new Date(Date.now() - days * 86400000);
  const sinceIso = since.toISOString();
  const [{ data: sales }, { data: fans }] = await Promise.all([
    supabase.from('sales').select('price, created_at').gte('created_at', sinceIso),
    supabase.from('fans').select('created_at').gte('created_at', sinceIso),
  ]);

  const dayKey = (d) => new Date(d).toISOString().slice(0, 10);
  const byDay = {};
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(Date.now() - i * 86400000);
    byDay[dayKey(d)] = { date: dayKey(d), revenue: 0, newFans: 0 };
  }
  (sales || []).forEach((s) => {
    const k = dayKey(s.created_at);
    if (byDay[k]) byDay[k].revenue += Number(s.price);
  });
  (fans || []).forEach((f) => {
    const k = dayKey(f.created_at);
    if (byDay[k]) byDay[k].newFans += 1;
  });
  return Object.values(byDay);
}

// ---------- Re-engagement (used by the cron job) ----------
async function getFansForReengagement(hoursThreshold) {
  const cutoff = new Date(Date.now() - hoursThreshold * 3600 * 1000).toISOString();
  const { data, error } = await supabase
    .from('fans')
    .select('*')
    .lt('last_active_at', cutoff)
    .in('status', ['new', 'engaged'])
    .or(`last_reengaged_at.is.null,last_reengaged_at.lt.${cutoff}`);
  if (error) throw error;
  return data;
}

// ---------- Coffre de contenu (content vault) ----------
// Organise les fichiers réels (photos/vidéos) de la créatrice par catégorie
// (senos, pies, etc.), optionnellement liés à un article du catalogue. L'IA
// ne voit JAMAIS ces fichiers eux-mêmes — seulement un résumé (catégorie +
// nombre de photos/vidéos + article lié) via getVaultSummary(), pour pouvoir
// répondre "sí tengo eso" et orienter vers le bon article sans halluciner ni
// décrire de contenu explicite elle-même.
async function listVaultAssets() {
  const { data, error } = await supabase
    .from('content_vault')
    .select('*, catalog_items(name)')
    .order('created_at', { ascending: false });
  if (error) throw error;
  return data;
}

async function addVaultAsset({ category, media_type, storage_path, catalog_item_id }) {
  const { data, error } = await supabase
    .from('content_vault')
    .insert({ category, media_type, storage_path, catalog_item_id: catalog_item_id || null })
    .select()
    .single();
  if (error) throw error;
  return data;
}

async function deleteVaultAsset(id) {
  const { data: asset, error: findErr } = await supabase.from('content_vault').select('storage_path').eq('id', id).single();
  if (findErr) throw findErr;
  if (asset) await supabase.storage.from('content-vault').remove([asset.storage_path]);
  const { error } = await supabase.from('content_vault').delete().eq('id', id);
  if (error) throw error;
}

async function getVaultSummary() {
  const assets = await listVaultAssets();
  const byCategory = {};
  (assets || []).forEach((a) => {
    if (!byCategory[a.category]) byCategory[a.category] = { category: a.category, photos: 0, videos: 0, linkedItems: new Set() };
    if (a.media_type === 'video') byCategory[a.category].videos++;
    else byCategory[a.category].photos++;
    if (a.catalog_items?.name) byCategory[a.category].linkedItems.add(a.catalog_items.name);
  });
  return Object.values(byCategory).map((c) => ({ ...c, linkedItems: Array.from(c.linkedItems) }));
}

async function markReengaged(fan_id) {
  await supabase.from('fans').update({ last_reengaged_at: new Date().toISOString() }).eq('id', fan_id);
}

// ---------- Incidents de sécurité : trace de chaque fois où le filtre serveur
// a bloqué un texte ou une offre avant l'envoi (contenu explicite, prix
// inventé, méthode de paiement non autorisée). Sert à la fois d'audit trail
// et de liste "à revoir" dans le dashboard pour l'admin.
async function logSafetyIncident({ fan_id, reasons, flagged_text }) {
  const { error } = await supabase.from('safety_incidents').insert({ fan_id, reasons, flagged_text });
  if (error) console.error('Erreur enregistrement incident de sécurité:', error.message);
}

async function listSafetyIncidents(limit = 50) {
  const { data, error } = await supabase
    .from('safety_incidents')
    .select('*, fans(telegram_username, first_name)')
    .order('created_at', { ascending: false })
    .limit(limit);
  if (error) throw error;
  return data;
}

// ---------- Suivi d'usage IA (pour estimer le crédit restant — voir plus haut,
// Anthropic n'expose aucune API de solde en temps réel). Chaque appel réel à
// Claude journalise ses tokens ici ; l'admin saisit manuellement son solde à
// chaque recharge (setAiCreditBalance), et on estime le restant en
// soustrayant le coût des tokens consommés depuis cette date.
async function logAiUsage({ input_tokens, output_tokens, fan_id }) {
  const { error } = await supabase
    .from('ai_usage_log')
    .insert({ input_tokens: input_tokens || 0, output_tokens: output_tokens || 0, fan_id: fan_id || null });
  if (error) console.error('Erreur log usage IA:', error.message);
}

async function getAiUsageSince(sinceIso) {
  let query = supabase.from('ai_usage_log').select('input_tokens, output_tokens');
  if (sinceIso) query = query.gte('created_at', sinceIso);
  const { data, error } = await query;
  if (error) throw error;
  return (data || []).reduce(
    (acc, r) => ({ input: acc.input + (r.input_tokens || 0), output: acc.output + (r.output_tokens || 0) }),
    { input: 0, output: 0 }
  );
}

async function setAiCreditBalance(amount) {
  const settings = await getSettings();
  const { data, error } = await supabase
    .from('settings')
    .update({ ai_credit_balance: amount, ai_credit_balance_updated_at: new Date().toISOString() })
    .eq('id', settings.id)
    .select()
    .single();
  if (error) throw error;
  return data;
}

// ---------- Stats "Live Ops" pour le panneau temps réel du dashboard. Combiné
// côté server.js avec des métriques en mémoire (taille de la file d'attente
// par fan, uptime du process) qui n'ont pas leur place en base.
async function getLiveOpsStats() {
  const now = Date.now();
  const since1h = new Date(now - 3600 * 1000).toISOString();
  const since24h = new Date(now - 24 * 3600 * 1000).toISOString();
  const d = new Date();
  const todayStart = new Date(d.getFullYear(), d.getMonth(), d.getDate()).toISOString();

  const [active1h, active24h, pausedCount, messagesToday, safetyToday] = await Promise.all([
    supabase.from('fans').select('*', { count: 'exact', head: true }).gte('last_active_at', since1h),
    supabase.from('fans').select('*', { count: 'exact', head: true }).gte('last_active_at', since24h),
    supabase.from('fans').select('*', { count: 'exact', head: true }).eq('paused', true),
    supabase.from('conversation_messages').select('*', { count: 'exact', head: true }).gte('created_at', todayStart),
    supabase.from('safety_incidents').select('*', { count: 'exact', head: true }).gte('created_at', todayStart),
  ]);

  return {
    active1h: active1h.count || 0,
    active24h: active24h.count || 0,
    pausedCount: pausedCount.count || 0,
    messagesToday: messagesToday.count || 0,
    safetyToday: safetyToday.count || 0,
  };
}

module.exports = {
  supabase,
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
  logAiUsage,
  getAiUsageSince,
  setAiCreditBalance,
  getLiveOpsStats,
};
