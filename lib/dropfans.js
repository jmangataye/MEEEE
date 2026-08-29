/**
 * Intégration Dropfans (plateforme de liens payants "pay-per-link").
 *
 * ÉTAT ACTUEL (le plus fiable, fonctionne dès aujourd'hui) :
 *   Tu crées manuellement chaque contenu sur https://www.dropfans.io/create,
 *   tu récupères le lien payant généré, et tu le colles dans le champ
 *   `dropfans_link` de l'article du catalogue (table catalog_items, ou via
 *   le dashboard admin). L'IA se contente alors d'envoyer ce lien.
 *
 * ÉVOLUTION POSSIBLE (API Dropfans) :
 *   Dropfans a annoncé une API ("The Dropfans API: Sell Drops and Post From
 *   Any Software") permettant de créer des drops par script/IA. La doc
 *   publique détaillée n'était pas accessible au moment de ce build — il
 *   faut demander l'accès à leur support (contact via dropfans.io) pour
 *   obtenir la clé de vault + les endpoints exacts. Une fois obtenus,
 *   complète `createDynamicDrop` ci-dessous : le reste du bot n'a rien à
 *   changer, il appelle juste cette fonction.
 */

const fetch = require('node-fetch');

async function getLinkForItem(catalogItem) {
  if (catalogItem.dropfans_link) {
    return catalogItem.dropfans_link;
  }
  if (process.env.DROPFANS_API_KEY) {
    try {
      return await createDynamicDrop(catalogItem);
    } catch (err) {
      console.error('Dropfans API indisponible, fallback lien manuel manquant:', err.message);
    }
  }
  return null; // Le serveur gérera l'absence de lien (voir server.js)
}

async function createDynamicDrop(catalogItem) {
  // TODO: à compléter avec l'endpoint réel une fois la doc API Dropfans obtenue.
  // Exemple indicatif (à ajuster) :
  // const res = await fetch('https://api.dropfans.io/v1/drops', {
  //   method: 'POST',
  //   headers: {
  //     'Authorization': `Bearer ${process.env.DROPFANS_API_KEY}`,
  //     'Content-Type': 'application/json',
  //   },
  //   body: JSON.stringify({
  //     title: catalogItem.name,
  //     description: catalogItem.description,
  //     price: catalogItem.price,
  //   }),
  // });
  // const data = await res.json();
  // return data.url;
  throw new Error('API Dropfans non configurée — utilise un lien manuel dans le catalogue.');
}

module.exports = { getLinkForItem };
