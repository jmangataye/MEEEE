// Job de relance automatique des fans inactifs.
// Pensé pour tourner comme "Cron Job" Render (pas un service web) — ex: toutes les 6h.
require('dotenv').config();
const { getSettings, getFansForReengagement, markReengaged, logMessage } = require('./lib/supabase');
const { sendMessage } = require('./lib/telegram');

async function run() {
  const settings = await getSettings();
  const fans = await getFansForReengagement(settings.reengagement_hours);
  console.log(`Relance: ${fans.length} fan(s) à recontacter.`);

  for (const fan of fans) {
    try {
      await sendMessage(settings.telegram_bot_token, fan.telegram_user_id, settings.reengagement_message);
      await logMessage(fan.id, 'assistant', settings.reengagement_message);
      await markReengaged(fan.id);
      console.log(`Relancé: ${fan.telegram_username || fan.first_name || fan.id}`);
    } catch (err) {
      console.error(`Erreur relance fan ${fan.id}:`, err.message);
    }
  }
}

run()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error('Erreur job de relance:', err);
    process.exit(1);
  });
