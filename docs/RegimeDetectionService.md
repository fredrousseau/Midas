# RegimeDetectionService - Documentation

## Vue d'ensemble

Le `RegimeDetectionService` est un service de détection automatique de régimes de marché qui combine plusieurs indicateurs techniques pour classifier l'état actuel du marché. Il identifie 9 types de régimes différents (tendances, breakouts, ranges) et calcule un score de confiance multi-critères.

## Architecture

Le service s'intègre dans l'architecture du projet en s'appuyant sur :
- **dataProvider** : Chargement des données OHLCV
- **indicatorService** : Calcul des indicateurs techniques (ADX, ATR, EMA)
- **logger** : Journalisation des opérations

### Calculs internes

Le service utilise exclusivement l'`indicatorService` pour les indicateurs standards (ADX, ATR, EMA).

Seuls quelques calculs sont effectués localement :
- **Efficiency Ratio** : Calcul personnalisé non disponible dans l'indicatorService
- **Directional Indicators (±DI)** : Complémentaires à l'ADX
- **RMA (Wilder's smoothing)** : Utilitaire pour lisser les DI et True Range

## Configuration

### Périodes des indicateurs

```javascript
config = {
  adxPeriod: 14,           // Période ADX
  erPeriod: 10,            // Période Efficiency Ratio
  atrShortPeriod: 14,      // Période ATR court terme
  atrLongPeriod: 50,       // Période ATR long terme
  maShortPeriod: 20,       // Période MA court terme
  maLongPeriod: 50,        // Période MA long terme
  minBars: 60              // Minimum de barres requises
}
```

### Seuils de détection

**ADX (Average Directional Index)**
```javascript
adx: {
  weak: 20,        // Tendance faible
  trending: 25,    // Tendance confirmée
  strong: 40       // Tendance forte
}
```

**Efficiency Ratio**
```javascript
er: {
  choppy: 0.3,     // Marché choppy/range
  trending: 0.5    // Marché en tendance
}
```

**ATR Ratio**
```javascript
atrRatio: {
  low: 0.8,        // Faible volatilité
  high: 1.3        // Forte volatilité
}
```

## Méthode principale : `detectRegime()`

### Paramètres

```javascript
detectRegime({
  symbol,          // Requis : Symbole à analyser (ex: 'BTC/USDT')
  timeframe,       // Défaut: '1h' - Timeframe d'analyse
  count,           // Défaut: 200 - Nombre de barres
  analysisDate,    // Optionnel : Date d'analyse (backtesting)
  useCache,        // Défaut: true - Utiliser le cache
  detectGaps       // Défaut: true - Détecter les gaps
})
```

### Processus de détection

1. **Chargement des données OHLCV** via `dataProvider`
2. **Calcul parallèle** de 6 indicateurs :
   - ADX (Average Directional Index)
   - ATR court terme et long terme
   - Efficiency Ratio
   - EMA court terme et long terme
3. **Analyse des composants** :
   - Calcul du ratio ATR
   - Détermination de la direction du marché
4. **Détection du type de régime**
5. **Calcul du score de confiance**

### Structure de retour

```javascript
{
  regime: string,           // Type de régime (9 valeurs possibles)
  confidence: number,       // Score de confiance (0.00 à 1.00)
  components: {
    adx: number,           // Valeur ADX (2 décimales)
    plusDI: number,        // +DI (2 décimales)
    minusDI: number,       // -DI (2 décimales)
    efficiency_ratio: number,  // ER (4 décimales)
    atr_ratio: number,     // Ratio ATR (4 décimales)
    direction: {
      direction: string,   // 'bullish' | 'bearish' | 'neutral'
      strength: number,    // Force de direction (4 décimales)
      emaShort: number,    // EMA courte (2 décimales)
      emaLong: number      // EMA longue (2 décimales)
    }
  },
  metadata: {
    symbol: string,
    timeframe: string,
    barsUsed: number,
    firstTimestamp: number,
    lastTimestamp: number,
    gapCount: number,
    fromCache: boolean,
    loadDuration: number,
    detectionDuration: number,
    loadedAt: string
  }
}
```

## Définition des régimes de marché

### 📈 TENDANCE (Trending)

**Définition** : Mouvement directionnel soutenu et efficace du prix dans une direction donnée (haussière ou baissière).

**Caractéristiques** :
- **ADX ≥ 25** : Force de tendance confirmée
- **Efficiency Ratio ≥ 0.5** : Mouvement directionnel efficace (peu de bruit)
- **Direction claire** : Prix et moyennes mobiles alignées
- **Momentum soutenu** : Le prix progresse de manière cohérente

**Analogie** : Une rivière qui coule régulièrement dans une direction - le courant est fort et constant.

### 💥 BREAKOUT

**Définition** : Explosion soudaine de volatilité accompagnée d'un mouvement directionnel fort, souvent après une période de consolidation.

**Caractéristiques** :
- **ATR ratio > 1.3** : Volatilité en forte expansion (court terme > long terme)
- **ADX > 25** : Force directionnelle en augmentation
- **Mouvement rapide** : Sortie d'une zone de consolidation
- **Volume souvent élevé** : Participation accrue du marché

**Analogie** : Un barrage qui cède - l'énergie accumulée se libère brutalement dans une direction.

### 📊 RANGE

**Définition** : Mouvement latéral du prix entre des niveaux de support et résistance, sans direction claire ni tendance établie.

**Caractéristiques** :
- **ADX < 25** : Absence de tendance forte
- **Efficiency Ratio < 0.5** : Mouvement inefficace, beaucoup de bruit
- **Prix oscillant** : Va-et-vient entre bornes supérieure et inférieure
- **Indécision** : Aucune direction dominante

**Analogie** : Une balle de tennis qui rebondit entre deux murs - mouvement répétitif sans progression.

### 📋 Tableau comparatif

| Critère | Tendance | Breakout | Range |
|---------|----------|----------|-------|
| **ADX** | ≥ 25 | > 25 | < 25 |
| **ER** | ≥ 0.5 | Variable | < 0.5 |
| **ATR Ratio** | Variable | > 1.3 | Variable |
| **Direction** | Claire et soutenue | Émergente et explosive | Absente ou confuse |
| **Volatilité** | Stable | En expansion | Stable ou variable |
| **Mouvement** | Linéaire efficace | Explosif rapide | Latéral répétitif |
| **Stratégies adaptées** | Suivi de tendance | Trading de cassure | Mean reversion |

### 🎯 Transitions typiques

```
Range (consolidation)
    ↓
Breakout (explosion)
    ↓
Tendance (continuation)
    ↓
Range (épuisement)
```

Le cycle typique : accumulation (range) → distribution (breakout) → tendance → retour au range.

## Valeurs possibles pour `regime`

### Régimes de tendance (3 types)

**Conditions** : ADX ≥ 25 ET Efficiency Ratio ≥ 0.5

- **`trending_bullish`** : Tendance haussière confirmée
  - Prix > EMA long
  - EMA court > EMA long
  - ADX élevé
  - ER élevé

- **`trending_bearish`** : Tendance baissière confirmée
  - Prix < EMA long
  - EMA court < EMA long
  - ADX élevé
  - ER élevé

- **`trending_neutral`** : Tendance sans direction claire
  - ADX élevé et ER élevé
  - Mais direction neutre

### Régimes de breakout (3 types)

**Conditions** : ATR ratio > 1.3 ET ADX > 25

- **`breakout_bullish`** : Breakout haussier
  - Volatilité en expansion
  - Direction bullish
  - ADX en hausse

- **`breakout_bearish`** : Breakout baissier
  - Volatilité en expansion
  - Direction bearish
  - ADX en hausse

- **`breakout_neutral`** : Breakout sans direction claire
  - Volatilité en expansion
  - ADX en hausse
  - Direction neutre

### Régimes de range (3 types)

**Conditions** : Autres cas (ADX < 25 ou ER < 0.5)

- **`range_low_vol`** : Range avec faible volatilité
  - ATR ratio < 0.8
  - ADX généralement bas
  - ER bas

- **`range_high_vol`** : Range avec forte volatilité
  - ATR ratio > 1.3
  - Mais ADX bas (pas de tendance)
  - ER bas

- **`range_normal`** : Range avec volatilité normale
  - ATR ratio entre 0.8 et 1.3
  - ADX bas
  - ER bas

## Calcul de la direction

La direction du marché est déterminée par la relation entre le prix et les moyennes mobiles :

### Types de direction

- **`bullish`** (Haussier)
  - Prix > EMA long
  - EMA court > EMA long

- **`bearish`** (Baissier)
  - Prix < EMA long
  - EMA court < EMA long

- **`neutral`** (Neutre)
  - Autres cas (signaux mixtes)

### Strength (Force)

La force de la direction est calculée comme :
```javascript
strength = (emaShort - emaLong) / atrLong
```

- Valeur **positive** : Force haussière
- Valeur **négative** : Force baissière
- Proche de **zéro** : Direction faible

## Score de confiance

Le score de confiance combine 4 critères indépendants :

### 1. Regime Clarity Score (Clarté du régime)

Évalue la cohérence entre l'ADX et le type de régime :

**Pour tendances/breakouts :**
- ADX > 40 → Score 1.0 (très forte)
- ADX > 25 → Score 0.7 (forte)
- ADX > 20 → Score 0.5 (modérée)
- Autres → Score 0.3 (faible)

**Pour ranges :**
- ADX < 20 → Score 0.8 (forte)
- ADX < 25 → Score 0.6 (modérée)
- Autres → Score 0.4 (faible)

### 2. ER Score (Efficiency Ratio)

Évalue l'adéquation de l'Efficiency Ratio :

**Pour tendances :**
- ER > 0.7 → Score 1.0
- ER > 0.5 → Score 0.7
- Autres → Score 0.4

**Pour ranges :**
- ER < 0.25 → Score 1.0
- ER < 0.35 → Score 0.7
- Autres → Score 0.4

### 3. Direction Score (Force de direction)

Basé sur la valeur absolue de `direction.strength` :

- |strength| > 0.8 → Score 1.0
- |strength| > 0.5 → Score 0.7
- |strength| > 0.25 → Score 0.5
- Autres → Score 0.3

### 4. Coherence Score (Cohérence logique)

Vérifie la cohérence entre tous les indicateurs selon des règles spécifiques pour chaque régime.

**Exemple pour `trending_bullish` :**
- ADX ≥ 25 ✓
- ER ≥ 0.5 ✓
- Direction = bullish ✓

Score = nombre de règles satisfaites / nombre total de règles

### Score final

```javascript
confidence = moyenne(regimeClarityScore, erScore, directionScore, coherenceScore)
```

Arrondi à 2 décimales (0.00 à 1.00)

## Indicateurs utilisés

### ADX (Average Directional Index)

- **Mesure** : Force de la tendance (0-100+)
- **Calcul** : Utilise +DI, -DI et leur différence lissée
- **Interprétation** :
  - ADX < 20 : Pas de tendance (range)
  - ADX 20-25 : Tendance faible
  - ADX > 25 : Tendance confirmée
  - ADX > 40 : Tendance forte

### ATR (Average True Range)

- **Mesure** : Volatilité absolue
- **Périodes** : Court terme (14) et long terme (50)
- **Ratio** : ATR court / ATR long
  - Ratio < 0.8 : Volatilité en baisse
  - Ratio > 1.3 : Volatilité en hausse

### Efficiency Ratio (ER)

- **Mesure** : Efficacité du mouvement de prix
- **Formule** : Mouvement net / Somme des mouvements
- **Calcul** : Personnalisé (non disponible dans l'IndicatorService)
- **Interprétation** :
  - ER proche de 0 : Marché choppy
  - ER proche de 1 : Mouvement directionnel efficace
- **Lissage** : EMA(3) appliqué inline pour stabilité

### Directional Indicators (±DI)

- **Mesure** : Direction du mouvement de prix
- **Calcul** : Interne, utilise le smoothing RMA de Wilder
- **Composants** :
  - **+DI** : Force du mouvement haussier
  - **-DI** : Force du mouvement baissier
- **Usage** : Complète l'analyse ADX pour déterminer la direction

### EMA (Exponential Moving Average)

- **Périodes** : Court terme (20) et long terme (50)
- **Usage** : Détermination de la direction du marché
- **Relation** : Position relative du prix et des EMAs

## Plages de valeurs

### Valeurs numériques typiques

- **confidence** : 0.00 à 1.00
- **adx** : 0 à 100+ (typiquement 0-60)
- **plusDI / minusDI** : 0 à 100+
- **efficiency_ratio** : 0.0000 à 1.0000
- **atr_ratio** : 0.0000+ (généralement 0.5 à 2.0)
- **direction.strength** : Peut être négatif ou positif

## Exemple d'utilisation

```javascript
const regimeService = new RegimeDetectionService({
  logger: logger,
  dataProvider: dataProvider,
  indicatorService: indicatorService
});

const result = await regimeService.detectRegime({
  symbol: 'BTC/USDT',
  timeframe: '1h',
  count: 200,
  useCache: true
});

console.log(`Régime: ${result.regime}`);
console.log(`Confiance: ${result.confidence}`);
console.log(`Direction: ${result.components.direction.direction}`);
```

### Exemple de retour

```javascript
{
  regime: 'trending_bullish',
  confidence: 0.82,
  components: {
    adx: 32.45,
    plusDI: 28.60,
    minusDI: 12.30,
    efficiency_ratio: 0.6234,
    atr_ratio: 1.1250,
    direction: {
      direction: 'bullish',
      strength: 0.8500,
      emaShort: 45230.25,
      emaLong: 44850.10
    }
  },
  metadata: {
    symbol: 'BTC/USDT',
    timeframe: '1h',
    barsUsed: 200,
    firstTimestamp: 1703001600000,
    lastTimestamp: 1703721600000,
    gapCount: 0,
    fromCache: true,
    loadDuration: 45,
    detectionDuration: 123,
    loadedAt: '2025-12-28T10:30:00.000Z'
  }
}
```

## Fonctions utilitaires

### `rma(values, period)`

Implémente le Wilder's Smoothing (RMA) utilisé pour lisser les composants des Directional Indicators.

**Algorithme** :
```javascript
rma[0] = values[0]
rma[i] = (rma[i-1] × (period - 1) + values[i]) / period
```

**Usage** :
- Lissage du True Range
- Lissage du Directional Movement (+DM, -DM)

**Note** : Cette fonction locale est nécessaire car elle opère sur des tableaux calculés (TR, DM) qui ne sont pas des données OHLCV standard que l'IndicatorService pourrait traiter.

### `calculateTrueRange(highs, lows, closes)`

Calcule le True Range pour chaque barre :
```javascript
TR = max(high - low, |high - close_prev|, |low - close_prev|)
```

### Helpers d'arrondi

- **`round2(x)`** : Arrondit à 2 décimales (pour prix, ADX, DI)
- **`round4(x)`** : Arrondit à 4 décimales (pour ER, ratios, strength)

## Points forts

✅ **Architecture propre** avec séparation des responsabilités
✅ **Utilisation optimale de l'IndicatorService** pour tous les indicateurs standards
✅ **Performance** avec calculs parallèles via `Promise.all`
✅ **Code épuré** sans duplication inutile (suppression de la fonction `ema` redondante)
✅ **Logging** informatif pour le débogage
✅ **Métadonnées riches** dans le résultat (cache, durée, gaps)
✅ **Flexibilité** via les paramètres `analysisDate`, `useCache`, `detectGaps`
✅ **Score de confiance multi-critères** pour évaluer la fiabilité

## Optimisations récentes

✨ **Suppression de la fonction `ema`** : Éliminée car redondante avec l'IndicatorService, calcul EMA inline pour le lissage ER
✨ **Conservation de `rma`** : Nécessaire pour les calculs internes de DI qui opèrent sur des données calculées

## Fichier source

[RegimeDetectionService.js](RegimeDetectionService.js)
