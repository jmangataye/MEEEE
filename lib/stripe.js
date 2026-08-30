const fetch = require('node-fetch');
const crypto = require('crypto');

// ---------- Intégration Stripe (facturation SaaS multi-créatrices) ----------
// Implémenté en appels HTTP directs (node-fetch, déjà une dépendance) plutôt
// qu'avec le package `stripe` — même logique que lib/aiProviders/openaiProvider.js
// : évite une dépendance supplémentaire pour un besoin simple (créer une session
// de paiement, vérifier une signature de webhook).
//
// IMPORTANT — décision business volontairement PAS prise ici : ce fichier ne
// crée aucun produit/prix Stripe et ne choisit aucun montant. Tant que
// STRIPE_SECRET_KEY / STRIPE_PRICE_ID / STRIPE_WEBHOOK_SECRET ne sont pas
// configurées sur Render (à faire par Bryan depuis son dashboard Stripe, une
// fois la tarification décidée), `available` reste `false` et l'inscription
// self-service continue de fonctionner normalement en mode "essai" (statut
// tenant 'trial'), simplement sans bouton de paiement actif.

const SECRET_KEY = process.env.STRIPE_SECRET_KEY;
const DEFAULT_PRICE_ID = process.env.STRIPE_PRICE_ID;
const WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET;

const available = !!SECRET_KEY;

function toFormBody(obj, prefix = '') {
  const params = [];
  for (const [key, value] of Object.entries(obj)) {
    if (value === undefined || value === null) continue;
    const fullKey = prefix ? `${prefix}[${key}]` : key;
    if (typeof value === 'object' && !Array.isArray(value)) {
      params.push(toFormBody(value, fullKey));
    } else if (Array.isArray(value)) {
      value.forEach((v, i) => {
        if (typeof v === 'object') params.push(toFormBody(v, `${fullKey}[${i}]`));
        else params.push(`${encodeURIComponent(`${fullKey}[${i}]`)}=${encodeURIComponent(v)}`);
      });
    } else {
      params.push(`${encodeURIComponent(fullKey)}=${encodeURIComponent(value)}`);
    }
  }
  return params.join('&');
}

async function stripeRequest(path, body) {
  if (!available) throw new Error('STRIPE_SECRET_KEY non configurée — facturation indisponible.');
  const res = await fetch(`https://api.stripe.com/v1/${path}`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${SECRET_KEY}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: toFormBody(body),
    timeout: 15 * 1000,
  });
  const data = await res.json();
  if (!res.ok) {
    throw new Error(`Erreur Stripe (${res.status}): ${data?.error?.message || JSON.stringify(data)}`);
  }
  return data;
}

// Crée une session Stripe Checkout (abonnement) pour un tenant donné — le
// tenant_id est glissé dans les metadata de la session ET de l'abonnement
// résultant, pour pouvoir relier le paiement au bon compte Meeli côté webhook.
async function createCheckoutSession({ tenantId, customerEmail, priceId, successUrl, cancelUrl }) {
  const price = priceId || DEFAULT_PRICE_ID;
  if (!price) throw new Error('Aucun price Stripe configuré (STRIPE_PRICE_ID).');
  const session = await stripeRequest('checkout/sessions', {
    mode: 'subscription',
    customer_email: customerEmail || undefined,
    line_items: [{ price, quantity: 1 }],
    subscription_data: { metadata: { tenant_id: tenantId } },
    metadata: { tenant_id: tenantId },
    success_url: successUrl,
    cancel_url: cancelUrl,
  });
  return session;
}

// Vérification manuelle de la signature Stripe (HMAC-SHA256 sur
// "timestamp.payload"), suivant exactement l'algorithme documenté par Stripe
// — nécessaire ici puisqu'on n'utilise pas le SDK officiel qui le fait pour nous.
function verifyWebhookSignature(rawBody, signatureHeader, toleranceSeconds = 300) {
  if (!WEBHOOK_SECRET) throw new Error('STRIPE_WEBHOOK_SECRET non configurée.');
  if (!signatureHeader) throw new Error('En-tête Stripe-Signature manquant.');

  const parts = Object.fromEntries(
    signatureHeader.split(',').map((p) => {
      const [k, v] = p.split('=');
      return [k, v];
    })
  );
  const timestamp = parts.t;
  const signature = parts.v1;
  if (!timestamp || !signature) throw new Error('En-tête Stripe-Signature malformé.');

  const payload = `${timestamp}.${rawBody.toString('utf8')}`;
  const expected = crypto.createHmac('sha256', WEBHOOK_SECRET).update(payload).digest('hex');

  const sigBuf = Buffer.from(signature, 'utf8');
  const expBuf = Buffer.from(expected, 'utf8');
  const valid = sigBuf.length === expBuf.length && crypto.timingSafeEqual(sigBuf, expBuf);
  if (!valid) throw new Error('Signature Stripe invalide.');

  const age = Math.abs(Date.now() / 1000 - Number(timestamp));
  if (age > toleranceSeconds) throw new Error('Signature Stripe expirée (horodatage trop ancien).');

  return true;
}

module.exports = { available, createCheckoutSession, verifyWebhookSignature };
