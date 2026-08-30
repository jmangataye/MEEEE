// Couche d'abstraction multi-modèle — MISE À JOUR 30/08/2026.
//
// Avant : lib/claudeAgent.js appelait directement le SDK Anthropic. Si
// Anthropic est en panne, à court de crédit, ou simplement lent, TOUT le bot
// s'arrête de répondre (le fan reçoit alors le message de repli générique,
// voir server.js). C'est arrivé une fois déjà en prod (30/08, épuisement du
// crédit Anthropic).
//
// Ce module ajoute un provider de secours (OpenAI) : si Anthropic échoue,
// et qu'une clé OPENAI_API_KEY est configurée sur Render, on retente
// automatiquement avec OpenAI avant d'abandonner et de déclencher le message
// de repli. Tant qu'OPENAI_API_KEY n'existe pas, ce module se comporte EXACTEMENT
// comme l'appel direct d'avant : Anthropic uniquement, mêmes erreurs
// remontées telles quelles en cas de panne.
//
// Contrat commun (peu importe le provider qui répond au final) :
//   chatComplete({ system, messages, tools, max_tokens })
//   → { provider, model, text, toolCalls: [{id, name, input}], usage: {input_tokens, output_tokens} | null, raw }
//
// `messages` est un tableau de { role: 'user'|'assistant', content: string }
// — déjà compatible tel quel entre Anthropic et OpenAI (pas de blocs de
// contenu structurés utilisés ici), donc aucune traduction n'est nécessaire
// à ce niveau.

const anthropicProvider = require('./anthropicProvider');
const openaiProvider = require('./openaiProvider');

async function chatComplete(opts) {
  try {
    return await anthropicProvider.complete(opts);
  } catch (anthropicErr) {
    if (!openaiProvider.available) {
      // Comportement identique à avant l'abstraction : pas de secours
      // configuré, l'erreur remonte telle quelle (déclenche le message de
      // repli existant côté server.js).
      throw anthropicErr;
    }
    console.error(
      `⚠️ Anthropic a échoué (${anthropicErr.message}) — bascule automatique vers OpenAI (provider de secours).`
    );
    try {
      const result = await openaiProvider.complete(opts);
      // Trace explicite dans les logs Render pour repérer immédiatement
      // qu'une réponse a été servie par le provider de secours plutôt que
      // le modèle habituel — utile pour surveiller la fréquence des pannes
      // Anthropic sans attendre qu'un fan s'en plaigne.
      console.warn(`✅ Réponse servie par le provider de secours OpenAI (modèle ${result.model}).`);
      return result;
    } catch (openaiErr) {
      console.error(`⚠️ Le provider de secours OpenAI a échoué aussi (${openaiErr.message}).`);
      // Les deux providers ont échoué : on relance l'erreur Anthropic
      // d'origine, qui est en général la plus parlante côté diagnostic
      // (c'est le provider principal).
      throw anthropicErr;
    }
  }
}

// Génère un embedding de similarité sémantique — utilisé par lib/embeddings.js
// pour la mémoire vectorielle des fans (voir migration fan_memory_embeddings).
// Anthropic n'a pas d'API d'embeddings publique : cette fonctionnalité
// dépend donc entièrement d'OPENAI_API_KEY. Retourne `null` (jamais une
// erreur) si la clé n'est pas configurée, pour que ce soit un simple no-op
// tant que Bryan n'a pas ajouté la clé sur Render.
async function embed(text) {
  if (!openaiProvider.available) return null;
  return openaiProvider.embed(text);
}

module.exports = {
  chatComplete,
  embed,
  providers: { anthropic: anthropicProvider, openai: openaiProvider },
};
