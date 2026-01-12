# Paramètres Configurables - API /context/enriched

Documentation exhaustive de tous les paramètres, pondérations et seuils utilisés dans l'analyse multi-timeframe pour le backtesting et l'auto-ajustement.

**Date de génération:** 2026-01-09
**Dernière mise à jour:** 2026-01-11 (Corrections critiques)
**Version API:** v1
**Total paramètres identifiés:** ~200+

---

## 🔧 CORRECTIONS CRITIQUES APPLIQUÉES (2026-01-11)

### 1. Poids Multi-Timeframe '1m' corrigé
- **Problème:** `'1m': 2.5` (identique à '1w') créait un biais vers le bruit court-terme
- **Solution:** `'1m': 0.3` (cohérent avec signal/bruit)
- **Fichier:** `StatisticalContextService.js:536`

### 2. Bar Counts centralisés
- **Problème:** Incohérence entre service principal (300 bars) et enrichers (200 bars)
- **Solution:** Configuration centralisée dans `config/barCounts.js`
- **Impact:** Garantit que les indicateurs ont suffisamment de données historiques

### 3. Lookback Periods configurables
- **Problème:** Magic numbers hardcodés partout (slice(-30), slice(-60))
- **Solution:** Configuration centralisée dans `config/lookbackPeriods.js`
- **Impact:** Facilite l'optimisation et le backtesting

### 4. Validation seuils ADX adaptatifs
- **Problème:** Les multiplicateurs adaptatifs pouvaient créer des seuils ADX < 10 (invalides)
- **Solution:** Ajout de `Math.max(10, ...)` pour garantir seuils minimums valides
- **Fichier:** `RegimeDetectionService.js:146-148`

**Note:** Ces corrections sont critiques pour la qualité des analyses et doivent être prises en compte lors de tout backtesting.

---

## Table des matières

1. [Regime Detection](#1-regime-detection)
2. [Multiplicateurs Timeframe](#2-multiplicateurs-timeframe)
3. [Poids Multi-Timeframe Alignment](#3-poids-multi-timeframe-alignment)
4. [Pondérations Confidence Finale](#4-pondérations-confidence-finale)
5. [Seuils Recommendations](#5-seuils-recommendations)
6. [Moving Averages](#6-moving-averages)
7. [Momentum Indicators](#7-momentum-indicators)
8. [Volatility Indicators](#8-volatility-indicators)
9. [Volume Indicators](#9-volume-indicators)
10. [Pattern Detector](#10-pattern-detector)
11. [Bar Counts Adaptatifs](#11-bar-counts-adaptatifs)
12. [**Lookback Periods (NOUVEAU)**](#12-lookback-periods)
12. [Recommandations pour Backtesting](#12-recommandations-pour-backtesting)

---

## 1. REGIME DETECTION

**Fichier:** `src/Trading/MarketAnalysis/RegimeDetection/RegimeDetectionService.js`
**Total paramètres:** 19

### 1.1 Périodes d'indicateurs

```javascript
adxPeriod: 14              // Période ADX pour détection de tendance
erPeriod: 10               // Période Efficiency Ratio
erSmoothPeriod: 3          // Lissage du Efficiency Ratio
atrShortPeriod: 14         // ATR court terme
atrLongPeriod: 50          // ATR long terme
maShortPeriod: 20          // EMA court terme pour direction
maLongPeriod: 50           // EMA long terme pour direction
```

**Localisation:** Lignes 11-17

### 1.2 Seuils ADX Base

```javascript
adx: {
  weak: 20,         // Pas de tendance claire
  trending: 25,     // Tendance formée
  strong: 40        // Tendance forte
}
```

**Localisation:** Lignes 20-24
**Usage:** Détection du type de régime (trending vs range)

### 1.3 Seuils Efficiency Ratio

```javascript
er: {
  choppy: 0.3,      // Marché agité/choppy
  trending: 0.5     // Marché en tendance
}
```

**Localisation:** Lignes 26-29
**Usage:** Mesure de l'efficacité directionnelle du marché

### 1.4 Seuils ATR Ratio

```javascript
atrRatio: {
  low: 0.8,         // Compression de volatilité
  high: 1.3         // Expansion/breakout potentiel
}
```

**Localisation:** Lignes 31-34
**Usage:** Détection phases de compression/expansion

### 1.5 Ajustement Volatilité

```javascript
adaptive: {
  enabled: true,
  volatilityWindow: 100,           // Fenêtre historique (bars)
  volatility: {
    minMultiplier: 0.7,            // Multiplicateur min (marchés calmes)
    maxMultiplier: 1.5             // Multiplicateur max (marchés volatils)
  }
}
```

**Localisation:** Lignes 37-61
**Usage:** Ajustement adaptatif des seuils selon conditions de marché

### 1.6 Données Minimales

```javascript
minBars: 60        // Nombre minimum de barres requises
```

**Localisation:** Ligne 63

### 1.7 Scores de Confiance

#### Regime Clarity Score

```javascript
// Trending/Breakout
if (adx > strong)     → regimeClarityScore = 1.0
if (adx > trending)   → regimeClarityScore = 0.7
if (adx > weak)       → regimeClarityScore = 0.5

// Range
if (adx < weak)       → regimeClarityScore = 0.8
if (adx < trending)   → regimeClarityScore = 0.6
else                  → regimeClarityScore = 0.4

// Base
regimeClarityScore = 0.3
```

**Localisation:** Lignes 323-333

#### Efficiency Ratio Score

```javascript
// Trending
if (er > 0.7)         → erScore = 1.0
if (er > 0.5)         → erScore = 0.7

// Breakout
if (er > 0.4)         → erScore = 1.0
if (er > 0.3)         → erScore = 0.7

// Range
if (er < 0.25)        → erScore = 1.0
if (er < 0.35)        → erScore = 0.7

// Base
erScore = 0.4
```

**Localisation:** Lignes 338-349

#### Direction Score

```javascript
if (absDir > 0.8)     → directionScore = 1.0
if (absDir > 0.5)     → directionScore = 0.7
if (absDir > 0.25)    → directionScore = 0.5

// Base
directionScore = 0.3
```

**Localisation:** Lignes 353-359

### 1.8 Calcul Confidence Finale

```javascript
confidence = 0.35 * regimeClarityScore    // 35% - Clarté du régime
           + 0.30 * coherence             // 30% - Cohérence indicateurs
           + 0.20 * directionScore        // 20% - Force directionnelle
           + 0.15 * erScore               // 15% - Efficiency Ratio
```

**Localisation:** Ligne 403
**Range:** [0.0, 1.0]

### 1.9 Interprétation ADX

```javascript
if (adx > 30)         → "strong trend"
if (adx > 25)         → "trend forming"
if (adx < 20)         → "weak or no trend"
else                  → "neutral"
```

**Localisation:** Lignes 424-428

### 1.10 Configuration PSAR

```javascript
psar: {
  step: 0.02,         // Pas d'incrémentation
  max: 0.2            // Maximum
}
```

**Localisation:** Ligne 439

---

## 2. MULTIPLICATEURS TIMEFRAME

**Fichier:** `src/Trading/MarketAnalysis/RegimeDetection/RegimeDetectionService.js`
**Total paramètres:** 9

```javascript
timeframeMultipliers: {
  '1m': 1.3,          // Timeframes courts = seuils plus élevés (bruit)
  '5m': 1.2,
  '15m': 1.1,
  '30m': 1.05,
  '1h': 1.0,          // Baseline de référence
  '2h': 0.95,
  '4h': 0.9,
  '1d': 0.85,
  '1w': 0.8           // Timeframes longs = seuils plus bas
}
```

**Localisation:** Lignes 43-53
**Usage:** Ajustement des seuils ADX selon la granularité temporelle
**Rationale:** Les timeframes courts ont plus de bruit, nécessitent des seuils plus élevés

---

## 3. POIDS MULTI-TIMEFRAME ALIGNMENT

**Fichier:** `src/Trading/MarketAnalysis/StatisticalContext/StatisticalContextService.js`
**Total paramètres:** 8

```javascript
weights: {
  '1m': 0.3,          // ⚠️ CORRIGÉ de 2.5 → 0.3 (bruit maximum)
  '5m': 0.5,          // Poids minimal
  '15m': 0.8,
  '30m': 1.0,
  '1h': 1.5,
  '4h': 2.0,
  '1d': 3.0,          // Poids maximal - tendance principale
  '1w': 2.5           // Tendance hebdomadaire stable
}
```

**Localisation:** Lignes 533-536
**Usage:** Calcul du score d'alignement multi-timeframe
**Impact:** Détermine l'importance relative de chaque timeframe dans la décision finale

**⚠️ CORRECTION CRITIQUE (2026-01-11):**
- **Ancien:** `'1m': 2.5` (identique à '1w')
- **Nouveau:** `'1m': 0.3` (cohérent avec le niveau de bruit)
- **Rationale:** Les timeframes ultra-courts (< 5m) ont un bruit très élevé et ne doivent PAS avoir le même poids qu'une tendance hebdomadaire établie. Le poids 0.3 reflète correctement le signal/bruit ratio du 1-minute.

### Formule Alignment Score

```javascript
// Score pondéré par direction
bullishScore = Σ(weight * confidence) where direction = 'bullish'
bearishScore = Σ(weight * confidence) where direction = 'bearish'
neutralScore = Σ(weight * confidence) where direction = 'neutral'

totalWeight = Σ(weight * confidence)

alignment_score = maxScore / totalWeight
```

**Localisation:** Lignes 572-594
**Range:** [0.0, 1.0]

---

## 4. PONDÉRATIONS CONFIDENCE FINALE

**Fichier:** `src/Trading/MarketAnalysis/RegimeDetection/RegimeDetectionService.js`
**Total paramètres:** 4

```javascript
confidenceWeights: {
  regimeClarity: 0.35,    // 35% - Clarté du régime (ADX)
  coherence: 0.30,        // 30% - Cohérence des indicateurs
  direction: 0.20,        // 20% - Force directionnelle
  efficiencyRatio: 0.15   // 15% - Efficacité du mouvement
}
```

**Localisation:** Ligne 403
**Total:** 100%

---

## 5. SEUILS RECOMMENDATIONS

**Fichier:** `src/Trading/MarketAnalysis/MarketAnalysisService.js`
**Total paramètres:** 8

### 5.1 Actions Trading

```javascript
// TRADE - Signal fort, exécution immédiate
if (alignment_score >= 0.8 && !neutral && !hasHighConflicts) {
  action: "TRADE_LONG" | "TRADE_SHORT"
  confidence: alignment_score * 1.0
}

// PREPARE - Signal prometteur, attendre confirmation
if (alignment_score >= 0.7 && !neutral && !hasModerateConflicts) {
  action: "PREPARE_LONG" | "PREPARE_SHORT"
  confidence: alignment_score * 0.9
}

// CAUTION - Signal modéré, réduire exposition
if (alignment_score >= 0.6) {
  action: "CAUTION"
  confidence: alignment_score * 0.8
}

// WAIT - Conflits majeurs
if (hasHighConflicts) {
  action: "WAIT"
  confidence: 0.3
}

// WAIT - Alignement faible
if (alignment_score < 0.6) {
  action: "WAIT"
  confidence: 0.4
}
```

**Localisation:** Lignes 76-107

### 5.2 Qualité Alignment

```javascript
if (hasHighConflicts)                           → quality: "poor"
if (alignment_score >= 0.85)                    → quality: "excellent"
if (alignment_score >= 0.75 && !moderate)       → quality: "good"
if (alignment_score >= 0.6)                     → quality: "fair"
else                                            → quality: "poor"
```

**Localisation:** Lignes 142-153

### 5.3 Sévérité Conflits

```javascript
// High severity
if (highWeightBullish.length > 0 && highWeightBearish.length > 0) {
  weight >= 2.0 pour les deux côtés
  severity: "high"
}

// Moderate severity
if (min(bullishSignals, bearishSignals) >= 2) {
  severity: "moderate"
}

// Low severity
else {
  severity: "low"
}
```

**Localisation:** Lignes 603-621

---

## 6. MOVING AVERAGES

**Fichier:** `src/Trading/MarketAnalysis/StatisticalContext/enrichers/MovingAveragesEnricher.js`
**Total paramètres:** 10

### 6.1 Périodes

```javascript
emaPeriods: [12, 26, 50, 200]
smaPeriods: [20, 50]
```

**Localisation:** Lignes 14-15

### 6.2 Seuils Slope

```javascript
if (slope > 0.3)      → "accelerating up"
if (slope > 0.1)      → "rising"
if (slope < -0.3)     → "accelerating down"
if (slope < -0.1)     → "declining"
if (|slope| < 0.05)   → "flat"
else                  → "stable"
```

**Localisation:** Lignes 209-215

### 6.3 Divergence

```javascript
if (diff < 0.001)     → "parallel (healthy trend)"
```

**Localisation:** Ligne 240

### 6.4 Support/Resistance Cluster

```javascript
clusterTolerance: 0.02    // 2% de tolérance pour regroupement
```

**Localisation:** Ligne 314

### 6.5 Bar Counts Adaptatifs

```javascript
// Standard
'5m': 200, '15m': 200, '30m': 200, '1h': 150,
'4h': 150, '1d': 100, '1w': 60, '1M': 50

// Pour EMA200 (nécessite plus de données)
'5m': 250, '15m': 250, '30m': 250, '1h': 220,
'4h': 220, '1d': 210, '1w': 210, '1M': 210
```

**Localisation:** Lignes 24-34

---

## 7. MOMENTUM INDICATORS

**Fichier:** `src/Trading/MarketAnalysis/StatisticalContext/enrichers/MomentumEnricher.js`
**Total paramètres:** 15

### 7.1 Zones RSI

```javascript
if (rsi > 70)         → "overbought (potential resistance)"
if (rsi > 65)         → "strong momentum, not yet overbought"
if (rsi > 50)         → "bullish momentum"
if (rsi > 35)         → "neutral to bearish momentum"
if (rsi > 30)         → "oversold zone but can extend"
if (rsi <= 30)        → "oversold (potential support)"
```

**Localisation:** Lignes 99-110
**Usage:** Identification zones de surachat/survente

### 7.2 Support Level RSI

```javascript
if (45 < rsi < 55)    → supportLevel: 50
```

**Localisation:** Lignes 113-115

### 7.3 RSI vs Higher Timeframe

```javascript
diff = rsi - htfRsi

if (diff < -10)       → "cooling from HTF"
if (diff > 10)        → "heating vs HTF"
else                  → "aligned with HTF"
```

**Localisation:** Lignes 92-95

### 7.4 ROC (Rate of Change)

```javascript
if (roc5 > 2 && roc10 > 2)         → "strong upward momentum"
if (roc5 < -2 && roc10 < -2)       → "strong downward momentum"
if (roc5 > 0 && roc10 > 0)         → "upward momentum"
if (roc5 < 0 && roc10 < 0)         → "downward momentum"
else                               → "short-term pullback"
```

**Localisation:** Lignes 250-260

### 7.5 Trend Detection

```javascript
if (slope > 0.5)      → "rising (bullish)"
if (slope < -0.5)     → "declining (bearish)"
else                  → "flat (range-bound)"
```

**Localisation:** Lignes 287-289

### 7.6 Bar Counts

```javascript
'5m': 200, '15m': 200, '30m': 200, '1h': 150,
'4h': 150, '1d': 100, '1w': 60, '1M': 50
default: 150
```

**Localisation:** Lignes 39-49

---

## 8. VOLATILITY INDICATORS

**Fichier:** `src/Trading/MarketAnalysis/StatisticalContext/enrichers/VolatilityEnricher.js`
**Total paramètres:** 20

### 8.1 ATR Percentile

```javascript
if (percentile > 0.8)     → "elevated volatility"
if (percentile > 0.6)     → "above average volatility"
if (percentile < 0.3)     → "low volatility (consolidation)"
else                      → "normal volatility"
```

**Localisation:** Lignes 109-116

### 8.2 ATR vs Higher Timeframe

```javascript
diff = (atrCurrent - htfATRScaled) / htfATRScaled * 100

if (diff > 20)            → "elevated"
if (diff < -20)           → "relative quiet"
else                      → "aligned"
```

**Localisation:** Lignes 119-126

### 8.3 ATR Ratio

```javascript
ratio = atrShort / atrLong

if (ratio > 1.3)          → "high (breakout or spike)" - Breakout
if (ratio > 1.1)          → "slightly elevated" - Momentum
if (ratio < 0.8)          → "low (compression)" - Compression
else                      → "normal"
```

**Localisation:** Lignes 238-250

### 8.4 ATR Trend

```javascript
change = (current - previous) / previous * 100

if (change > 10%)         → "expanding (breakout potential)"
if (change < -10%)        → "contracting (consolidation)"
if (|change| < 3%)        → "stable"
else                      → "slightly rising/falling"
```

**Localisation:** Lignes 299-306

### 8.5 Bollinger Bands Position

```javascript
position = (close - lower) / (upper - lower)

if (position > 0.8)       → "approaching upper band (resistance)"
if (position < 0.2)       → "approaching lower band (support)"
if (position > 0.6)       → "upper half (bullish)"
if (position < 0.4)       → "lower half (bearish)"
else                      → "middle (neutral)"
```

**Localisation:** Lignes 184-193

### 8.6 Bollinger Bands Width

```javascript
if (widthPercentile > 0.7)    → "wide bands (high volatility)"
if (widthPercentile < 0.3)    → "narrow range"
else                          → "normal width"
```

**Localisation:** Lignes 175-180

### 8.7 Bollinger Squeeze

```javascript
if (bandwidthPercentile < 0.30)    → Squeeze forming
  if (< 0.20)                      → severity: "extreme"
  else                             → severity: "moderate"
```

**Localisation:** Lignes 318-324

### 8.8 Timeframe Scaling

```javascript
timeframeMinutes: {
  '5m': 5, '15m': 15, '30m': 30, '1h': 60,
  '4h': 240, '1d': 1440, '1w': 10080, '1M': 43200
}
defaultMultiplier: 4
```

**Localisation:** Lignes 18-27
**Usage:** Normalisation ATR entre timeframes différents

### 8.9 Bar Counts

```javascript
'5m': 200, '15m': 200, '30m': 200, '1h': 150,
'4h': 150, '1d': 100, '1w': 60, '1M': 50
default: 150
```

**Localisation:** Lignes 61-71

---

## 9. VOLUME INDICATORS

**Fichier:** `src/Trading/MarketAnalysis/StatisticalContext/enrichers/VolumeEnricher.js`
**Total paramètres:** 12

### 9.1 Volume Ratio

```javascript
ratio = currentVolume / avg20

if (ratio > 2.0)          → "very high volume (climax or news)"
if (ratio > 1.5)          → "high volume (above average)"
if (ratio > 1.2)          → "good participation"
if (ratio < 0.7)          → "low volume (indecision)"
else                      → "normal volume"
```

**Localisation:** Lignes 79-89

### 9.2 OBV Trend

```javascript
change = (last - first) / |first| * 100

if (change > 5%)          → "rising strongly"
if (change > 2%)          → "rising"
if (change < -5%)         → "declining strongly"
if (change < -2%)         → "declining"
else                      → "flat"
```

**Localisation:** Lignes 182-197

### 9.3 VWAP Interpretation

```javascript
diff = (price - vwap) / vwap * 100

if (diff > 1%)            → "strong institutional buying"
if (diff > 0.3%)          → "institutional support"
if (diff < -1%)           → "strong institutional selling"
if (diff < -0.3%)         → "institutional resistance"
else                      → "fair value"
```

**Localisation:** Lignes 237-246

### 9.4 Bar Counts

```javascript
'5m': 200, '15m': 200, '30m': 200, '1h': 150,
'4h': 150, '1d': 100, '1w': 60, '1M': 50
default: 150
```

**Localisation:** Lignes 34-45

---

## 10. PATTERN DETECTOR

**Fichier:** `src/Trading/MarketAnalysis/StatisticalContext/enrichers/PatternDetector.js`
**Total paramètres:** 25

### 10.1 Bull/Bear Flag

```javascript
// Critères de base
poleATRMultiple >= 3                  // Pole minimum 3x ATR
flagDuration: [5, 15]                 // 5-15 barres
flagRange < poleRange * 0.5           // Flag < 50% du pole
flagMove < poleRange * 0.3            // Mouvement < 30% du pole

// Confidence
baseConfidence: 0.70
if (8 <= duration <= 12)              → bonus: +0.05
if (flagRange < poleRange * 0.3)      → bonus: +0.05
```

**Localisation:** Lignes 168-219

### 10.2 Triangle

```javascript
// Critères
swingATR: 1.3                         // Minimum pour swing valide
minSwings: 2 highs && 2 lows

// Types
ascending: |highSlope| < atr && lowSlope > atr
descending: highSlope < -atr && |lowSlope| < atr

// Confidence
baseConfidence: 0.65-0.70
```

**Localisation:** Lignes 228-279

### 10.3 Wedge

```javascript
// Critères
swingATR: 1.3
minSwings: 2 highs && 2 lows

// Confidence
baseConfidence: 0.65
```

**Localisation:** Lignes 286-321

### 10.4 Head & Shoulders

```javascript
// Critères
swingATR: 1.5                         // Plus stricte
minSwings: 3 highs
shouldersVariance < 5%                // Épaules similaires

// Confidence
baseConfidence: 0.75
```

**Localisation:** Lignes 327-358

### 10.5 Double Top/Bottom

```javascript
// Critères
swingATR: 1.3
minSwings: 2 highs/lows
peakSimilarity < 2%                   // Pics similaires

// Confidence
baseConfidence: 0.65
```

**Localisation:** Lignes 364-431

### 10.6 Confirmation Bonuses

```javascript
if (volumeConfirmed)                  → bonus: +0.05
if (breakoutConfirmed)                → bonus: +0.10
maxConfidence: 0.95
```

**Localisation:** Lignes 53-62

### 10.7 Volume Confirmation

```javascript
// Reversal patterns
volumeRatio > 1.4

// Continuation patterns
volumeRatio > 1.2
```

**Localisation:** Lignes 133-136

### 10.8 Breakout Confirmation

```javascript
// Head & Shoulders
|close - neckline| > atr * 0.3

// Bull patterns
close > invalidation + atr * 0.2

// Bear patterns
close < invalidation - atr * 0.2
```

**Localisation:** Lignes 142-157

### 10.9 Swing Detection

```javascript
minATR: 1.2                           // Multiple ATR minimum
```

**Localisation:** Ligne 93

---

## 11. BAR COUNTS ADAPTATIFS

**Fichier:** `src/Trading/MarketAnalysis/StatisticalContext/StatisticalContextService.js`
**Total paramètres:** 8 timeframes

```javascript
'5m': 300,      // ~1 jour de données
'15m': 300,     // ~3 jours de données
'30m': 250,     // ~5 jours de données
'1h': 250,      // ~10 jours de données
'4h': 200,      // ~33 jours de données
'1d': 150,      // ~5 mois de données
'1w': 100,      // ~2 ans de données
'1M': 60,       // ~5 ans de données
default: 250
```

**Localisation:** Lignes 194-204
**Usage:** Optimisation de la quantité de données historiques par timeframe

### Context Depth

```javascript
timeframeMinutes >= 1440 (1d+)        → level: "light"
  purpose: "macro trend direction"

timeframeMinutes >= 240 (4h+)         → level: "medium"
  purpose: "structure and trend phase"

timeframeMinutes < 240 (<4h)          → level: "full"
  purpose: "precise entry/exit timing"
```

**Localisation:** Lignes 329-340

---

## 12. RECOMMANDATIONS POUR BACKTESTING

### 12.1 Paramètres Prioritaires (Impact Majeur)

Ces paramètres ont l'impact le plus direct sur les décisions de trading :

#### Niveau 1 - Critique
1. **Multi-timeframe weights** (9 valeurs)
   - Impact: Détermine quelle timeframe influence le plus la décision
   - Recommandation: Tester variations ±20%
   - Fichier: `StatisticalContextService.js:533`

2. **Confidence weights** (4 valeurs)
   - Impact: Change la composition du score de confiance
   - Recommandation: Total doit = 1.0, tester redistributions
   - Fichier: `RegimeDetectionService.js:403`

3. **Recommendation thresholds** (5 valeurs)
   - Impact: Détermine quand TRADE vs WAIT
   - Recommandation: Tester variations ±0.05
   - Fichier: `MarketAnalysisService.js:76-107`

#### Niveau 2 - Important
4. **ADX thresholds** (3 valeurs)
   - Impact: Classification régime trending vs range
   - Recommandation: Tester variations ±5
   - Fichier: `RegimeDetectionService.js:20-24`

5. **ATR ratio thresholds** (2 valeurs)
   - Impact: Détection breakout vs compression
   - Recommandation: Tester variations ±0.1
   - Fichier: `RegimeDetectionService.js:31-34`

### 12.2 Paramètres Secondaires

#### Niveau 3 - Modéré
6. **RSI zones** (6 seuils)
   - Impact: Détection surachat/survente
   - Recommandation: Tester variations ±5
   - Fichier: `MomentumEnricher.js:99-110`

7. **Volume ratios** (4 seuils)
   - Impact: Détection volume anormal
   - Recommandation: Tester variations ±0.2
   - Fichier: `VolumeEnricher.js:79-89`

8. **Pattern confidence** (base + bonus)
   - Impact: Fiabilité des patterns détectés
   - Recommandation: Tester variations ±0.05
   - Fichier: `PatternDetector.js:53-62`

### 12.3 Stratégie d'Optimisation

#### Phase 1: Optimisation Globale
```
1. Multi-timeframe weights
2. Confidence weights
3. Recommendation thresholds
```
**Objectif:** Maximiser le Sharpe Ratio global

#### Phase 2: Optimisation par Régime
```
4. ADX thresholds
5. ER thresholds
6. ATR ratio thresholds
```
**Objectif:** Améliorer performance dans chaque type de marché

#### Phase 3: Fine-tuning
```
7. RSI zones
8. Volume thresholds
9. Pattern parameters
```
**Objectif:** Réduction des faux signaux

### 12.4 Métriques de Backtesting

#### Métriques Globales
- Sharpe Ratio
- Maximum Drawdown
- Win Rate
- Profit Factor
- Total Return

#### Métriques par Régime
- Performance en trending_bullish
- Performance en trending_bearish
- Performance en range_*
- Performance en breakout_*

#### Métriques par Timeframe
- Impact relatif 1d vs 4h vs 1h
- Corrélation poids vs performance
- Optimal weight distribution

### 12.5 Plages de Variation Suggérées

```javascript
// Multi-timeframe weights (±30%)
'5m': [0.35, 0.65]
'15m': [0.56, 1.04]
'30m': [0.70, 1.30]
'1h': [1.05, 1.95]
'4h': [1.40, 2.60]
'1d': [2.10, 3.90]  // Le plus critique

// Recommendation thresholds (±0.1)
TRADE: [0.70, 0.90]
PREPARE: [0.60, 0.80]
CAUTION: [0.50, 0.70]

// ADX thresholds (±10)
weak: [10, 30]
trending: [15, 35]
strong: [30, 50]

// Confidence weights (contraints: sum = 1.0)
regimeClarity: [0.25, 0.45]
coherence: [0.20, 0.40]
direction: [0.10, 0.30]
efficiencyRatio: [0.05, 0.25]
```

### 12.6 Approches d'Optimisation

#### Grid Search
- Discrétiser chaque paramètre en 5-10 valeurs
- Tester toutes combinaisons
- Computationnellement intensif mais exhaustif

#### Genetic Algorithm
- Population de 50-100 configurations
- Évolution sur 100-200 générations
- Bon équilibre performance/temps

#### Bayesian Optimization
- Échantillonnage intelligent de l'espace paramétrique
- Convergence rapide vers optimum local
- Recommandé pour phase 1

#### Walk-Forward Analysis
- Optimisation sur période N
- Test sur période N+1
- Validation robustesse temporelle

### 12.7 Données de Backtesting

#### Période Minimum
- **Trending markets:** 6 mois minimum
- **Range markets:** 6 mois minimum
- **Breakout events:** 20+ événements
- **Total recommandé:** 2-3 ans

#### Granularité
- Timeframe principal: 1h
- Données requises: 1d, 4h, 1h simultanément
- Synchronisation: Alignment timestamps critiques

#### Qualité
- Gaps de données < 1%
- Volume data disponible
- Données corporate actions ajustées

---

## Résumé Statistique

### Distribution des Paramètres

| Catégorie | Nombre | Priorité | Impact |
|-----------|--------|----------|--------|
| Regime Detection | 19 | Haute | Majeur |
| Multi-TF Alignment | 9 | Critique | Majeur |
| Recommendations | 8 | Critique | Majeur |
| Confidence Weights | 4 | Critique | Majeur |
| Moving Averages | 10 | Moyenne | Modéré |
| Momentum | 15 | Haute | Modéré |
| Volatility | 20 | Haute | Modéré |
| Volume | 12 | Moyenne | Faible |
| Patterns | 25 | Basse | Faible |
| Bar Counts | 24 | Basse | Faible |

**Total: ~200+ paramètres configurables**

### Effort d'Optimisation Estimé

| Phase | Paramètres | Combinaisons | Temps CPU | Priorité |
|-------|-----------|--------------|-----------|----------|
| Phase 1 | 18 | ~10^6 | 1-2 semaines | Critique |
| Phase 2 | 8 | ~10^4 | 2-3 jours | Haute |
| Phase 3 | 30 | ~10^8 | 1-2 mois | Moyenne |

---

## Notes de Version

### Version 1.0 (2026-01-09)
- Documentation initiale
- Extraction exhaustive des paramètres
- Recommandations backtesting

### Changelog
- **2026-01-09:** Création du document après fix du bug analysisDate
- Identification de 200+ paramètres configurables
- Structuration pour optimisation systematique

---

## Contact & Contribution

Pour questions ou suggestions d'amélioration de cette documentation:
- Créer une issue sur le repository
- Proposer des PR avec modifications

**Note:** Ce document doit être mis à jour lors de tout changement de paramètres dans le code source.

---

## 12. LOOKBACK PERIODS

**Fichier:** `src/Trading/MarketAnalysis/config/lookbackPeriods.js`  
**Date ajout:** 2026-01-11  
**Total paramètres:** 30

**Description:** Configuration centralisée de toutes les périodes de lookback historique utilisées pour les calculs statistiques, détection de tendances, patterns, et analyse de volume. Remplace 48+ magic numbers hardcodés à travers le codebase.

**Impact:** Ces paramètres déterminent la quantité d'historique utilisée pour chaque calcul. Modifier ces valeurs affecte directement la réactivité vs stabilité des signaux.

---

### 12.1 STATISTICAL_PERIODS

**Total paramètres:** 3  
**Usage:** Calculs de percentiles, moyennes, ranges typiques, statistiques générales

```javascript
export const STATISTICAL_PERIODS = {
    short: 20,    // Court-terme (~20 bars)
    medium: 50,   // Moyen-terme (~50 bars)
    long: 90      // Long-terme (max pour anomaly detection)
};
```

#### 12.1.1 `short` (20)

**Utilisé dans:**
- RSI percentile 20 jours (MomentumEnricher)
- Structure de prix récente (PriceActionEnricher)
- Divergences EMA (MovingAveragesEnricher)
- Bandwidth Bollinger Bands récent (VolatilityEnricher)
- Breakout levels (PriceActionEnricher)

**Impact si augmenté (ex: 25-30):**
- ➕ Plus stable, moins de faux signaux
- ➕ Meilleure vision du contexte récent
- ➖ Plus lent à réagir aux changements
- ➖ Peut manquer des mouvements rapides

**Impact si diminué (ex: 15):**
- ➕ Plus réactif aux changements récents
- ➕ Capture mieux les micro-tendances
- ➖ Plus sensible au bruit
- ➖ Plus de faux signaux

**Range recommandé:** 15-30  
**Priorité backtesting:** 🔴 HAUTE

---

#### 12.1.2 `medium` (50)

**Utilisé dans:**
- RSI percentile 50 jours (MomentumEnricher)
- RSI mean et typical range (MomentumEnricher)
- ATR percentile et mean (VolatilityEnricher)
- Bollinger Bands width percentile (VolatilityEnricher)
- OBV percentile (VolumeEnricher)

**Impact si augmenté (ex: 60-70):**
- ➕ Vision plus large, capture mieux les cycles
- ➕ Statistiques plus robustes
- ➖ Moins réactif aux changements récents
- ➖ Peut être en retard sur les reversals

**Impact si diminué (ex: 30-40):**
- ➕ Plus adaptatif aux nouvelles conditions
- ➕ Meilleure détection des changements de régime
- ➖ Statistiques moins stables
- ➖ Plus influencé par les anomalies récentes

**Range recommandé:** 40-70  
**Priorité backtesting:** 🔴 HAUTE

---

#### 12.1.3 `long` (90)

**Utilisé dans:**
- Détection d'anomalies statistiques (StatisticalContextService)
- Analyse long-terme des indicateurs

**Impact si augmenté (ex: 100-120):**
- ➕ Anomalies plus significatives
- ➕ Meilleure détection des événements exceptionnels
- ➖ Nécessite plus de données historiques
- ➖ ⚠️ Attention aux contraintes bar counts!

**Impact si diminué (ex: 60-80):**
- ➕ Détection plus sensible
- ➕ Fonctionne avec moins d'historique
- ➖ Risque de faux positifs
- ➖ Anomalies moins significatives

**Range recommandé:** 60-120  
**Contrainte:** MAX 90 pour timeframes 1h/4h (limite bar counts)  
**Priorité backtesting:** 🟡 MOYENNE

---

### 12.2 TREND_PERIODS

**Total paramètres:** 4  
**Usage:** Détection de tendances, slopes, rate of change

```javascript
export const TREND_PERIODS = {
    immediate: 5,   // Tendance immédiate (5 bars)
    short: 10,      // Tendance court-terme
    medium: 20,     // Tendance moyen-terme
    long: 50        // Tendance long-terme
};
```

#### 12.2.1 `immediate` (5)

**Utilisé dans:**
- Rate of change immédiat (StatisticalContextService)
- Histogram MACD trend (MomentumEnricher)
- ATR trend analysis (VolatilityEnricher)
- Candle patterns récents (PriceActionEnricher)

**Impact si augmenté (ex: 7-10):**
- ➕ Trends plus confirmées
- ➕ Moins de bruit
- ➖ Perd la réactivité immédiate

**Impact si diminué (ex: 3):**
- ➕ Extrêmement réactif
- ➖ Très sensible au bruit
- ➖ Beaucoup de faux signaux

**Range recommandé:** 3-10  
**Priorité backtesting:** 🟢 BASSE (très spécialisé)

---

#### 12.2.2 `short` (10)

**Utilisé dans:**
- Tendance RSI (MomentumEnricher)
- Tendance ATR (VolatilityEnricher)
- Slopes EMA court-terme (MovingAveragesEnricher)
- Detection peaks RSI/prix (MomentumEnricher)
- Micro patterns (PriceActionEnricher)

**Impact si augmenté (ex: 12-15):**
- ➕ Tendances plus stables
- ➕ Meilleur filtrage du bruit
- ➖ Moins réactif

**Impact si diminué (ex: 7-8):**
- ➕ Très réactif
- ➕ Capture les micro-mouvements
- ➖ Plus de faux signaux

**Range recommandé:** 7-15  
**Priorité backtesting:** 🔴 HAUTE

---

#### 12.2.3 `medium` (20)

**Utilisé dans:**
- Tendance prix principale (StatisticalContextService)
- Divergences RSI/MACD (MomentumEnricher)
- Slopes EMA moyen-terme (MovingAveragesEnricher)
- Rate of change 10 bars (StatisticalContextService)

**Impact si augmenté (ex: 25-30):**
- ➕ Capture la tendance principale sans bruit
- ➕ Divergences plus significatives
- ➖ Détection plus tardive

**Impact si diminué (ex: 15):**
- ➕ Plus réactif aux changements
- ➖ Peut confondre corrections et reversals

**Range recommandé:** 15-30  
**Priorité backtesting:** 🔴 HAUTE

---

#### 12.2.4 `long` (50)

**Utilisé dans:**
- Tendances long-terme
- Support/resistance identification

**Impact si augmenté (ex: 60-100):**
- ➕ Tendance primaire très stable
- ➖ Très lent à réagir

**Impact si diminué (ex: 30-40):**
- ➕ Plus adaptatif
- ➖ Peut perdre la vue d'ensemble

**Range recommandé:** 40-100  
**Priorité backtesting:** 🟡 MOYENNE

---

### 12.3 PATTERN_PERIODS

**Total paramètres:** 14  
**Usage:** Détection de patterns chartistes (flags, triangles, H&S, etc.)

```javascript
export const PATTERN_PERIODS = {
    // Base patterns
    swingLookback: 30,
    structureLookback: 80,
    microPattern: 10,
    recentAction: 3,
    
    // Pattern-specific
    minimumBars: 30,
    range24h: 24,
    
    // Flag patterns
    flagRecent: 30,
    poleMinLength: 15,
    poleSearchStart: 15,
    poleSearchEnd: 8,
    flagMinLength: 5,
    flagMaxLength: 15,
    
    // Swing detection
    triangleSwingBars: 60,
    wedgeSwingBars: 60,
    headShouldersSwingBars: 80,
    doublePatternBars: 50
};
```

#### 12.3.1 `swingLookback` (30)

**Utilisé dans:** Identification des swing points (PriceActionEnricher)

**Impact:** Détermine combien de bars en arrière chercher pour les points de swing.

**Range recommandé:** 20-50  
**Priorité:** 🟡 MOYENNE

---

#### 12.3.2 `structureLookback` (80)

**Utilisé dans:** Analyse de structure de prix (PriceActionEnricher, PatternDetector)

**Impact:** Plus élevé = patterns plus larges détectés

**Range recommandé:** 60-100  
**Priorité:** 🟡 MOYENNE

---

#### 12.3.3 `microPattern` (10)

**Utilisé dans:** 
- Micro structure (PriceActionEnricher)
- Basic price action (StatisticalContextService)
- Recent highs/lows (PriceActionEnricher)

**Impact:** Patterns très court-terme, très sensible au bruit si trop bas.

**Range recommandé:** 8-15  
**Priorité:** 🟡 MOYENNE

---

#### 12.3.4 `recentAction` (3)

**Utilisé dans:** Actions immédiates, dernières barres

**Impact:** Très spécialisé, rarement modifié

**Range recommandé:** 2-5  
**Priorité:** 🟢 BASSE

---

#### 12.3.5 Flag Pattern Parameters (6 paramètres)

**`flagRecent` (30):** Bars pour détecter flag  
**`poleMinLength` (15):** Longueur min du pole  
**`poleSearchStart` (15):** Début recherche pole  
**`poleSearchEnd` (8):** Fin recherche pole  
**`flagMinLength` (5):** Durée min du flag  
**`flagMaxLength` (15):** Durée max du flag  

**Impact global:** Détermine la sensibilité de détection des bull/bear flags.

**Si valeurs plus strictes (augmenter min, diminuer max):**
- ➕ Flags plus fiables
- ➖ Moins de détections

**Si valeurs plus permissives:**
- ➕ Plus de détections
- ➖ Plus de faux positifs

**Range recommandé:**
- flagMinLength: 3-7
- flagMaxLength: 12-20
- poleMinLength: 10-20

**Priorité:** 🟡 MOYENNE

---

#### 12.3.6 Swing Detection Parameters (4 paramètres)

**`triangleSwingBars` (60):** Bars pour swings de triangles  
**`wedgeSwingBars` (60):** Bars pour swings de wedges  
**`headShouldersSwingBars` (80):** Bars pour H&S  
**`doublePatternBars` (50):** Bars pour double top/bottom  

**Impact:** Plus de bars = patterns plus larges, plus significatifs mais moins fréquents.

**Range recommandé:** 40-100  
**Priorité:** 🟡 MOYENNE

---

### 12.4 PATTERN_ATR_MULTIPLIERS

**Total paramètres:** 2  
**Usage:** Multiplicateurs ATR pour déterminer la significativité des swings

```javascript
export const PATTERN_ATR_MULTIPLIERS = {
    normalSwing: 1.3,      // Swings standards
    significantSwing: 1.5  // Swings significatifs (H&S)
};
```

#### 12.4.1 `normalSwing` (1.3)

**Utilisé dans:** Triangles, wedges, double tops/bottoms

**Impact si augmenté (ex: 1.5-1.7):**
- ➕ Swings plus significatifs uniquement
- ➕ Moins de faux patterns
- ➖ Moins de détections

**Impact si diminué (ex: 1.0-1.2):**
- ➕ Plus de patterns détectés
- ➖ Plus de faux positifs

**Range recommandé:** 1.0-1.7  
**Priorité:** 🔴 HAUTE

---

#### 12.4.2 `significantSwing` (1.5)

**Utilisé dans:** Head & Shoulders (patterns majeurs)

**Impact:** Similaire à normalSwing mais pour patterns plus importants.

**Range recommandé:** 1.3-2.0  
**Priorité:** 🟡 MOYENNE

---

### 12.5 VOLUME_PERIODS

**Total paramètres:** 4  
**Usage:** Analyse de volume, OBV, divergences prix-volume

```javascript
export const VOLUME_PERIODS = {
    average: 20,        // Moyenne mobile volume
    recentBars: 3,      // Barres récentes à analyser
    obvTrend: 20,       // Tendance OBV
    divergence: 10      // Divergence prix-volume
};
```

#### 12.5.1 `average` (20)

**Utilisé dans:** 
- Calcul volume moyen (VolumeEnricher)
- Ratio volume actuel vs moyen

**Impact:** Définit ce qui est considéré "volume normal".

**Range recommandé:** 15-30  
**Priorité:** 🔴 HAUTE

---

#### 12.5.2 `recentBars` (3)

**Utilisé dans:** Analyse des barres de volume les plus récentes

**Impact:** Très court-terme, capture activité immédiate.

**⚠️ NOTE:** Avant refactoring, le code utilisait 10! Maintenant corrigé à 3 (cohérent).

**Range recommandé:** 3-5  
**Priorité:** 🟢 BASSE

---

#### 12.5.3 `obvTrend` (20)

**Utilisé dans:** Détection de tendance OBV

**Impact:** Plus élevé = trend OBV plus stable.

**Range recommandé:** 15-30  
**Priorité:** 🟡 MOYENNE

---

#### 12.5.4 `divergence` (10)

**Utilisé dans:** Détection divergence prix-OBV

**Impact:** Fenêtre pour comparer prix vs OBV.

**⚠️ NOTE:** Avant refactoring, le code utilisait 20! Maintenant corrigé à 10 (cohérent).

**Range recommandé:** 10-20  
**Priorité:** 🔴 HAUTE (divergences critiques)

---

### 12.6 SUPPORT_RESISTANCE_PERIODS

**Total paramètres:** 3  
**Usage:** Identification S/R, clusters, validation

```javascript
export const SUPPORT_RESISTANCE_PERIODS = {
    lookback: 50,           // Historique S/R
    clusterWindow: 30,      // Fenêtre clusters
    validationBars: 10      // Validation niveau
};
```

#### 12.6.1 `lookback` (50)

**Utilisé dans:**
- Identification S/R (StatisticalContextService)
- Swing points (PriceActionEnricher)

**Impact:** Plus élevé = S/R basés sur historique plus long, plus robustes.

**Range recommandé:** 40-80  
**Priorité:** 🔴 HAUTE

---

#### 12.6.2 `clusterWindow` (30)

**Utilisé dans:** Identification de zones de S/R (clusters de niveaux)

**Impact:** Fenêtre pour regrouper les niveaux proches.

**Range recommandé:** 20-50  
**Priorité:** 🟡 MOYENNE

---

#### 12.6.3 `validationBars` (10)

**Utilisé dans:** Validation qu'un niveau S/R tient

**Impact:** Plus élevé = niveau doit tenir plus longtemps pour être validé.

**Range recommandé:** 5-15  
**Priorité:** 🟡 MOYENNE

---

### 12.7 Validation et Contraintes

**Contrainte critique:** `max(all lookback periods) ≤ min(INDICATOR_BAR_COUNTS for medium/full contexts)`

**Actuellement:**
- Max lookback: 90 (STATISTICAL_PERIODS.long)
- Min bar count (1h/4h): 150
- ✅ Validation: 90 < 150 OK

**⚠️ Si tu augmentes un lookback period > 150:**
- ❌ Tests échoueront
- ❌ Erreurs à runtime pour 1h/4h timeframes
- ✅ Solution: Augmenter INDICATOR_BAR_COUNTS ou réduire lookback

**Script de validation:**
```bash
node scripts/validate-critical-fixes.js
```

---

### 12.8 Guide d'Optimisation

#### Stratégie Scalping (Haute Fréquence)

```javascript
// Réduis tous les lookbacks pour plus de réactivité
STATISTICAL_PERIODS = { short: 10, medium: 30, long: 60 };
TREND_PERIODS = { immediate: 3, short: 7, medium: 15, long: 30 };
VOLUME_PERIODS = { average: 15, recentBars: 3, obvTrend: 15, divergence: 10 };
```

**Résultat:** Signaux rapides, plus de trades, plus de bruit

---

#### Stratégie Position (Long-terme)

```javascript
// Augmente lookbacks pour stabilité
STATISTICAL_PERIODS = { short: 30, medium: 70, long: 120 };
TREND_PERIODS = { immediate: 10, short: 20, medium: 40, long: 100 };
VOLUME_PERIODS = { average: 30, recentBars: 5, obvTrend: 30, divergence: 20 };
```

**Résultat:** Signaux stables, moins de trades, moins de faux signaux

---

#### Stratégie Swing (Équilibrée)

```javascript
// Valeurs actuelles = bon équilibre
// Optimiser individuellement selon backtests
```

---

### 12.9 Priorités de Backtesting

**Paramètres à tester EN PREMIER (impact le plus élevé):**

1. 🔴 `STATISTICAL_PERIODS.short` (20)
2. 🔴 `STATISTICAL_PERIODS.medium` (50)
3. 🔴 `TREND_PERIODS.short` (10)
4. 🔴 `TREND_PERIODS.medium` (20)
5. 🔴 `VOLUME_PERIODS.average` (20)
6. 🔴 `VOLUME_PERIODS.divergence` (10)
7. 🔴 `SUPPORT_RESISTANCE_PERIODS.lookback` (50)
8. 🔴 `PATTERN_ATR_MULTIPLIERS.normalSwing` (1.3)

**Paramètres secondaires:**

9. 🟡 `STATISTICAL_PERIODS.long` (90)
10. 🟡 `TREND_PERIODS.long` (50)
11. 🟡 Tous les PATTERN_PERIODS

**Paramètres spécialisés (tester si focus sur patterns):**

12. 🟢 `TREND_PERIODS.immediate` (5)
13. 🟢 `PATTERN_PERIODS.recentAction` (3)
14. 🟢 `VOLUME_PERIODS.recentBars` (3)

---

### 12.10 Exemples de Backtesting Paramétrique

#### Exemple 1: Grid Search sur STATISTICAL_PERIODS.short

```javascript
const results = [];
for (let short = 15; short <= 30; short += 5) {
    STATISTICAL_PERIODS.short = short;
    const performance = runBacktest(startDate, endDate);
    results.push({ short, sharpe: performance.sharpe, trades: performance.trades });
}
// Analyser results pour trouver optimal
```

#### Exemple 2: Optimisation Multi-Paramètres

```javascript
const configs = [
    { short: 15, medium: 40, trendShort: 8 },
    { short: 20, medium: 50, trendShort: 10 },  // Actuel
    { short: 25, medium: 60, trendShort: 12 },
];

for (const cfg of configs) {
    STATISTICAL_PERIODS.short = cfg.short;
    STATISTICAL_PERIODS.medium = cfg.medium;
    TREND_PERIODS.short = cfg.trendShort;
    // Run backtest et comparer
}
```

---

**Total nouveaux paramètres optimisables:** 30  
**Total paramètres système (avec bar counts):** 62+  
**Fichier configuration:** `src/Trading/MarketAnalysis/config/lookbackPeriods.js`
