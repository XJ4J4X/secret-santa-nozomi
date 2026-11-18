# 🎁 Secret Santa — De Kanezaka jusqu'à Mars

Mini-jeu 3D dans le navigateur (Three.js) : capture 12 points sur deux cartes (Kanezaka puis Mars),
réponds aux questions sur Kiriko, Juno et Overwatch, et repars avec ton diplôme en PDF.

- Le pseudo **Nozomi** débloque le diplôme en édition légendaire.
- Tout tient dans `index.html` (Three.js et jsPDF chargés depuis cdnjs).

## Multijoueur
Tous les joueurs qui ouvrent le site arrivent dans le même salon (`noel`).
Pour un salon privé : ajoute `?salle=monsalon` à l'adresse.
Le serveur (`server.js`) est un relais WebSocket sans dépendance.

## Déploiement Render
`render.yaml` (Blueprint) crée deux services : le site statique et le serveur multijoueur `secret-santa-nozomi-ws` (offre gratuite, il s'endort après 15 min sans joueur et met ~1 min à se réveiller).

## Personnaliser
En haut du script dans `index.html` : `SPECIAL_NAME` et `SPECIAL_MESSAGE`.
