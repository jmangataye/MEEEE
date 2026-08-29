# Meeli — Assistante IA de vente (Telegram + Dropfans + Claude)

## Ce que fait ce système

Un fan de ton canal Telegram (20K) clique un lien généré depuis la landing page →
il atterrit dans une conversation Telegram avec ton assistante IA (persona configurable) →
elle discute, cerne ses envies, propose une offre du catalogue → dès qu'un prix est
convenu elle envoie automatiquement le lien de paiement Dropfans → tout est loggé
(fan, conversation, vente) et visible dans le dashboard admin.

**Important, ça a été construit avec cette limite volontaire** : si un fan demande
explicitement si c'est un bot, l'assistante le dit honnêtement (elle ne prétend jamais
être un humain réel). Elle ne produit pas de texte sexuel explicite elle-même — son
rôle est de créer de la complicité et de vendre l'accès au contenu, pas de le décrire.

## Ce qui est déjà fait

- [x] Base de données Supabase (projet existant `ujlqhpwomxkirllqavyw`) : catalogue,
      fans, conversations, ventes, réglages persona, liens traçables.
- [x] Catalogue de départ pré-rempli (à éditer dans le dashboard) : Pack Découverte
      12,99€, Pack Intense 29,99€, Expérience Premium 89€ (négociable), Sur-mesure.
- [x] Backend Node.js complet (webhook Telegram, agent de vente Claude, intégration
      Dropfans, API admin, dashboard, landing page).

## Ce qu'il te reste à faire (dans l'ordre)

### 1. Créer le bot Telegram
- Ouvre Telegram, cherche **@BotFather**, envoie `/newbot`, choisis un nom et un
  username (ex: `LeaAssistanteBot`).
- Il te donne un **token** — garde-le, tu le colleras dans les variables d'environnement.

### 2. Créer ta clé API Anthropic (Claude)
- Va sur https://console.anthropic.com/settings/keys, crée une clé.
- C'est elle qui fait "réfléchir" l'assistante.

### 3. Récupérer la clé Supabase "service_role"
- Dashboard Supabase → ton projet (`ujlqhpwomxkirllqavyw`) → Settings → API →
  copie la clé **service_role** (secrète, ne jamais l'exposer publiquement).

### 4. Créer un dépôt Git avec ce code
Depuis ce dossier (`meeli-bot/`) :
```
git init
git add .
git commit -m "Meeli bot initial"
```
Puis crée un dépôt vide sur GitHub (github.com/new) et pousse :
```
git remote add origin https://github.com/TON_COMPTE/meeli-bot.git
git branch -M main
git push -u origin main
```
*(Je n'ai pas accès à ton compte GitHub depuis cette session — c'est la seule étape
que tu dois faire toi-même. Dis-moi quand c'est fait et donne-moi l'URL du repo :
je peux ensuite déployer directement sur Render pour toi via l'API.)*

### 5. Déployer (je peux le faire pour toi une fois le repo prêt)
Une fois le repo GitHub créé, je lance le déploiement sur ton compte Render déjà
connecté, avec ces variables d'environnement :
- `SUPABASE_URL` = https://ujlqhpwomxkirllqavyw.supabase.co
- `SUPABASE_SERVICE_KEY` = (celle de l'étape 3)
- `TELEGRAM_BOT_TOKEN` = (celle de l'étape 1)
- `TELEGRAM_BOT_USERNAME` = (le username de ton bot, sans @)
- `ANTHROPIC_API_KEY` = (celle de l'étape 2)
- `ADMIN_API_TOKEN` = un token long que tu inventes (protège ton dashboard)
- `PUBLIC_BASE_URL` = l'URL Render (puis ton domaine une fois connecté)

### 6. Activer le webhook Telegram
Une fois déployé, un seul appel (je peux le faire) :
```
POST https://ton-app.onrender.com/api/admin/setup-webhook
Header: X-Admin-Token: <ton ADMIN_API_TOKEN>
```

### 7. Configurer ton persona et ton catalogue
Ouvre `https://ton-app.onrender.com/admin`, colle le token admin (visible aussi
dans Supabase, table `settings`), et personnalise : nom de la créatrice, ton du
persona, message d'accueil, prix, articles.

Ajoute les liens Dropfans de chaque article : crée-les sur
https://www.dropfans.io/create, colle l'URL générée dans le champ correspondant
du catalogue.

### 8. Générer ton lien pour le canal Telegram (20K)
Dans le dashboard admin, section "Générer un lien Telegram traçable" — colle le
lien obtenu dans ton canal. Chaque clic est tracé (source, conversions, revenu).

### 9. Acheter et connecter ton domaine
- Achète le domaine où tu veux (Namecheap, OVH, Google Domains...).
- Sur Render : Dashboard → ton service → Settings → Custom Domain → ajoute ton
  domaine, Render te donne l'enregistrement DNS exact (CNAME/A) à ajouter chez
  ton registrar.
- Une fois propagé (quelques minutes à quelques heures), mets à jour
  `PUBLIC_BASE_URL` avec ton domaine et relance `setup-webhook`.

## Notes importantes

- **OnlyFans** : ce système ne touche jamais OnlyFans directement (ses CGU
  interdisent les bots de messagerie). Le canal de vente automatisé est Telegram
  + Dropfans, comme tu l'as décrit.
- **API Dropfans** : ils ont annoncé une API pour créer des liens par script,
  mais la documentation publique complète n'était pas disponible au moment du
  build (`lib/dropfans.js`). En attendant, le système fonctionne très bien avec
  des liens créés manuellement sur dropfans.io/create et collés dans le
  catalogue — c'est le flux que Dropfans documente eux-mêmes. Contacte leur
  support si tu veux l'automatisation complète, je branche l'API dès que tu as
  les identifiants/doc.
- **Plusieurs créatrices plus tard** : le schéma (table `settings` séparée du
  reste) est pensé pour dupliquer facilement à d'autres créatrices — dis-le moi
  quand tu veux passer à plusieurs comptes.
