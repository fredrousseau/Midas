#!/usr/bin/env node
/**
 * Backtest Regime Detection Accuracy
 *
 * Compare les régimes détectés vs la "vérité terrain" calculée
 * avec les MÊMES indicateurs que RegimeDetectionService.
 *
 * Usage:
 *   node scripts/backtest-regime.js --symbol BTCUSDT --timeframe 1h --bars 2000
 */

import { DataProvider } from '../src/DataProvider/DataProvider.js';
import { BinanceAdapter } from '../src/DataProvider/BinanceAdapter.js';
import { IndicatorService } from '../src/Trading/Indicator/IndicatorService.js';
import { RegimeDetectionService } from '../src/Trading/MarketAnalysis/RegimeDetection/RegimeDetectionService.js';
import { logger } from '../src/Logger/LoggerService.js';

/* ===========================================================
   CONFIGURATION
   =========================================================== */

const CONFIG = {
	lookforward: 20,        // Bars dans le futur pour validation
	warmupBars: 250,        // Warmup indicateurs

	// Utilise les MÊMES seuils que RegimeDetectionService
	// (importés depuis regimeConfig)
};

const REGIMES = [
	'trending_bullish', 'trending_bearish',
	'breakout_bullish', 'breakout_bearish', 'breakout_neutral',
	'range_normal', 'range_low_vol', 'range_high_vol', 'range_directional',
];

/* ===========================================================
   GROUND TRUTH GENERATION

   Utilise les MÊMES indicateurs que RegimeDetectionService:
   - ADX pour la force de tendance
   - Efficiency Ratio pour la directionnalité
   - ATR ratio pour la volatilité
   - EMA crossover pour la direction
   =========================================================== */

/**
 * Génère le label de vérité en utilisant les indicateurs du futur
 * (ce qu'on aurait détecté si on avait attendu lookforward bars)
 */
function generateTruthLabel(futureRegimeResult) {
	if (!futureRegimeResult) return null;
	return futureRegimeResult.regime;
}

/* ===========================================================
   METRICS COMPUTATION
   =========================================================== */

const getCategory = (regime) => regime.split('_')[0];
const getDirection = (regime) =>
	regime.includes('bullish') ? 'bullish' :
	regime.includes('bearish') ? 'bearish' : 'neutral';

function computeMetrics(results) {
	const total = results.length;
	if (total === 0) return null;

	// Exact match
	const exact = results.filter(r => r.predicted === r.truth).length;

	// Category match (trending/breakout/range)
	const category = results.filter(r =>
		getCategory(r.predicted) === getCategory(r.truth)
	).length;

	// Direction match (pour non-range)
	const directionalPairs = results.filter(r =>
		getDirection(r.truth) !== 'neutral' && getDirection(r.predicted) !== 'neutral'
	);
	const direction = directionalPairs.filter(r =>
		getDirection(r.predicted) === getDirection(r.truth)
	).length;

	// High confidence accuracy
	const highConf = results.filter(r => r.confidence >= 0.7);
	const highConfCorrect = highConf.filter(r => r.predicted === r.truth).length;

	// Per-regime breakdown
	const perRegime = {};
	for (const regime of REGIMES) {
		const regimeResults = results.filter(r => r.truth === regime);
		const correct = regimeResults.filter(r => r.predicted === regime).length;
		if (regimeResults.length > 0) {
			perRegime[regime] = {
				total: regimeResults.length,
				correct,
				pct: ((correct / regimeResults.length) * 100).toFixed(1),
			};
		}
	}

	// Confusion matrix
	const confusion = {};
	for (const r of REGIMES) {
		confusion[r] = {};
		for (const c of REGIMES) confusion[r][c] = 0;
	}
	for (const r of results) {
		if (confusion[r.truth]?.[r.predicted] !== undefined)
			confusion[r.truth][r.predicted]++;
	}

	return {
		total,
		exact: { count: exact, pct: ((exact / total) * 100).toFixed(1) },
		category: { count: category, pct: ((category / total) * 100).toFixed(1) },
		direction: {
			count: direction,
			total: directionalPairs.length,
			pct: directionalPairs.length > 0
				? ((direction / directionalPairs.length) * 100).toFixed(1)
				: 'N/A'
		},
		highConf: {
			count: highConfCorrect,
			total: highConf.length,
			pct: highConf.length > 0
				? ((highConfCorrect / highConf.length) * 100).toFixed(1)
				: 'N/A',
		},
		perRegime,
		confusion,
	};
}

/* ===========================================================
   DISPLAY
   =========================================================== */

function displayResults(metrics) {
	const line = '═'.repeat(50);

	console.log(`\n${line}`);
	console.log('                    RESULTS');
	console.log(line);

	console.log('\nACCURACY:');
	console.log(`  Exact match:      ${metrics.exact.pct}%  (${metrics.exact.count}/${metrics.total})`);
	console.log(`  Category match:   ${metrics.category.pct}%  (${metrics.category.count}/${metrics.total})`);
	console.log(`  Direction match:  ${metrics.direction.pct}%  (${metrics.direction.count}/${metrics.direction.total})`);
	console.log(`  High conf (≥70%): ${metrics.highConf.pct}%  (${metrics.highConf.count}/${metrics.highConf.total})`);

	// Per-regime
	const regimesWithData = Object.entries(metrics.perRegime).filter(([, d]) => d.total > 0);
	if (regimesWithData.length > 0) {
		console.log('\nPER-REGIME:');
		for (const [regime, data] of regimesWithData) {
			console.log(`  ${regime.padEnd(18)} ${data.pct.padStart(5)}%  (${data.correct}/${data.total})`);
		}
	}

	// Confusion matrix (only show regimes with data)
	const activeRegimes = REGIMES.filter(r =>
		Object.values(metrics.confusion[r]).some(v => v > 0) ||
		REGIMES.some(r2 => metrics.confusion[r2][r] > 0)
	);

	if (activeRegimes.length > 0) {
		console.log('\nCONFUSION MATRIX (truth → predicted):');

		const shortName = {
			trending_bullish: 'TR_BUL', trending_bearish: 'TR_BEA',
			breakout_bullish: 'BK_BUL', breakout_bearish: 'BK_BEA', breakout_neutral: 'BK_NEU',
			range_normal: 'RG_NOR', range_low_vol: 'RG_LOW', range_high_vol: 'RG_HIG', range_directional: 'RG_DIR',
		};

		// Header
		process.stdout.write('              ');
		for (const r of activeRegimes) process.stdout.write(shortName[r].padStart(8));
		console.log();

		// Rows
		for (const truth of activeRegimes) {
			process.stdout.write(`  ${shortName[truth].padEnd(10)}  `);
			for (const pred of activeRegimes) {
				const val = metrics.confusion[truth][pred] || 0;
				process.stdout.write(val.toString().padStart(8));
			}
			console.log();
		}
	}

	// Interpretation
	console.log(`\n${line}`);
	console.log('INTERPRETATION:');
	const exactPct = parseFloat(metrics.exact.pct);
	const catPct = parseFloat(metrics.category.pct);

	// Note: avec cette méthode, on mesure la STABILITÉ du régime
	// (est-ce que le régime actuel persiste dans le futur?)
	console.log('\nCe backtest mesure: "Le régime détecté maintenant');
	console.log('sera-t-il le même dans ' + CONFIG.lookforward + ' bars?"');

	if (exactPct >= 70) console.log('\n✓ Stabilité excellente (≥70%): régimes très persistants');
	else if (exactPct >= 55) console.log('\n✓ Stabilité correcte (55-70%): régimes assez stables');
	else if (exactPct >= 40) console.log('\n~ Stabilité moyenne (40-55%): transitions fréquentes');
	else console.log('\n✗ Stabilité faible (<40%): régimes très volatils');

	if (catPct >= 80) console.log('✓ Catégories stables (≥80%): trending/range/breakout persistants');
	else if (catPct >= 65) console.log('~ Catégories moyennement stables (65-80%)');
	else console.log('✗ Catégories instables (<65%): changements fréquents de type');

	console.log('\n' + line + '\n');
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
	const barsToLoad = parseInt(getArg('bars', '2000'));

	console.log('\n══════════════════════════════════════════════════');
	console.log('       REGIME STABILITY BACKTEST');
	console.log('══════════════════════════════════════════════════');
	console.log(`Symbol: ${symbol}  |  Timeframe: ${timeframe}  |  Bars: ${barsToLoad}`);
	console.log(`Lookforward: ${CONFIG.lookforward} bars`);
	console.log('');
	console.log('Test: Regime(t) vs Regime(t + lookforward)');
	console.log('       using identical detection logic');
	console.log('══════════════════════════════════════════════════\n');

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
		maxDataPoints: parseInt(process.env.MAX_DATA_POINTS || '1000'),
		redisConfig,
	});

	const indicatorService = new IndicatorService({ logger, dataProvider });
	const regimeService = new RegimeDetectionService({ logger, dataProvider, indicatorService });

	// Load data
	console.log('Loading historical data...');
	const totalBars = barsToLoad + CONFIG.warmupBars + CONFIG.lookforward;
	const ohlcv = await dataProvider.loadOHLCV({ symbol, timeframe, count: totalBars });

	if (!ohlcv?.bars || ohlcv.bars.length < CONFIG.warmupBars + CONFIG.lookforward + 100) {
		console.error(`Insufficient data: got ${ohlcv?.bars?.length || 0} bars, need ${totalBars}`);
		process.exit(1);
	}
	console.log(`Loaded ${ohlcv.bars.length} bars\n`);

	// Run backtest
	const results = [];
	const startIdx = CONFIG.warmupBars;
	const endIdx = ohlcv.bars.length - CONFIG.lookforward;
	const totalSamples = endIdx - startIdx;
	let processed = 0;
	let errors = 0;

	console.log(`Processing ${totalSamples} samples...`);
	console.log(`(2 regime detections per sample: current + future)\n`);

	for (let i = startIdx; i < endIdx; i++) {
		const currentDate = new Date(ohlcv.bars[i].timestamp).toISOString();
		const futureDate = new Date(ohlcv.bars[i + CONFIG.lookforward].timestamp).toISOString();

		try {
			// Détection à la date courante (ce que le service prédit)
			const predictedRegime = await regimeService.detectRegime({
				symbol,
				timeframe,
				count: 200,
				analysisDate: currentDate,
			});

			// Détection à la date future (vérité terrain)
			// = ce que le service aurait détecté avec plus de données
			const futureRegime = await regimeService.detectRegime({
				symbol,
				timeframe,
				count: 200,
				analysisDate: futureDate,
			});

			const truth = generateTruthLabel(futureRegime);

			if (truth) {
				results.push({
					predicted: predictedRegime.regime,
					truth,
					confidence: predictedRegime.confidence,
				});
			}
			processed++;

			if (processed % 50 === 0) {
				const pct = ((processed / totalSamples) * 100).toFixed(0);
				process.stdout.write(`\r  Progress: ${processed}/${totalSamples} (${pct}%)`);
			}
		} catch {
			errors++;
		}
	}

	console.log(`\n\nProcessed: ${processed} | Errors: ${errors}\n`);

	// Display results
	const metrics = computeMetrics(results);
	if (metrics) {
		displayResults(metrics);
	} else {
		console.log('No results to display.');
	}
}

main().catch((e) => {
	console.error('Error:', e.message);
	process.exit(1);
});
