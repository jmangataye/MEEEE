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
  const { data: created, error: createErr } = await supabase
    .from('fans')
    .insert({ telegram_user_id, telegram_username, first_name, source_token })
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

async function recordSale({ fan_id, catalog_item_id, price, dropfans_link }) {
  const { error } = await supabase
    .from('sales')
    .insert({ fan_id, catalog_item_id, price, dropfans_link });
  if (error) throw error;

  const { data: fan } = await supabase.from('fans').select('total_spent').eq('id', fan_id).single();
  await supabase
    .from('fans')
    .update({ total_spent: (Number(fan?.total_spent) || 0) + Number(price), status: 'customer' })
    .eq('id', fan_id);
}

async function setFanStatus(fan_id, status) {
  const { error } = await supabase.from('fans').update({ status }).eq('id', fan_id);
  if (error) throw error;
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
  setFanStatus,
};
