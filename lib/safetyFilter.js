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
 *
 * MISE À JOUR 30/08/2026 : l'analyse des 9h30 suivant le déploiement du 29/08
 * a montré que 15 des 16 incidents journalisés étaient des FAUX POSITIFS —
 * l'IA REFUSAIT correctement du contenu hors catalogue ("no tengo videos de
 * penetración... pero tengo baile, twerking...") mais le simple mot-clé
 * "penetra" suffisait à bloquer le message, à le remplacer par un texte
 * générique, ET À METTRE LA CONVERSATION EN PAUSE — un fan qui recevait une
 * réponse parfaitement correcte se retrouvait donc bloqué avec un message
 * creux, souvent pour des heures, sans que personne ne s'en rende compte. Le
 * filtre distingue maintenant "l'IA mentionne X en le refusant/niant" de
 * "l'IA propose/décrit X" en regardant le texte immédiatement AUTOUR de
 * chaque mot-clé trouvé (avant ET après, le refus arrivant parfois après le
 * mot en espagnol — ex: "si buscas algo con penetración... eso no está
 * disponible"). Un cas réel de prix inventé a aussi été trouvé où l'IA ne
 * faisait que reprendre un chiffre que LE FAN venait lui-même de mentionner
 * (litige de prix) — ce n'est pas un prix inventé par l'IA, donc plus flagué
 * non plus (voir `fanText` ci-dessous). Le contrôle réel d'un prix accordé
 * pour une vraie vente reste, lui, inchangé et strict : voir
 * `reviewOfferInput`, qui ne dépend pas du texte libre.
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

// Marqueurs de refus/négation en espagnol. Volontairement large (mieux vaut
// laisser passer un vrai cas limite de temps en temps — le prompt reste la
// première ligne de défense, et une vraie offre/lien passe de toute façon par
// `reviewOfferInput`, indépendant de ce texte libre — que noyer le dashboard
// sous des dizaines de faux positifs par jour comme observé le 29-30/08).
// ATTENTION : pas de \b après un mot accentué ("está") — en JS sans le flag
// /u, \b ne reconnaît que [A-Za-z0-9_] comme "caractère de mot", donc un \b
// juste après un é/á/í/ó/ú/ñ ne matche pas de façon fiable et cassait
// silencieusement la détection sur "no está disponible", très fréquent en
// espagnol. On borne seulement le DÉBUT de chaque alternative.
const REFUSAL_MARKERS =
  /\bno\s+(tengo|hay|est[aá]|puedo|ofrezco|manejo|dispongo|vendo|incluye|cuento|de\b|con\b)|\bnada\s+(de|con)\b|\bsin\b/i;

// Un mot-clé trouvé dans le texte compte-t-il comme "l'IA propose/décrit ça"
// (à flaguer) ou "l'IA dit qu'elle NE L'A PAS / le refuse" (à laisser passer)?
// On regarde une fenêtre de texte autour de CHAQUE occurrence plutôt que le
// message entier, pour ne pas rater une vraie offre plus loin dans un message
// qui contient par ailleurs un refus (et vice-versa) — et dans les deux sens
// (avant ET après le mot-clé) car en espagnol le refus arrive parfois après
// ("si buscas algo con penetración... eso no está disponible").
function hasUnrefusedMatch(text, patterns, window = 60) {
  return patterns.some((base) => {
    const re = new RegExp(base.source, base.flags.includes('g') ? base.flags : base.flags + 'g');
    let m;
    while ((m = re.exec(text))) {
      const start = Math.max(0, m.index - window);
      const end = Math.min(text.length, m.index + m[0].length + window);
      const surrounding = text.slice(start, end);
      if (!REFUSAL_MARKERS.test(surrounding)) return true;
      if (re.lastIndex === m.index) re.lastIndex += 1; // évite une boucle infinie sur un match de longueur 0
    }
    return false;
  });
}

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

function reviewOutgoingText({ text, catalog, settings, fanText }) {
  const reasons = [];
  if (!text) return { ok: true, reasons };

  if (hasUnrefusedMatch(text, EXPLICIT_PATTERNS)) {
    reasons.push('contenido_explicito_no_permitido_en_texto_de_la_ia');
  }
  if (hasUnrefusedMatch(text, PAYMENT_METHOD_PATTERNS)) {
    reasons.push('metodo_de_pago_no_autorizado_mencionado');
  }
  const fanPrices = fanText ? extractMentionedPrices(fanText) : [];
  const badPrices = extractMentionedPrices(text).filter((p) => {
    if (isPriceAllowed(p, catalog, settings)) return false;
    // L'IA ne fait que reprendre un chiffre que LE FAN vient lui-même de
    // mentionner (typiquement un litige : "me cobraron $17") — ce n'est pas
    // un prix inventé par l'IA. Le prix réel d'une vente reste vérifié
    // séparément et strictement par `reviewOfferInput`, qui ignore ce texte.
    if (fanPrices.some((fp) => Math.abs(fp - p) <= 0.01)) return false;
    return true;
  });
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
