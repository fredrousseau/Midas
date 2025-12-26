# Analyse de l'algorithme MarketAnalysisService

## Architecture Globale

Le **MarketAnalysisService** est un orchestrateur qui coordonne trois services spécialisés pour générer une analyse de marché complète avec des recommandations de trading.

```
MarketAnalysisService
├── RegimeDetectionService    (Détection du régime de marché)
├── StatisticalContextService (Génération du contexte statistique)
└── TradingContextService     (Génération des décisions de trading)
```

## Flux Principal : `generateEnrichedContext()`

### 1️⃣ Génération du Contexte Statistique

Le service délègue à `StatisticalContextService.generateFullContext()` :

#### A. Traitement Multi-Timeframe (du plus haut au plus bas)

Pour chaque timeframe (ex: 1d → 4h → 1h):

**Profondeur Contextuelle Adaptative:**
- **Light** (1d, 1w): Moyennes mobiles + ADX + price action basique
- **Medium** (4h): + RSI, MACD, ATR, Bollinger Bands, Volume, PSAR, Support/Résistance
- **Full** (1h et moins): + Micro-patterns, Swing points détaillés

**Enrichisseurs Spécialisés:**
```javascript
MovingAveragesEnricher  → EMA12/26/50/200 + alignement
MomentumEnricher        → RSI + MACD + Divergences + comparaison HTF
VolatilityEnricher      → ATR + Bollinger Bands + squeeze detection
VolumeEnricher          → Volume + OBV + interprétation
PriceActionEnricher     → Bougies, wicks, swing points
PatternDetector         → Bull/bear flags, triangles, etc.
```

#### B. Détection du Régime (pour chaque timeframe)

`RegimeDetectionService.detectRegime()` utilise:
- **ADX** (Average Directional Index) - Force de la tendance
- **ER** (Efficiency Ratio) - Efficacité du mouvement
- **ATR Ratio** (ATR court/long) - Volatilité relative
- **EMAs** (20/50) - Direction

**Classification des Régimes:**
```
trending_bullish/bearish   → ADX ≥ 25 + ER ≥ 0.5 + direction confirmée
range_low_vol              → ATR ratio < 0.8
range_normal               → ADX faible + ATR ratio normal
range_high_vol             → ATR ratio > 1.3
breakout_bullish/bearish   → ATR ratio > 1.3 + ADX > 25
```

**Score de Confiance** (0-1) basé sur:
- Clarté du régime (ADX)
- Cohérence ER/régime
- Force directionnelle
- Alignement des signaux

#### C. Analyse Multi-Timeframe

Calcul de l'**alignement** entre timeframes:
```javascript
alignment_score = max(bullish, bearish, neutral) / total_regimes
quality: perfect (≥0.8), good (≥0.6), mixed (≥0.4), poor
dominant_direction: bullish/bearish/ranging
conflicts: détection des divergences directionnelles
```

### 2️⃣ Génération du Contexte Trading

`TradingContextService.generate()` transforme l'analyse statistique en décisions:

#### A. Phase de Marché

Détermine la phase actuelle:
- Forte tendance
- Consolidation dans tendance
- Breakout
- Transition
- Conditions mixtes

#### B. Analyse des Scénarios

Génère 3 scénarios avec **probabilités normalisées**:

**Scénario Bullish:**
```javascript
rawScore = 40 (base)
  + 20 si alignement bullish
  + 10 si alignment_score > 0.7
  + 10 si H4 trending_bullish
  + 10 si micro-pattern bullish
→ Normalisé en probabilité (somme = 1.0)
```

Inclut:
- Trigger (niveau de déclenchement)
- Targets (3 niveaux avec probabilités)
- Stop loss
- Rationale

**Scénario Bearish:** (similaire, score de base généralement plus bas)

**Scénario Neutral:** Score augmente si marché ranging ou faible alignement

#### C. Stratégies d'Entrée

**Stratégie Primaire (breakout):**
- Direction (scénario à plus haute probabilité)
- Niveau d'entrée
- Confirmation (volume, clôture)
- Risk/Reward

**Stratégie Alternative (retest):**
- Entrée sur retest de support
- Stop plus serré
- R:R généralement favorable

#### D. Évaluation de la Qualité du Trade

Score composite (0-1) basé sur:
```javascript
overall = trend_alignment * 0.3
        + momentum * 0.2
        + volume * 0.15
        + pattern * 0.2
        + risk_reward * 0.15
```

#### E. Recommandation Finale

Logique décisionnelle:
```
SI quality > 0.75 ET prob > 0.65
  → "WAIT for breakout, then BUY/SELL"

SI quality > 0.60 ET prob > 0.55
  → "WAIT for confirmation"

SINON
  → "WAIT" (conflits ou qualité insuffisante)
```

## Schéma de Flux Complet

```
┌─────────────────────────────────────────────┐
│  INPUT: { symbol, timeframes, count }      │
└──────────────┬──────────────────────────────┘
               │
               ▼
┌──────────────────────────────────────────────┐
│  StatisticalContextService                   │
│  ┌──────────────────────────────────────┐   │
│  │ Pour chaque TF (1d → 4h → 1h):       │   │
│  │                                       │   │
│  │ 1. Load OHLCV                         │   │
│  │ 2. RegimeDetection                    │   │
│  │    ├─ ADX                             │   │
│  │    ├─ Efficiency Ratio                │   │
│  │    ├─ ATR Ratio                       │   │
│  │    └─ Direction (EMAs)                │   │
│  │    → regime + confidence              │   │
│  │                                       │   │
│  │ 3. Enrichers (selon profondeur):     │   │
│  │    ├─ MovingAverages                  │   │
│  │    ├─ Momentum (RSI, MACD)            │   │
│  │    ├─ Volatility (ATR, BB)            │   │
│  │    ├─ Volume (OBV)                    │   │
│  │    ├─ PriceAction                     │   │
│  │    └─ Patterns                        │   │
│  │                                       │   │
│  │ 4. Support/Resistance                 │   │
│  └──────────────────────────────────────┘   │
│                                              │
│  5. Multi-Timeframe Alignment               │
│     → alignment_score, conflicts            │
└──────────────┬───────────────────────────────┘
               │
               ▼ statistical_context
               │
┌──────────────┴───────────────────────────────┐
│  TradingContextService                       │
│                                              │
│  1. Market Phase                            │
│     → strong trend / consolidation / etc.   │
│                                              │
│  2. Scenario Analysis                       │
│     ├─ Bullish (score → probability)        │
│     ├─ Bearish (score → probability)        │
│     └─ Neutral (score → probability)        │
│                                              │
│  3. Entry Strategies                        │
│     ├─ Primary (breakout)                   │
│     └─ Alternative (retest)                 │
│                                              │
│  4. Risk Assessment                         │
│     → conflicts, divergences, etc.          │
│                                              │
│  5. Trade Quality Score                     │
│     → 0-1 composite score                   │
│                                              │
│  6. Recommendation                          │
│     → BUY / SELL / WAIT + confidence        │
└──────────────┬───────────────────────────────┘
               │
               ▼
┌──────────────────────────────────────────────┐
│  OUTPUT: Enriched Context                    │
│  ├─ timeframes: {...}                        │
│  ├─ multi_timeframe_alignment: {...}         │
│  └─ trading_context:                         │
│      ├─ current_market_phase                 │
│      ├─ scenario_analysis                    │
│      ├─ optimal_entry_strategy               │
│      ├─ risk_factors                         │
│      ├─ trade_quality_score                  │
│      └─ recommended_action                   │
└──────────────────────────────────────────────┘
```

## Points Clés de l'Algorithme

1. **Approche Top-Down**: Analyse du plus haut timeframe au plus bas pour contexte hiérarchique
2. **Profondeur Adaptative**: Détails minimaux sur HTF, analyse complète sur LTF
3. **Détection de Régime Robuste**: 4 indicateurs combinés (ADX, ER, ATR, EMAs)
4. **Probabilités Normalisées**: Les 3 scénarios totalisent toujours 100%
5. **Scoring Multi-Critères**: Qualité du trade évaluée sur 5 dimensions pondérées
6. **Recommandations Prudentes**: Privilégie WAIT si qualité ou alignement insuffisant

## Méthodes Utilitaires Principales

- `quickMultiTimeframeCheck()`: Analyse rapide de l'alignement multi-TF sans contexte complet
- `generateStatisticalContext()`: Contexte statistique seul (sans décisions)
- `generateTradingContext()`: Décisions à partir d'un contexte existant
- `detectRegime()`: Proxy vers RegimeDetectionService

## Références de Code

- Service principal: [MarketAnalysisService.js](src/Trading/MarketAnalysis/MarketAnalysisService.js)
- Contexte statistique: [StatisticalContextService.js](src/Trading/MarketAnalysis/StatisticalContext/StatisticalContextService.js)
- Contexte trading: [TradingContextService.js](src/Trading/MarketAnalysis/TradingContext/TradingContextService.js)
- Détection de régime: [RegimeDetectionService.js](src/Trading/MarketAnalysis/RegimeDetection/RegimeDetectionService.js)

---

## Règles Appliquées par Étape

### 📊 ÉTAPE 1 : Génération du Contexte Statistique

#### 1.A - Traitement Multi-Timeframe

**Règle de Profondeur Adaptative:**
```
SI timeframe IN ['1d', '1w'] → Profondeur = LIGHT
  ├─ Calculer: EMA12, EMA26, EMA50, EMA200
  ├─ Calculer: ADX
  └─ Analyser: Price action basique uniquement

SI timeframe = '4h' → Profondeur = MEDIUM
  ├─ Tout de LIGHT
  ├─ Ajouter: RSI, MACD, ATR, Bollinger Bands
  ├─ Ajouter: Volume, OBV
  ├─ Ajouter: PSAR
  └─ Ajouter: Support/Résistance

SI timeframe IN ['1h', '15m', '5m'] → Profondeur = FULL
  ├─ Tout de MEDIUM
  ├─ Ajouter: Micro-patterns détaillés
  ├─ Ajouter: Swing points précis
  └─ Ajouter: Analyse fine des divergences
```

**Règle d'Enrichissement Séquentiel:**
```
POUR chaque timeframe:
  1. MovingAveragesEnricher
     └─ Calculer EMAs + déterminer alignement (bullish/bearish/mixed)

  2. MomentumEnricher (si profondeur ≥ MEDIUM)
     ├─ RSI: overbought (>70), oversold (<30), divergences
     ├─ MACD: signal line cross, histogram, divergences
     └─ Comparaison avec timeframe supérieur

  3. VolatilityEnricher (si profondeur ≥ MEDIUM)
     ├─ ATR: niveau actuel vs historique
     ├─ Bollinger Bands: position du prix, squeeze detection
     └─ Classification: low/normal/high volatility

  4. VolumeEnricher (si profondeur ≥ MEDIUM)
     ├─ Volume relatif: comparaison avec moyenne
     ├─ OBV: tendance et divergences
     └─ Interprétation: confirmation/divergence avec prix

  5. PriceActionEnricher
     ├─ Analyse des bougies: doji, hammers, engulfing
     ├─ Wicks: rejection patterns
     └─ Swing points: highs/lows significatifs

  6. PatternDetector (si profondeur = FULL)
     └─ Détection: flags, triangles, wedges, channels
```

#### 1.B - Détection du Régime

**Règle de Classification par Indicateurs:**
```javascript
ADX = Average Directional Index (force de tendance)
ER = Efficiency Ratio (efficacité du mouvement)
ATR_ratio = ATR_court / ATR_long (volatilité relative)
direction = position prix vs EMA20/EMA50

// Règle 1: Trending
SI ADX ≥ 25 ET ER ≥ 0.5 ALORS
  SI direction = UP → regime = "trending_bullish"
  SI direction = DOWN → regime = "trending_bearish"

// Règle 2: Ranging Low Volatility
SI ATR_ratio < 0.8 ALORS
  regime = "range_low_vol"

// Règle 3: Ranging Normal
SI ADX < 25 ET ATR_ratio ENTRE [0.8, 1.3] ALORS
  regime = "range_normal"

// Règle 4: Ranging High Volatility
SI ATR_ratio > 1.3 ET ADX < 25 ALORS
  regime = "range_high_vol"

// Règle 5: Breakout
SI ATR_ratio > 1.3 ET ADX > 25 ALORS
  SI direction = UP → regime = "breakout_bullish"
  SI direction = DOWN → regime = "breakout_bearish"
```

**Règle de Calcul du Score de Confiance:**
```javascript
confidence = 0

// Contribution ADX (max 0.3)
SI ADX > 30 → confidence += 0.3
SI ADX ENTRE [25, 30] → confidence += 0.2
SINON → confidence += 0.1

// Contribution ER (max 0.25)
SI regime = trending ET ER > 0.6 → confidence += 0.25
SI regime = trending ET ER ENTRE [0.5, 0.6] → confidence += 0.15
SI regime = ranging ET ER < 0.3 → confidence += 0.25

// Contribution Direction (max 0.25)
SI direction claire (prix loin des EMAs) → confidence += 0.25
SINON → confidence += 0.1

// Contribution Cohérence (max 0.2)
SI tous les signaux alignés → confidence += 0.2
SINON → confidence += confidence_partielle

→ confidence normalisé sur [0, 1]
```

#### 1.C - Analyse Multi-Timeframe

**Règle d'Alignement:**
```javascript
bullish_count = 0
bearish_count = 0
neutral_count = 0
total_regimes = nombre_de_timeframes

POUR chaque regime:
  SI regime CONTIENT "bullish" OU "breakout_bullish" → bullish_count++
  SI regime CONTIENT "bearish" OU "breakout_bearish" → bearish_count++
  SI regime CONTIENT "range" → neutral_count++

alignment_score = MAX(bullish_count, bearish_count, neutral_count) / total_regimes

// Classification de la qualité
SI alignment_score ≥ 0.8 → quality = "perfect"
SI alignment_score ≥ 0.6 → quality = "good"
SI alignment_score ≥ 0.4 → quality = "mixed"
SINON → quality = "poor"

// Direction dominante
dominant = ARGMAX(bullish_count, bearish_count, neutral_count)
```

**Règle de Détection des Conflits:**
```javascript
conflicts = []

SI bullish_count > 0 ET bearish_count > 0 ALORS
  conflicts.push({
    type: "directional_divergence",
    severity: MIN(bullish_count, bearish_count) / total_regimes
  })

SI H4_regime = "trending" ET H1_regime = "ranging" ALORS
  conflicts.push({
    type: "timeframe_disagreement",
    description: "Higher TF trending but lower TF ranging"
  })

SI Daily_direction ≠ H4_direction ALORS
  conflicts.push({
    type: "trend_reversal_potential",
    severity: "high"
  })
```

---

### 💼 ÉTAPE 2 : Génération du Contexte Trading

#### 2.A - Détermination de la Phase de Marché

**Règle de Classification:**
```javascript
alignment = multi_timeframe_alignment
primary_regime = H4_regime OU H1_regime

// Règle 1: Forte Tendance
SI alignment.quality IN ["perfect", "good"]
   ET alignment.dominant IN ["bullish", "bearish"]
   ET primary_regime CONTIENT "trending"
ALORS
  phase = "strong_trend"
  direction = alignment.dominant

// Règle 2: Consolidation dans Tendance
SI alignment.dominant ≠ "ranging"
   ET current_TF_regime CONTIENT "range"
   ET higher_TF_regime CONTIENT "trending"
ALORS
  phase = "consolidation_in_trend"

// Règle 3: Breakout
SI primary_regime CONTIENT "breakout"
   ET ATR_ratio > 1.3
ALORS
  phase = "breakout"
  direction = regime_direction

// Règle 4: Transition
SI conflicts.length > 0
   ET alignment.quality = "mixed"
ALORS
  phase = "transition"

// Règle 5: Conditions Mixtes (défaut)
SINON
  phase = "mixed_conditions"
```

#### 2.B - Analyse des Scénarios

**Règle de Scoring Bullish:**
```javascript
bullish_score = 40 // Score de base

// Bonus alignement (max +30)
SI alignment.dominant = "bullish" → bullish_score += 20
SI alignment.score > 0.7 → bullish_score += 10

// Bonus régime H4 (max +10)
SI H4_regime = "trending_bullish" → bullish_score += 10
SI H4_regime = "breakout_bullish" → bullish_score += 8

// Bonus pattern (max +10)
SI micro_pattern = "bullish_flag" → bullish_score += 10
SI micro_pattern = "ascending_triangle" → bullish_score += 8

// Bonus momentum (max +15)
SI RSI ENTRE [40, 60] → bullish_score += 5  // Zone neutre favorable
SI MACD > signal_line → bullish_score += 5
SI RSI_divergence = "bullish" → bullish_score += 10

// Bonus volume (max +10)
SI volume > moyenne * 1.2 ET prix_up → bullish_score += 10

// Pénalités
SI RSI > 70 → bullish_score -= 10  // Overbought
SI bearish_count > 0 → bullish_score -= 10 * bearish_count
```

**Règle de Scoring Bearish:**
```javascript
bearish_score = 35 // Score de base (légèrement inférieur)

// Bonus alignement (max +30)
SI alignment.dominant = "bearish" → bearish_score += 20
SI alignment.score > 0.7 → bearish_score += 10

// Bonus régime H4 (max +10)
SI H4_regime = "trending_bearish" → bearish_score += 10
SI H4_regime = "breakout_bearish" → bearish_score += 8

// Bonus pattern (max +10)
SI micro_pattern = "bearish_flag" → bearish_score += 10
SI micro_pattern = "descending_triangle" → bearish_score += 8

// Bonus momentum (max +15)
SI RSI ENTRE [40, 60] → bearish_score += 5
SI MACD < signal_line → bearish_score += 5
SI RSI_divergence = "bearish" → bearish_score += 10

// Bonus volume (max +10)
SI volume > moyenne * 1.2 ET prix_down → bearish_score += 10

// Pénalités
SI RSI < 30 → bearish_score -= 10  // Oversold
SI bullish_count > 0 → bearish_score -= 10 * bullish_count
```

**Règle de Scoring Neutral:**
```javascript
neutral_score = 30 // Score de base

// Bonus ranging (max +30)
SI alignment.dominant = "ranging" → neutral_score += 25
SI neutral_count > bullish_count ET neutral_count > bearish_count → neutral_score += 15

// Bonus faible alignement (max +20)
SI alignment.score < 0.5 → neutral_score += 20

// Bonus régime (max +15)
SI primary_regime CONTIENT "range" → neutral_score += 15

// Bonus ADX faible (max +10)
SI ADX < 20 → neutral_score += 10

// Bonus conflits (max +15)
SI conflicts.length > 0 → neutral_score += 5 * conflicts.length (max 15)
```

**Règle de Normalisation des Probabilités:**
```javascript
total = bullish_score + bearish_score + neutral_score

bullish_probability = bullish_score / total
bearish_probability = bearish_score / total
neutral_probability = neutral_score / total

// Vérification: bullish_prob + bearish_prob + neutral_prob = 1.0
```

**Règle de Calcul des Targets:**
```javascript
current_price = dernière_clôture
ATR = Average True Range

POUR scenario IN [bullish, bearish]:
  direction = scenario.direction  // 1 pour bullish, -1 pour bearish

  // Target 1 (conservative) - Probabilité: 70%
  target1 = current_price + (direction * ATR * 1.0)
  target1_probability = 0.7

  // Target 2 (moderate) - Probabilité: 50%
  target2 = current_price + (direction * ATR * 2.0)
  target2_probability = 0.5

  // Target 3 (ambitious) - Probabilité: 30%
  target3 = current_price + (direction * ATR * 3.5)
  target3_probability = 0.3

  // Ajustement selon volatilité
  SI volatility = "high" ALORS
    target2_probability -= 0.1
    target3_probability -= 0.15

  // Stop Loss
  stop_loss = current_price - (direction * ATR * 1.5)
```

#### 2.C - Stratégies d'Entrée

**Règle de Stratégie Primaire (Breakout):**
```javascript
dominant_scenario = ARGMAX(bullish_prob, bearish_prob, neutral_prob)

SI dominant_scenario ≠ neutral ALORS

  // Niveau d'entrée
  SI direction = "bullish" ALORS
    entry_level = resistance_proche OU swing_high_récent
    confirmation = "Close above " + entry_level + " with volume"

  SI direction = "bearish" ALORS
    entry_level = support_proche OU swing_low_récent
    confirmation = "Close below " + entry_level + " with volume"

  // Risk/Reward
  distance_to_stop = ABS(entry_level - stop_loss)
  distance_to_target1 = ABS(target1 - entry_level)
  risk_reward = distance_to_target1 / distance_to_stop

  // Validation
  SI risk_reward < 1.5 ALORS
    warning = "Suboptimal R:R ratio"
```

**Règle de Stratégie Alternative (Retest):**
```javascript
SI phase = "consolidation_in_trend" OU phase = "breakout" ALORS

  SI higher_TF_direction = "bullish" ALORS
    alternative_entry = support_récent OU EMA50
    alternative_stop = support_suivant OU swing_low
    note = "Enter on retest after pullback"

  SI higher_TF_direction = "bearish" ALORS
    alternative_entry = resistance_récente OU EMA50
    alternative_stop = resistance_suivante OU swing_high
    note = "Enter on retest after bounce"

  // Généralement meilleur R:R
  alternative_RR = (target1 - alternative_entry) / (alternative_entry - alternative_stop)
```

#### 2.D - Évaluation de la Qualité du Trade

**Règle de Scoring Composite:**
```javascript
// 1. Trend Alignment (poids: 0.3)
trend_score = alignment.score  // déjà entre 0-1

// 2. Momentum (poids: 0.2)
momentum_score = 0

SI RSI ENTRE [40, 60] → momentum_score += 0.3  // Zone neutre
SI RSI_direction = scenario_direction → momentum_score += 0.3
SI MACD_direction = scenario_direction → momentum_score += 0.2
SI divergence = scenario_direction → momentum_score += 0.2

// 3. Volume (poids: 0.15)
volume_score = 0

SI volume_trend = scenario_direction → volume_score += 0.4
SI current_volume > avg_volume * 1.2 → volume_score += 0.3
SI OBV_direction = scenario_direction → volume_score += 0.3

// 4. Pattern (poids: 0.2)
pattern_score = 0

SI pattern_detecté ET pattern_direction = scenario_direction → pattern_score += 0.5
SI pattern_quality = "high" → pattern_score += 0.3
SI price_action = scenario_direction → pattern_score += 0.2

// 5. Risk/Reward (poids: 0.15)
rr_score = 0

SI risk_reward > 3 → rr_score = 1.0
SI risk_reward > 2 → rr_score = 0.8
SI risk_reward > 1.5 → rr_score = 0.6
SINON → rr_score = 0.3

// Score Final
trade_quality = (trend_score * 0.3)
              + (momentum_score * 0.2)
              + (volume_score * 0.15)
              + (pattern_score * 0.2)
              + (rr_score * 0.15)

→ trade_quality entre [0, 1]
```

#### 2.E - Recommandation Finale

**Règle Décisionnelle:**
```javascript
highest_prob_scenario = MAX(bullish_prob, bearish_prob, neutral_prob)
scenario_name = ARGMAX(bullish_prob, bearish_prob, neutral_prob)

// Règle 1: STRONG BUY/SELL
SI trade_quality > 0.75
   ET highest_prob_scenario > 0.65
   ET scenario_name ≠ "neutral"
   ET alignment.quality IN ["perfect", "good"]
ALORS
  SI scenario_name = "bullish" → action = "WAIT for breakout confirmation, then BUY"
  SI scenario_name = "bearish" → action = "WAIT for breakdown confirmation, then SELL"
  confidence = "high"

// Règle 2: MODERATE BUY/SELL
SI trade_quality > 0.60
   ET highest_prob_scenario > 0.55
   ET scenario_name ≠ "neutral"
ALORS
  action = "WAIT for strong confirmation before " + scenario_name.toUpperCase()
  confidence = "moderate"

// Règle 3: WAIT - Qualité insuffisante
SI trade_quality < 0.60 ALORS
  action = "WAIT - Trade quality insufficient"
  reason = "Low quality score: " + trade_quality
  confidence = "low"

// Règle 4: WAIT - Probabilité faible
SI highest_prob_scenario < 0.55 ALORS
  action = "WAIT - No clear directional bias"
  reason = "Highest scenario probability: " + highest_prob_scenario
  confidence = "low"

// Règle 5: WAIT - Conflits détectés
SI conflicts.length > 0 ET alignment.quality = "poor" ALORS
  action = "WAIT - Conflicting signals across timeframes"
  reason = conflicts.map(c => c.type).join(", ")
  confidence = "low"

// Règle 6: WAIT - Neutral dominant
SI scenario_name = "neutral" ET neutral_prob > 0.5 ALORS
  action = "WAIT - Market ranging, no clear trend"
  confidence = "moderate"
```

**Règle de Formatage de la Réponse:**
```javascript
recommendation = {
  action: action,  // "BUY" | "SELL" | "WAIT"
  confidence: confidence,  // "high" | "moderate" | "low"
  entry_price: primary_strategy.entry_level,
  stop_loss: primary_strategy.stop_loss,
  targets: [target1, target2, target3],
  risk_reward: primary_strategy.risk_reward,

  reasoning: {
    market_phase: current_market_phase,
    dominant_scenario: scenario_name,
    probability: highest_prob_scenario,
    quality_score: trade_quality,
    key_factors: top_contributing_factors,
    warnings: risk_factors
  },

  alternative_approach: alternative_strategy  // Si disponible
}
```

---

*Cette analyse détaillée expose toutes les règles et seuils utilisés à chaque étape du processus décisionnel de trading.*
