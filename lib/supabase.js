const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY,
  { auth: { persistSession: false } }
);

// MISE À JOUR 30/08/2026 — multi-tenant : `tenant_id` est maintenant
// OBLIGATOIRE. Avant, `.limit(1).single()` supposait qu'il n'existait qu'une
// seule ligne "settings" au monde — avec plusieurs créatrices, chacune a sa
// propre ligne. Appeler cette fonction sans tenant_id est une erreur de
// programmation (pas un cas à tolérer silencieusement), d'où l'exception
// explicite plutôt qu'un fallback qui masquerait le bug.
async function getSettings(tenant_id) {
  if (!tenant_id) throw new Error('getSettings() nécessite un tenant_id.');
  const { data, error } = await supabase.from('settings').select('*').eq('tenant_id', tenant_id).limit(1).single();
  if (error) throw error;
  return data;
}

// Colonnes numériques (bigint/integer/numeric) de la table "settings" — un
// champ HTML vide envoie une chaîne vide "", que Postgres refuse pour ces
// types (ex: 22P02 "invalid input syntax for type bigint: \"\""). Repéré le
// 29/08 : c'est CE bug précis qui empêchait TOUTE sauvegarde des réglages —
// y compris des champs texte comme le nom de la persona — dès que
// "admin_telegram_chat_id" (chat_id Telegram) était laissé vide, puisque
// updateSettings() met à jour toute la fiche en un seul appel. Converti ici
// en null plutôt que de planter, pour tous les champs numériques connus.
const NUMERIC_SETTINGS_FIELDS = new Set([
  'admin_telegram_chat_id',
  'min_custom_price',
  'max_negotiation_discount_pct',
  'response_delay_min_seconds',
  'response_delay_max_seconds',
  'vip_threshold',
  'alert_min_sale',
  'reengagement_hours',
  'ai_credit_balance',
  'low_credit_alert_threshold',
]);

// MISE À JOUR 30/08/2026 — historique des versions (dashboard, Persona &
// Script → "Historique"). Avant, écraser un champ dans le dashboard était
// définitif : aucun moyen de revenir à un réglage précédent. On garde
// maintenant une photo complète de la fiche "settings" à chaque sauvegarde
// réussie, dans une table à part (settings_history), pour pouvoir restaurer
// une version antérieure depuis le dashboard.
async function snapshotSettings(settings, tenant_id) {
  try {
    const { error } = await supabase.from('settings_history').insert({ settings_snapshot: settings, tenant_id });
    if (error) console.error('Erreur snapshotSettings (non bloquant):', error.message);
  } catch (err) {
    // Ne doit JAMAIS faire échouer une sauvegarde de réglages réelle — c'est
    // un historique "best effort", pas une opération critique.
    console.error('Erreur snapshotSettings (non bloquant):', err.message);
  }
}

// MISE À JOUR 30/08/2026 — multi-tenant : filtré par tenant_id pour qu'une
// créatrice ne voie jamais l'historique de réglages d'une autre.
async function listSettingsHistory(tenant_id, limit = 20) {
  const { data, error } = await supabase
    .from('settings_history')
    .select('id, created_at, settings_snapshot')
    .eq('tenant_id', tenant_id)
    .order('created_at', { ascending: false })
    .limit(limit);
  if (error) throw error;
  return data;
}

// Champs qu'on ne réapplique jamais depuis un ancien instantané : ce sont des
// identifiants/métadonnées propres à LA LIGNE settings actuelle, pas des
// "réglages" à restaurer (restaurer l'ancien "id" casserait la mise à jour,
// et "updated_at"/"ai_credit_balance" seraient trompeurs — le crédit réel n'a
// pas changé juste parce qu'on restaure un ancien ton de voix).
const SETTINGS_HISTORY_EXCLUDED_FIELDS = new Set(['id', 'created_at', 'updated_at', 'ai_credit_balance']);

// MISE À JOUR 30/08/2026 — multi-tenant : `historyId` seul suffirait (c'est
// un uuid, donc déjà unique), mais on vérifie EN PLUS qu'il appartient bien
// au tenant qui fait la demande — sinon une créatrice pourrait restaurer une
// version d'historique appartenant à une autre créatrice en devinant/rejouant
// un id. Défense en profondeur, pas juste une optimisation.
async function restoreSettingsVersion(historyId, tenant_id) {
  const { data: historyRow, error: findErr } = await supabase
    .from('settings_history')
    .select('settings_snapshot')
    .eq('id', historyId)
    .eq('tenant_id', tenant_id)
    .single();
  if (findErr) throw findErr;
  const snapshot = historyRow.settings_snapshot || {};
  const patch = {};
  for (const key of Object.keys(snapshot)) {
    if (SETTINGS_HISTORY_EXCLUDED_FIELDS.has(key)) continue;
    patch[key] = snapshot[key];
  }
  // La restauration elle-même compte comme une sauvegarde — elle passe donc
  // par updateSettings() ci-dessous, qui prend automatiquement une nouvelle
  // photo APRÈS restauration (donc l'état d'avant-restauration reste, lui
  // aussi, dans l'historique — restaurer n'efface jamais rien).
  return updateSettings(patch, tenant_id);
}

async function updateSettings(patch, tenant_id) {
  if (!tenant_id) throw new Error('updateSettings() nécessite un tenant_id.');
  const settings = await getSettings(tenant_id);
  const sanitized = { ...patch };
  for (const key of Object.keys(sanitized)) {
    if (!NUMERIC_SETTINGS_FIELDS.has(key)) continue;
    const v = sanitized[key];
    if (v === '' || v === null || v === undefined || (typeof v === 'number' && Number.isNaN(v))) {
      sanitized[key] = null;
    } else {
      const n = Number(v);
      sanitized[key] = Number.isNaN(n) ? null : n;
    }
  }
  // `tenant_id` ne doit jamais être écrasable via un patch de réglages —
  // sécurité en profondeur au cas où un jour un champ mal nommé côté
  // formulaire finirait par matcher cette clé.
  delete sanitized.tenant_id;
  const { data, error } = await supabase
    .from('settings')
    .update({ ...sanitized, updated_at: new Date().toISOString() })
    .eq('id', settings.id)
    .eq('tenant_id', tenant_id)
    .select()
    .single();
  if (error) throw error;
  await snapshotSettings(data, tenant_id);
  return data;
}

async function getActiveCatalog(tenant_id) {
  if (!tenant_id) throw new Error('getActiveCatalog() nécessite un tenant_id.');
  const { data, error } = await supabase
    .from('catalog_items')
    .select('*')
    .eq('tenant_id', tenant_id)
    .eq('active', true)
    .order('sort_order', { ascending: true });
  if (error) throw error;
  return data;
}

// MISE À JOUR 30/08/2026 — multi-tenant : `tenant_id` obligatoire. La même
// personne Telegram peut être fan de PLUSIEURS créatrices (chacune a son
// propre bot) — c'est pour ça que la contrainte unique en base est passée de
// `telegram_user_id` seul à `(tenant_id, telegram_user_id)` (voir migration
// fix_fans_constraints_for_multitenant). Sans le filtre `tenant_id` ici, un
// fan de la créatrice A qui écrit aussi à la créatrice B se serait vu
// fusionné sur SA fiche chez A — fuite de données entre créatrices.
async function getOrCreateFan({ telegram_user_id, telegram_username, first_name, source_token, tenant_id }) {
  if (!tenant_id) throw new Error('getOrCreateFan() nécessite un tenant_id.');
  const { data: existing, error: findErr } = await supabase
    .from('fans')
    .select('*')
    .eq('telegram_user_id', telegram_user_id)
    .eq('tenant_id', tenant_id)
    .maybeSingle();
  if (findErr) throw findErr;
  if (existing) {
    await supabase
      .from('fans')
      .update({ last_active_at: new Date().toISOString() })
      .eq('id', existing.id);
    return existing;
  }

  // MISE À JOUR 30/08/2026 — remplace le tirage à pile ou face 50/50 par le
  // bandit Thompson sampling (voir getVariantsForField/pickVariantForField
  // plus bas) : dès qu'au moins une variante 'intro_message' existe dans
  // script_variants (créées par défaut lors de la migration, à partir des
  // anciens settings.intro_message / intro_message_b), on assigne la
  // variante qui convertit statistiquement le mieux — sinon on retombe sur
  // l'ancien tirage 50/50 comme filet de sécurité (aucune variante encore
  // configurée). `ab_variant` (colonne texte simple) reste renseigné en
  // parallèle pour ne pas casser les anciens rapports/exports qui la lisent
  // déjà (CSV fans, stats par variante) — il reflète maintenant le label de
  // la variante choisie par le bandit quand il y en a une.
  let assignedVariant = null;
  try {
    assignedVariant = await pickVariantForField('intro_message', tenant_id);
  } catch (err) {
    console.error('Erreur sélection variante bandit (non bloquant, retombe sur A/B):', err.message);
  }
  const ab_variant = assignedVariant ? assignedVariant.label || 'A' : Math.random() < 0.5 ? 'A' : 'B';
  const variant_assignments = assignedVariant ? { intro_message: assignedVariant.id } : {};

  const { data: created, error: createErr } = await supabase
    .from('fans')
    .insert({ telegram_user_id, telegram_username, first_name, source_token, ab_variant, variant_assignments, tenant_id })
    .select()
    .single();
  if (createErr) {
    // MISE À JOUR 30/08/2026 — trouvé en audit : `telegram_user_id` a une
    // contrainte UNIQUE en base (vérifié), donc si deux chemins de code
    // DIFFÉRENTS (ex: un fan tout neuf envoie une photo ET un texte presque
    // simultanément — le handler média et enqueueFanMessage appellent chacun
    // getOrCreateFan indépendamment) font tous les deux le SELECT ci-dessus
    // avant que l'un des deux ait fini son INSERT, le perdant de cette course
    // se prend une violation de contrainte unique (23505) et plantait avant
    // ce correctif — privant ce fan tout neuf de réponse sur l'un des deux
    // messages. Le fix côté enqueueFanMessage (voir server.js, 30/08) ferme
    // cette course pour les messages texte, mais pas entre chemins de code
    // différents — on la referme ici, à la source, pour de bon : au lieu de
    // planter, on récupère simplement la ligne créée entre-temps par l'autre appel.
    if (createErr.code === '23505') {
      const { data: retryFan, error: retryErr } = await supabase
        .from('fans')
        .select('*')
        .eq('telegram_user_id', telegram_user_id)
        .eq('tenant_id', tenant_id)
        .single();
      if (retryErr) throw retryErr;
      return retryFan;
    }
    throw createErr;
  }

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

// `isFallback` (optionnel) : true quand ce message est le repli fixe envoyé
// suite à une erreur (voir server.js) et non une vraie réponse de l'IA — voir
// get_stalled_conversations, qui s'en sert pour continuer à détecter ces
// fans comme "en attente" même si le dernier message loggé est déjà de
// l'assistant.
// MISE À JOUR 30/08/2026 — `tenant_id` maintenant obligatoire. `fan_id` seul
// suffirait techniquement (uuid unique), mais SANS tenant_id explicite ici,
// la colonne serait remplie par sa valeur par défaut (le tenant historique
// "Meely", voir migration add_tenant_id_to_all_tables) — donc les messages
// d'une DEUXIÈME créatrice se retrouveraient mal étiquetés dans les
// requêtes/RLS futures qui filtrent par tenant_id, même si `fan_id` reste
// correct. L'appelant (server.js) a toujours `fan.tenant_id` sous la main.
async function logMessage(fan_id, role, content, isFallback = false, tenant_id) {
  if (!tenant_id) throw new Error('logMessage() nécessite un tenant_id.');
  const { error } = await supabase.from('conversation_messages').insert({ fan_id, role, content, is_fallback: isFallback, tenant_id });
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
async function recordSale({ fan_id, catalog_item_id, price, dropfans_link, status = 'sent', payment_method = 'dropfans', tenant_id }) {
  if (!tenant_id) throw new Error('recordSale() nécessite un tenant_id.');
  const { error } = await supabase
    .from('sales')
    .insert({ fan_id, catalog_item_id, price, dropfans_link, status, payment_method, tenant_id });
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

// ---------- Ventes : distinguer "lien envoyé" (status='sent', valeur par
// défaut posée dès la création) de "payé confirmé" (status='paid'). Rien ne
// confirme jamais automatiquement le paiement (pas de webhook Dropp.fans) —
// listSales/confirmSale servent à ce que l'admin le fasse manuellement depuis
// le dashboard après avoir vérifié le wallet Dropp (ou une preuve Yape/Nequi).
async function listSales(tenant_id, limit = 100) {
  if (!tenant_id) throw new Error('listSales() nécessite un tenant_id.');
  const { data, error } = await supabase
    .from('sales')
    .select('*, fans(telegram_username, first_name), catalog_items(name)')
    .eq('tenant_id', tenant_id)
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

  // MISE À JOUR 30/08/2026 — alimente le bandit de variantes de script (voir
  // section "Système de variantes de script + bandit" plus bas) : une vente
  // confirmée payée est le signal de conversion réel. `maybeLogConversionForFan`
  // est défini plus bas dans ce fichier (hoisting des `function` — pas de
  // souci d'ordre), et ne doit jamais faire échouer la confirmation de vente
  // elle-même si ce suivi rencontre un problème.
  if (data && data.fan_id) {
    maybeLogConversionForFan(data.fan_id).catch((err) =>
      console.error('Erreur suivi conversion bandit (non bloquant):', err.message)
    );
  }

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
// MISE À JOUR 30/08/2026 — deux bugs trouvés lors de l'audit :
// 1) Le frontend n'envoyait jamais de recherche/filtre au serveur : la
//    recherche par pseudo et le filtre de statut ne portaient QUE sur les
//    fans déjà chargés (par défaut les 50 plus actifs récemment) — avec 959+
//    fans, chercher quelqu'un qui n'a pas écrit récemment ne trouvait jamais
//    rien, sans aucune erreur. `search`/`status` sont maintenant appliqués
//    ici, dans la clause WHERE, donc sur TOUTE la table.
// 2) Le `.in('fan_id', ids)` ci-dessous scalait avec `limit` sans aucune
//    protection — exactement le même genre de requête qui a cassé
//    get_stalled_conversations à 959 ids (URL PostgREST trop longue). On
//    appelait cette fonction avec un `limit` toujours petit (≤200) donc ça ne
//    s'était pas encore reproduit ici, mais rien n'empêchait un futur appel
//    avec un plus grand `limit` de reproduire le même bug silencieusement. On
//    découpe maintenant systématiquement en petits lots ("chunks") — cette
//    requête ne peut plus jamais dépasser la limite d'URL, quelle que soit la
//    taille de `limit` à l'avenir.
async function listFansWithPreview({ tenant_id, limit = 50, offset = 0, search = '', status = '' } = {}) {
  if (!tenant_id) throw new Error('listFansWithPreview() nécessite un tenant_id.');
  let query = supabase.from('fans').select('*').eq('tenant_id', tenant_id);

  if (search && search.trim()) {
    // Échappe les caractères spéciaux de ILIKE (%, _) pour qu'une recherche
    // contenant un "%" ne soit pas interprétée comme un joker.
    const escaped = search.trim().replace(/[%_]/g, (c) => '\\' + c);
    const asNumber = /^\d+$/.test(search.trim()) ? search.trim() : null;
    const orParts = [`telegram_username.ilike.%${escaped}%`, `first_name.ilike.%${escaped}%`];
    if (asNumber) orParts.push(`telegram_user_id.eq.${asNumber}`);
    query = query.or(orParts.join(','));
  }
  if (status === 'paused') {
    query = query.eq('paused', true);
  } else if (status) {
    query = query.eq('status', status).eq('paused', false);
  }

  const { data: fans, error } = await query
    .order('last_active_at', { ascending: false })
    .range(offset, offset + limit - 1);
  if (error) throw error;
  if (!fans.length) return [];

  const ids = fans.map((f) => f.id);
  const CHUNK_SIZE = 150;
  const lastMessages = [];
  for (let i = 0; i < ids.length; i += CHUNK_SIZE) {
    const chunk = ids.slice(i, i + CHUNK_SIZE);
    const { data, error: msgErr } = await supabase
      .from('conversation_messages')
      .select('fan_id, role, content, created_at')
      .in('fan_id', chunk)
      .order('created_at', { ascending: false });
    if (msgErr) throw msgErr;
    lastMessages.push(...(data || []));
  }

  const previewByFan = {};
  for (const m of lastMessages) {
    if (!previewByFan[m.fan_id]) previewByFan[m.fan_id] = m;
  }

  return fans.map((f) => ({ ...f, last_message: previewByFan[f.id] || null }));
}

async function getFanById(fan_id) {
  const { data, error } = await supabase.from('fans').select('*').eq('id', fan_id).single();
  if (error) throw error;
  return data;
}

// MISE À JOUR 30/08/2026 — bug trouvé lors de l'audit : `order(ascending:true).limit(limit)`
// renvoyait les `limit` PREMIERS messages de la conversation, jamais les plus
// récents. Pour un fan actif depuis longtemps (>200 messages — justement ceux
// que Bryan a le plus besoin de suivre), le panneau "En direct" restait figé
// sur le tout début de la conversation pour toujours, donnant l'impression que
// le bot "avait oublié" alors que ce n'était qu'un bug d'affichage admin (l'IA,
// elle, utilise bien getRecentHistory() qui prend déjà les plus récents). On va
// donc chercher les `limit` DERNIERS messages (ordre descendant), puis on
// remet dans l'ordre chronologique pour l'affichage.
async function getFullConversation(fan_id, limit = 200) {
  const { data, error } = await supabase
    .from('conversation_messages')
    .select('role, content, created_at')
    .eq('fan_id', fan_id)
    .order('created_at', { ascending: false })
    .limit(limit);
  if (error) throw error;
  return (data || []).reverse();
}

// ---------- Admin tokens (simple multi-admin support) ----------
// MISE À JOUR 30/08/2026 — multi-tenant : chaque token admin appartient
// maintenant à UNE créatrice précise. Tout est filtré par tenant_id pour
// qu'une créatrice ne puisse jamais lister, créer ou supprimer les accès
// admin d'une autre.
async function listAdminTokens(tenant_id) {
  if (!tenant_id) throw new Error('listAdminTokens() nécessite un tenant_id.');
  const { data, error } = await supabase
    .from('admin_tokens')
    .select('id, label, token, created_at, last_used_at')
    .eq('tenant_id', tenant_id)
    .order('created_at', { ascending: true });
  if (error) throw error;
  return data;
}

// MISE À JOUR 30/08/2026 — retourne maintenant `{ ok, tenant_id }` au lieu
// d'un simple booléen : le multi-tenant a besoin de savoir à QUELLE créatrice
// ce token donne accès, pour que `requireAdminToken` (server.js) puisse
// scoper TOUTE la requête à son tenant_id. Le token "maître" (ADMIN_API_TOKEN,
// variable d'environnement — le filet de sécurité historique de Bryan pour
// ne jamais rester bloqué dehors) reste valide, mais résout maintenant vers
// le tenant marqué plan='founder' plutôt que de contourner le tenant
// entièrement — sinon ce token donnerait accès à TOUTES les créatrices, ce
// qui serait correct pour Bryan en tant qu'opérateur de la plateforme mais
// dangereux comme comportement par défaut non explicite.
async function isValidAdminToken(token) {
  if (!token) return { ok: false, tenant_id: null };
  if (process.env.ADMIN_API_TOKEN && token === process.env.ADMIN_API_TOKEN) {
    const { data: founder } = await supabase.from('tenants').select('id').eq('plan', 'founder').limit(1).maybeSingle();
    return { ok: true, tenant_id: founder ? founder.id : null };
  }
  const { data } = await supabase.from('admin_tokens').select('id, tenant_id').eq('token', token).maybeSingle();
  if (data) {
    // ATTENTION : sans ce .catch(), un rejet de cette promesse (jamais awaited,
    // volontairement — on ne veut pas ralentir chaque appel admin pour juste
    // mettre à jour "dernière utilisation") devenait une UnhandledPromiseRejection
    // qui CRASHE tout le process Node (comportement par défaut) — donc TOUTE la
    // conversation de TOUS les fans en cours s'arrête d'un coup. Repéré le 29/08
    // en analysant un crash serveur réel juste après un déploiement. C'est un
    // candidat sérieux pour expliquer des vagues de "elle arrête de répondre"
    // touchant plusieurs fans en même temps.
    supabase.from('admin_tokens').update({ last_used_at: new Date().toISOString() }).eq('id', data.id).then(
      () => {},
      (err) => console.error('Erreur mise à jour last_used_at (non bloquant):', err.message)
    );
    return { ok: true, tenant_id: data.tenant_id };
  }
  return { ok: false, tenant_id: null };
}

async function createAdminToken(label, tenant_id) {
  if (!tenant_id) throw new Error('createAdminToken() nécessite un tenant_id.');
  const { data, error } = await supabase.from('admin_tokens').insert({ label, tenant_id }).select().single();
  if (error) throw error;
  return data;
}

async function deleteAdminToken(id, tenant_id) {
  if (!tenant_id) throw new Error('deleteAdminToken() nécessite un tenant_id.');
  const { error } = await supabase.from('admin_tokens').delete().eq('id', id).eq('tenant_id', tenant_id);
  if (error) throw error;
}

// ---------- Analytics ----------
async function getAnalytics(tenant_id) {
  if (!tenant_id) throw new Error('getAnalytics() nécessite un tenant_id.');
  const [{ count: fanCount }, { data: sales }, { data: fans }] = await Promise.all([
    supabase.from('fans').select('*', { count: 'exact', head: true }).eq('tenant_id', tenant_id),
    supabase.from('sales').select('price, created_at, fan_id, status').eq('tenant_id', tenant_id),
    supabase.from('fans').select('id, status, ab_variant, source_token, total_spent').eq('tenant_id', tenant_id),
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

  const { data: links } = await supabase.from('tracking_links').select('source_token, campaign_label, clicks').eq('tenant_id', tenant_id);
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
async function getDailyTimeseries(tenant_id, days = 30) {
  if (!tenant_id) throw new Error('getDailyTimeseries() nécessite un tenant_id.');
  const since = new Date(Date.now() - days * 86400000);
  const sinceIso = since.toISOString();
  const [{ data: sales }, { data: fans }] = await Promise.all([
    supabase.from('sales').select('price, created_at').eq('tenant_id', tenant_id).gte('created_at', sinceIso),
    supabase.from('fans').select('created_at').eq('tenant_id', tenant_id).gte('created_at', sinceIso),
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
// MISE À JOUR 30/08/2026 — bug trouvé lors de l'audit : cette requête ne
// filtrait jamais sur `paused` — un fan mis en pause manuellement, ou par le
// filtre de sécurité suite à un incident (voir safetyFilter.js), pouvait quand
// même recevoir un message de relance automatique en pleine investigation.
// `.eq('paused', false)` ajouté pour respecter cette pause, quelle qu'en soit
// la raison.
// MISE À JOUR 30/08/2026 — multi-tenant : `tenant_id` obligatoire — le cron
// de relance (cron-reengagement.js) boucle maintenant sur CHAQUE créatrice
// active (voir listActiveTenants) et appelle cette fonction une fois par
// tenant, plutôt que de supposer une seule créatrice au monde.
async function getFansForReengagement(tenant_id, hoursThreshold) {
  if (!tenant_id) throw new Error('getFansForReengagement() nécessite un tenant_id.');
  const cutoff = new Date(Date.now() - hoursThreshold * 3600 * 1000).toISOString();
  const { data, error } = await supabase
    .from('fans')
    .select('*')
    .eq('tenant_id', tenant_id)
    .eq('paused', false)
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
async function listVaultAssets(tenant_id) {
  if (!tenant_id) throw new Error('listVaultAssets() nécessite un tenant_id.');
  const { data, error } = await supabase
    .from('content_vault')
    .select('*, catalog_items(name)')
    .eq('tenant_id', tenant_id)
    .order('created_at', { ascending: false });
  if (error) throw error;
  return data;
}

async function addVaultAsset({ category, media_type, storage_path, catalog_item_id, tenant_id }) {
  if (!tenant_id) throw new Error('addVaultAsset() nécessite un tenant_id.');
  const { data, error } = await supabase
    .from('content_vault')
    .insert({ category, media_type, storage_path, catalog_item_id: catalog_item_id || null, tenant_id })
    .select()
    .single();
  if (error) throw error;
  return data;
}

// ---------- Photo d'aperçu VISIBLE PAR LE FAN, par article du catalogue ----------
// Différent du coffre de contenu (content_vault, ci-dessus) : ceci est
// réellement ENVOYÉ au fan par le bot (voir "send_preview" dans
// claudeAgent.js / server.js) pour donner envie avant l'achat — jamais juste
// une référence interne pour l'IA. Stocké dans le même bucket privé
// "content-vault" (sous previews/), mais servi via une URL signée à la volée
// juste avant l'envoi Telegram — pas besoin que le bucket soit public.
async function setCatalogItemPreview(catalog_item_id, storage_path) {
  const { data, error } = await supabase
    .from('catalog_items')
    .update({ preview_image_path: storage_path })
    .eq('id', catalog_item_id)
    .select()
    .single();
  if (error) throw error;
  return data;
}

async function getSignedUrl(storage_path, expirySeconds = 3600) {
  if (!storage_path) return null;
  const { data, error } = await supabase.storage.from('content-vault').createSignedUrl(storage_path, expirySeconds);
  if (error) { console.error('Erreur génération URL signée:', error.message); return null; }
  return data?.signedUrl || null;
}

async function deleteVaultAsset(id) {
  const { data: asset, error: findErr } = await supabase.from('content_vault').select('storage_path').eq('id', id).single();
  if (findErr) throw findErr;
  if (asset) await supabase.storage.from('content-vault').remove([asset.storage_path]);
  const { error } = await supabase.from('content_vault').delete().eq('id', id);
  if (error) throw error;
}

async function getVaultSummary(tenant_id) {
  const assets = await listVaultAssets(tenant_id);
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
async function logSafetyIncident({ fan_id, reasons, flagged_text, tenant_id }) {
  const { error } = await supabase.from('safety_incidents').insert({ fan_id, reasons, flagged_text, tenant_id });
  if (error) console.error('Erreur enregistrement incident de sécurité:', error.message);
}

async function listSafetyIncidents(tenant_id, limit = 50, { onlyUnresolved = true } = {}) {
  if (!tenant_id) throw new Error('listSafetyIncidents() nécessite un tenant_id.');
  let query = supabase
    .from('safety_incidents')
    .select('*, fans(telegram_username, first_name, total_spent)')
    .eq('tenant_id', tenant_id)
    .order('created_at', { ascending: false })
    .limit(limit);
  if (onlyUnresolved) query = query.eq('resolved', false);
  const { data, error } = await query;
  if (error) throw error;
  return data;
}

// ---------- "Dépiler" un incident de sécurité une fois traité par l'admin —
// il disparaît du panneau "Alertes de sécurité récentes" sans être supprimé
// (garde l'historique pour l'audit trail, juste filtré de la vue par défaut).
async function resolveSafetyIncident(id) {
  const { error } = await supabase.from('safety_incidents').update({ resolved: true }).eq('id', id);
  if (error) throw error;
}

// ---------- Suivi d'usage IA (pour estimer le crédit restant — voir plus haut,
// Anthropic n'expose aucune API de solde en temps réel). Chaque appel réel à
// Claude journalise ses tokens ici ; l'admin saisit manuellement son solde à
// chaque recharge (setAiCreditBalance), et on estime le restant en
// soustrayant le coût des tokens consommés depuis cette date.
// MISE À JOUR 30/08/2026 — `provider` (colonne ajoutée, défaut 'anthropic')
// trace quel modèle a réellement répondu, maintenant que lib/aiProviders/
// peut basculer vers OpenAI en secours si Anthropic échoue. Permet de voir
// dans le dashboard à quelle fréquence le secours est utilisé, sans attendre
// qu'un fan se plaigne d'une réponse bizarre.
async function logAiUsage({ input_tokens, output_tokens, fan_id, provider, tenant_id }) {
  if (!tenant_id) {
    console.error('Erreur log usage IA: tenant_id manquant — usage non journalisé pour éviter de le mal-attribuer.');
    return;
  }
  const { error } = await supabase
    .from('ai_usage_log')
    .insert({
      input_tokens: input_tokens || 0,
      output_tokens: output_tokens || 0,
      fan_id: fan_id || null,
      provider: provider || 'anthropic',
      tenant_id,
    });
  if (error) console.error('Erreur log usage IA:', error.message);
}

// MISE À JOUR 30/08/2026 — bug trouvé lors de l'audit : avant, cette fonction
// chargeait TOUTES les lignes de `ai_usage_log` depuis la dernière recharge et
// les additionnait côté Node — mais PostgREST plafonne silencieusement une
// requête sans `.limit()` explicite à 1000 lignes. Le bot peut largement
// dépasser 1000 appels IA entre deux recharges (plusieurs centaines de fans
// actifs) : passé ce seuil, l'usage réel était sous-compté, ce qui faisait
// croire qu'il restait PLUS de crédit que la réalité — probablement une des
// causes de la panne de crédit du 30/08 sans alerte à temps. On agrège
// maintenant côté base de données (fonction SQL get_ai_usage_sum), qui ne
// dépend plus du nombre de lignes.
// MISE À JOUR 30/08/2026 — `p_tenant_id` ajouté au RPC (voir migration
// scope_sql_functions_by_tenant) pour que le crédit IA soit compté SÉPARÉMENT
// par créatrice — chacune a son propre budget/alerte de crédit bas.
async function getAiUsageSince(sinceIso, tenant_id) {
  if (!tenant_id) throw new Error('getAiUsageSince() nécessite un tenant_id.');
  const { data, error } = await supabase.rpc('get_ai_usage_sum', { since_ts: sinceIso || null, p_tenant_id: tenant_id });
  if (error) throw error;
  const row = (data && data[0]) || { input_sum: 0, output_sum: 0 };
  return { input: Number(row.input_sum) || 0, output: Number(row.output_sum) || 0 };
}

async function setAiCreditBalance(amount, tenant_id) {
  const settings = await getSettings(tenant_id);
  const { data, error } = await supabase
    .from('settings')
    // On repart de zéro sur l'alerte de solde bas à chaque recharge — sinon,
    // une fois l'alerte envoyée, elle ne repartirait jamais après un topup.
    .update({
      ai_credit_balance: amount,
      ai_credit_balance_updated_at: new Date().toISOString(),
      low_credit_alert_sent: false,
    })
    .eq('id', settings.id)
    .select()
    .single();
  if (error) throw error;
  return data;
}

// Marque l'alerte "crédit bas" comme déjà envoyée pour ce cycle — évite de
// spammer l'admin à chaque rafraîchissement du dashboard (toutes les 5s) tant
// qu'il n'a pas rechargé (voir setAiCreditBalance, qui remet ce drapeau à
// zéro).
async function markLowCreditAlertSent(tenant_id) {
  const settings = await getSettings(tenant_id);
  const { error } = await supabase.from('settings').update({ low_credit_alert_sent: true }).eq('id', settings.id);
  if (error) console.error('Erreur marquage alerte crédit bas:', error.message);
}

// ---------- Stats "Live Ops" pour le panneau temps réel du dashboard. Combiné
// côté server.js avec des métriques en mémoire (taille de la file d'attente
// par fan, uptime du process) qui n'ont pas leur place en base.
async function getLiveOpsStats(tenant_id) {
  if (!tenant_id) throw new Error('getLiveOpsStats() nécessite un tenant_id.');
  const now = Date.now();
  const since1h = new Date(now - 3600 * 1000).toISOString();
  const since24h = new Date(now - 24 * 3600 * 1000).toISOString();
  const d = new Date();
  const todayStart = new Date(d.getFullYear(), d.getMonth(), d.getDate()).toISOString();

  const [active1h, active24h, pausedCount, messagesToday, safetyToday] = await Promise.all([
    supabase.from('fans').select('*', { count: 'exact', head: true }).eq('tenant_id', tenant_id).gte('last_active_at', since1h),
    supabase.from('fans').select('*', { count: 'exact', head: true }).eq('tenant_id', tenant_id).gte('last_active_at', since24h),
    supabase.from('fans').select('*', { count: 'exact', head: true }).eq('tenant_id', tenant_id).eq('paused', true),
    supabase.from('conversation_messages').select('*', { count: 'exact', head: true }).eq('tenant_id', tenant_id).gte('created_at', todayStart),
    supabase.from('safety_incidents').select('*', { count: 'exact', head: true }).eq('tenant_id', tenant_id).gte('created_at', todayStart),
  ]);

  return {
    active1h: active1h.count || 0,
    active24h: active24h.count || 0,
    pausedCount: pausedCount.count || 0,
    messagesToday: messagesToday.count || 0,
    safetyToday: safetyToday.count || 0,
  };
}

// ---------- "En attente de révision" : conversations qui semblent bloquées —
// dernier message venant du fan, IA pas en pause, et pourtant aucune réponse
// envoyée depuis plus de `thresholdMinutes`. Repéré en investiguant pourquoi
// certains fans n'avaient jamais de réponse (29/08) : ça arrive parfois sans
// aucune erreur visible dans les logs (probablement un appel Anthropic resté
// bloqué — voir le timeout ajouté dans lib/claudeAgent.js). Cette vue ne
// dépend d'aucun log d'erreur : elle regarde juste l'état réel de la
// conversation, donc elle détecte le problème même quand rien n'a "planté"
// au sens classique.
//
// MISE À JOUR 30/08/2026 — bug de scalabilité trouvé en vérifiant les logs
// juste après le déploiement de la refonte Persona & Script : l'ancienne
// version chargeait TOUS les fans non en pause, puis passait leurs UUID dans
// un filtre .in() vers conversation_messages et stalled_dismissals. Avec 959
// fans non en pause en prod, l'URL générée par PostgREST dépassait la limite
// acceptée et Supabase répondait "Bad Request" — visible dans les logs Render
// ("Erreur calcul conversations en attente de révision: Bad Request"),
// silencieusement avalé par le .catch() de la route /api/admin/live-stats.
// Ce panneau affichait donc TOUJOURS zéro conversation bloquée, quel que soit
// l'état réel — potentiellement des fans payants laissés sans réponse pendant
// des heures sans que Bryan le voie (voir l'incident du 30/08 : un client
// ayant payé $16.98 resté 7h sans réponse). Fix : tout le calcul se fait
// maintenant en une seule requête SQL côté Postgres (fonction RPC
// get_stalled_conversations, migration fix_stalled_conversations_scale_bug),
// qui va chercher le dernier message de chaque fan via un LATERAL JOIN sur
// l'index existant (fan_id, created_at) — plus besoin de charger tous les
// fans ni de construire une liste d'UUID dans l'URL. Ça scale indéfiniment.
async function getStalledConversations(tenant_id, thresholdMinutes = 5) {
  if (!tenant_id) throw new Error('getStalledConversations() nécessite un tenant_id.');
  const { data, error } = await supabase.rpc('get_stalled_conversations', { threshold_minutes: thresholdMinutes, p_tenant_id: tenant_id });
  if (error) throw error;
  return (data || []).map((row) => ({
    fan_id: row.fan_id,
    telegram_username: row.telegram_username,
    first_name: row.first_name,
    telegram_user_id: row.telegram_user_id,
    status: row.status,
    total_spent: row.total_spent,
    last_message: row.last_message,
    last_message_at: row.last_message_at,
    minutes_since: Math.floor(Number(row.minutes_since)),
  }));
}

// ---------- Analyse en temps réel de l'audience (panneau "Vue d'ensemble") ----------
// MISE À JOUR 31/08/2026 — demandé par Bryan : un vrai "pouls" de l'audience,
// pas juste des compteurs bruts (le panneau "live-ops" existant — active1h,
// messagesToday... — reste tel quel, celui-ci le complète sans le dupliquer).
// Trois idées derrière ce choix de métriques :
//  1. "Chaud" = potential='potencial' (déjà posé par l'IA via remember_about_fan)
//     ET actif dans les 2 dernières heures ET pas en pause — une conversation
//     qui montre un intérêt réel MAINTENANT, pas un score figé depuis des jours.
//  2. "Potentiel de revenu" est décomposé en DEUX nombres distincts et non
//     mélangés, parce que la question qu'on répond n'est pas la même :
//     - `pendingValue` = tout l'argent des liens envoyés jamais confirmés
//       payés (tout historique confondu) — "ce qui pourrait encore rentrer".
//     - `sentTodayValue` = valeur des liens envoyés AUJOURD'HUI seulement —
//       "l'activité commerciale du jour". On ne peut PAS calculer un
//       "confirmé aujourd'hui" fiable : `sales` n'a pas de colonne horodatant
//       le moment de la confirmation (confirmSale ne fait que changer le
//       statut), donc on ne prétend pas savoir quand un paiement a eu lieu.
//  3. Le "ressenti" (ce que demandent les fans) est donné par de VRAIS extraits
//     (interests_notes/objections_notes/budget_notes déjà écrits par l'IA),
//     pas par un comptage de mots-clés qui donnerait une fausse précision.
async function getLiveAudiencePulse(tenant_id) {
  if (!tenant_id) throw new Error('getLiveAudiencePulse() nécessite un tenant_id.');
  const now = Date.now();
  const since2h = new Date(now - 2 * 3600 * 1000).toISOString();
  const d = new Date();
  const todayStart = new Date(d.getFullYear(), d.getMonth(), d.getDate()).toISOString();

  const [
    { count: hotCount },
    { data: hotList },
    { count: newFansToday },
    { data: pendingSales },
    { data: salesToday },
    { data: activeTodayFans },
  ] = await Promise.all([
    supabase.from('fans').select('*', { count: 'exact', head: true })
      .eq('tenant_id', tenant_id).eq('potential', 'potencial').eq('paused', false).gte('last_active_at', since2h),
    supabase.from('fans').select('id, telegram_username, first_name, total_spent, last_active_at, interests_notes, objections_notes, budget_notes')
      .eq('tenant_id', tenant_id).eq('potential', 'potencial').eq('paused', false).gte('last_active_at', since2h)
      .order('last_active_at', { ascending: false }).limit(6),
    supabase.from('fans').select('*', { count: 'exact', head: true }).eq('tenant_id', tenant_id).gte('created_at', todayStart),
    supabase.from('sales').select('price').eq('tenant_id', tenant_id).eq('status', 'sent'),
    supabase.from('sales').select('price, catalog_item_id, catalog_items(name)').eq('tenant_id', tenant_id).gte('created_at', todayStart),
    supabase.from('fans').select('potential, country').eq('tenant_id', tenant_id).gte('last_active_at', todayStart),
  ]);

  const pendingValue = (pendingSales || []).reduce((sum, s) => sum + Number(s.price), 0);
  const sentTodayValue = (salesToday || []).reduce((sum, s) => sum + Number(s.price), 0);

  const byItem = {};
  (salesToday || []).forEach((s) => {
    const key = s.catalog_item_id || 'inconnu';
    if (!byItem[key]) byItem[key] = { name: s.catalog_items?.name || 'Article supprimé', count: 0, value: 0 };
    byItem[key].count += 1;
    byItem[key].value += Number(s.price);
  });
  const topItemsToday = Object.values(byItem).sort((a, b) => b.value - a.value).slice(0, 3);

  const sentiment = { potencial: 0, sin_potencial: 0, non_evalue: 0 };
  const byCountry = {};
  (activeTodayFans || []).forEach((f) => {
    if (f.potential === 'potencial') sentiment.potencial += 1;
    else if (f.potential === 'sin_potencial') sentiment.sin_potencial += 1;
    else sentiment.non_evalue += 1;
    const c = (f.country || '').trim();
    if (c) byCountry[c] = (byCountry[c] || 0) + 1;
  });
  const topCountriesToday = Object.entries(byCountry).map(([country, count]) => ({ country, count })).sort((a, b) => b.count - a.count).slice(0, 3);

  return {
    hotCount: hotCount || 0,
    hotList: (hotList || []).map((f) => ({
      label: f.telegram_username ? `@${f.telegram_username}` : (f.first_name || 'Fan'),
      total_spent: Number(f.total_spent) || 0,
      last_active_at: f.last_active_at,
      // On donne la priorité à ce qui ressemble le plus à une demande concrète
      // (intérêt) plutôt qu'à un frein (objection), pour que ce flux se lise
      // comme "ce qu'ils veulent" et pas seulement "ce qui coince".
      snippet: f.interests_notes || f.objections_notes || f.budget_notes || null,
    })),
    newFansToday: newFansToday || 0,
    activeFansToday: (activeTodayFans || []).length,
    pendingValue,
    sentTodayValue,
    salesCountToday: (salesToday || []).length,
    topItemsToday,
    sentiment,
    topCountriesToday,
    generatedAt: new Date().toISOString(),
  };
}

// ---------- Capture automatique du chat_id Telegram de l'admin ----------
// Avant : le champ "chat_id Telegram" des réglages restait vide car il fallait
// que Bryan trouve son propre chat_id via un bot tiers (@userinfobot) et le
// colle à la main — jamais fait en pratique, donc AUCUNE alerte Telegram
// (ventes VIP, incidents de sécurité) n'est jamais partie (constaté le
// 30/08/2026 : 16 incidents et plusieurs ventes VIP sans la moindre alerte).
// Nouveau flux : un code à usage unique généré depuis le dashboard, que Bryan
// envoie lui-même en message à son bot ("/admin_XXXXXX") — server.js capture
// alors automatiquement le chat_id de qui a envoyé ce message exact.
function generateSetupCode() {
  return Math.random().toString(36).slice(2, 8).toUpperCase();
}

async function generateAdminSetupCode(tenant_id) {
  const settings = await getSettings(tenant_id);
  const code = generateSetupCode();
  const { error } = await supabase.from('settings').update({ admin_setup_code: code }).eq('id', settings.id);
  if (error) throw error;
  return code;
}

// Retourne le chat_id enregistré si le code correspond (et l'enregistre comme
// admin_telegram_chat_id), sinon null — appelé depuis le webhook Telegram
// quand un message "/admin_XXXXXX" arrive (voir server.js). `tenant_id` est
// déjà connu à cet endroit (c'est LE tenant dont le bot a reçu ce message) —
// on vérifie le code SEULEMENT dans sa propre ligne settings, jamais dans
// celle d'une autre créatrice.
async function tryCaptureAdminChatId(code, chatId, tenant_id) {
  const settings = await getSettings(tenant_id);
  if (!settings.admin_setup_code || settings.admin_setup_code !== code) return false;
  const { error } = await supabase
    .from('settings')
    .update({ admin_telegram_chat_id: chatId, admin_setup_code: null })
    .eq('id', settings.id);
  if (error) throw error;
  return true;
}

// ---------- Note manuelle libre de l'admin sur un fan (distincte des notes
// écrites par l'IA via remember_about_fan) — demandé le 30/08/2026 : Bryan
// n'avait aucun moyen d'ajouter sa propre observation sur un fan.
async function setFanAdminNote(fan_id, note) {
  const { error } = await supabase.from('fans').update({ admin_note: note }).eq('id', fan_id);
  if (error) throw error;
}

// ---------- "Dépiler" une conversation bloquée : Bryan/Meely a vu l'alerte et
// s'en occupe (ou a jugé que ce n'était pas grave) — elle disparaît du
// panneau tant que le fan n'a pas écrit de nouveau message depuis.
async function dismissStalledFan(fan_id, tenant_id) {
  const { data: lastMsg, error: msgErr } = await supabase
    .from('conversation_messages')
    .select('created_at')
    .eq('fan_id', fan_id)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (msgErr) throw msgErr;
  const dismissed_last_message_at = lastMsg ? lastMsg.created_at : new Date().toISOString();
  const { error } = await supabase
    .from('stalled_dismissals')
    .upsert({ fan_id, dismissed_at: new Date().toISOString(), dismissed_last_message_at, tenant_id }, { onConflict: 'fan_id' });
  if (error) throw error;
}

// ---------- Regroupement des fans par pays (carte "Fans par pays") ----------
// MISE À JOUR 30/08/2026 — alimente la carte interactive de Vue d'ensemble.
// On ne remonte que la colonne "country" (légère) et on agrège côté Node plutôt
// que côté SQL : nombre de valeurs distinctes attendu très faible (quelques
// dizaines de pays), donc pas besoin d'une fonction RPC dédiée ici.
async function getFanCountByCountry(tenant_id) {
  if (!tenant_id) throw new Error('getFanCountByCountry() nécessite un tenant_id.');
  const { data, error } = await supabase.from('fans').select('country').eq('tenant_id', tenant_id).not('country', 'is', null);
  if (error) throw error;
  const counts = {};
  for (const row of data) {
    const c = (row.country || '').trim();
    if (!c) continue;
    counts[c] = (counts[c] || 0) + 1;
  }
  return counts;
}

// ========================================================================
// MISE À JOUR 30/08/2026 — Système de variantes de script + bandit
// (Thompson sampling, voir lib/banditMath.js). Généralise et remplace
// progressivement l'ancien tirage à pile ou face 50/50 (`fans.ab_variant`,
// `settings.intro_message` / `intro_message_b`) : au lieu d'un split figé
// dont on ne fait qu'observer le résultat, chaque nouveau fan se voit
// assigner la variante qui a statistiquement le plus de chances de
// convertir, tout en continuant à tester les autres.
//
// `field_key` identifie à quel champ de script la variante s'applique (pour
// l'instant seul 'intro_message' est câblé de bout en bout — voir
// getOrCreateFan ci-dessus et server.js /start — mais le schéma est générique
// pour pouvoir étendre plus tard à d'autres étapes, ex: 'script_closing').
// ========================================================================

const { pickBanditVariant } = require('./banditMath');

// MISE À JOUR 30/08/2026 — multi-tenant : `tenant_id` obligatoire. Sans ça,
// deux créatrices ayant chacune une variante 'intro_message' se
// mélangeraient dans le même pool de sélection du bandit — une créatrice
// pourrait littéralement se voir assigner le message d'accueil configuré par
// une autre.
async function getVariantsForField(field_key, tenant_id, { activeOnly = true } = {}) {
  if (!tenant_id) throw new Error('getVariantsForField() nécessite un tenant_id.');
  let query = supabase.from('script_variants').select('*').eq('field_key', field_key).eq('tenant_id', tenant_id);
  if (activeOnly) query = query.eq('active', true);
  const { data, error } = await query.order('created_at', { ascending: true });
  if (error) throw error;
  return data || [];
}

// Stats agrégées (expositions/conversions) par variante — utilisées à la
// fois par le bandit pour décider, et par le dashboard pour afficher le
// taux de conversion de chaque variante.
async function getVariantStats(field_key, tenant_id) {
  const variants = await getVariantsForField(field_key, tenant_id, { activeOnly: false });
  if (!variants.length) return [];

  const ids = variants.map((v) => v.id);
  const { data: events, error } = await supabase
    .from('script_variant_events')
    .select('variant_id, event_type')
    .in('variant_id', ids);
  if (error) throw error;

  const counts = {};
  for (const v of variants) counts[v.id] = { exposures: 0, conversions: 0 };
  for (const ev of events || []) {
    if (!counts[ev.variant_id]) continue;
    if (ev.event_type === 'exposed') counts[ev.variant_id].exposures += 1;
    if (ev.event_type === 'converted') counts[ev.variant_id].conversions += 1;
  }

  return variants.map((v) => ({
    ...v,
    exposures: counts[v.id].exposures,
    conversions: counts[v.id].conversions,
    conversion_rate: counts[v.id].exposures > 0 ? counts[v.id].conversions / counts[v.id].exposures : null,
  }));
}

// Choisit la variante à assigner à un nouveau fan pour ce field_key, via le
// bandit Thompson sampling. Retourne `null` si aucune variante active
// n'existe pour ce champ (l'appelant retombe alors sur l'ancien comportement
// — voir settings.intro_message dans getOrCreateFan/server.js).
async function pickVariantForField(field_key, tenant_id) {
  const stats = await getVariantStats(field_key, tenant_id);
  const active = stats.filter((s) => s.active);
  if (!active.length) return null;
  const chosenId = pickBanditVariant(active.map((s) => ({ id: s.id, exposures: s.exposures, conversions: s.conversions })));
  return active.find((s) => s.id === chosenId) || null;
}

async function getScriptVariantById(id) {
  if (!id) return null;
  const { data, error } = await supabase.from('script_variants').select('*').eq('id', id).maybeSingle();
  if (error) throw error;
  return data;
}

async function logVariantEvent(variant_id, fan_id, event_type, tenant_id) {
  if (!variant_id) return;
  const { error } = await supabase.from('script_variant_events').insert({ variant_id, fan_id: fan_id || null, event_type, tenant_id });
  if (error) console.error('Erreur log événement variante:', error.message);
}

async function createScriptVariant({ field_key, label, content, tenant_id }) {
  if (!tenant_id) throw new Error('createScriptVariant() nécessite un tenant_id.');
  const { data, error } = await supabase
    .from('script_variants')
    .insert({ field_key, label: label || null, content, active: true, tenant_id })
    .select()
    .single();
  if (error) throw error;
  return data;
}

async function updateScriptVariant(id, patch) {
  const allowed = {};
  if (typeof patch.label === 'string') allowed.label = patch.label;
  if (typeof patch.content === 'string') allowed.content = patch.content;
  if (typeof patch.active === 'boolean') allowed.active = patch.active;
  const { data, error } = await supabase.from('script_variants').update(allowed).eq('id', id).select().single();
  if (error) throw error;
  return data;
}

// Enregistre, pour ce fan, la première conversion (premier lien de vente
// confirmé payé) sur la variante qui lui avait été assignée — c'est le
// signal qui alimente le bandit. Appelé depuis confirmSale() ci-dessus.
// `field_key` est en dur sur 'intro_message' pour l'instant (seul champ
// câblé), voir le commentaire d'en-tête de cette section.
async function maybeLogConversionForFan(fan_id) {
  try {
    const { data: fan, error: fanErr } = await supabase
      .from('fans')
      .select('variant_assignments, tenant_id')
      .eq('id', fan_id)
      .single();
    if (fanErr || !fan) return;
    const variantId = fan.variant_assignments && fan.variant_assignments.intro_message;
    if (!variantId) return;

    // Ne compte que la PREMIÈRE conversion de ce fan sur cette variante —
    // sinon un fan qui achète plusieurs fois gonflerait artificiellement le
    // taux de conversion de sa variante à chaque nouvel achat.
    const { count, error: countErr } = await supabase
      .from('script_variant_events')
      .select('id', { count: 'exact', head: true })
      .eq('variant_id', variantId)
      .eq('fan_id', fan_id)
      .eq('event_type', 'converted');
    if (countErr) return;
    if (count && count > 0) return;

    await logVariantEvent(variantId, fan_id, 'converted', fan.tenant_id);
  } catch (err) {
    // Best-effort : ne doit jamais faire échouer une confirmation de vente
    // réelle à cause d'un souci sur le suivi du bandit.
    console.error('Erreur maybeLogConversionForFan (non bloquant):', err.message);
  }
}

// ========================================================================
// MISE À JOUR 30/08/2026 — Mémoire vectorielle (pgvector), premier étage.
// Complète (sans le remplacer) le champ texte libre `memory_notes` : chaque
// mise à jour de note via l'outil "remember_about_fan" est aussi enregistrée
// comme un embedding, ce qui permettra plus tard un rappel sémantique
// (retrouver une note pertinente même si elle ne tient plus dans la fenêtre
// de conversation chargée). Dépend entièrement de OPENAI_API_KEY (voir
// lib/embeddings.js) — no-op silencieux tant que cette clé n'est pas
// configurée sur Render, donc aucun risque pour le fonctionnement actuel.
// ========================================================================

async function storeFanMemoryEmbedding(fan_id, content, embedding, tenant_id) {
  if (!embedding) return;
  const { error } = await supabase.from('fan_memory_embeddings').insert({ fan_id, content, embedding, tenant_id });
  if (error) console.error('Erreur stockage embedding mémoire fan:', error.message);
}

async function hasFanMemoryEmbeddings(fan_id) {
  const { count, error } = await supabase
    .from('fan_memory_embeddings')
    .select('id', { count: 'exact', head: true })
    .eq('fan_id', fan_id);
  if (error) return false;
  return !!count && count > 0;
}

// Recherche par similarité cosinus via la fonction SQL `match_fan_memory`
// (voir migration) — reste cantonné aux souvenirs de CE fan uniquement.
async function searchFanMemory(fan_id, queryEmbedding, matchCount = 3) {
  if (!queryEmbedding) return [];
  const { data, error } = await supabase.rpc('match_fan_memory', {
    p_fan_id: fan_id,
    p_query_embedding: queryEmbedding,
    p_match_count: matchCount,
  });
  if (error) {
    console.error('Erreur recherche mémoire vectorielle:', error.message);
    return [];
  }
  return data || [];
}

// ========================================================================
// MISE À JOUR 30/08/2026 — Gestion des tenants (créatrices), voir migration
// create_tenants_table_and_seed_default. Fonctions utilisées par
// l'inscription self-service (server.js, POST /api/signup) et le routage
// webhook multi-bot (server.js, /telegram/webhook/:tenantId).
// ========================================================================

async function getTenantById(id) {
  if (!id) return null;
  const { data, error } = await supabase.from('tenants').select('*').eq('id', id).maybeSingle();
  if (error) throw error;
  return data;
}

// Résout un tenant à partir du token de bot Telegram qui a reçu le message —
// c'est ce qui permet à server.js de savoir "cette mise à jour Telegram
// concerne quelle créatrice" indépendamment de l'URL du webhook.
async function getTenantByBotToken(token) {
  if (!token) return null;
  const { data, error } = await supabase.from('tenants').select('*').eq('telegram_bot_token', token).maybeSingle();
  if (error) throw error;
  return data;
}

async function listActiveTenants() {
  const { data, error } = await supabase.from('tenants').select('*').eq('status', 'active');
  if (error) throw error;
  return data || [];
}

async function updateTenant(id, patch) {
  const allowed = {};
  for (const key of ['name', 'owner_email', 'telegram_bot_token', 'telegram_bot_username', 'status', 'plan', 'stripe_customer_id', 'stripe_subscription_id']) {
    if (patch[key] !== undefined) allowed[key] = patch[key];
  }
  const { data, error } = await supabase.from('tenants').update(allowed).eq('id', id).select().single();
  if (error) throw error;
  return data;
}

// ---------- Inscription self-service ----------
// Provisionne tout ce dont une nouvelle créatrice a besoin pour démarrer :
// sa ligne tenant, sa ligne settings avec des valeurs par défaut raisonnables
// (elle les ajustera ensuite depuis son dashboard), et son premier token
// admin. N'appelle PAS setWebhook ici — server.js s'en charge une fois cette
// fonction retournée, pour garder la logique réseau Telegram hors de ce
// fichier (qui ne parle qu'à Supabase).
async function createTenant({ name, owner_email, telegram_bot_token, telegram_bot_username }) {
  if (!name || !telegram_bot_token) throw new Error('createTenant() nécessite au moins name et telegram_bot_token.');

  // Un token de bot Telegram ne peut appartenir qu'à UNE créatrice — vérifié
  // ici en amont pour renvoyer une erreur claire plutôt qu'une violation de
  // contrainte SQL opaque si jamais on en ajoute une plus tard.
  const existing = await getTenantByBotToken(telegram_bot_token);
  if (existing) throw new Error('Ce token de bot Telegram est déjà utilisé par un autre compte Meeli.');

  const { data: tenant, error: tenantErr } = await supabase
    .from('tenants')
    .insert({ name, owner_email: owner_email || null, telegram_bot_token, telegram_bot_username: telegram_bot_username || null, status: 'trial', plan: 'starter' })
    .select()
    .single();
  if (tenantErr) throw tenantErr;

  // Valeurs par défaut délibérément neutres/sûres — la créatrice les affine
  // ensuite depuis Persona & Script. Reprend la forme de la ligne settings
  // historique (mêmes colonnes) pour que tout le reste du code (getSettings,
  // buildSystemPrompt, etc.) fonctionne sans distinction entre un tenant
  // fondateur et un tenant inscrit en self-service.
  const { error: settingsErr } = await supabase.from('settings').insert({
    tenant_id: tenant.id,
    creator_name: name,
    persona_name: 'Mia',
    tone: 'cálida, cómplice, curiosa',
    currency_symbol: '$',
    language: 'es',
    min_custom_price: 5,
    max_negotiation_discount_pct: 15,
    reengagement_hours: 24,
    vip_threshold: 100,
    alert_min_sale: 20,
    intro_message: `Hola! soy {persona_name}, la asistente de {creator_name} 😊 cómo te llamas?`,
    telegram_bot_token,
    // MISE À JOUR 30/08/2026 — manquait à l'origine : sans ça, une nouvelle
    // créatrice inscrite en self-service se retrouvait avec
    // settings.telegram_bot_username toujours vide, ce qui casse le lien de
    // suivi (/api/tracking-link) et l'affichage du nom du bot (bouton
    // "Connecter les alertes Telegram"). Non bloquant (aucune colonne NOT NULL
    // sans défaut n'était concernée), mais un vrai manque fonctionnel corrigé
    // avant le premier vrai test d'inscription self-service.
    telegram_bot_username: telegram_bot_username || null,
  });
  if (settingsErr) {
    // Best-effort rollback : évite un tenant "fantôme" sans settings si cette
    // deuxième insertion échoue (ex: colonne manquante côté schéma).
    await supabase.from('tenants').delete().eq('id', tenant.id);
    throw settingsErr;
  }

  const adminToken = await createAdminToken('Accès principal', tenant.id);
  return { tenant, adminToken };
}

module.exports = {
  supabase,
  getTenantById,
  getTenantByBotToken,
  listActiveTenants,
  updateTenant,
  createTenant,
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
  listVaultAssets,
  addVaultAsset,
  deleteVaultAsset,
  getVaultSummary,
  setCatalogItemPreview,
  getSignedUrl,
  logAiUsage,
  getAiUsageSince,
  setAiCreditBalance,
  markLowCreditAlertSent,
  getLiveOpsStats,
  getStalledConversations,
  getLiveAudiencePulse,
  generateAdminSetupCode,
  tryCaptureAdminChatId,
  setFanAdminNote,
  snapshotSettings,
  listSettingsHistory,
  restoreSettingsVersion,
  getVariantsForField,
  getVariantStats,
  pickVariantForField,
  getScriptVariantById,
  logVariantEvent,
  createScriptVariant,
  updateScriptVariant,
  storeFanMemoryEmbedding,
  hasFanMemoryEmbeddings,
  searchFanMemory,
};
