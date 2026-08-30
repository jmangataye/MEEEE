const Anthropic = require('@anthropic-ai/sdk');

// `timeout` + `maxRetries` explicites : sans ça, le SDK peut attendre très
// longtemps une réponse bloquée côté Anthropic (constaté en prod le 29/08 —
// des conversations qui "arrêtent de répondre" sans aucune erreur visible
// dans les logs). Comme chaque fan est traité en série (voir fanQueues dans
// server.js), un seul appel qui reste bloqué indéfiniment gèle TOUTE la suite
// de la conversation de ce fan pour toujours. Avec un timeout, l'appel finit
// par échouer proprement — ce qui permet maintenant au failover multi-modèle
// (voir ./index.js) de prendre le relais au lieu de simplement déclencher le
// message de repli.
const anthropic = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY,
  timeout: 25 * 1000,
  maxRetries: 2,
});

const MODEL = 'claude-sonnet-4-5';

const available = !!process.env.ANTHROPIC_API_KEY;

// Interface commune (voir ./index.js pour le contrat exact) : reçoit
// {system, messages, tools, max_tokens} au format "Anthropic" (déjà le
// format natif ici, donc pas de traduction) et retourne
// {text, toolCalls: [{id, name, input}], usage: {input_tokens, output_tokens}, raw}.
async function complete({ system, messages, tools, max_tokens = 1024 }) {
  const response = await anthropic.messages.create({
    model: MODEL,
    max_tokens,
    system,
    tools: tools && tools.length ? tools : undefined,
    messages,
  });

  const textParts = [];
  const toolCalls = [];
  for (const block of response.content) {
    if (block.type === 'text') textParts.push(block.text);
    if (block.type === 'tool_use') toolCalls.push({ id: block.id, name: block.name, input: block.input });
  }

  return {
    provider: 'anthropic',
    model: MODEL,
    text: textParts.join('\n').trim(),
    toolCalls,
    usage: response.usage
      ? { input_tokens: response.usage.input_tokens, output_tokens: response.usage.output_tokens }
      : null,
    raw: response,
  };
}

module.exports = { complete, available, MODEL, name: 'anthropic' };
