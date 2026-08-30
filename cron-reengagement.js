// Job de relance automatique des fans inactifs.
// Pensé pour tourner comme "Cron Job" Render (pas un service web) — ex: toutes les 6h.
require('dotenv').config();
const { getSettings, getFansForReengagement, markReengaged, logMessage, listActiveTenants } = require('./lib/supabase');
const { sendMessage } = require('./lib/telegram');

// MISE À JOUR 30/08/2026 (multi-tenant) — ce job tournait à l'origine pour UNE
// seule créatrice (Meely, via getSettings() sans argument). Il boucle
// maintenant sur toutes les créatrices actives (listActiveTenants) — chacune
// avec son propre bot Telegram, ses propres réglages de relance et sa propre
// pause globale — voir aussi la route /api/cron/reengagement de server.js qui
// fait la même chose pour un déclenchement HTTP externe (cron-job.org).
async function run() {
  const tenants = await listActiveTenants();
  console.log(`Relance: ${tenants.length} créatrice(s) active(s) à traiter.`);

  for (const tenant of tenants) {
    try {
      const settings = await getSettings(tenant.id);

      // MISE À JOUR 30/08/2026 — bug trouvé lors de l'audit : ce cron tourne
      // dans un processus séparé du serveur web, donc il ne savait rien du
      // bouton "Mettre le bot en pause" (bot_globally_paused) — pauser le bot
      // depuis le dashboard n'empêchait pas cette relance automatique de
      // partir quand même à sa prochaine exécution programmée.
      if (settings.bot_globally_paused) {
        console.log(`[${tenant.name}] Bot en pause globale — relance sautée pour cette exécution.`);
        continue;
      }

      const fans = await getFansForReengagement(tenant.id, settings.reengagement_hours);
      console.log(`[${tenant.name}] ${fans.length} fan(s) à recontacter.`);

      for (const fan of fans) {
        try {
          await sendMessage(settings.telegram_bot_token, fan.telegram_user_id, settings.reengagement_message);
          await logMessage(fan.id, 'assistant', settings.reengagement_message, false, tenant.id);
          await markReengaged(fan.id);
          console.log(`[${tenant.name}] Relancé: ${fan.telegram_username || fan.first_name || fan.id}`);
        } catch (err) {
          console.error(`[${tenant.name}] Erreur relance fan ${fan.id}:`, err.message);
        }
      }
    } catch (tenantErr) {
      // Un problème sur UNE créatrice (bot_token invalide, réglages
      // manquants...) ne doit jamais empêcher la relance de tourner pour
      // toutes les autres.
      console.error(`Erreur relance pour tenant ${tenant.id} (${tenant.name}):`, tenantErr.message);
    }
  }
}

run()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error('Erreur job de relance:', err);
    process.exit(1);
  });
