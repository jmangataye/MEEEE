// Petites primitives statistiques pour le bandit multi-bras (Thompson
// sampling) utilisé par le système de variantes de script (voir
// lib/supabase.js — pickVariantForField). Aucune dépendance externe : tout
// est calculé à la main pour rester léger et sans nouveau package npm.
//
// Principe du Thompson sampling appliqué ici : chaque variante a un taux de
// conversion inconnu, modélisé par une loi Beta(conversions+1, échecs+1)
// (prior uniforme Beta(1,1) = aucune connaissance a priori). À chaque
// sélection, on tire un échantillon aléatoire de la loi Beta de CHAQUE
// variante active, et on choisit celle dont l'échantillon est le plus élevé.
// Ça explore naturellement les variantes peu testées (leur loi Beta est
// large, donc l'échantillon peut être élevé par chance) tout en convergeant
// progressivement vers la variante qui convertit vraiment le mieux — sans
// jamais figer un choix de façon définitive comme le faisait l'ancien
// tirage à pile ou face 50/50.

function gaussianRandom() {
  // Transformation de Box-Muller.
  let u = 0;
  let v = 0;
  while (u === 0) u = Math.random();
  while (v === 0) v = Math.random();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

// Échantillonnage d'une loi Gamma(shape, scale=1) — méthode de Marsaglia et
// Tsang (2000), standard pour ce cas (shape >= 1, boosté sinon).
function sampleGamma(shape) {
  if (shape < 1) {
    const u = Math.random();
    return sampleGamma(1 + shape) * Math.pow(u, 1 / shape);
  }
  const d = shape - 1 / 3;
  const c = 1 / Math.sqrt(9 * d);
  for (let i = 0; i < 100; i++) {
    let x;
    let v;
    do {
      x = gaussianRandom();
      v = 1 + c * x;
    } while (v <= 0);
    v = v * v * v;
    const u = Math.random();
    if (u < 1 - 0.0331 * x * x * x * x) return d * v;
    if (Math.log(u) < 0.5 * x * x + d * (1 - v + Math.log(v))) return d * v;
  }
  // Ne devrait presque jamais arriver (boucle conçue pour converger très
  // vite) — filet de sécurité pour ne jamais rester bloqué indéfiniment.
  return d;
}

function sampleBeta(alpha, beta) {
  const x = sampleGamma(alpha);
  const y = sampleGamma(beta);
  if (x + y === 0) return 0.5;
  return x / (x + y);
}

// stats: [{ id, exposures, conversions }, ...] (variantes actives uniquement)
// Retourne l'id de la variante choisie pour ce tour.
// Règle de démarrage à froid : toute variante jamais exposée est choisie en
// priorité (une seule fois chacune) avant même de faire tourner le tirage
// Thompson — sinon une variante toute neuve pourrait rester ignorée très
// longtemps si les autres ont déjà un bon score.
function pickBanditVariant(stats) {
  if (!stats || !stats.length) return null;
  const neverExposed = stats.find((s) => Number(s.exposures) === 0);
  if (neverExposed) return neverExposed.id;

  let best = null;
  let bestScore = -1;
  for (const s of stats) {
    const conversions = Number(s.conversions) || 0;
    const exposures = Number(s.exposures) || 0;
    const failures = Math.max(0, exposures - conversions);
    const score = sampleBeta(conversions + 1, failures + 1);
    if (score > bestScore) {
      bestScore = score;
      best = s.id;
    }
  }
  return best;
}

module.exports = { gaussianRandom, sampleGamma, sampleBeta, pickBanditVariant };
