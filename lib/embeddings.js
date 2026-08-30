// Mémoire vectorielle des fans — premier étage (voir migration pgvector +
// fan_memory_embeddings, et lib/supabase.js pour le stockage/la recherche
// brute). Ce module fait le lien entre lib/aiProviders (génération de
// l'embedding) et lib/supabase.js (persistance/recherche), et applique la
// règle de coût qui compte vraiment ici : ne jamais dépenser un appel
// d'embedding pour un fan qui n'a encore aucun souvenir stocké.
//
// Dépend entièrement de OPENAI_API_KEY (Anthropic n'a pas d'API d'embeddings
// publique) — tant que cette clé n'est pas configurée sur Render, toutes les
// fonctions ci-dessous sont des no-op silencieux et le bot se comporte
// exactement comme avant.

const { embed } = require('./aiProviders');
const { storeFanMemoryEmbedding, hasFanMemoryEmbeddings, searchFanMemory } = require('./supabase');

// Appelé quand l'IA met à jour memory_notes via l'outil "remember_about_fan"
// (voir server.js). Best-effort : ne doit jamais interrompre le flux
// principal (la note texte, elle, est déjà enregistrée par ailleurs).
async function rememberFanNoteEmbedding(fan_id, content) {
  if (!content || !content.trim()) return;
  try {
    const vector = await embed(content);
    if (!vector) return; // pas de clé OpenAI configurée — no-op normal.
    await storeFanMemoryEmbedding(fan_id, content, vector);
  } catch (err) {
    console.error('Erreur génération/stockage embedding mémoire fan (non bloquant):', err.message);
  }
}

// Cherche des souvenirs sémantiquement proches du message actuel du fan, à
// injecter dans le prompt système (voir buildSystemPrompt). Retourne toujours
// un tableau (vide si rien de pertinent, si pas de clé OpenAI, ou si ce fan
// n'a encore aucun embedding stocké — ce dernier cas est le chemin le plus
// fréquent au début, d'où la vérification `hasFanMemoryEmbeddings` en amont
// pour éviter de payer un appel d'embedding pour rien à chaque message).
async function recallRelevantMemories(fan_id, queryText, limit = 3) {
  if (!fan_id || !queryText || !queryText.trim()) return [];
  try {
    const hasAny = await hasFanMemoryEmbeddings(fan_id);
    if (!hasAny) return [];
    const queryVector = await embed(queryText);
    if (!queryVector) return [];
    const matches = await searchFanMemory(fan_id, queryVector, limit);
    // Seuil de similarité cosinus minimal — en dessous, le souvenir n'est
    // probablement pas pertinent pour le message actuel et ne ferait
    // qu'ajouter du bruit (et des tokens facturés) au prompt.
    return matches.filter((m) => typeof m.similarity === 'number' && m.similarity >= 0.7);
  } catch (err) {
    console.error('Erreur recherche mémoire vectorielle (non bloquant):', err.message);
    return [];
  }
}

module.exports = { rememberFanNoteEmbedding, recallRelevantMemories };
