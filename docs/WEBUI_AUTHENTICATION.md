# Protection WebUI par Authentification

## 📋 Vue d'ensemble

Le WebUI de Midas est maintenant protégé par un système d'authentification basé sur JWT (JSON Web Tokens). Les utilisateurs doivent s'authentifier avant d'accéder à l'interface web.

## 🔐 Architecture de Sécurité

### Composants

1. **WebUIAuthService** (`src/OAuth/WebUIAuthService.js`)
   - Gère l'authentification username/password
   - Génère et valide les JWT tokens
   - Utilise une comparaison constant-time pour prévenir les timing attacks

2. **AuthClient** (`src/WebUI/auth-client.js`)
   - Client JavaScript côté navigateur
   - Stocke les tokens dans localStorage
   - Rafraîchit automatiquement les tokens expirés
   - Inclut les tokens dans toutes les requêtes API

3. **Page de Login** (`src/WebUI/login.html`)
   - Interface de connexion sécurisée
   - Formulaire username/password
   - Affichage des erreurs

4. **Middleware de Protection** (dans `src/server.js`)
   - Protège tous les fichiers statiques sauf login.html et auth-client.js
   - Vérifie les tokens JWT
   - Redirige vers login si non authentifié

## 🚀 Configuration

### Variables d'environnement (.env)

```env
# Activer/désactiver la sécurité
SECURED_SERVER=true

# Credentials WebUI
WEBUI_USERNAME=admin
WEBUI_PASSWORD=changeme123

# Durée de validité des tokens (en minutes)
OAUTH_ACCESS_TOKEN_DURATION=60
OAUTH_REFRESH_TOKEN_DURATION=10080

# Secret JWT (généré automatiquement)
JWT_SECRET=...
```

⚠️ **IMPORTANT** : Changez le mot de passe par défaut en production !

## 📝 Utilisation

### 1. Démarrer le serveur

```bash
npm start
```

### 2. Accéder au WebUI

1. Ouvrez votre navigateur : `http://localhost:3000`
2. Vous serez redirigé vers `/login.html`
3. Entrez vos identifiants :
   - **Username** : `admin` (ou celui configuré dans .env)
   - **Password** : `changeme123` (ou celui configuré dans .env)
4. Cliquez sur "Se connecter"
5. Vous serez redirigé vers l'application principale

### 3. Se déconnecter

- Cliquez sur le bouton "Se déconnecter" dans le coin supérieur droit de la sidebar
- Vous serez redirigé vers la page de login
- Les tokens seront supprimés du navigateur

## 🔄 Flux d'authentification

```
1. Utilisateur accède à http://localhost:3000
   ↓
2. Middleware détecte l'absence de token
   ↓
3. Redirection vers /login.html
   ↓
4. Utilisateur entre username/password
   ↓
5. POST /webui/login avec credentials
   ↓
6. Serveur valide et retourne access_token + refresh_token
   ↓
7. Tokens stockés dans localStorage
   ↓
8. Redirection vers /index.html
   ↓
9. Toutes les requêtes incluent: Authorization: Bearer <token>
```

## 🛡️ Sécurité

### Fonctionnalités de sécurité

- ✅ **JWT avec expiration** : Access token expire après 60 minutes
- ✅ **Refresh tokens** : Refresh token valide 7 jours
- ✅ **Auto-refresh** : Rafraîchissement automatique 5 min avant expiration
- ✅ **Constant-time comparison** : Protection contre les timing attacks
- ✅ **HTTPS recommandé** : En production, utiliser HTTPS
- ✅ **Rate limiting** : Protection contre brute-force (100 req/15min)

### Recommandations

1. **Changez le mot de passe par défaut** immédiatement
2. **Utilisez HTTPS** en production
3. **Générez un nouveau JWT_SECRET** pour chaque environnement
4. **Stockez les credentials** de manière sécurisée (gestionnaire de secrets)
5. **Activez les logs** pour surveiller les tentatives de connexion

## 🔧 Désactiver l'authentification

Pour désactiver l'authentification (développement uniquement) :

```env
SECURED_SERVER=false
```

⚠️ **NE JAMAIS désactiver en production !**

## 📡 Routes API

### Routes d'authentification

| Méthode | Route | Description |
|---------|-------|-------------|
| POST | `/webui/login` | Connexion avec username/password |
| POST | `/webui/refresh` | Rafraîchir l'access token |
| POST | `/webui/logout` | Déconnexion |

### Exemple : Login

```bash
curl -X POST http://localhost:3000/webui/login \
  -H "Content-Type: application/json" \
  -d '{"username":"admin","password":"changeme123"}'
```

Réponse :
```json
{
  "access_token": "eyJhbGc...",
  "refresh_token": "eyJhbGc...",
  "token_type": "Bearer",
  "expires_in": 3600
}
```

### Exemple : Requête authentifiée

```bash
curl -X GET http://localhost:3000/api/v1/price/BTCUSDT \
  -H "Authorization: Bearer eyJhbGc..."
```

## 🐛 Dépannage

### Problème : "Invalid or expired token"

**Solution** : Le token a expiré. Reconnectez-vous.

### Problème : Redirection infinie vers /login.html

**Solution** : Vérifiez que `auth-client.js` est bien chargé et que les credentials sont corrects.

### Problème : CORS errors

**Solution** : Vérifiez la configuration CORS dans `.env` :
```env
CORS_ORIGIN=http://localhost:3000
```

### Problème : Le serveur ne démarre pas

**Solution** : Vérifiez que `JWT_SECRET` est défini dans `.env`

## 📂 Fichiers créés/modifiés

### Nouveaux fichiers
- `src/OAuth/WebUIAuthService.js` - Service d'authentification
- `src/WebUI/auth-client.js` - Client JavaScript
- `src/WebUI/login.html` - Page de login
- `WEBUI_AUTHENTICATION.md` - Cette documentation

### Fichiers modifiés
- `src/server.js` - Ajout du middleware de protection
- `src/routes.js` - Enregistrement des routes WebUI
- `src/WebUI/index.html` - Ajout du bouton logout
- `src/WebUI/app.js` - Intégration de l'authentification
- `.env` - Ajout des credentials WebUI

## 📚 Ressources

- [JWT.io](https://jwt.io/) - Debugger de tokens JWT
- [OWASP Authentication Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/Authentication_Cheat_Sheet.html)
- [Node.js Security Best Practices](https://nodejs.org/en/docs/guides/security/)

---

**Auteur** : Système d'authentification WebUI Midas
**Version** : 1.0.0
**Date** : 2024-12-19
