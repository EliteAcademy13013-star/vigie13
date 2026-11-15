# Vigie 13 — première version PWA

## Ce qui est inclus
- Interface responsive pour mobile et ordinateur.
- Manifest PWA et service worker (cache de base hors ligne).
- Filtres par catégorie.
- Liens directs vers les sources officielles.
- Demande de permission de notifications navigateur.

## Important : limites de cette version
Les cartes sont des exemples de présentation et ne constituent pas des données en direct. Aucun flux de données officiel n'est encore raccordé. Le bouton notifications demande une permission navigateur mais aucun serveur d'envoi push n'est configuré. Il faut connecter et tester les sources (RTM, TER/SNCF, Bison Futé, Météo-France, préfecture, aéroport) et un backend push avant toute mise en production.

## Hébergement gratuit
Le projet est prévu pour Cloudflare Pages en HTTPS. Importer ce dossier dans un dépôt GitHub, puis créer un projet Pages relié au dépôt avec le répertoire racine `vigie13` (ou placer les fichiers à la racine du dépôt). Aucun domaine personnalisé n'est nécessaire : l'adresse `*.pages.dev` est fournie.

## Notifications iPhone
Sur iOS/iPadOS 16.4+, l'utilisateur doit ajouter la PWA à l'écran d'accueil puis accepter les notifications. Le serveur doit ensuite gérer les abonnements Push API et envoyer les messages. Ne pas confondre l'autorisation locale et la réception effective d'alertes.
