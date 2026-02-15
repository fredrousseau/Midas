# MIDAS - Documentation Technique Complète

**Plateforme d'Analyse Multi-Timeframe pour le Trading**

**Version:** 2.0
**Date:** 2026-01-16
**Status:** Production Ready

---

## Table des Matières

1. [Vue d'Ensemble](#1-vue-densemble)
2. [Architecture](#2-architecture)
3. [Services Principaux](#3-services-principaux)
4. [Détection de Régime](#4-détection-de-régime)
5. [Système de Recommandations](#5-système-de-recommandations)
6. [API REST](#6-api-rest)
7. [Authentification](#7-authentification)
8. [Configuration](#8-configuration)
9. [Développement](#9-développement)

---

## 1. Vue d'Ensemble

Midas est une plateforme d'analyse technique sophistiquée qui transforme des données de marché brutes en décisions de trading actionnables via une architecture hiérarchique en 5 couches.

### Caractéristiques Principales

- **Analyse Multi-Timeframe Pondérée** - Les timeframes supérieurs dominent naturellement
- **Détection de Régimes de Marché** - 9 régimes distincts (trending/ranging/breakout × bull/bear/neutral)
- **Recommandations Automatiques** - TRADE / PREPARE / CAUTION / WAIT avec confiance
- **Détection de Conflits 3-Niveaux** - High / Moderate / Low severity
- **Contexte Trading Actionnable** - Scénarios, entries, stops, targets, risk/reward
- **Support Analyse Historique** - Visualisation historique avec `referenceDate`

### Technologies

- **Node.js v20.x** (requis, vérifié au démarrage)
- **Express.js** (REST API)
- **Binance API** (source de données)
- **Redis** (cache optionnel mais recommandé)
- **OAuth 2.0 + JWT** (authentification)

---

## 2. Architecture

### Architecture en 5 Couches

```
┌─────────────────────────────────────────────────────────────────┐
│                     NIVEAU 1: INFRASTRUCTURE                     │
│                  (Données Brutes & Connectivité)                 │
├─────────────────────────────────────────────────────────────────┤
│  BinanceAdapter → DataProvider (Redis Cache)                    │
│  • OHLCV data • Price feeds • Volume data • Gap detection       │
└─────────────────────────────────────────────────────────────────┘
                              ↓
┌─────────────────────────────────────────────────────────────────┐
│                    NIVEAU 2: CALCUL TECHNIQUE                    │
│                  (Indicateurs & Métriques Pures)                 │
├─────────────────────────────────────────────────────────────────┤
│  IndicatorService                                                │
│  • RSI, MACD, EMA, SMA, ATR, ADX, Bollinger Bands              │
│  • Stochastic, OBV, Parabolic SAR, Ichimoku                     │
│  • 40+ indicateurs techniques                                    │
└─────────────────────────────────────────────────────────────────┘
                              ↓
┌─────────────────────────────────────────────────────────────────┐
│                   NIVEAU 3: ANALYSE CONTEXTUELLE                 │
│               (Enrichissement & Interprétation)                  │
├─────────────────────────────────────────────────────────────────┤
│  RegimeDetectionService                                          │
│  • ADX + ER + ATR → Régime de marché                            │
│  • 9 régimes: trending/ranging/breakout × bull/bear/neutral     │
│                                                                  │
│  StatisticalContextService (6 Enrichers)                        │
│  • MovingAverages, Momentum, Volatility                         │
│  • Volume, PriceAction, Patterns                                │
└─────────────────────────────────────────────────────────────────┘
                              ↓
┌─────────────────────────────────────────────────────────────────┐
│                  NIVEAU 4: DÉCISION & STRATÉGIE                  │
│              (Recommandations Actionnables)                      │
├─────────────────────────────────────────────────────────────────┤
│  MarketAnalysisService (Orchestrateur)                          │
│  • Génère statistical_context                                    │
│  • Calcule alignment_score (0-1)                                │
│  • Génère recommandations automatiques                          │
│                                                                  │
│  TradingContextService                                           │
│  • Market phase, Scenario analysis, Entry strategies            │
│  • Risk assessment, Trade quality scoring                       │
└─────────────────────────────────────────────────────────────────┘
                              ↓
┌─────────────────────────────────────────────────────────────────┐
│                    NIVEAU 5: EXPOSITION API                      │
├─────────────────────────────────────────────────────────────────┤
│  REST API Endpoints + WebUI + MCP Tools                         │
└─────────────────────────────────────────────────────────────────┘
```

### Structure des Fichiers

```
src/
├── DataProvider/          # Market data + Redis cache
│   ├── BinanceAdapter.js
│   ├── DataProvider.js
│   └── CacheManager.js
├── Trading/
│   ├── Indicator/         # 40+ technical indicators
│   ├── MarketData/        # OHLCV data service
│   ├── MarketAnalysis/    # Core analysis engine
│   │   ├── config/        # Configurable parameters
│   │   ├── StatisticalContext/  # 6 Enrichers
│   │   ├── RegimeDetection/
│   │   └── TradingContext/
├── OAuth/                 # Authentication
├── Mcp/                   # Model Context Protocol
├── WebUI/                 # Web interface
├── routes.js              # API endpoints
└── server.js              # Entry point
```

---

## 3. Services Principaux

### MarketAnalysisService (Orchestrateur)

Point d'entrée principal qui coordonne tous les sous-services.

**Responsabilités:**
- Coordonne StatisticalContextService, RegimeDetectionService, TradingContextService
- Génère recommandations automatiques basées sur alignment
- Évalue qualité globale de l'analyse

**Méthodes Principales:**
```javascript
// Analyse complète multi-timeframe
async generateMarketAnalysis({ symbol, timeframes, count, referenceDate })

// Analyse complète avec trading context
async generateCompleteAnalysis({ symbol, timeframes, count, referenceDate })
```

### StatisticalContextService

Génère le contexte statistique enrichi avec analyse multi-timeframe.

**Context Depth Strategy:**

| Timeframe | Level | Enrichers | Purpose |
|-----------|-------|-----------|---------|
| 1D/1W/1M | LIGHT | MA + ADX + Basic Price Action | Macro direction |
| 4H | MEDIUM | + Momentum + Volatility + Volume + S/R | Structure & phase |
| <4H | FULL | + Micro Patterns | Precise timing |

**Enrichers:**
- `MovingAveragesEnricher`: EMA12/26/50/200, alignments, crossovers
- `MomentumEnricher`: RSI, MACD, Stochastic, divergences
- `VolatilityEnricher`: ATR, Bollinger Bands, squeeze detection
- `VolumeEnricher`: OBV, volume spikes, accumulation/distribution
- `PriceActionEnricher`: Swing points, candle patterns, structure
- `PatternDetector`: Chart patterns (flags, triangles, wedges)

### TradingContextService

Génère le contexte trading actionnable.

**Responsabilités:**
- Market phase detection (strong trend, consolidation, breakout)
- Scenario analysis (bullish/bearish/neutral probabilities)
- Entry strategies (breakout + retest)
- Risk assessment et Trade quality scoring

**Trade Quality Components:**

| Component | Weight |
|-----------|--------|
| Trend Alignment | 30% |
| Momentum | 20% |
| Volume | 15% |
| Pattern | 20% |
| Risk/Reward | 15% |

---

## 4. Détection de Régime

### RegimeDetectionService

Détecte automatiquement le régime de marché en combinant plusieurs indicateurs.

### Indicateurs Utilisés

| Indicateur | Période | Usage |
|------------|---------|-------|
| ADX | 14 | Force de tendance |
| Efficiency Ratio | 10 | Efficacité du mouvement |
| ATR Short/Long | 14/50 | Volatilité |
| EMA Short/Long | 20/50 | Direction |
| +DI / -DI | 14 | Confirmation directionnelle |

### Les 9 Régimes

**Tendances (ADX ≥ 25, ER ≥ 0.5):**
- `trending_bullish` - Tendance haussière confirmée
- `trending_bearish` - Tendance baissière confirmée

**Breakouts (ATR ratio > 1.3, ADX ≥ 25):**
- `breakout_bullish` - Breakout haussier
- `breakout_bearish` - Breakout baissier
- `breakout_neutral` - Breakout sans direction claire

**Ranges (ADX < 25 ou ER < 0.5):**
- `range_low_vol` - Range basse volatilité
- `range_high_vol` - Range haute volatilité
- `range_normal` - Range volatilité normale

### Calcul de Confiance

```javascript
confidence = 0.35 × regimeClarityScore    // Clarté du régime (ADX)
           + 0.30 × coherenceScore        // Cohérence indicateurs
           + 0.20 × directionScore        // Force directionnelle
           + 0.15 × erScore               // Efficiency Ratio
```

### Processus de Détection

1. **Chargement OHLCV** via DataProvider
2. **Calcul parallèle** des 6 indicateurs
3. **Détection direction** via structure EMA + filtre ±DI
4. **Classification régime** (priorité: Breakout → Trending → Range)
5. **Calcul confiance** multi-composants

---

## 5. Système de Recommandations

### Pondération Multi-Timeframe

```javascript
weights = {
  '1m': 0.3,   '5m': 0.5,   '15m': 0.8,
  '30m': 1.0,  '1h': 1.5,   '4h': 2.0,
  '1d': 3.0,   '1w': 2.5
}
```

**Principe:** Les timeframes supérieurs sont plus significatifs (moins de bruit).

### Calcul Alignment Score

```javascript
// Pour chaque signal
weighted_score[i] = timeframe_weight[i] × regime_confidence[i]

// Scores totaux
bullishScore = Σ(weighted_score) for bullish signals
bearishScore = Σ(weighted_score) for bearish signals
totalWeight = Σ(timeframe_weight × regime_confidence)

// Alignment score (0-1)
alignment_score = max(bullishScore, bearishScore) / totalWeight
```

### Arbre de Décision

| Condition | Action | Confiance |
|-----------|--------|-----------|
| High severity conflicts | WAIT | 0.30 |
| alignment ≥ 0.8, no conflicts | TRADE_BULLISH/BEARISH | alignment_score |
| alignment ≥ 0.7, no moderate conflicts | PREPARE_BULLISH/BEARISH | × 0.9 |
| alignment ≥ 0.6 | CAUTION | × 0.8 |
| alignment < 0.6 | WAIT | 0.40 |

### Détection de Conflits

**High Severity:**
- HTF majeurs opposés (ex: 1D bull vs 4H bear)
- Weight ≥ 2.0 des deux côtés
- Impact: WAIT recommandé

**Moderate Severity:**
- 2+ timeframes bull vs 2+ bear
- Impact: Réduit confiance

**Low Severity:**
- Divergence HTF/LTF normale
- Impact: Signal potentiel retournement

---

## 6. API REST

### Détection de Régime

```http
GET /api/v1/regime?symbol=BTCUSDT&timeframe=1h&count=200
```

**Response:**
```json
{
  "regime": "trending_bullish",
  "confidence": 0.87,
  "components": {
    "adx": 35.2,
    "efficiency_ratio": 0.68,
    "atr_ratio": 1.15,
    "direction": { "trend": "bullish", "diPlus": 28.5, "diMinus": 15.3 }
  }
}
```

### Analyse Multi-Timeframe

```http
GET /api/v1/context/enriched?symbol=BTCUSDT&timeframes=1d,4h,1h&count=200
```

**Response:** Analyse complète avec statistical_context, regimes par timeframe, alignment_score, recommandation.

### Autres Endpoints

| Endpoint | Description |
|----------|-------------|
| `GET /api/v1/price/:symbol` | Prix actuel |
| `GET /api/v1/ohlcv` | Données OHLCV |
| `GET /api/v1/pairs` | Paires disponibles |
| `GET /api/v1/indicator/:indicator` | Indicateur spécifique |

---

## 7. Authentification

### WebUI Authentication

Protection par JWT avec username/password.

**Configuration (.env):**
```env
SECURED_SERVER=true
WEBUI_USERNAME=admin
WEBUI_PASSWORD=changeme123
OAUTH_ACCESS_TOKEN_DURATION=60
OAUTH_REFRESH_TOKEN_DURATION=10080
```

**Flux:**
1. Accès à `http://localhost:3000`
2. Redirection vers `/login.html`
3. POST `/webui/login` avec credentials
4. JWT stocké en HTTP-only cookie
5. Auto-refresh 5 min avant expiration

**Routes d'authentification:**
- `POST /webui/login` - Connexion
- `POST /webui/refresh` - Rafraîchir token
- `POST /webui/logout` - Déconnexion

### OAuth Dynamic Client Registration

Protection AK/SK avec HMAC-SHA256 pour l'enregistrement de clients OAuth.

**Headers requis:**
- `X-Access-Key`: Access Key
- `X-Timestamp`: Timestamp en ms
- `X-Signature`: HMAC-SHA256(access_key + timestamp + body)

**Configuration (.env):**
```env
OAUTH_REGISTRATION_ACCESS_KEY=your_access_key
OAUTH_REGISTRATION_SECRET_KEY=your_secret_key
```

---

## 8. Configuration

### Variables d'Environnement

```env
# Server
PORT=3000
NODE_ENV=development
SECURED_SERVER=false

# Redis (recommandé)
REDIS_ENABLED=true
REDIS_HOST=localhost
REDIS_PORT=6379
REDIS_CACHE_TTL=300
REDIS_MAX_BARS_PER_KEY=10000

# Data
MAX_DATA_POINTS=5000

# Logging
LOG_LEVEL=verbose
```

### Fichiers de Configuration Critiques

**1. Bar Counts** (`config/barCounts.js`)
- OHLCV_BAR_COUNTS: Bars à fetcher par timeframe
- INDICATOR_BAR_COUNTS: Bars pour calculs indicateurs
- Règle: OHLCV count ≥ INDICATOR count + 50 bars

**2. Lookback Periods** (`config/lookbackPeriods.js`)
- STATISTICAL_PERIODS: Percentiles, mean/std
- TREND_PERIODS: Slopes, trend detection
- PATTERN_PERIODS: Swing detection, structure
- VOLUME_PERIODS: Volume analysis
- SUPPORT_RESISTANCE_PERIODS: S/R identification

### Paramètres Prioritaires pour Optimisation

**Niveau 1 - Critique:**
1. Multi-timeframe weights (impact décision)
2. Confidence weights (composition score)
3. Recommendation thresholds (TRADE vs WAIT)

**Niveau 2 - Important:**
4. ADX thresholds (trending vs range)
5. ATR ratio thresholds (breakout vs compression)
6. STATISTICAL_PERIODS.short/medium

**Niveau 3 - Modéré:**
7. RSI zones
8. Volume ratios
9. Pattern confidence

---

## 9. Développement

### Path Aliases

Le projet utilise des **subpath imports** Node.js pour simplifier les imports:

```javascript
// Avant
import { round } from '../../../../Utils/statisticalHelpers.js';

// Après
import { round } from '#utils/statisticalHelpers.js';
```

**Aliases disponibles:**
| Alias | Path |
|-------|------|
| `#utils/*` | `./src/Utils/*` |
| `#trading/*` | `./src/Trading/*` |
| `#data/*` | `./src/Data/*` |
| `#logger` | `./src/Logger/LoggerService.js` |
| `#mcp/*` | `./src/Mcp/*` |

### Commandes de Test

```bash
# Tous les tests
./scripts/RUN_ALL_TESTS.sh

# Tests individuels
node scripts/validate-critical-fixes.js      # Config validation
node scripts/test-enrichers-functional.js    # Lookback periods
node scripts/test-integration-api.js         # API tests
```

### Patterns de Code

**Async Route Handler:**
```javascript
app.post('/api/v1/endpoint',
  asyncHandler(async (req) => {
    return result; // Auto-wrapped in { success: true, data: ... }
  })
);
```

**Service Dependencies:**
```javascript
// MarketAnalysisService
const service = new MarketAnalysisService({
  dataProvider,
  indicatorService,
  logger
});
```

**DataProvider Usage:**
```javascript
// Correct: loadOHLCV (pas getOHLCV)
const data = await dataProvider.loadOHLCV({
  symbol,
  timeframe,
  count,
  to: date.getTime() // Timestamp en ms, pas Date
});
```

### Performance

**Redis est critique pour production:**
- Réduit latence de 2000ms → 50ms
- Évite rate limiting Binance
- Essentiel pour analyses multi-timeframe intensives

**Recommandations:**
- Quick check: 100 bars
- Full analysis: 200 bars
- Timeframes: max 4 simultanément sans cache

---

## Annexe: Métriques Cibles

### Performance Minimum Acceptable

- Pattern success rate: > 60%
- Regime accuracy: > 70%
- Signal precision: > 65%
- Coherent signal win rate: > 70%

### Performance World-Class

- Pattern success rate: > 75%
- Regime accuracy: > 85%
- Signal precision: > 75%
- Coherent signal win rate: > 80%

---

**Documentation générée le:** 2026-01-18
**Consolidation de:** TRADING.md, CONFIGURABLE_PARAMETERS.md, WEBUI_AUTHENTICATION.md, OAUTH_AKSK_REGISTRATION.md, RegimeDetectionService.md, PATH_ALIASES.md
