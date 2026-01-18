# Flux d'exécution de `/api/v1/context/enriched`

## Étape 1 : Route Handler

**Fichier:** [routes.js:317-346](src/routes.js#L317-L346)

- Extraction des paramètres : `symbol`, `long`, `medium`, `short`, `analysisDate`
- Validation : `symbol` requis + au moins un timeframe
- Construction de l'objet `timeframes` (ex: `{ long: '1d', medium: '4h', short: '1h' }`)
- Appel à `marketAnalysisService.generateMarketAnalysis()`

## Étape 2 : generateMarketAnalysis

**Fichier:** [MarketAnalysisService.js:39-70](src/Trading/MarketAnalysis/MarketAnalysisService.js#L39-L70)

1. Appelle `statisticalContextService.generateFullContext()`
2. Extrait l'alignement multi-timeframe
3. Génère une **recommandation** (TRADE/PREPARE/CAUTION/WAIT)
4. Évalue la **qualité** de l'alignement (excellent/good/fair/poor)

## Étape 3 : StatisticalContextService.generateFullContext

**Fichier:** [StatisticalContextService.js:50-124](src/Trading/MarketAnalysis/StatisticalContext/StatisticalContextService.js#L50-L124)

1. **Parse les timeframes** et les trie par ordre décroissant
2. **Pour chaque timeframe** (du plus long au plus court) :
   - `_generateTimeframeContext()` qui :
     - **Charge les données OHLCV** via `dataProvider.loadOHLCV()` (avec bar count adaptatif)
     - **Détecte le régime** via `regimeDetectionService.detectRegime()`
     - **Exécute les 6 Enrichers** selon la profondeur de contexte :
       - `maEnricher` → Moyennes mobiles (EMA 8/21/50/200)
       - `momentumEnricher` → RSI, MACD, Stochastic
       - `volatilityEnricher` → ATR, Bollinger Bands
       - `volumeEnricher` → Volume, OBV
       - `priceActionEnricher` → Structure des prix
       - `patternDetector` → Micro-patterns (niveau "full" seulement)
     - **Identifie supports/résistances**
     - **Vérifie la cohérence** des signaux
3. **Analyse l'alignement multi-timeframe** : compare les directions et détecte les conflits
4. Retourne les métadonnées + contexte par temporalité + alignement

## Étape 4 : Génération des recommandations

**Fichier:** [MarketAnalysisService.js:76-115](src/Trading/MarketAnalysis/MarketAnalysisService.js#L76-L115)

| Score d'alignement | Conditions | Action |
|-------------------|------------|--------|
| ≥ 0.8 | Direction claire | `TRADE_BULLISH/BEARISH` |
| ≥ 0.7 | Sans conflits modérés | `PREPARE_BULLISH/BEARISH` |
| ≥ 0.6 | - | `CAUTION` |
| < 0.6 | - | `WAIT` |

## Résumé visuel

```
Route Handler
     │
     ▼
MarketAnalysisService.generateMarketAnalysis()
     │
     ├── StatisticalContextService.generateFullContext()
     │       │
     │       └── Pour chaque timeframe (long → medium → short):
     │               │
     │               ├── DataProvider.loadOHLCV()
     │               ├── RegimeDetectionService.detectRegime()
     │               └── 6 Enrichers:
     │                     • MomentumEnricher
     │                     • VolatilityEnricher
     │                     • VolumeEnricher
     │                     • MovingAveragesEnricher
     │                     • PriceActionEnricher
     │                     • PatternDetector
     │
     ├── _analyzeMultiTimeframeAlignment()
     │
     ▼
Recommandation + Qualité + Conflits
```
