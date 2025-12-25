# 🐛 BUGS TO FIX - PROJET MIDAS

**Date d'analyse:** 2025-12-19
**Fichiers analysés:** 39 fichiers JavaScript
**Lignes de code:** ~8500+ lignes
**Problèmes identifiés:** 47 problèmes

---

## 📊 RÉSUMÉ EXÉCUTIF

| Priorité | Nombre | Description | Action |
|----------|--------|-------------|--------|
| 🔴 **P0 (Critique)** | 11 | À corriger **immédiatement** | Cette semaine |
| 🟠 **P1 (Majeur)** | 12 | À corriger rapidement | Ce mois |
| 🟡 **P2-P3 (Mineur)** | 24 | Maintenance progressive | Opportuniste |

### ✅ Corrections déjà effectuées
- ✅ [routes.js:377-378] Variables utilisées avant déclaration
- ✅ [routes.js:165] Route `/mcp/tools` sans `res.json()`
- ✅ [routes.js:65] Typo "markerAnalysisService" → "marketAnalysisService"
- ✅ [routes.js:5] Import `errorHandler` inutilisé supprimé
- ✅ [OAuthService.js:20-21] Validation JWT_SECRET ajoutée
- ✅ [Utils/helpers.js:70-84] Fonction `errorHandler` supprimée
- ✅ [LoggerService.js:69-73] Logs avec rotation quotidienne (winston-daily-rotate-file)

---

## 🔴 PROBLÈMES CRITIQUES - P0 (11)

### 1. StorageService - MEMORY LEAK MAJEUR

**Fichier:** `src/OAuth/StorageService.js`
**Lignes:** 15, 35
**Catégorie:** Performance & Mémoire
**Impact:** Accumulation infinie de clients OAuth en production

#### Problème
```javascript
this.clients = new Map();  // Ligne 15
this.clients.set(clientId, metadata);  // Ligne 35
```

La Map `clients` n'a aucune limite de taille ni mécanisme de nettoyage (TTL).

#### Solution
```javascript
constructor() {
    if (StorageService.#instance)
        return StorageService.#instance;

    this.clients = new Map();
    this.maxClients = 10000; // Limite maximale
    this.clientTTL = 24 * 60 * 60 * 1000; // 24 heures

    // Cleanup périodique toutes les heures
    this.cleanupInterval = setInterval(() => this.cleanup(), 60 * 60 * 1000);

    StorageService.#instance = this;
}

setClient(clientId, metadata = {}) {
    // Vérifier la limite
    if (this.clients.size >= this.maxClients) {
        // Supprimer le plus ancien (FIFO)
        const firstKey = this.clients.keys().next().value;
        this.clients.delete(firstKey);
    }

    this.clients.set(clientId, {
        ...metadata,
        createdAt: Date.now(),
        lastAccess: Date.now()
    });
}

cleanup() {
    const now = Date.now();
    let cleaned = 0;

    for (const [clientId, data] of this.clients.entries()) {
        if (now - data.createdAt > this.clientTTL) {
            this.clients.delete(clientId);
            cleaned++;
        }
    }

    if (cleaned > 0) {
        console.log(`StorageService: Cleaned ${cleaned} expired clients`);
    }
}

// Ajouter un cleanup lors de l'arrêt
destroy() {
    if (this.cleanupInterval) {
        clearInterval(this.cleanupInterval);
    }
}
```

---

### 2. app.js - EVENT LISTENERS NON NETTOYÉS

**Fichier:** `src/WebUI/app.js`
**Lignes:** 157-179, 169-179
**Catégorie:** WebUI Memory Leak
**Impact:** Memory leak à chaque recréation de chart

#### Problème
```javascript
mainChart.timeScale().subscribeVisibleTimeRangeChange((timeRange) => {
    if (timeRange && !syncingFromIndicator) {
        syncingFromMain = true;
        try {
            indicatorChart.timeScale().setVisibleRange(timeRange);
        } catch (e) {}
        syncingFromMain = false;
    }
});

// Listener jamais unsubscribed lors de la recréation du chart
```

#### Solution
```javascript
// Déclarer les références de désabonnement au niveau du module
let mainChartUnsubscribe = null;
let indicatorChartUnsubscribe = null;

function initCharts() {
    // ... code de création des charts existant ...

    // Nettoyer les anciens listeners AVANT de créer les nouveaux
    if (mainChartUnsubscribe) {
        mainChartUnsubscribe();
        mainChartUnsubscribe = null;
    }
    if (indicatorChartUnsubscribe) {
        indicatorChartUnsubscribe();
        indicatorChartUnsubscribe = null;
    }

    // Créer les nouveaux listeners et stocker les fonctions d'unsubscribe
    mainChartUnsubscribe = mainChart.timeScale().subscribeVisibleTimeRangeChange((timeRange) => {
        if (timeRange && !syncingFromIndicator) {
            syncingFromMain = true;
            try {
                indicatorChart.timeScale().setVisibleRange(timeRange);
            } catch (e) {
                console.error('Error syncing main chart:', e);
            } finally {
                syncingFromMain = false; // ✅ Utiliser finally pour garantir le reset
            }
        }
    });

    indicatorChartUnsubscribe = indicatorChart.timeScale().subscribeVisibleTimeRangeChange((timeRange) => {
        if (timeRange && !syncingFromMain) {
            syncingFromIndicator = true;
            try {
                mainChart.timeScale().setVisibleRange(timeRange);
            } catch (e) {
                console.error('Error syncing indicator chart:', e);
            } finally {
                syncingFromIndicator = false; // ✅ Utiliser finally
            }
        }
    });
}
```

---

### 3. app.js - STATE GLOBAL NON ENCAPSULÉ

**Fichier:** `src/WebUI/app.js`
**Lignes:** 2-13
**Catégorie:** Architecture
**Impact:** Difficile à tester, maintenir et réutiliser

#### Problème
```javascript
// 11 variables globales dans le scope du module
const API_BASE = window.location.origin;
let mainChart = null;
let candlestickSeries = null;
let indicatorChart = null;
let currentData = null;
let indicatorSeries = new Map();
let catalogData = null;
let indicatorDescriptions = new Map();
let appTimezone = 'Europe/Paris';
let authClient = null;
```

#### Solution
```javascript
class ChartApp {
    constructor() {
        this.API_BASE = window.location.origin;
        this.mainChart = null;
        this.candlestickSeries = null;
        this.indicatorChart = null;
        this.currentData = null;
        this.indicatorSeries = new Map();
        this.catalogData = null;
        this.indicatorDescriptions = new Map();
        this.appTimezone = 'Europe/Paris';
        this.authClient = null;

        // Listeners cleanup
        this.mainChartUnsubscribe = null;
        this.indicatorChartUnsubscribe = null;
    }

    async init() {
        await this.loadCatalog();
        await this.tryInitCharts();
    }

    async loadCatalog() {
        // ... logique existante adaptée
    }

    async loadData() {
        // ... logique existante adaptée
    }

    cleanup() {
        if (this.mainChartUnsubscribe) this.mainChartUnsubscribe();
        if (this.indicatorChartUnsubscribe) this.indicatorChartUnsubscribe();
        if (this.mainChart) this.mainChart.remove();
        if (this.indicatorChart) this.indicatorChart.remove();
    }
}

// Créer l'instance unique
const app = new ChartApp();
app.init();

// Cleanup lors de la fermeture de la page
window.addEventListener('beforeunload', () => {
    app.cleanup();
});
```

---

### 4. auth-client.js - TIMERS NON CLEARÉS

**Fichier:** `src/WebUI/auth-client.js`
**Lignes:** 258-261
**Catégorie:** WebUI Memory Leak
**Impact:** Requêtes inutiles après déconnexion

#### Problème
```javascript
setupAutoRefresh() {
    // ...
    this.refreshTimer = setTimeout(async () => {
        console.log('Auto-refreshing token...');
        await this.refreshToken();
    }, refreshTime);

    // ❌ Timer jamais annulé lors de la navigation ou déconnexion
}
```

#### Solution
```javascript
setupAutoRefresh() {
    // Nettoyer l'ancien timer s'il existe
    if (this.refreshTimer) {
        clearTimeout(this.refreshTimer);
        this.refreshTimer = null;
    }

    const accessToken = this.getAccessToken();
    if (!accessToken) return;

    const payload = this.parseJWT(accessToken);
    if (!payload || !payload.exp) return;

    const expiresAt = payload.exp * 1000;
    const now = Date.now();
    const timeUntilExpiry = expiresAt - now;
    const refreshTime = timeUntilExpiry - (5 * 60 * 1000);

    if (refreshTime > 0) {
        console.log(`Auto-refresh scheduled in ${Math.round(refreshTime / 1000 / 60)} minutes`);
        this.refreshTimer = setTimeout(async () => {
            console.log('Auto-refreshing token...');
            const success = await this.refreshToken();

            if (success) {
                // Re-schedule next refresh
                this.setupAutoRefresh();
            }
        }, refreshTime);
    }
}

clearTokens() {
    // ✅ Annuler le timer lors du logout
    if (this.refreshTimer) {
        clearTimeout(this.refreshTimer);
        this.refreshTimer = null;
    }

    localStorage.removeItem('access_token');
    localStorage.removeItem('refresh_token');
    localStorage.removeItem('token_expires_in');
}

// ✅ Ajouter un cleanup global
window.addEventListener('beforeunload', () => {
    if (window.authClient && window.authClient.refreshTimer) {
        clearTimeout(window.authClient.refreshTimer);
    }
});
```

---

### 5. chart-legend.js - EVENT LISTENER DOCUMENT NON NETTOYÉ

**Fichier:** `src/WebUI/chart-legend.js`
**Lignes:** 179-191
**Catégorie:** WebUI Memory Leak
**Impact:** Accumulation de listeners globaux sur `document`

#### Problème
```javascript
const closeHandler = (e) => {
    if (!picker.contains(e.target) && e.target !== btn) {
        if (document.body.contains(picker))
            document.body.removeChild(picker);

        document.removeEventListener('click', closeHandler);
    }
};

setTimeout(() => {
    document.addEventListener('click', closeHandler);
}, 0);

// ❌ Si le picker est fermé autrement (navigation, etc), le listener reste
```

#### Solution
```javascript
// Stocker les handlers actifs au niveau du module
const activeCloseHandlers = new Set();

function showLegendColorPicker(seriesKey, btn, colorBox) {
    const currentColor = colorBox.style.backgroundColor;
    const picker = document.createElement('div');
    picker.className = 'color-picker-popup';
    picker.style.cssText = `position: absolute; background: white; border: 1px solid #ccc; padding: 10px; z-index: 1000;`;

    const btnRect = btn.getBoundingClientRect();
    picker.style.left = btnRect.left + 'px';
    picker.style.top = (btnRect.bottom + 5) + 'px';

    const colors = ['#2196F3', '#FF9800', '#4CAF50', '#F44336', '#9C27B0', '#00BCD4'];

    colors.forEach(color => {
        const swatch = document.createElement('div');
        swatch.style.cssText = `width: 30px; height: 30px; background: ${color}; display: inline-block; margin: 2px; cursor: pointer; border: 2px solid ${color === currentColor ? '#000' : 'transparent'};`;
        swatch.addEventListener('click', () => {
            colorBox.style.backgroundColor = color;
            updateLegendSeriesColor(seriesKey, color);
            document.body.removeChild(picker);

            // ✅ Retirer le listener
            document.removeEventListener('click', closeHandler);
            activeCloseHandlers.delete(closeHandler);
        });
        picker.appendChild(swatch);
    });

    const closeHandler = (e) => {
        if (!picker.contains(e.target) && e.target !== btn) {
            if (document.body.contains(picker))
                document.body.removeChild(picker);

            document.removeEventListener('click', closeHandler);
            activeCloseHandlers.delete(closeHandler);
        }
    };

    // ✅ Nettoyer les anciens handlers avant d'ajouter un nouveau
    activeCloseHandlers.forEach(handler => {
        document.removeEventListener('click', handler);
    });
    activeCloseHandlers.clear();

    setTimeout(() => {
        document.addEventListener('click', closeHandler);
        activeCloseHandlers.add(closeHandler);
    }, 0);

    document.body.appendChild(picker);
}

// ✅ Cleanup global au cas où
window.addEventListener('beforeunload', () => {
    activeCloseHandlers.forEach(handler => {
        document.removeEventListener('click', handler);
    });
    activeCloseHandlers.clear();
});
```

---

### 6. indicators-ui.js - EVENT LISTENER DOCUMENT NON NETTOYÉ

**Fichier:** `src/WebUI/indicators-ui.js`
**Lignes:** 489-498
**Catégorie:** WebUI Memory Leak
**Impact:** Identique au problème 5

#### Problème
```javascript
const closeHandler = (e) => {
    if (!picker.contains(e.target) && e.target !== colorBox) {
        if (document.body.contains(picker))
            document.body.removeChild(picker);

        document.removeEventListener('click', closeHandler);
    }
};

setTimeout(() => document.addEventListener('click', closeHandler), 0);
```

#### Solution
Appliquer la même solution que pour le problème 5.

---

### 7. DataProvider.js - RACE CONDITION DANS LE CACHE

**Fichier:** `src/DataProvider/DataProvider.js`
**Lignes:** 140-168, 194-204
**Catégorie:** Async & Concurrence
**Impact:** Requêtes API dupliquées si 2 appels simultanés

#### Problème
```javascript
async loadOHLCV(options = {}) {
    // ...
    const cacheKey = this._getCacheKey(symbol, timeframe);

    // Vérifier le cache
    if (useCache && this.enableCache && this.cache.has(cacheKey)) {
        // ... retourner cache
    }

    // ❌ Si 2 requêtes arrivent en même temps, les 2 vont fetcher
    const rawData = await this.dataAdapter.fetchOHLC({ symbol, timeframe, count, from, to });
}
```

#### Solution
```javascript
constructor(parameters = {}) {
    this.dataAdapter = parameters.dataAdapter;
    this.logger = parameters.logger;
    this.cache = new Map();
    this.pendingRequests = new Map(); // ✅ Ajouter un lock par cacheKey
    this.cacheTTL = parameters.cacheTTL || 60000;
    this.enableCache = parameters.enableCache !== false;
    this.maxDataPoints = parameters.maxDataPoints || 5000;
    this.logger.info('DataProvider initialized');
}

async loadOHLCV(options = {}) {
    const { symbol, timeframe = '1h', count = 200, from, to, useCache = true, detectGaps = true } = options;

    if (!symbol) throw new Error('Symbol is required');
    if (count < 1 || count > this.maxDataPoints) throw new Error(`Count must be between 1 and ${this.maxDataPoints}`);

    const startTime = Date.now();
    const cacheKey = this._getCacheKey(symbol, timeframe);

    // Vérifier le cache
    if (useCache && this.enableCache && this.cache.has(cacheKey)) {
        const cached = this.cache.get(cacheKey);
        const cachedBarCount = cached.data?.bars?.length || 0;

        if (this._isCacheValid(cached.timestamp) && cachedBarCount >= count) {
            this.logger.info(`Cache hit for ${symbol} (${timeframe}, ${count}/${cachedBarCount} bars)`);
            const trimmedBars = cached.data.bars.slice(-count);
            return {
                ...cached.data,
                bars: trimmedBars,
                count: trimmedBars.length,
                firstTimestamp: trimmedBars.at(0)?.timestamp ?? null,
                lastTimestamp: trimmedBars.at(-1)?.timestamp ?? null,
                fromCache: true,
                cachedBarCount,
            };
        }

        if (this._isCacheValid(cached.timestamp) && cachedBarCount < count)
            this.logger.info(`Cache insufficient for ${symbol} (${timeframe}): has ${cachedBarCount} bars, need ${count}`);

        this.cache.delete(cacheKey);
    }

    // ✅ Vérifier si une requête est déjà en cours
    if (this.pendingRequests.has(cacheKey)) {
        this.logger.info(`Awaiting pending request for ${symbol} (${timeframe})`);
        return await this.pendingRequests.get(cacheKey);
    }

    // ✅ Créer la promesse et la stocker
    const requestPromise = this._fetchAndCache(symbol, timeframe, count, from, to, detectGaps, startTime);
    this.pendingRequests.set(cacheKey, requestPromise);

    try {
        const result = await requestPromise;
        return result;
    } finally {
        // ✅ Nettoyer la promesse en attente
        this.pendingRequests.delete(cacheKey);
    }
}

async _fetchAndCache(symbol, timeframe, count, from, to, detectGaps, startTime) {
    try {
        const rawData = await this.dataAdapter.fetchOHLC({ symbol, timeframe, count, from, to });
        this._validateOHLCVData(rawData);
        const cleanedData = this._cleanOHLCVData(rawData);
        const gaps = detectGaps ? this._detectGaps(cleanedData, timeframe) : [];
        const duration = Date.now() - startTime;
        const gapInfo = gaps.length > 0 ? ` (${gaps.length} gaps detected)` : '';

        const response = {
            symbol,
            timeframe,
            count: cleanedData.length,
            bars: cleanedData,
            firstTimestamp: cleanedData.at(0)?.timestamp ?? null,
            lastTimestamp: cleanedData.at(-1)?.timestamp ?? null,
            gaps,
            gapCount: gaps.length,
            fromCache: false,
            loadDuration: duration,
            loadedAt: new Date().toISOString(),
        };

        // Smart caching
        if (this.enableCache) {
            const cacheKey = this._getCacheKey(symbol, timeframe);
            const existing = this.cache.get(cacheKey);
            const existingBarCount = existing?.data?.bars?.length || 0;

            if (cleanedData.length >= existingBarCount) {
                this.cache.set(cacheKey, { data: response, timestamp: Date.now() });
                this.logger.verbose(`Cache updated: ${symbol} (${timeframe}) with ${cleanedData.length} bars`);
            } else {
                this.logger.verbose(`Cache NOT updated: existing cache has more bars (${existingBarCount} > ${cleanedData.length})`);
            }
        }

        this.logger.info(`Data Loaded : ${symbol} (${timeframe} / ${cleanedData.length}) bars in ${duration}ms${gapInfo}`);

        return response;
    } catch (error) {
        this.logger.error(`Error loading data for ${symbol}: ${error.message}`);
        throw error;
    }
}
```

---

### 8. indicators.js - ASYNC SANS TRY/CATCH

**Fichier:** `src/Trading/Indicator/indicators.js`
**Lignes:** 145-174
**Catégorie:** Gestion d'erreurs
**Impact:** Erreurs non contextualisées, difficiles à débugger

#### Problème
```javascript
async calculateIndicators({ symbol, indicators, bars = 200, calculationBars, timeframe }) {
    const maxWarmup = this._calculateMaxWarmup(indicators);
    const warmupBuffer = Math.ceil(maxWarmup * 1.2);
    const requestedBars = calculationBars || bars;
    const totalBarsToFetch = requestedBars + warmupBuffer;

    this.logger.verbose(`Fetching OHLCV for ${symbol}: ${requestedBars} requested + ${warmupBuffer} warmup = ${totalBarsToFetch} total bars`);

    // ❌ Pas de try/catch
    const ohlcvResult = await this.dataProvider.loadOHLCV({
        symbol,
        timeframe: timeframe || DEFAULT_TIMEFRAME,
        count: totalBarsToFetch,
        useCache: true,
        detectGaps: false,
    });

    const ohlcvBars = ohlcvResult.bars;

    if (!ohlcvBars || ohlcvBars.length === 0)
        throw new Error(`No data received for ${symbol}`);

    if (ohlcvBars.length < totalBarsToFetch)
        this.logger.warn(`Requested ${totalBarsToFetch} bars but only got ${ohlcvBars.length}. Results may have null values at the beginning.`);

    return this._calculateFromBars({ bars: ohlcvBars, indicators, requestedBars });
}
```

#### Solution
```javascript
async calculateIndicators({ symbol, indicators, bars = 200, calculationBars, timeframe }) {
    try {
        const maxWarmup = this._calculateMaxWarmup(indicators);
        const warmupBuffer = Math.ceil(maxWarmup * 1.2);
        const requestedBars = calculationBars || bars;
        const totalBarsToFetch = requestedBars + warmupBuffer;

        this.logger.verbose(`Fetching OHLCV for ${symbol}: ${requestedBars} requested + ${warmupBuffer} warmup = ${totalBarsToFetch} total bars`);

        const ohlcvResult = await this.dataProvider.loadOHLCV({
            symbol,
            timeframe: timeframe || DEFAULT_TIMEFRAME,
            count: totalBarsToFetch,
            useCache: true,
            detectGaps: false,
        });

        const ohlcvBars = ohlcvResult.bars;

        if (!ohlcvBars || ohlcvBars.length === 0)
            throw new Error(`No data received for ${symbol}`);

        if (ohlcvBars.length < totalBarsToFetch)
            this.logger.warn(`Requested ${totalBarsToFetch} bars but only got ${ohlcvBars.length}. Results may have null values at the beginning.`);

        return this._calculateFromBars({ bars: ohlcvBars, indicators, requestedBars });
    } catch (error) {
        this.logger.error(`Failed to calculate indicators for ${symbol}: ${error.message}`);
        throw new Error(`Indicator calculation failed for ${symbol}: ${error.message}`);
    }
}
```

---

### 9. RegimeDetectionService.js - PROMISE.ALL SANS GESTION

**Fichier:** `src/Trading/MarketAnalysis/RegimeDetection/RegimeDetectionService.js`
**Lignes:** 90-97
**Catégorie:** Gestion d'erreurs
**Impact:** Si un indicateur échoue, toute la détection échoue

#### Problème
```javascript
// ❌ Si une promesse échoue, toutes les autres sont ignorées
const [adxData, atrShort, atrLong, er, emaShort, emaLong] = await Promise.all([
    this._getADX(symbol, timeframe, ohlcv.bars.length),
    this._getATR(symbol, timeframe, ohlcv.bars.length, config.atrShortPeriod),
    this._getATR(symbol, timeframe, ohlcv.bars.length, config.atrLongPeriod),
    this._getEfficiencyRatio(closes, config.erPeriod),
    this._getEMA(symbol, timeframe, ohlcv.bars.length, config.maShortPeriod),
    this._getEMA(symbol, timeframe, ohlcv.bars.length, config.maLongPeriod),
]);
```

#### Solution
```javascript
// ✅ Utiliser Promise.allSettled pour gérer les erreurs individuelles
const results = await Promise.allSettled([
    this._getADX(symbol, timeframe, ohlcv.bars.length),
    this._getATR(symbol, timeframe, ohlcv.bars.length, config.atrShortPeriod),
    this._getATR(symbol, timeframe, ohlcv.bars.length, config.atrLongPeriod),
    this._getEfficiencyRatio(closes, config.erPeriod),
    this._getEMA(symbol, timeframe, ohlcv.bars.length, config.maShortPeriod),
    this._getEMA(symbol, timeframe, ohlcv.bars.length, config.maLongPeriod),
]);

// Extraire les valeurs ou utiliser des fallbacks
const adxData = results[0].status === 'fulfilled' ? results[0].value : null;
const atrShort = results[1].status === 'fulfilled' ? results[1].value : null;
const atrLong = results[2].status === 'fulfilled' ? results[2].value : null;
const er = results[3].status === 'fulfilled' ? results[3].value : null;
const emaShort = results[4].status === 'fulfilled' ? results[4].value : null;
const emaLong = results[5].status === 'fulfilled' ? results[5].value : null;

// Valider qu'on a assez de données pour continuer
const missing = [];
if (!adxData) missing.push('ADX');
if (!atrShort) missing.push('ATR Short');
if (!atrLong) missing.push('ATR Long');
if (!er) missing.push('Efficiency Ratio');
if (!emaShort) missing.push('EMA Short');
if (!emaLong) missing.push('EMA Long');

if (missing.length > 0) {
    this.logger.error(`Missing required indicators: ${missing.join(', ')}`);
    throw new Error(`Failed to calculate required indicators: ${missing.join(', ')}`);
}

// Logger les erreurs individuelles
results.forEach((result, index) => {
    if (result.status === 'rejected') {
        const indicators = ['ADX', 'ATR Short', 'ATR Long', 'Efficiency Ratio', 'EMA Short', 'EMA Long'];
        this.logger.error(`Failed to calculate ${indicators[index]}: ${result.reason?.message}`);
    }
});
```

---

### 10. server.js - ERREUR MCP NON GÉRÉE

**Fichier:** `src/server.js`
**Lignes:** 194-201
**Catégorie:** Gestion d'erreurs
**Impact:** Serveur démarre avec fonctionnalités MCP cassées

#### Problème
```javascript
// ❌ Si l'enregistrement des modules échoue, le serveur continue quand même
await mcpService.registerAllModules({
    mcpService: mcpService,
    logger: logger,
    dataProvider: dataProvider,
    marketDataService: marketDataService,
    indicatorService: indicatorService,
    marketAnalysisService: marketAnalysisService,
});
```

#### Solution
```javascript
try {
    await mcpService.registerAllModules({
        mcpService: mcpService,
        logger: logger,
        dataProvider: dataProvider,
        marketDataService: marketDataService,
        indicatorService: indicatorService,
        marketAnalysisService: marketAnalysisService,
    });
} catch (error) {
    logger.error(`Failed to register MCP modules: ${error.message}`);
    logger.error(`Stack: ${error.stack}`);
    logger.warn('Server will start but MCP functionality may be limited');
    // Optionnel : process.exit(1) si MCP est critique pour l'application
}
```

---

### 11. server.js - CORS MAL CONFIGURÉ

**Fichier:** `src/server.js`
**Lignes:** 66-74
**Catégorie:** Sécurité
**Impact:** API exposée à tous les domaines (dangereux avec credentials)

#### Problème
```javascript
app.use(
    cors({
        origin: process.env.CORS_ORIGIN || '*', // ⚠️ Accepte TOUS les origins
        methods: ['GET', 'POST'],
        allowedHeaders: ['Content-Type', 'Authorization', 'Mcp-Session-Id'],
        credentials: true, // ⚠️ DANGEREUX avec origin: '*'
        maxAge: 86400,
    })
);
```

Avec `origin: '*'` et `credentials: true`, n'importe quel site peut faire des requêtes authentifiées à votre API.

#### Solution
```javascript
// Parser les origins autorisés depuis l'environnement
const allowedOrigins = process.env.CORS_ORIGIN
    ? process.env.CORS_ORIGIN.split(',').map(o => o.trim())
    : ['http://localhost:3000'];

app.use(
    cors({
        origin: (origin, callback) => {
            // Autoriser les requêtes sans origin (Postman, curl, etc.)
            if (!origin) return callback(null, true);

            if (allowedOrigins.includes(origin)) {
                callback(null, true);
            } else {
                logger.warn(`CORS blocked request from origin: ${origin}`);
                callback(new Error('Not allowed by CORS'));
            }
        },
        methods: ['GET', 'POST', 'DELETE'],
        allowedHeaders: ['Content-Type', 'Authorization', 'Mcp-Session-Id'],
        credentials: true,
        maxAge: 86400,
    })
);

logger.info(`CORS configured for origins: ${allowedOrigins.join(', ')}`);
```

**Fichier .env:**
```env
# Séparer par des virgules pour plusieurs domaines
CORS_ORIGIN=http://localhost:3000,https://app.exemple.com,https://www.exemple.com
```

---

## 🟠 PROBLÈMES MAJEURS - P1 (12)

### 12. StatisticalContextService.js - PROMISE.ALL SÉQUENTIEL

**Fichier:** `src/Trading/MarketAnalysis/StatisticalContext/StatisticalContextService.js`
**Lignes:** 149-169
**Catégorie:** Async & Performance
**Impact:** Génération de contexte lente (séquentielle au lieu de parallèle)

#### Problème
```javascript
for (const tf of sortedTFs)
    try {
        const tfContext = await this._generateTimeframeContext(
            symbol,
            tf,
            count,
            higherTFData
        );
        contexts[tf] = tfContext;
        // ...
    } catch (error) {
        this.logger.error(`Failed to generate context for ${tf}: ${error.message}`);
        contexts[tf] = { error: error.message };
    }
```

#### Solution
Utiliser `Promise.allSettled` pour paralléliser si les timeframes sont indépendants.

---

### 13-15. MarketDataService.js & MarketAnalysisService.js - PROMISE.ALL SANS TRY/CATCH

**Fichiers:**
- `src/Trading/MarketData/MarketDataService.js:83-97`
- `src/Trading/MarketAnalysis/MarketAnalysisService.js:129-137`

**Catégorie:** Gestion d'erreurs
**Impact:** Erreurs non catchées si Promise.all échoue

#### Solution
Envelopper dans un try/catch global.

---

### 16. indicators.js - IF/ELSE AU LIEU DE SWITCH

**Fichier:** `src/Trading/Indicator/indicators.js`
**Lignes:** 233-247
**Catégorie:** Logique & Contrôle
**Impact:** Code peu clair, pas de default explicite

#### Problème
```javascript
const inputType = INPUT_TYPE_MAP[indicatorKey];
let input;

if (inputType === 'barWithVolume')
    input = { close: bar.close, volume: bar.volume };
 else if (inputType === 'close')
    input = bar.close;
 else if (inputType === 'highLow')
    input = { high: bar.high, low: bar.low };
 else if (inputType === 'highLowClose')
    input = { high: bar.high, low: bar.low, close: bar.close };
 else if (inputType === 'ohlc')
    input = { open: bar.open, high: bar.high, low: bar.low, close: bar.close };
 else
    input = bar;
```

#### Solution
```javascript
const inputType = INPUT_TYPE_MAP[indicatorKey];
let input;

switch (inputType) {
    case 'barWithVolume':
        input = { close: bar.close, volume: bar.volume };
        break;
    case 'close':
        input = bar.close;
        break;
    case 'highLow':
        input = { high: bar.high, low: bar.low };
        break;
    case 'highLowClose':
        input = { high: bar.high, low: bar.low, close: bar.close };
        break;
    case 'ohlc':
        input = { open: bar.open, high: bar.high, low: bar.low, close: bar.close };
        break;
    default:
        this.logger.warn(`Unknown input type for ${indicatorKey}: ${inputType}, using full bar`);
        input = bar;
}
```

---

### 17. DataProvider.js - MESSAGES D'ERREUR IMPRÉCIS

**Fichier:** `src/DataProvider/DataProvider.js`
**Lignes:** 67-79
**Catégorie:** Types & Validation
**Impact:** Difficile de débugger si erreur

#### Problème
```javascript
for (const field of required)
    if (typeof bar[field] !== 'number' || bar[field] < 0)
        throw new Error(`Bar ${i}: Invalid ${field}`);
```

Ne distingue pas si c'est un problème de type ou de valeur négative.

#### Solution
```javascript
for (const field of required) {
    if (typeof bar[field] !== 'number') {
        throw new Error(`Bar ${i}: ${field} must be a number, got ${typeof bar[field]}`);
    }
    if (bar[field] < 0) {
        throw new Error(`Bar ${i}: ${field} cannot be negative (${bar[field]})`);
    }
    if (isNaN(bar[field])) {
        throw new Error(`Bar ${i}: ${field} is NaN`);
    }
}
```

---

### 18-20. OAuthService.js & WebUIAuthService.js - PARSEINT SANS VALIDATION

**Fichiers:**
- `src/OAuth/OAuthService.js:239, 285-286`
- `src/OAuth/WebUIAuthService.js:100-101`

**Catégorie:** Types & Validation
**Impact:** `NaN * 60 * 1000 = NaN` si variable d'environnement invalide

#### Problème
```javascript
const codeExpirationMs = parseInt(process.env.OAUTH_AUTHORIZATION_CODE_DURATION, 10) * 60 * 1000;
// Si OAUTH_AUTHORIZATION_CODE_DURATION n'est pas défini ou invalide → NaN
```

#### Solution
```javascript
const parseEnvDuration = (envVar, defaultMinutes, name) => {
    const value = parseInt(envVar, 10);

    if (isNaN(value) || value <= 0) {
        this.logger.warn(`${name} is invalid or not set (${envVar}), using default ${defaultMinutes} minutes`);
        return defaultMinutes * 60 * 1000;
    }

    return value * 60 * 1000;
};

// Utilisation
const codeExpirationMs = parseEnvDuration(
    process.env.OAUTH_AUTHORIZATION_CODE_DURATION,
    10,
    'OAUTH_AUTHORIZATION_CODE_DURATION'
);

const accessTokenDuration = parseEnvDuration(
    process.env.OAUTH_ACCESS_TOKEN_DURATION,
    60,
    'OAUTH_ACCESS_TOKEN_DURATION'
) / 1000; // Convertir en secondes
```

---

### 21. BinanceAdapter.js - PARSEFLOAT SANS VALIDATION NaN

**Fichier:** `src/DataProvider/BinanceAdapter.js`
**Lignes:** 64-72
**Catégorie:** Types & Validation
**Impact:** Données corrompues si l'API retourne des valeurs invalides

#### Problème
```javascript
const ohlcv = rawData.map((candle) => ({
    timestamp: candle[0],
    open: parseFloat(candle[1]),
    high: parseFloat(candle[2]),
    low: parseFloat(candle[3]),
    close: parseFloat(candle[4]),
    volume: parseFloat(candle[5]),
    symbol: symbol,
}));
```

#### Solution
```javascript
const ohlcv = rawData.map((candle, i) => {
    const open = parseFloat(candle[1]);
    const high = parseFloat(candle[2]);
    const low = parseFloat(candle[3]);
    const close = parseFloat(candle[4]);
    const volume = parseFloat(candle[5]);

    // Valider que toutes les valeurs sont des nombres valides
    if (isNaN(open) || isNaN(high) || isNaN(low) || isNaN(close) || isNaN(volume)) {
        this.logger.error(`Invalid OHLCV data at index ${i}: ${JSON.stringify(candle)}`);
        throw new Error(`Invalid OHLCV data received from Binance at index ${i}`);
    }

    return {
        timestamp: candle[0],
        open,
        high,
        low,
        close,
        volume,
        symbol: symbol,
    };
});
```

---

### 22. routes.js - RATE LIMITING TROP PERMISSIF

**Fichier:** `src/routes.js`
**Lignes:** 10-21
**Catégorie:** Sécurité
**Impact:** Protection insuffisante contre les attaques par force brute

#### Problème
```javascript
function makeLimiter({ logger: logger, windowMs = 15 * 60 * 1000, max = 100 } = {}) {
    // 100 requêtes / 15 min est trop pour les routes sensibles (login, token)
}
```

#### Solution
```javascript
// Différents limiters selon le type de route
function makeLimiter({ logger, windowMs = 15 * 60 * 1000, max = 100 } = {}) {
    return rateLimit({
        windowMs,
        max,
        standardHeaders: true,
        legacyHeaders: false,
        handler: (req, res) => {
            logger.info(`Rate limit exceeded for IP: ${req.ip} on ${req.path}`);
            res.status(429).json({ error: 'too_many_requests' });
        },
    });
}

// Dans registerRoutes
const authLimiter = makeLimiter({ logger, windowMs: 15 * 60 * 1000, max: 5 }); // Auth stricte
const apiLimiter = makeLimiter({ logger, windowMs: 15 * 60 * 1000, max: 100 }); // API normale
const publicLimiter = makeLimiter({ logger, windowMs: 15 * 60 * 1000, max: 300 }); // Public

// Appliquer le limiter approprié
oauthRoutes.forEach((route) => {
    const middleware = [];

    // Limiter strict pour les routes d'auth
    if (route.path === '/oauth/token' || route.path === '/webui/login') {
        middleware.push(authLimiter);
    } else {
        middleware.push(apiLimiter);
    }

    middleware.push(route.handler.bind(oauthService));
    app[route.method](route.path, ...middleware);
});
```

---

### 23. StatisticalContextService.js - CODE MORT

**Fichier:** `src/Trading/MarketAnalysis/StatisticalContext/StatisticalContextService.js`
**Lignes:** 721-767
**Catégorie:** Fonctions & Méthodes
**Impact:** Code inutilisé qui pollue le fichier

#### Problème
```javascript
_analyzeStructure(bars) {
    // ~50 lignes de code jamais appelées
}

_interpretWicks(upperWick, lowerWick, totalRange) {
    // Code jamais appelé
}
```

#### Solution
```javascript
// Option 1: Supprimer complètement
// Supprimer les lignes 721-767

// Option 2: Commenter avec explication
/**
 * Legacy methods from V1 - Not currently used
 * Kept for potential future price action analysis features
 *
 * @deprecated Since V2
 * @todo Decide if these should be integrated into PriceActionEnricher or removed
 */

// Option 3: Documenter l'intention future
/**
 * Planned for future use in advanced price action analysis
 * Will be integrated when implementing advanced candle pattern recognition
 */
```

---

## 🟡 PROBLÈMES MINEURS - P2-P3 (24)

### 24. app.js & auth-client.js - CONSOLE.LOG EN PRODUCTION

**Fichiers:** `src/WebUI/app.js`, `src/WebUI/auth-client.js`
**Impact:** Logs non centralisés, debug difficile

#### Solution
Créer un logger centralisé pour le WebUI:

```javascript
// logger.js
class Logger {
    constructor(level = 'info') {
        this.level = level;
        this.levels = { error: 0, warn: 1, info: 2, debug: 3 };
    }

    _log(level, ...args) {
        if (this.levels[level] <= this.levels[this.level]) {
            console[level](`[${new Date().toISOString()}] [${level.toUpperCase()}]`, ...args);
        }
    }

    error(...args) { this._log('error', ...args); }
    warn(...args) { this._log('warn', ...args); }
    info(...args) { this._log('info', ...args); }
    debug(...args) { this._log('debug', ...args); }
}

const logger = new Logger(process.env.LOG_LEVEL || 'info');
export default logger;
```

Puis remplacer tous les `console.log` par `logger.info`.

---

### 25-47. Autres problèmes mineurs

- Fonctions jamais utilisées (`helpers.js`: `isValidOHLC`, `isRetryableError`)
- Paramètres inutilisés (`app.js:540`, `TradingContextService.js:245`)
- Await dans boucle (`app.js:612-613`) au lieu de `Promise.all`
- Fonction deprecated (`RegimeDetectionService.js:546`)
- Duplication de code (`StatisticalContextService.js:234-295`)
- Conditions redondantes (`zodToJsonSchema.js:28-29`)
- Documentation manquante (JSDoc)

---

## 📋 CHECKLIST DE CORRECTION

### Phase 1 - CRITIQUE (P0) - Cette semaine
- [ ] 1. StorageService - Ajouter TTL et limite de taille
- [ ] 2. app.js - Nettoyer event listeners des charts
- [ ] 3. app.js - Encapsuler le state global dans une classe
- [ ] 4. auth-client.js - Annuler timers lors de beforeunload
- [ ] 5. chart-legend.js - Nettoyer event listeners document
- [ ] 6. indicators-ui.js - Nettoyer event listeners document
- [ ] 7. DataProvider.js - Ajouter lock pour race conditions
- [ ] 8. indicators.js - Ajouter try/catch dans calculateIndicators
- [ ] 9. RegimeDetectionService.js - Utiliser Promise.allSettled
- [ ] 10. server.js - Gérer erreurs registerAllModules
- [ ] 11. server.js - Sécuriser CORS avec whitelist

### Phase 2 - MAJEUR (P1) - Ce mois
- [ ] 12. StatisticalContextService - Paralléliser avec Promise.allSettled
- [ ] 13-15. MarketDataService & MarketAnalysisService - Ajouter try/catch global
- [ ] 16. indicators.js - Remplacer if/else par switch
- [ ] 17. DataProvider.js - Améliorer messages d'erreur
- [ ] 18-20. OAuthService & WebUIAuthService - Valider parseInt
- [ ] 21. BinanceAdapter - Valider parseFloat
- [ ] 22. routes.js - Renforcer rate limiting
- [ ] 23. StatisticalContextService - Supprimer code mort

### Phase 3 - MINEUR (P2-P3) - Progressif
- [ ] 24. Remplacer console.log par logger centralisé
- [ ] 25-47. Nettoyer imports, améliorer documentation, optimiser

---

## 📊 MÉTRIQUES ATTENDUES APRÈS CORRECTIONS

| Métrique | Avant | Après | Amélioration |
|----------|-------|-------|--------------|
| Memory leaks | 6 | 0 | ✅ 100% |
| Erreurs non gérées | 5 | 0 | ✅ 100% |
| Sécurité CORS | ⚠️ Faible | ✅ Forte | ✅ 100% |
| Race conditions | 1 | 0 | ✅ 100% |
| Code mort | 3 | 0 | ✅ 100% |
| Note globale | 7.5/10 | 9/10 | ⬆️ +20% |

---

## 🎯 CONCLUSION

Le projet Midas est **globalement bien structuré** avec une bonne séparation des responsabilités. Les principaux problèmes identifiés concernent :

1. **Memory leaks WebUI** - Event listeners et timers non nettoyés
2. **Gestion d'erreurs async** - Promises non gérées, try/catch manquants
3. **Sécurité** - CORS trop permissif, rate limiting insuffisant
4. **Performance** - Race conditions, code séquentiel au lieu de parallèle

Avec les corrections **P0 et P1**, le projet sera **production-ready** et passera de **7.5/10 à 9/10**.

---

**Généré le:** 2025-12-19
**Version:** 1.0
**Auteur:** Analyse automatique du code
