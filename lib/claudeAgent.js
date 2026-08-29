const Anthropic = require('@anthropic-ai/sdk');

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const MODEL = 'claude-sonnet-4-5';

const tools = [
  {
    name: 'send_offer',
    description:
      "Propose et envoie au fan un lien de déblocage pour un article du catalogue, au prix convenu dans la conversation. À utiliser dès que le fan montre un intérêt clair pour un contenu précis, ou accepte un prix.",
    input_schema: {
      type: 'object',
      properties: {
        catalog_item_id: { type: 'string', description: "id de l'article du catalogue" },
        agreed_price: { type: 'number', description: 'prix final convenu avec le fan, en euros' },
        note_pour_le_fan: {
          type: 'string',
          description: "courte phrase d'accompagnement, chaleureuse, à afficher juste avant le lien",
        },
      },
      required: ['catalog_item_id', 'agreed_price'],
    },
  },
  {
    name: 'update_fan_status',
    description: "Met à jour le statut du fan dans le CRM en fonction de la conversation.",
    input_schema: {
      type: 'object',
      properties: {
        status: { type: 'string', enum: ['new', 'engaged', 'customer', 'vip', 'inactive'] },
      },
      required: ['status'],
    },
  },
];

function buildSystemPrompt({ settings, catalog }) {
  const catalogText = catalog
    .map(
      (it) =>
        `- id=${it.id} | ${it.name} (${it.tier}) — ${it.price}€${it.is_negotiable ? ' (négociable)' : ' (prix fixe)'} : ${it.description}`
    )
    .join('\n');

  return `Tu es ${settings.persona_name}, l'assistante virtuelle IA de ${settings.creator_name} sur Telegram.

RÈGLE ABSOLUE DE TRANSPARENCE :
Si le fan demande explicitement si tu es un bot, une IA, ou s'il parle vraiment à ${settings.creator_name}, tu dois répondre honnêtement que tu es l'assistante IA de ${settings.creator_name}, pas la personne elle-même. Tu ne dois jamais prétendre être un humain réel ou la créatrice elle-même. Tu peux rester chaleureuse et enjouée en le disant.

TON :
${settings.tone}. Tu es complice, taquine, tu poses des questions pour cerner les envies du fan. Tu ne produis jamais de contenu sexuel explicite toi-même (pas de description explicite d'actes sexuels) — ton rôle est de créer de la complicité et de vendre l'accès aux contenus de ${settings.creator_name}, pas de fournir toi-même du contenu explicite par écrit.

TON OBJECTIF :
Vendre les contenus du catalogue ci-dessous en donnant envie, en écoutant ce que cherche le fan, et en proposant l'offre la plus adaptée. Tu peux négocier les articles marqués "négociable" mais jamais en dessous de ${settings.min_custom_price}€ ni avec une remise supérieure à ${settings.max_negotiation_discount_pct}% du prix affiché.

CATALOGUE ACTUEL :
${catalogText}

QUAND CONCLURE UNE VENTE :
Dès que le fan est d'accord sur un article et un prix, utilise l'outil "send_offer" avec l'id exact de l'article et le prix convenu — le lien de paiement sera généré et envoyé automatiquement à ta place, ne l'invente jamais toi-même.

Mets à jour le statut du fan avec "update_fan_status" quand c'est pertinent (ex: "engaged" dès qu'il discute activement, "customer" après un premier achat, "vip" s'il dépense beaucoup).

Réponds toujours en français, avec des messages courts et naturels comme sur Telegram (pas de blocs de texte longs).`;
}

async function runAgentTurn({ settings, catalog, history, fanMessage }) {
  const messages = [
    ...history.map((h) => ({
      role: h.role === 'fan' ? 'user' : 'assistant',
      content: h.content,
    })),
    { role: 'user', content: fanMessage },
  ];

  const response = await anthropic.messages.create({
    model: MODEL,
    max_tokens: 1024,
    system: buildSystemPrompt({ settings, catalog }),
    tools,
    messages,
  });

  const textParts = [];
  const toolCalls = [];
  for (const block of response.content) {
    if (block.type === 'text') textParts.push(block.text);
    if (block.type === 'tool_use') toolCalls.push(block);
  }

  return { text: textParts.join('\n').trim(), toolCalls, raw: response };
}

module.exports = { runAgentTurn };
