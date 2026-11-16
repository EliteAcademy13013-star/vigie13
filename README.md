# Vigie 13 — PWA et Worker Cloudflare

## Fonctionnalités de cette branche
- Interface responsive installable (PWA), filtres et accès aux sources institutionnelles.
- Endpoint Cloudflare Worker `/api/rtm-alerts` qui interroge le jeu de données ouvert `ol-perturbation-la-mobilite` de la Métropole Aix-Marseille-Provence.
- Rafraîchissement de l'affichage toutes les 5 minutes.
- Service worker qui ne met pas en cache les réponses de l'API afin d'éviter d'afficher des perturbations périmées.

## Déploiement Cloudflare Workers
Le fichier `wrangler.jsonc` configure un Worker nommé `vigie13`, sert les fichiers statiques depuis la racine et route `/api/*` vers le Worker. Déploiement depuis un environnement disposant de Wrangler :
```sh
npx wrangler deploy
``
Avant le déploiement, vérifier dans Cloudflare que le Worker existant porte bien le nom `vigie13` et que le dépôt est relié au bon environnement. Ne pas déployer sur un Worker différent sans vérifier le domaine public.

## Sources et limites
Le flux intégré concerne les perturbations de mobilité publiées par la Métropole Aix-Marseille-Provence. Il ne représente pas à lui seul toutes les informations RTM, TER/SNCF, circulation routière, météo, aéroport ou préfecture. Les autres rubriques restent des liens vers les sources officielles.
La réponse du flux est normalisée côté Worker et les dates de validité sont prises en compte lorsqu'elles sont présentes. Une indisponibilité de la source est affichée comme telle : aucune fausse alerte n'est générée.

## Notifications
Le bouton de notification demande uniquement l'autorisation du navigateur. Les notifications push à distance ne sont pas encore actives : elles nécessitent la gestion des abonnements Push API et une clé VAPID conservée comme secret Cloudflare. Ne pas annoncer la réception d'alertes push tant que cette infrastructure n'est pas configurée et testée.
Sur iOS/iPadOS 16.4+, la PWA doit être ajoutée à l'écran d'accueil avant de pouvoir recevoir des notifications web push.
