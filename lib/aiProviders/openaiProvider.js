const fetch = require('node-fetch');

// Provider de secours (voir ./index.js) — utilisé UNIQUEMENT si Anthropic
// échoue (crédit épuisé, panne, timeout) ET si OPENAI_API_KEY est configurée
// sur Render. Tant que cette variable d'environnement n'existe pas,
// `available` reste `false` et ce fichier ne fait strictement rien : aucun
// appel réseau, aucun changement de comportement pour le bot actuel.
//
// Implémenté avec `node-fetch` (déjà une dépendance du projet) plutôt qu'en
// ajoutant le package `openai` — un appel HTTP direct suffit pour les deux
// besoins ici (complétion de chat + embeddings) et évite une dépendance
// supplémentaire à maintenir.

const API_KEY = process.env.OPENAI_API_KEY;
const CHAT_MODEL = 'gpt-4o';
const EMBEDDING_MODEL = 'text-embedding-3-small';
const EMBEDDING_DIMENSIONS = 1536;

const available = !!API_KEY;

// Traduit un outil au format Anthropic ({name, description, input_schema})
// vers le format "function calling" d'OpenAI.
function toOpenAiTool(tool) {
  return {
    type: 'function',
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.input_schema,
    },
  };
}

async function complete({ system, messages, tools, max_tokens = 1024 }) {
  if (!available) throw new Error('OPENAI_API_KEY non configurée — provider OpenAI indisponible.');

  const body = {
    model: CHAT_MODEL,
    max_tokens,
    messages: system ? [{ role: 'system', content: system }, ...messages] : messages,
  };
  if (tools && tools.length) body.tools = tools.map(toOpenAiTool);

  const res = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${API_KEY}` },
    body: JSON.stringify(body),
    timeout: 25 * 1000,
  });

  const data = await res.json();
  if (!res.ok) {
    throw new Error(`Erreur OpenAI (${res.status}): ${data?.error?.message || JSON.stringify(data)}`);
  }

  const choice = data.choices && data.choices[0];
  const message = choice ? choice.message : {};
  const toolCalls = (message.tool_calls || []).map((tc) => {
    let input = {};
    try {
      input = JSON.parse(tc.function.arguments || '{}');
    } catch (err) {
      console.error('Erreur parsing arguments tool_call OpenAI:', err.message);
    }
    return { id: tc.id, name: tc.function.name, input };
  });

  return {
    provider: 'openai',
    model: CHAT_MODEL,
    text: (message.content || '').trim(),
    toolCalls,
    usage: data.usage
      ? { input_tokens: data.usage.prompt_tokens, output_tokens: data.usage.completion_tokens }
      : null,
    raw: data,
  };
}

// Génère un embedding (vecteur de similarité sémantique) pour un texte donné
// — utilisé par lib/embeddings.js pour la mémoire vectorielle des fans.
// Retourne `null` (plutôt que de lancer une erreur) si le provider n'est pas
// disponible, pour que les appelants puissent traiter l'absence d'embeddings
// comme un cas normal (fonctionnalité simplement inactive) et non une panne.
async function embed(text) {
  if (!available || !text || !text.trim()) return null;

  const res = await fetch('https://api.openai.com/v1/embeddings', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${API_KEY}` },
    body: JSON.stringify({ model: EMBEDDING_MODEL, input: text.slice(0, 8000) }),
    timeout: 15 * 1000,
  });

  const data = await res.json();
  if (!res.ok) {
    throw new Error(`Erreur embedding OpenAI (${res.status}): ${data?.error?.message || JSON.stringify(data)}`);
  }
  return (data.data && data.data[0] && data.data[0].embedding) || null;
}

module.exports = { complete, embed, available, name: 'openai', CHAT_MODEL, EMBEDDING_MODEL, EMBEDDING_DIMENSIONS };
