/**
 * Backtest Regime Detection - Validation Descriptive
 *
 * OBJECTIF: Valider que le régime détecté décrit correctement l'état ACTUEL du marché.
 *           (Pas de prédiction - validation de cohérence interne)
 *
 * MÉTHODOLOGIE:
 *   Détection:  [T-200, T]  → RegimeDetectionService utilise ces données
 *   Validation: [T-N, T]    → On mesure le mouvement réel sur la MÊME période
 *
 * QUESTIONS:
 *   1. TRENDING détecté → Le prix était-il vraiment directionnel et efficace ?
 *   2. RANGE détecté → Le prix oscillait-il vraiment sans direction claire ?
 *   3. BREAKOUT détecté → Y avait-il compression puis expansion ?
 *   4. DIRECTION détectée → Le prix allait-il vraiment dans cette direction ?
 *
 * Usage:
 *   node scripts/backtest-regime.js --symbol BTCUSDT --timeframe 1h --bars 500
 *   node scripts/backtest-regime.js --symbol ETHUSDT --timeframe 4h --bars 1000 --lookback 50
 */

import 'dotenv/config';

import { DataProvider } from '../src/DataProvider/DataProvider.js';
import { BinanceAdapter } from '../src/DataProvider/BinanceAdapter.js';
import { IndicatorService } from '../src/Trading/Indicator/IndicatorService.js';
import { RegimeDetectionService } from '../src/Trading/MarketAnalysis/RegimeDetection/RegimeDetectionService.js';
import { logger } from '../src/Logger/LoggerService.js';

/* ===========================================================
   CONFIGURATION
   =========================================================== */

const CONFIG = {
	lookback: 50,           // Bars to analyze for validation (same period as detection)
	warmupBars: 250,        // Indicator warmup
	batchSize: 50,          // Progress update frequency
};

/* ===========================================================
   MESURE DU MOUVEMENT RÉEL (PÉRIODE DE DÉTECTION)
   =========================================================== */

/**
 * Mesure objective du mouvement sur les N dernières bougies (période de détection)
 * C'est la "vérité terrain" pour valider si le régime détecté est correct
 */
function measureActualMovement(bars, endIdx, lookback) {
	const startIdx = Math.max(0, endIdx - lookback);
	const periodBars = bars.slice(startIdx, endIdx + 1);

	if (periodBars.length < lookback) return null;

	const startPrice = periodBars[0].open;
	const endPrice = periodBars[periodBars.length - 1].close;
	const closes = periodBars.map(b => b.close);
	const highestHigh = Math.max(...periodBars.map(b => b.high));
	const lowestLow = Math.min(...periodBars.map(b => b.low));

	// Mesures objectives
	const netChange = (endPrice - startPrice) / startPrice;
	const totalRange = (highestHigh - lowestLow) / startPrice;
	const efficiency = totalRange > 0 ? Math.abs(netChange) / totalRange : 0;

	// Volatilité par bougie
	const barRanges = periodBars.map(b => (b.high - b.low) / b.open);
	const avgVolatility = barRanges.reduce((a, b) => a + b, 0) / barRanges.length;

	// Direction réelle basée sur le mouvement net
	let actualDirection;
	if (netChange > 0.005) actualDirection = 'bullish';      // > 0.5% = haussier
	else if (netChange < -0.005) actualDirection = 'bearish'; // < -0.5% = baissier
	else actualDirection = 'neutral';

	// Catégorie réelle basée sur l'efficacité
	let actualCategory;
	if (efficiency > 0.5 && Math.abs(netChange) > 0.02) {
		// Mouvement efficace (>50%) ET significatif (>2%) = trending
		actualCategory = 'trending';
	} else if (efficiency < 0.3) {
		// Mouvement très inefficace = range (beaucoup de bruit, peu de direction)
		actualCategory = 'range';
	} else {
		// Zone intermédiaire - regarder la volatilité
		if (avgVolatility > 0.015) {
			// Haute volatilité mais pas très efficace = range volatile ou breakout raté
			actualCategory = 'range';
		} else {
			// Volatilité normale, efficacité moyenne
			actualCategory = efficiency > 0.4 ? 'trending' : 'range';
		}
	}

	return {
		netChange,
		netChangePct: netChange * 100,
		totalRange,
		totalRangePct: totalRange * 100,
		efficiency,
		avgVolatility,
		actualDirection,
		actualCategory,
		priceWentUp: netChange > 0,
		priceWentDown: netChange < 0,
	};
}

/* ===========================================================
   VALIDATION DESCRIPTIVE (COHÉRENCE)
   =========================================================== */

/**
 * Valide si le régime détecté correspond au mouvement réel observé
 * sur la MÊME période utilisée pour la détection
 */
function validateCoherence(detected, actual) {
	const detectedCategory = detected.regime.split('_')[0];
	const detectedDirection = detected.direction;

	// Q1: La CATÉGORIE détectée correspond-elle au mouvement réel ?
	const categoryCorrect = detectedCategory === actual.actualCategory;

	// Q2: La DIRECTION détectée correspond-elle au mouvement réel ?
	let directionCorrect = null;
	if (detectedDirection !== 'neutral' && actual.actualDirection !== 'neutral') {
		directionCorrect = detectedDirection === actual.actualDirection;
	} else if (detectedDirection === 'neutral' && actual.actualDirection === 'neutral') {
		directionCorrect = true;
	} else if (detectedDirection === 'neutral') {
		// Détecté neutral, réel directionnel - acceptable si mouvement faible
		directionCorrect = Math.abs(actual.netChange) < 0.02;
	} else {
		// Détecté directionnel, réel neutral - erreur
		directionCorrect = false;
	}

	// Q3: L'EFFICACITÉ détectée (via ER) correspond-elle à la réalité ?
	const detectedER = detected.components?.efficiency_ratio || 0;
	const erCoherent = (detectedER > 0.5 && actual.efficiency > 0.4) ||
	                   (detectedER <= 0.5 && actual.efficiency <= 0.6);

	// Q4: Cohérence spécifique par catégorie
	let specificCoherence = false;

	if (detectedCategory === 'trending') {
		// Trending = efficacité haute + mouvement significatif
		specificCoherence = actual.efficiency > 0.4 && Math.abs(actual.netChange) > 0.01;
	} else if (detectedCategory === 'breakout') {
		// Breakout = expansion de volatilité (vérifié par le système)
		// On valide juste qu'il y a eu du mouvement
		specificCoherence = actual.totalRange > 0.03 || Math.abs(actual.netChange) > 0.02;
	} else if (detectedCategory === 'range') {
		// Range = efficacité basse OU mouvement faible
		specificCoherence = actual.efficiency < 0.5 || Math.abs(actual.netChange) < 0.02;
	}

	return {
		categoryCorrect,
		directionCorrect,
		erCoherent,
		specificCoherence,
		detectedCategory,
		actualCategory: actual.actualCategory,
		detectedDirection,
		actualDirection: actual.actualDirection,
		detectedER,
		actualEfficiency: actual.efficiency,
	};
}

/* ===========================================================
   CALCUL DES MÉTRIQUES
   =========================================================== */

function computeMetrics(results) {
	const total = results.length;

	// === CATÉGORIE ===
	const categoryCorrect = results.filter(r => r.validation.categoryCorrect).length;

	// Par catégorie détectée
	const trendingDetected = results.filter(r => r.validation.detectedCategory === 'trending');
	const breakoutDetected = results.filter(r => r.validation.detectedCategory === 'breakout');
	const rangeDetected = results.filter(r => r.validation.detectedCategory === 'range');

	const trendingCorrect = trendingDetected.filter(r => r.validation.categoryCorrect).length;
	const breakoutCorrect = breakoutDetected.filter(r => r.validation.categoryCorrect).length;
	const rangeCorrect = rangeDetected.filter(r => r.validation.categoryCorrect).length;

	// === DIRECTION ===
	const withDirection = results.filter(r => r.validation.directionCorrect !== null);
	const directionCorrect = withDirection.filter(r => r.validation.directionCorrect === true).length;

	// Par direction détectée
	const bullishDetected = results.filter(r => r.validation.detectedDirection === 'bullish');
	const bearishDetected = results.filter(r => r.validation.detectedDirection === 'bearish');
	const neutralDetected = results.filter(r => r.validation.detectedDirection === 'neutral');

	const bullishCorrect = bullishDetected.filter(r => r.validation.directionCorrect === true).length;
	const bearishCorrect = bearishDetected.filter(r => r.validation.directionCorrect === true).length;

	// === EFFICACITÉ (ER) ===
	const erCoherent = results.filter(r => r.validation.erCoherent).length;

	// === COHÉRENCE SPÉCIFIQUE ===
	const specificCorrect = results.filter(r => r.validation.specificCoherence).length;

	// === CONFIANCE vs COHÉRENCE ===
	const highConf = results.filter(r => r.detected.confidence >= 0.7);
	const lowConf = results.filter(r => r.detected.confidence < 0.5);

	const highConfCorrect = highConf.filter(r => r.validation.categoryCorrect).length;
	const lowConfCorrect = lowConf.filter(r => r.validation.categoryCorrect).length;

	// === DISTRIBUTION DES ERREURS ===
	const errors = {
		trendingAsRange: results.filter(r =>
			r.validation.detectedCategory === 'trending' && r.validation.actualCategory === 'range'
		).length,
		rangeAsTrending: results.filter(r =>
			r.validation.detectedCategory === 'range' && r.validation.actualCategory === 'trending'
		).length,
		wrongDirection: withDirection.filter(r => r.validation.directionCorrect === false).length,
	};

	return {
		total,
		category: {
			correct: categoryCorrect,
			pct: (categoryCorrect / total * 100),
			trending: {
				detected: trendingDetected.length,
				correct: trendingCorrect,
				pct: trendingDetected.length > 0 ? (trendingCorrect / trendingDetected.length * 100) : 0,
			},
			breakout: {
				detected: breakoutDetected.length,
				correct: breakoutCorrect,
				pct: breakoutDetected.length > 0 ? (breakoutCorrect / breakoutDetected.length * 100) : 0,
			},
			range: {
				detected: rangeDetected.length,
				correct: rangeCorrect,
				pct: rangeDetected.length > 0 ? (rangeCorrect / rangeDetected.length * 100) : 0,
			},
		},
		direction: {
			total: withDirection.length,
			correct: directionCorrect,
			pct: withDirection.length > 0 ? (directionCorrect / withDirection.length * 100) : 0,
			bullish: {
				detected: bullishDetected.length,
				correct: bullishCorrect,
				pct: bullishDetected.length > 0 ? (bullishCorrect / bullishDetected.length * 100) : 0,
			},
			bearish: {
				detected: bearishDetected.length,
				correct: bearishCorrect,
				pct: bearishDetected.length > 0 ? (bearishCorrect / bearishDetected.length * 100) : 0,
			},
			neutral: { detected: neutralDetected.length },
		},
		efficiency: {
			coherent: erCoherent,
			pct: (erCoherent / total * 100),
		},
		specific: {
			correct: specificCorrect,
			pct: (specificCorrect / total * 100),
		},
		confidence: {
			high: {
				total: highConf.length,
				correct: highConfCorrect,
				pct: highConf.length > 0 ? (highConfCorrect / highConf.length * 100) : 0,
			},
			low: {
				total: lowConf.length,
				correct: lowConfCorrect,
				pct: lowConf.length > 0 ? (lowConfCorrect / lowConf.length * 100) : 0,
			},
		},
		errors,
	};
}

/* ===========================================================
   AFFICHAGE
   =========================================================== */

function displayResults(metrics, config) {
	const line = '═'.repeat(70);
	const thinLine = '─'.repeat(70);

	console.log(`\n${line}`);
	console.log('       BACKTEST RÉGIME - VALIDATION DESCRIPTIVE (COHÉRENCE)');
	console.log(`${line}`);

	// === EXPLICATION ===
	console.log(`\n${thinLine}`);
	console.log('📖 CE QUE MESURE CE TEST');
	console.log(`${thinLine}`);
	console.log(`
  OBJECTIF: Vérifier que le régime détecté DÉCRIT CORRECTEMENT le marché.
            (Pas de prédiction du futur - validation de cohérence)

  MÉTHODE:
    • Le système détecte un régime à partir des ${config.lookback} dernières bougies
    • On mesure le mouvement RÉEL sur ces MÊMES bougies
    • On compare: le régime détecté correspond-il à la réalité observée ?

  CRITÈRES DE VALIDATION:
    • TRENDING = efficacité > 40% ET mouvement > 1%
    • RANGE = efficacité < 50% OU mouvement < 2%
    • BREAKOUT = range total > 3% OU mouvement > 2%
    • DIRECTION = correspond au sens du mouvement net
`);

	// === CATÉGORIE ===
	console.log(`${thinLine}`);
	console.log('📊 Q1: LA CATÉGORIE DÉTECTÉE EST-ELLE CORRECTE ?');
	console.log(`${thinLine}`);

	const c = metrics.category;
	console.log(`
  Résultat global: ${c.correct}/${metrics.total} = ${c.pct.toFixed(1)}%
`);
	console.log(`    TRENDING détecté:  ${c.trending.correct}/${c.trending.detected} corrects (${c.trending.pct.toFixed(1)}%)`);
	console.log(`    BREAKOUT détecté:  ${c.breakout.correct}/${c.breakout.detected} corrects (${c.breakout.pct.toFixed(1)}%)`);
	console.log(`    RANGE détecté:     ${c.range.correct}/${c.range.detected} corrects (${c.range.pct.toFixed(1)}%)`);
	console.log('');

	if (c.pct > 80)
		console.log('  ✅ Excellente cohérence - Le système décrit bien le marché');
	else if (c.pct > 65)
		console.log('  🟡 Bonne cohérence - Quelques erreurs de classification');
	else
		console.log('  ❌ Cohérence faible - Le système ne décrit pas bien le marché');

	// === DIRECTION ===
	console.log(`\n${thinLine}`);
	console.log('🧭 Q2: LA DIRECTION DÉTECTÉE EST-ELLE CORRECTE ?');
	console.log(`${thinLine}`);

	const d = metrics.direction;
	console.log(`
  Résultat global: ${d.correct}/${d.total} = ${d.pct.toFixed(1)}%
`);
	console.log(`    BULLISH détecté:   ${d.bullish.correct}/${d.bullish.detected} corrects (${d.bullish.pct.toFixed(1)}%)`);
	console.log(`    BEARISH détecté:   ${d.bearish.correct}/${d.bearish.detected} corrects (${d.bearish.pct.toFixed(1)}%)`);
	console.log(`    NEUTRAL détecté:   ${d.neutral.detected} cas`);
	console.log('');

	if (d.pct > 80)
		console.log('  ✅ Direction bien détectée');
	else if (d.pct > 65)
		console.log('  🟡 Direction correcte dans la plupart des cas');
	else
		console.log('  ❌ Direction souvent incorrecte');

	// === EFFICACITÉ ===
	console.log(`\n${thinLine}`);
	console.log('📈 Q3: L\'EFFICIENCY RATIO EST-IL COHÉRENT ?');
	console.log(`${thinLine}`);

	const e = metrics.efficiency;
	console.log(`
  ER cohérent avec le mouvement réel: ${e.coherent}/${metrics.total} = ${e.pct.toFixed(1)}%
`);

	if (e.pct > 75)
		console.log('  ✅ ER reflète bien l\'efficacité réelle du mouvement');
	else if (e.pct > 60)
		console.log('  🟡 ER globalement cohérent');
	else
		console.log('  ❌ ER ne reflète pas bien la réalité');

	// === COHÉRENCE SPÉCIFIQUE ===
	console.log(`\n${thinLine}`);
	console.log('🎯 Q4: COHÉRENCE SPÉCIFIQUE PAR RÉGIME');
	console.log(`${thinLine}`);

	const s = metrics.specific;
	console.log(`
  Régime cohérent avec ses critères: ${s.correct}/${metrics.total} = ${s.pct.toFixed(1)}%
`);

	// === CONFIANCE ===
	console.log(`${thinLine}`);
	console.log('🔍 CONFIANCE vs COHÉRENCE');
	console.log(`${thinLine}`);

	const conf = metrics.confidence;
	console.log(`
    Haute confiance (≥70%): ${conf.high.correct}/${conf.high.total} corrects (${conf.high.pct.toFixed(1)}%)
    Basse confiance (<50%): ${conf.low.correct}/${conf.low.total} corrects (${conf.low.pct.toFixed(1)}%)
`);

	const confDiff = conf.high.pct - conf.low.pct;
	if (confDiff > 15)
		console.log(`  ✅ La confiance prédit bien la cohérence (+${confDiff.toFixed(0)}%)`);
	else if (confDiff > 5)
		console.log(`  🟡 Légère corrélation confiance/cohérence (+${confDiff.toFixed(0)}%)`);
	else
		console.log('  ❌ La confiance ne prédit pas la cohérence');

	// === ERREURS ===
	console.log(`\n${thinLine}`);
	console.log('⚠️  ANALYSE DES ERREURS');
	console.log(`${thinLine}`);

	const err = metrics.errors;
	console.log(`
    Trending détecté mais c'était Range: ${err.trendingAsRange} cas
    Range détecté mais c'était Trending: ${err.rangeAsTrending} cas
    Direction incorrecte: ${err.wrongDirection} cas
`);

	if (err.trendingAsRange > err.rangeAsTrending)
		console.log('  💡 Le système sur-détecte les tendances (faux positifs trending)');
	else if (err.rangeAsTrending > err.trendingAsRange)
		console.log('  💡 Le système sous-détecte les tendances (faux négatifs trending)');

	// === RÉSUMÉ ===
	console.log(`\n${line}`);
	console.log('📋 RÉSUMÉ - COHÉRENCE DU SYSTÈME');
	console.log(`${line}`);

	console.log(`
  Configuration: ${config.lookback} bougies analysées, ${metrics.total} échantillons

  ┌────────────────────────────────────────────────────────┐
  │ Catégorie correcte:     ${c.pct.toFixed(1).padStart(5)}%  ${c.pct > 80 ? '✅' : c.pct > 65 ? '🟡' : '❌'}                     │
  │ Direction correcte:     ${d.pct.toFixed(1).padStart(5)}%  ${d.pct > 80 ? '✅' : d.pct > 65 ? '🟡' : '❌'}                     │
  │ ER cohérent:            ${e.pct.toFixed(1).padStart(5)}%  ${e.pct > 75 ? '✅' : e.pct > 60 ? '🟡' : '❌'}                     │
  │ Cohérence spécifique:   ${s.pct.toFixed(1).padStart(5)}%  ${s.pct > 75 ? '✅' : s.pct > 60 ? '🟡' : '❌'}                     │
  └────────────────────────────────────────────────────────┘
`);

	// Verdict final
	const avgCoherence = (c.pct + d.pct + e.pct + s.pct) / 4;
	console.log(`  Score de cohérence moyen: ${avgCoherence.toFixed(1)}%`);

	if (avgCoherence > 75)
		console.log('  ✅ Le système décrit correctement l\'état du marché');
	else if (avgCoherence > 60)
		console.log('  🟡 Le système est globalement cohérent avec des améliorations possibles');
	else
		console.log('  ❌ Le système ne décrit pas fidèlement l\'état du marché');

	console.log(`\n${line}\n`);
}

/* ===========================================================
   MAIN
   =========================================================== */

async function main() {
	const args = process.argv.slice(2);
	const getArg = (name, defaultVal) => {
		const idx = args.indexOf(`--${name}`);
		return idx !== -1 && args[idx + 1] ? args[idx + 1] : defaultVal;
	};

	const symbol = getArg('symbol', 'BTCUSDT');
	const timeframe = getArg('timeframe', '1h');
	const barsToLoad = parseInt(getArg('bars', '500'));
	CONFIG.lookback = parseInt(getArg('lookback', String(CONFIG.lookback)));

	console.log('\n' + '═'.repeat(60));
	console.log('      BACKTEST RÉGIME - VALIDATION DESCRIPTIVE');
	console.log('═'.repeat(60));
	console.log(`Symbol: ${symbol}  |  Timeframe: ${timeframe}  |  Bars: ${barsToLoad}`);
	console.log(`Lookback: ${CONFIG.lookback} bars  |  Warmup: ${CONFIG.warmupBars} bars`);
	console.log('');
	console.log('Testing: Le régime détecté décrit-il correctement le marché ?');
	console.log('═'.repeat(60) + '\n');

	// Initialize services
	const binanceAdapter = new BinanceAdapter({ logger });

	const redisConfig = {
		enabled: process.env.REDIS_ENABLED?.toLowerCase() === 'true',
		host: process.env.REDIS_HOST || 'localhost',
		port: parseInt(process.env.REDIS_PORT || '6379'),
		password: process.env.REDIS_PASSWORD || undefined,
		ttl: parseInt(process.env.REDIS_CACHE_TTL || '300'),
	};

	const dataProvider = new DataProvider({
		dataAdapter: binanceAdapter,
		logger,
		maxDataPoints: parseInt(process.env.MAX_DATA_POINTS || '5000'),
		redisConfig,
	});

	const indicatorService = new IndicatorService({ logger, dataProvider });
	const regimeService = new RegimeDetectionService({ logger, dataProvider, indicatorService });

	// Load data
	console.log('Loading historical data...');
	const totalBars = barsToLoad + CONFIG.warmupBars + CONFIG.lookback;
	const ohlcv = await dataProvider.loadOHLCV({ symbol, timeframe, count: totalBars });

	if (!ohlcv?.bars || ohlcv.bars.length < CONFIG.warmupBars + CONFIG.lookback + 100) {
		console.error(`Insufficient data: got ${ohlcv?.bars?.length || 0} bars, need ${totalBars}`);
		process.exit(1);
	}
	console.log(`Loaded ${ohlcv.bars.length} bars\n`);

	// Run backtest
	const results = [];
	const startIdx = CONFIG.warmupBars + CONFIG.lookback;
	const endIdx = ohlcv.bars.length;
	const totalSamples = endIdx - startIdx;
	let processed = 0;
	let errors = 0;

	console.log(`Processing ${totalSamples} samples...\n`);
	const startTime = Date.now();

	for (let i = startIdx; i < endIdx; i++) {
		const currentDate = new Date(ohlcv.bars[i].timestamp).toISOString();

		try {
			// Detect regime at T (uses data [T-200, T])
			const regime = await regimeService.detectRegime({
				symbol,
				timeframe,
				count: 200,
				referenceDate: currentDate,
			});

			// Measure actual movement on [T-lookback, T] (same period)
			const actual = measureActualMovement(ohlcv.bars, i, CONFIG.lookback);

			if (regime && actual) {
				const validation = validateCoherence(regime, actual);
				results.push({
					detected: regime,
					actual,
					validation,
					timestamp: currentDate,
				});
			}
			processed++;

			if (processed % CONFIG.batchSize === 0) {
				const pct = (processed / totalSamples * 100).toFixed(0);
				const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
				process.stdout.write(`\r  Progress: ${processed}/${totalSamples} (${pct}%) | ${elapsed}s`);
			}
		} catch (e) {
			errors++;
			if (errors < 5)
				console.error(`\n  Error at index ${i}: ${e.message}`);
		}
	}

	const totalTime = ((Date.now() - startTime) / 1000).toFixed(1);
	console.log(`\n\nCompleted in ${totalTime}s | Processed: ${processed} | Errors: ${errors}\n`);

	if (results.length === 0) {
		console.log('No results to display.');
		process.exit(1);
	}

	// Compute metrics and display
	const metrics = computeMetrics(results);
	displayResults(metrics, CONFIG);
}

main().catch((e) => {
	console.error('Error:', e.message);
	console.error(e.stack);
	process.exit(1);
});
