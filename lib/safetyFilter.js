/**
 * Filet de sécurité serveur — dernière ligne de défense avant qu'un texte ou
 * une offre générés par le modèle ne partent vraiment vers un fan.
 *
 * Contexte : le 29/08/2026, une revue des logs de conversation a montré que
 * les règles écrites dans le prompt système (voir claudeAgent.js, section
 * "REGLA ABSOLUTA — SOLO EXISTE LO QUE HAY EN EL CATÁLOGO") ne suffisent pas
 * toujours face à un fan suffisamment insistant : le modèle a continué à
 * décrire du contenu explicite hors catalogue et à inventer des prix
 * contradictoires APRÈS le déploiement de cette règle. Un prompt seul ne peut
 * pas garantir un comportement — il faut une vérification déterministe côté
 * serveur, qui ne dépend pas de ce que le modèle "décide" de respecter.
 *
 * Ce module n'empêche pas le modèle de mal répondre, mais empêche qu'une
 * mauvaise réponse parte réellement au fan : si un texte ou une offre est
 * signalé, server.js envoie un message de repli fixe (pas généré par l'IA),
 * met la conversation en pause automatiquement, et alerte l'admin — voir
 * server.js pour l'intégration complète.
 */

const EXPLICIT_PATTERNS = [
  /penetra/i,
  /garganta\s*profunda/i,
  /me\s*corro/i,
  /me\s*vengo/i,
  /eyacul/i,
  /esperma/i,
  /\bsemen\b/i,
  /follar/i,
  /cogiendo/i,
  /mamada/i,
  /squirt/i,
  /dedos?\s*adentro/i,
  /culo\s*abierto/i,
  /verga\s*dura/i,
  /chupando\s*la\s*verga/i,
];

const PAYMENT_METHOD_PATTERNS = [
  /paypal/i,
  /zelle/i,
  /venmo/i,
  /cash\s*app/i,
  /bitcoin/i,
  /\bcrypto/i,
  /criptomoneda/i,
  /\bnequi\b/i,
  /daviplata/i,
  /western\s*union/i,
  /transferencia\s*bancaria/i,
  /wire\s*transfer/i,
  // OJO: "efectivo" solo (sin "en") también significa "eficaz" en español
  // ("es muy efectivo") — exigir "en efectivo" o "pagar...efectivo" evita
  // falsos positivos sobre frases normales que no hablan de un pago en cash.
  /en\s+efectivo\b/i,
  /pag\w*\s+(en\s+)?efectivo\b/i,
  /contra\s*entrega/i,
];

// Repère tout nombre qui ressemble à un prix mentionné dans le texte (précédé
// d'un symbole monétaire, ou suivi de "usd"/"dólares"/"pesos"/"dollars").
function extractMentionedPrices(text) {
  const found = [];
  const symbolRegex = /[$€]\s?(\d+(?:[.,]\d{1,2})?)/g;
  const wordRegex = /(\d+(?:[.,]\d{1,2})?)\s?(usd|dólares|dolares|pesos|dollars)\b/gi;
  let m;
  while ((m = symbolRegex.exec(text))) found.push(parseFloat(m[1].replace(',', '.')));
  while ((m = wordRegex.exec(text))) found.push(parseFloat(m[1].replace(',', '.')));
  return found;
}

// Un prix est autorisé s'il correspond exactement au prix catalogue d'un
// article (précision non-négociable), ou s'il tombe dans la fourchette de
// négociation permise (précision négociable) d'au moins un article.
function isPriceAllowed(price, catalog, settings) {
  const tolerance = 0.01;
  return (catalog || []).some((item) => {
    const itemPrice = Number(item.price);
    if (!item.is_negotiable) return Math.abs(itemPrice - price) <= tolerance;
    const discountPct = Number(settings?.max_negotiation_discount_pct) || 0;
    const floor = Math.max(Number(settings?.min_custom_price) || 0, itemPrice * (1 - discountPct / 100));
    return price >= floor - tolerance && price <= itemPrice + tolerance;
  });
}

function reviewOutgoingText({ text, catalog, settings }) {
  const reasons = [];
  if (!text) return { ok: true, reasons };

  if (EXPLICIT_PATTERNS.some((p) => p.test(text))) {
    reasons.push('contenido_explicito_no_permitido_en_texto_de_la_ia');
  }
  if (PAYMENT_METHOD_PATTERNS.some((p) => p.test(text))) {
    reasons.push('metodo_de_pago_no_autorizado_mencionado');
  }
  const badPrices = extractMentionedPrices(text).filter((p) => !isPriceAllowed(p, catalog, settings));
  if (badPrices.length) {
    reasons.push(`precio_inventado_o_fuera_de_catalogo: ${badPrices.join(', ')}`);
  }

  return { ok: reasons.length === 0, reasons };
}

function reviewOfferInput({ item, agreedPrice, settings }) {
  const price = Number(agreedPrice);
  if (!Number.isFinite(price)) {
    return { ok: false, reasons: ['precio_invalido_no_numerico'] };
  }
  if (!isPriceAllowed(price, [item], settings)) {
    return {
      ok: false,
      reasons: [
        `precio_fuera_de_rango: acordado=${price} para "${item.name}" (catálogo=${item.price}${
          item.is_negotiable ? ', negociable' : ', precio fijo'
        })`,
      ],
    };
  }
  return { ok: true, reasons: [] };
}

// Messages de repli FIXES (jamais générés par le modèle) envoyés au fan quand
// le filtre bloque une réponse — garantit qu'aucun texte à risque ne peut
// partir même dans ce cas de secours. Deux variantes : une générique (contenu
// explicite / prix inventé), et une pour une demande de moyen de paiement
// alternatif (Yape, Nequi, etc.) — ce n'est pas un incident grave comme les
// deux autres, c'est une piste de vente à vérifier manuellement (voir
// server.js et le circuit de paiement alternatif documenté dans le projet).
const FALLBACK_MESSAGE = 'dame un momentito, ya te ayudo con eso 🙏';
const PAYMENT_ALT_FALLBACK_MESSAGE = 'dale, dejame consultar esa opción con el equipo y te confirmo enseguida 🙏';

// Un incident est-il *seulement* une demande de moyen de paiement alternatif
// (pas de contenu explicite ni de prix inventé en même temps) ? Sert à server.js
// pour choisir le message de repli et le ton de l'alerte admin appropriés.
function isPaymentAlternativeOnly(reasons) {
  return reasons.length > 0 && reasons.every((r) => r.startsWith('metodo_de_pago_no_autorizado_mencionado'));
}

module.exports = {
  reviewOutgoingText,
  reviewOfferInput,
  FALLBACK_MESSAGE,
  PAYMENT_ALT_FALLBACK_MESSAGE,
  isPaymentAlternativeOnly,
};
