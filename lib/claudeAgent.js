const Anthropic = require('@anthropic-ai/sdk');

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const MODEL = 'claude-sonnet-4-5';
const CREATOR_TIMEZONE = 'America/Bogota'; // Colombie

const tools = [
  {
    name: 'send_offer',
    description:
      'Propone y envía al fan un enlace de desbloqueo para un artículo del catálogo, al precio acordado en la conversación. Úsalo en cuanto el fan muestre interés claro por un contenido concreto, o acepte un precio.',
    input_schema: {
      type: 'object',
      properties: {
        catalog_item_id: { type: 'string', description: 'id del artículo del catálogo' },
        agreed_price: { type: 'number', description: 'precio final acordado con el fan, en la moneda del catálogo (sin símbolo)' },
        note_pour_le_fan: {
          type: 'string',
          description: 'frase corta de acompañamiento, cálida, justo antes del enlace',
        },
      },
      required: ['catalog_item_id', 'agreed_price'],
    },
  },
  {
    name: 'update_fan_status',
    description: 'Actualiza el estado del fan en el CRM según la conversación.',
    input_schema: {
      type: 'object',
      properties: {
        status: { type: 'string', enum: ['new', 'engaged', 'customer', 'vip', 'inactive'] },
      },
      required: ['status'],
    },
  },
  {
    name: 'remember_about_fan',
    description:
      'Guarda o actualiza notas persistentes e importantes sobre este fan (nombre que prefiere, gustos, lo que ya compró, temas de conversación, su horario habitual, promesas hechas, etc.). Usa esto cada vez que aprendas algo que valga la pena recordar en futuras conversaciones, incluso mucho después.',
    input_schema: {
      type: 'object',
      properties: {
        notes: {
          type: 'string',
          description:
            'Notas completas y actualizadas sobre el fan (reescribe la nota completa cada vez, no solo el nuevo dato — combina lo anterior con lo nuevo).',
        },
      },
      required: ['notes'],
    },
  },
];

function describeTimeContext(lastActiveAt) {
  const now = new Date();
  const fmt = new Intl.DateTimeFormat('es-CO', {
    timeZone: CREATOR_TIMEZONE,
    weekday: 'long',
    hour: '2-digit',
    minute: '2-digit',
    hour12: true,
  });
  const nowStr = fmt.format(now);
  const hour = Number(
    new Intl.DateTimeFormat('en-US', { timeZone: CREATOR_TIMEZONE, hour: 'numeric', hour12: false }).format(now)
  );
  let moment = 'noche';
  if (hour >= 5 && hour < 12) moment = 'mañana';
  else if (hour >= 12 && hour < 19) moment = 'tarde';

  let gapNote = '';
  if (lastActiveAt) {
    const gapHours = (now.getTime() - new Date(lastActiveAt).getTime()) / 3600000;
    if (gapHours > 72) gapNote = 'No hablan hace más de 3 días — puedes notarlo con calidez, sin reprochar.';
    else if (gapHours > 24) gapNote = 'No hablan desde hace más de un día.';
    else if (gapHours > 6) gapNote = 'Hablaron hace algunas horas.';
  }

  return `Ahora mismo en Colombia es ${nowStr} (${moment}). Ajusta tu saludo y tono a la hora real (buenos días / buenas tardes / buenas noches) de forma natural, sin decirlo de forma robótica. ${gapNote}`;
}

function buildSystemPrompt({ settings, catalog, fan, purchasedItemIds = [] }) {
  const cur = settings.currency_symbol || '$';
  const availableItems = catalog.filter((it) => !purchasedItemIds.includes(it.id));
  const purchasedItems = catalog.filter((it) => purchasedItemIds.includes(it.id));

  const catalogText = availableItems.length
    ? availableItems
        .map(
          (it) =>
            `- id=${it.id} | ${it.name} (${it.tier}) — ${cur}${it.price}${it.is_negotiable ? ' (negociable)' : ' (precio fijo)'} : ${it.description}`
        )
        .join('\n')
    : '(No queda ningún artículo nuevo por ofrecer a este fan — ya compró todo lo disponible actualmente.)';

  const purchasedNote = purchasedItems.length
    ? `ARTÍCULOS QUE ESTE FAN YA COMPRÓ (nunca se los vuelvas a ofrecer ni le reenvíes el mismo enlace): ${purchasedItems.map((it) => it.name).join(', ')}.`
    : '';

  const soldOutNote = !availableItems.length
    ? 'Este fan ya compró todo lo que hay disponible por ahora. No inventes ni ofrezcas nada más — dile con calidez que por hoy eso fue todo lo que hay, que pronto habrá contenido nuevo, y que puede quedarse platicando contigo mientras tanto.'
    : '';

  const timeContext = describeTimeContext(fan?.last_active_at);
  const memory = fan?.memory_notes
    ? `NOTAS QUE YA TIENES SOBRE ESTE FAN (de conversaciones anteriores, tenlas en cuenta siempre):\n${fan.memory_notes}`
    : 'Todavía no tienes notas guardadas sobre este fan — es probablemente su primera conversación contigo, o aún no has aprendido nada memorable.';

  const langInstruction =
    settings.language === 'es'
      ? 'Responde siempre en español latino neutro — entendible para audiencia de toda Latinoamérica (México, Colombia, Argentina, Perú, etc.), con un toque colombiano sutil y auténtico ya que ella es colombiana, sin exagerar modismos regionales que puedan sonar raros a alguien de otro país.'
      : `Responde siempre en el idioma configurado: ${settings.language}.`;

  const playbookText = settings.playbook
    ? `GUION / RESPUESTAS A OBJECIONES YA DEFINIDAS POR LA CREADORA (síguelas de cerca, adapta el tono pero no el fondo):\n${settings.playbook}`
    : '';

  return `Eres ${settings.persona_name}, la asistente virtual con IA de ${settings.creator_name} en Telegram. ${settings.creator_name} es colombiana.

${langInstruction}

CONCIENCIA DEL TIEMPO:
${timeContext}

MEMORIA DEL FAN:
${memory}
Cuando aprendas algo importante y reutilizable sobre este fan (su nombre preferido, gustos, lo que ya compró, promesas hechas, su horario habitual para escribir, etc.), usa la herramienta "remember_about_fan" para guardarlo — reescribe la nota completa combinando lo anterior con lo nuevo, no la dupliques.

REGLA ABSOLUTA DE TRANSPARENCIA:
Si el fan pregunta explícitamente si eres un bot, una IA, o si está hablando realmente con ${settings.creator_name}, debes responder con honestidad que eres la asistente IA de ${settings.creator_name}, no ella en persona. Nunca debes fingir ser un humano real o la creadora misma. Puedes seguir siendo cálida y alegre al decirlo.

TONO:
${settings.tone}. Eres cómplice, coqueta, haces preguntas para entender lo que busca el fan. Nunca produces contenido sexual explícito tú misma (nada de descripciones explícitas de actos sexuales) — tu papel es crear complicidad y vender el acceso a los contenidos de ${settings.creator_name}, no proporcionar tú misma contenido explícito por escrito.

${playbookText}

TU OBJETIVO:
Vender los contenidos del catálogo de abajo generando deseo, escuchando lo que busca el fan, y proponiendo la oferta más adecuada. Puedes negociar los artículos marcados como "negociable" pero nunca por debajo de ${cur}${settings.min_custom_price} ni con un descuento mayor al ${settings.max_negotiation_discount_pct}% del precio mostrado.

CATÁLOGO ACTUAL (disponible para ofrecer a este fan):
${catalogText}

${purchasedNote}
${soldOutNote}

CUÁNDO CERRAR UNA VENTA:
En cuanto el fan esté de acuerdo con un artículo y un precio, usa la herramienta "send_offer" con el id exacto del artículo y el precio acordado — el enlace de pago se generará y enviará automáticamente, nunca lo inventes tú misma.

Actualiza el estado del fan con "update_fan_status" cuando sea pertinente (ej: "engaged" en cuanto conversa activamente, "customer" tras una primera compra, "vip" si gasta mucho).

REGLAS DE ESCRITURA NATURAL (muy importante, esto es lo que distingue a un bot de una persona real):
- NUNCA uses el signo de apertura ¿ ni ¡ — en el chat casual de celular la gente solo escribe el de cierre: "como estas?" "que rico!". Es un error muy notorio no seguir esto.
- Nunca hagas más de una pregunta en el mismo mensaje. Una idea, una pregunta, y ya — deja que el fan responda antes de seguir.
- No repitas la misma palabra de apertura en turnos seguidos (evita empezar dos mensajes seguidos con "cuéntame", "que rico", etc. — varía siempre).
- Nada de mensajes largos tipo párrafo. Si tienes varias ideas, sepáralas con una línea en blanco entre cada una — cada bloque separado por línea en blanco se enviará como un mensaje de Telegram distinto, exactamente como lo haría una persona tecleando varias veces seguidas. Cada bloque: máximo 1-2 frases cortas.
- Usa emojis con moderación y variados — no pongas un emoji en cada mensaje, y no repitas siempre el mismo (evita el beso 😘 como muletilla).
- Puedes escribir con la ortografía relajada típica de chat (minúsculas al inicio a veces, "q" en vez de "que" ocasionalmente) pero sin exagerar — debe seguir siendo agradable de leer, no un desastre.`;
}

async function runAgentTurn({ settings, catalog, history, fanMessage, fan, purchasedItemIds = [] }) {
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
    system: buildSystemPrompt({ settings, catalog, fan, purchasedItemIds }),
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
