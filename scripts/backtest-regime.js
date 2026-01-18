#!/usr/bin/env node
/**
 * Backtest Regime Detection - Enhanced Version
 *
 * Tests regime stability and analyzes all RegimeDetectionService capabilities:
 * - Regime stability over lookforward period
 * - Trend phase correlation (nascent/mature/exhausted vs stability)
 * - Breakout quality correlation (high/medium/low vs persistence)
 * - Volume confirmation effectiveness
 * - Compression detection accuracy
 * - Transition pattern analysis
 * - Scoring component breakdown
 *
 * Usage:
 *   node scripts/backtest-regime.js --symbol BTCUSDT --timeframe 1h --bars 2000
 *   node scripts/backtest-regime.js --symbol ETHUSDT --timeframe 4h --bars 1000 --lookforward 10
 */

// Environment is loaded via import 'dotenv/config' at file top so other modules see process.env
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
	lookforward: 20,        // Bars into future for validation
	warmupBars: 250,        // Indicator warmup
	batchSize: 50,          // Progress update frequency
	minSamplesForStats: 10, // Minimum samples for statistical analysis
};

const REGIMES = [
	'trending_bullish', 'trending_bearish',
	'breakout_bullish', 'breakout_bearish', 'breakout_neutral',
	'range_normal', 'range_low_vol', 'range_high_vol', 'range_directional',
];

const PHASES = ['nascent', 'mature', 'exhausted', 'unknown'];
const BREAKOUT_GRADES = ['high', 'medium', 'low'];

/* ===========================================================
   ENHANCED DATA COLLECTION
   =========================================================== */

/**
 * Extract all relevant data from a regime detection result
 */
function extractFullData(regimeResult) {
	if (!regimeResult) return null;

	return {
		// Core
		regime: regimeResult.regime,
		direction: regimeResult.direction,
		confidence: regimeResult.confidence,

		// Category extraction
		category: regimeResult.regime.split('_')[0],

		// Trend phase
		phase: regimeResult.trend_phase?.phase || 'unknown',
		adxSlopeDirection: regimeResult.trend_phase?.adx_slope?.direction || 'unknown',
		adxSlopeStrength: regimeResult.trend_phase?.adx_slope?.strength || 0,

		// Components
		adx: regimeResult.components?.adx || 0,
		efficiencyRatio: regimeResult.components?.efficiency_ratio || 0,
		atrRatio: regimeResult.components?.atr_ratio || 0,
		directionStrength: regimeResult.components?.direction?.strength || 0,

		// Volume
		volumeAvailable: regimeResult.volume_analysis !== null,
		volumeRatio: regimeResult.volume_analysis?.ratio || null,
		volumeSpike: regimeResult.volume_analysis?.is_spike || false,
		volumeConfirmsBreakout: regimeResult.volume_analysis?.confirms_breakout || false,
		volumeTrend: regimeResult.volume_analysis?.trend || null,

		// Compression
		compressionDetected: regimeResult.compression?.detected || false,
		compressionRatio: regimeResult.compression?.ratio || null,

		// Breakout quality
		breakoutQuality: regimeResult.breakout_quality?.grade || null,
		breakoutScore: regimeResult.breakout_quality?.score || null,
		breakoutFactors: regimeResult.breakout_quality?.factors || [],

		// Scoring details
		regimeClarity: regimeResult.scoring_details?.regime_clarity || 0,
		erScore: regimeResult.scoring_details?.er_score || 0,
		directionScore: regimeResult.scoring_details?.direction_score || 0,
		coherence: regimeResult.scoring_details?.coherence || 0,
		phaseBonus: regimeResult.scoring_details?.phase_bonus || 0,

		// Thresholds used
		thresholds: regimeResult.thresholds || null,
	};
}

/* ===========================================================
   METRICS COMPUTATION
   =========================================================== */

function computeBasicMetrics(results) {
	const total = results.length;
	if (total === 0) return null;

	// Exact match
	const exact = results.filter(r => r.predicted.regime === r.truth.regime).length;

	// Category match
	const category = results.filter(r => r.predicted.category === r.truth.category).length;

	// Direction match (for directional regimes only)
	const directionalPairs = results.filter(r =>
		r.truth.direction !== 'neutral' && r.predicted.direction !== 'neutral'
	);
	const direction = directionalPairs.filter(r =>
		r.predicted.direction === r.truth.direction
	).length;

	// Confidence buckets
	const highConf = results.filter(r => r.predicted.confidence >= 0.7);
	const medConf = results.filter(r => r.predicted.confidence >= 0.5 && r.predicted.confidence < 0.7);
	const lowConf = results.filter(r => r.predicted.confidence < 0.5);

	const highConfCorrect = highConf.filter(r => r.predicted.regime === r.truth.regime).length;
	const medConfCorrect = medConf.filter(r => r.predicted.regime === r.truth.regime).length;
	const lowConfCorrect = lowConf.filter(r => r.predicted.regime === r.truth.regime).length;

	return {
		total,
		exact: { count: exact, pct: (exact / total * 100).toFixed(1) },
		category: { count: category, pct: (category / total * 100).toFixed(1) },
		direction: {
			count: direction,
			total: directionalPairs.length,
			pct: directionalPairs.length > 0 ? (direction / directionalPairs.length * 100).toFixed(1) : 'N/A',
		},
		confidence: {
			high: { total: highConf.length, correct: highConfCorrect, pct: highConf.length > 0 ? (highConfCorrect / highConf.length * 100).toFixed(1) : 'N/A' },
			medium: { total: medConf.length, correct: medConfCorrect, pct: medConf.length > 0 ? (medConfCorrect / medConf.length * 100).toFixed(1) : 'N/A' },
			low: { total: lowConf.length, correct: lowConfCorrect, pct: lowConf.length > 0 ? (lowConfCorrect / lowConf.length * 100).toFixed(1) : 'N/A' },
		},
	};
}

function computePhaseCorrelation(results) {
	const byPhase = {};

	for (const phase of PHASES) {
		const phaseResults = results.filter(r => r.predicted.phase === phase);
		if (phaseResults.length < CONFIG.minSamplesForStats) continue;

		const exact = phaseResults.filter(r => r.predicted.regime === r.truth.regime).length;
		const category = phaseResults.filter(r => r.predicted.category === r.truth.category).length;

		// For trending regimes specifically
		const trendingResults = phaseResults.filter(r => r.predicted.category === 'trending');
		const trendingStable = trendingResults.filter(r => r.predicted.regime === r.truth.regime).length;

		byPhase[phase] = {
			total: phaseResults.length,
			exactMatch: { count: exact, pct: (exact / phaseResults.length * 100).toFixed(1) },
			categoryMatch: { count: category, pct: (category / phaseResults.length * 100).toFixed(1) },
			avgConfidence: (phaseResults.reduce((sum, r) => sum + r.predicted.confidence, 0) / phaseResults.length).toFixed(2),
			avgADX: (phaseResults.reduce((sum, r) => sum + r.predicted.adx, 0) / phaseResults.length).toFixed(1),
			trending: trendingResults.length > 0 ? {
				total: trendingResults.length,
				stable: trendingStable,
				pct: (trendingStable / trendingResults.length * 100).toFixed(1),
			} : null,
		};
	}

	return byPhase;
}

function computeBreakoutQualityCorrelation(results) {
	const breakoutResults = results.filter(r => r.predicted.category === 'breakout');
	if (breakoutResults.length < CONFIG.minSamplesForStats) return null;

	const byGrade = {};

	for (const grade of BREAKOUT_GRADES) {
		const gradeResults = breakoutResults.filter(r => r.predicted.breakoutQuality === grade);
		if (gradeResults.length < 3) continue;

		const exact = gradeResults.filter(r => r.predicted.regime === r.truth.regime).length;
		const stillBreakout = gradeResults.filter(r => r.truth.category === 'breakout').length;
		const becameTrending = gradeResults.filter(r => r.truth.category === 'trending').length;
		const becameRange = gradeResults.filter(r => r.truth.category === 'range').length;

		byGrade[grade] = {
			total: gradeResults.length,
			exactMatch: { count: exact, pct: (exact / gradeResults.length * 100).toFixed(1) },
			outcomes: {
				stillBreakout: { count: stillBreakout, pct: (stillBreakout / gradeResults.length * 100).toFixed(1) },
				becameTrending: { count: becameTrending, pct: (becameTrending / gradeResults.length * 100).toFixed(1) },
				becameRange: { count: becameRange, pct: (becameRange / gradeResults.length * 100).toFixed(1) },
			},
			avgScore: (gradeResults.reduce((sum, r) => sum + (r.predicted.breakoutScore || 0), 0) / gradeResults.length).toFixed(0),
		};
	}

	// Volume confirmation analysis
	const volumeConfirmed = breakoutResults.filter(r => r.predicted.volumeConfirmsBreakout);
	const volumeNotConfirmed = breakoutResults.filter(r => r.predicted.volumeAvailable && !r.predicted.volumeConfirmsBreakout);

	const volumeAnalysis = {
		confirmed: volumeConfirmed.length >= 3 ? {
			total: volumeConfirmed.length,
			stable: volumeConfirmed.filter(r => r.predicted.regime === r.truth.regime).length,
			pct: (volumeConfirmed.filter(r => r.predicted.regime === r.truth.regime).length / volumeConfirmed.length * 100).toFixed(1),
		} : null,
		notConfirmed: volumeNotConfirmed.length >= 3 ? {
			total: volumeNotConfirmed.length,
			stable: volumeNotConfirmed.filter(r => r.predicted.regime === r.truth.regime).length,
			pct: (volumeNotConfirmed.filter(r => r.predicted.regime === r.truth.regime).length / volumeNotConfirmed.length * 100).toFixed(1),
		} : null,
	};

	// Compression analysis
	const withCompression = breakoutResults.filter(r => r.predicted.compressionDetected);
	const withoutCompression = breakoutResults.filter(r => !r.predicted.compressionDetected);

	const compressionAnalysis = {
		withCompression: withCompression.length >= 3 ? {
			total: withCompression.length,
			stable: withCompression.filter(r => r.predicted.regime === r.truth.regime).length,
			pct: (withCompression.filter(r => r.predicted.regime === r.truth.regime).length / withCompression.length * 100).toFixed(1),
		} : null,
		withoutCompression: withoutCompression.length >= 3 ? {
			total: withoutCompression.length,
			stable: withoutCompression.filter(r => r.predicted.regime === r.truth.regime).length,
			pct: (withoutCompression.filter(r => r.predicted.regime === r.truth.regime).length / withoutCompression.length * 100).toFixed(1),
		} : null,
	};

	return { byGrade, volumeAnalysis, compressionAnalysis };
}

function computeTransitionPatterns(results) {
	const transitions = {};

	for (const r of results) {
		const from = r.predicted.regime;
		const to = r.truth.regime;

		if (from === to) continue; // Skip stable regimes

		const key = `${from} → ${to}`;
		if (!transitions[key])
			transitions[key] = {
				count: 0,
				avgConfidence: 0,
				avgADX: 0,
				samples: [],
			};
		transitions[key].count++;
		transitions[key].samples.push({
			confidence: r.predicted.confidence,
			adx: r.predicted.adx,
			phase: r.predicted.phase,
		});
	}

	// Calculate averages and sort by frequency
	const sorted = Object.entries(transitions)
		.map(([key, data]) => ({
			transition: key,
			count: data.count,
			pct: (data.count / results.length * 100).toFixed(1),
			avgConfidence: (data.samples.reduce((s, x) => s + x.confidence, 0) / data.samples.length).toFixed(2),
			avgADX: (data.samples.reduce((s, x) => s + x.adx, 0) / data.samples.length).toFixed(1),
			dominantPhase: getMostFrequent(data.samples.map(s => s.phase)),
		}))
		.sort((a, b) => b.count - a.count)
		.slice(0, 15); // Top 15 transitions

	return sorted;
}

function computeScoringCorrelation(results) {
	// Analyze which scoring components best predict stability
	const stable = results.filter(r => r.predicted.regime === r.truth.regime);
	const unstable = results.filter(r => r.predicted.regime !== r.truth.regime);

	if (stable.length < CONFIG.minSamplesForStats || unstable.length < CONFIG.minSamplesForStats) return null;

	const components = ['regimeClarity', 'erScore', 'directionScore', 'coherence', 'confidence', 'adx', 'efficiencyRatio'];

	const analysis = {};

	for (const comp of components) {
		const stableAvg = stable.reduce((s, r) => s + (r.predicted[comp] || 0), 0) / stable.length;
		const unstableAvg = unstable.reduce((s, r) => s + (r.predicted[comp] || 0), 0) / unstable.length;
		const diff = stableAvg - unstableAvg;

		analysis[comp] = {
			stableAvg: stableAvg.toFixed(3),
			unstableAvg: unstableAvg.toFixed(3),
			difference: diff.toFixed(3),
			predictive: Math.abs(diff) > 0.05 ? (diff > 0 ? 'higher_better' : 'lower_better') : 'neutral',
		};
	}

	return analysis;
}

function computePerRegimeBreakdown(results) {
	const perRegime = {};

	for (const regime of REGIMES) {
		const regimeResults = results.filter(r => r.truth.regime === regime);
		if (regimeResults.length < 3) continue;

		const correct = regimeResults.filter(r => r.predicted.regime === regime).length;

		// What does this regime typically become?
		const outcomes = {};
		for (const r of regimeResults) {
			const pred = r.predicted.regime;
			outcomes[pred] = (outcomes[pred] || 0) + 1;
		}

		// Sort outcomes by frequency
		const sortedOutcomes = Object.entries(outcomes)
			.sort((a, b) => b[1] - a[1])
			.slice(0, 3)
			.map(([reg, count]) => ({ regime: reg, count, pct: (count / regimeResults.length * 100).toFixed(1) }));

		perRegime[regime] = {
			total: regimeResults.length,
			correct,
			pct: (correct / regimeResults.length * 100).toFixed(1),
			topOutcomes: sortedOutcomes,
		};
	}

	return perRegime;
}

function computeConfusionMatrix(results) {
	const confusion = {};

	for (const r of REGIMES) {
		confusion[r] = {};
		for (const c of REGIMES) confusion[r][c] = 0;
	}

	for (const r of results) {
		const truth = r.truth.regime;
		const pred = r.predicted.regime;
		if (confusion[truth]?.[pred] !== undefined)
			confusion[truth][pred]++;
	}

	return confusion;
}

/* ===========================================================
   HELPERS
   =========================================================== */

function getMostFrequent(arr) {
	const counts = {};
	for (const item of arr) counts[item] = (counts[item] || 0) + 1;
	return Object.entries(counts).sort((a, b) => b[1] - a[1])[0]?.[0] || 'unknown';
}

/* ===========================================================
   DISPLAY
   =========================================================== */

function displayResults(metrics, config) {
	const line = '═'.repeat(60);
	const thinLine = '─'.repeat(60);

	console.log(`\n${line}`);
	console.log('                      BACKTEST RESULTS');
	console.log(`${line}\n`);

	// Basic accuracy
	console.log('BASIC ACCURACY:');
	console.log(`  Exact match:      ${metrics.basic.exact.pct}%  (${metrics.basic.exact.count}/${metrics.basic.total})`);
	console.log(`  Category match:   ${metrics.basic.category.pct}%  (${metrics.basic.category.count}/${metrics.basic.total})`);
	console.log(`  Direction match:  ${metrics.basic.direction.pct}%  (${metrics.basic.direction.count}/${metrics.basic.direction.total})`);

	// Confidence breakdown
	console.log(`\nCONFIDENCE BREAKDOWN:`);
	console.log(`  High (≥70%):    ${metrics.basic.confidence.high.pct}%  (${metrics.basic.confidence.high.correct}/${metrics.basic.confidence.high.total})`);
	console.log(`  Medium (50-70%): ${metrics.basic.confidence.medium.pct}%  (${metrics.basic.confidence.medium.correct}/${metrics.basic.confidence.medium.total})`);
	console.log(`  Low (<50%):     ${metrics.basic.confidence.low.pct}%  (${metrics.basic.confidence.low.correct}/${metrics.basic.confidence.low.total})`);

	// Phase correlation
	if (Object.keys(metrics.phaseCorrelation).length > 0) {
		console.log(`\n${thinLine}`);
		console.log('TREND PHASE CORRELATION:');
		console.log('(Does ADX slope predict regime stability?)\n');

		for (const [phase, data] of Object.entries(metrics.phaseCorrelation)) {
			const trendInfo = data.trending ? ` | Trending: ${data.trending.pct}% stable (${data.trending.stable}/${data.trending.total})` : '';
			console.log(`  ${phase.padEnd(10)} n=${String(data.total).padStart(4)} | Exact: ${data.exactMatch.pct.padStart(5)}% | Cat: ${data.categoryMatch.pct.padStart(5)}% | Avg ADX: ${data.avgADX}${trendInfo}`);
		}
	}

	// Breakout quality
	if (metrics.breakoutQuality) {
		console.log(`\n${thinLine}`);
		console.log('BREAKOUT QUALITY CORRELATION:');
		console.log('(Do high-quality breakouts persist longer?)\n');

		if (Object.keys(metrics.breakoutQuality.byGrade).length > 0)
			for (const [grade, data] of Object.entries(metrics.breakoutQuality.byGrade))
				console.log(`  ${grade.toUpperCase().padEnd(8)} n=${String(data.total).padStart(3)} | Stable: ${data.exactMatch.pct.padStart(5)}% | →Trend: ${data.outcomes.becameTrending.pct.padStart(5)}% | →Range: ${data.outcomes.becameRange.pct.padStart(5)}% | Avg Score: ${data.avgScore}`);

		// Volume confirmation
		if (metrics.breakoutQuality.volumeAnalysis.confirmed || metrics.breakoutQuality.volumeAnalysis.notConfirmed) {
			console.log('\n  Volume Confirmation:');
			if (metrics.breakoutQuality.volumeAnalysis.confirmed)
				console.log(`    With volume:    ${metrics.breakoutQuality.volumeAnalysis.confirmed.pct}% stable (${metrics.breakoutQuality.volumeAnalysis.confirmed.stable}/${metrics.breakoutQuality.volumeAnalysis.confirmed.total})`);
			if (metrics.breakoutQuality.volumeAnalysis.notConfirmed)
				console.log(`    Without volume: ${metrics.breakoutQuality.volumeAnalysis.notConfirmed.pct}% stable (${metrics.breakoutQuality.volumeAnalysis.notConfirmed.stable}/${metrics.breakoutQuality.volumeAnalysis.notConfirmed.total})`);
		}

		// Compression
		if (metrics.breakoutQuality.compressionAnalysis.withCompression || metrics.breakoutQuality.compressionAnalysis.withoutCompression) {
			console.log('\n  Prior Compression:');
			if (metrics.breakoutQuality.compressionAnalysis.withCompression)
				console.log(`    With compression:    ${metrics.breakoutQuality.compressionAnalysis.withCompression.pct}% stable (${metrics.breakoutQuality.compressionAnalysis.withCompression.stable}/${metrics.breakoutQuality.compressionAnalysis.withCompression.total})`);
			if (metrics.breakoutQuality.compressionAnalysis.withoutCompression)
				console.log(`    Without compression: ${metrics.breakoutQuality.compressionAnalysis.withoutCompression.pct}% stable (${metrics.breakoutQuality.compressionAnalysis.withoutCompression.stable}/${metrics.breakoutQuality.compressionAnalysis.withoutCompression.total})`);
		}
	}

	// Transition patterns
	if (metrics.transitions.length > 0) {
		console.log(`\n${thinLine}`);
		console.log('TOP REGIME TRANSITIONS:');
		console.log('(Most common regime changes over lookforward period)\n');

		for (const t of metrics.transitions.slice(0, 10))
			console.log(`  ${t.transition.padEnd(40)} ${String(t.count).padStart(4)}x (${t.pct.padStart(4)}%) | Conf: ${t.avgConfidence} | ADX: ${t.avgADX} | Phase: ${t.dominantPhase}`);
	}

	// Scoring correlation
	if (metrics.scoringCorrelation) {
		console.log(`\n${thinLine}`);
		console.log('SCORING COMPONENT ANALYSIS:');
		console.log('(Which scores best predict stability?)\n');

		const sorted = Object.entries(metrics.scoringCorrelation)
			.sort((a, b) => Math.abs(parseFloat(b[1].difference)) - Math.abs(parseFloat(a[1].difference)));

		for (const [comp, data] of sorted) {
			const indicator = data.predictive === 'higher_better' ? '↑' : data.predictive === 'lower_better' ? '↓' : '─';
			console.log(`  ${comp.padEnd(18)} Stable: ${data.stableAvg.padStart(6)} | Unstable: ${data.unstableAvg.padStart(6)} | Diff: ${data.difference.padStart(7)} ${indicator}`);
		}
	}

	// Per-regime breakdown
	if (Object.keys(metrics.perRegime).length > 0) {
		console.log(`\n${thinLine}`);
		console.log('PER-REGIME STABILITY:');
		console.log('(How stable is each regime over lookforward?)\n');

		const sortedRegimes = Object.entries(metrics.perRegime).sort((a, b) => parseFloat(b[1].pct) - parseFloat(a[1].pct));

		for (const [regime, data] of sortedRegimes) {
			const topOutcome = data.topOutcomes[0];
			const outcomeStr = topOutcome && topOutcome.regime !== regime
				? ` → often becomes: ${topOutcome.regime} (${topOutcome.pct}%)`
				: '';
			console.log(`  ${regime.padEnd(20)} ${data.pct.padStart(5)}% stable (${String(data.correct).padStart(3)}/${String(data.total).padStart(3)})${outcomeStr}`);
		}
	}

	// Confusion matrix
	displayConfusionMatrix(metrics.confusion);

	// Interpretation
	console.log(`\n${line}`);
	console.log('INTERPRETATION:');
	console.log(`\nThis backtest measures: "Will the regime detected now`);
	console.log(`persist for the next ${config.lookforward} bars?"\n`);

	const exactPct = parseFloat(metrics.basic.exact.pct);
	const catPct = parseFloat(metrics.basic.category.pct);

	if (exactPct >= 70) console.log('✓ Excellent stability (≥70%): Regimes are highly persistent');
	else if (exactPct >= 55) console.log('✓ Good stability (55-70%): Regimes are fairly stable');
	else if (exactPct >= 40) console.log('~ Moderate stability (40-55%): Frequent transitions');
	else console.log('✗ Low stability (<40%): Regimes are very volatile');

	if (catPct >= 80) console.log('✓ Categories stable (≥80%): trending/range/breakout persist well');
	else if (catPct >= 65) console.log('~ Categories moderately stable (65-80%)');
	else console.log('✗ Categories unstable (<65%): Frequent type changes');

	// Key insights
	console.log('\nKEY INSIGHTS:');

	// Phase insight
	const phaseData = metrics.phaseCorrelation;
	if (phaseData.nascent && phaseData.exhausted) {
		const nascentPct = parseFloat(phaseData.nascent.exactMatch.pct);
		const exhaustedPct = parseFloat(phaseData.exhausted.exactMatch.pct);
		if (nascentPct > exhaustedPct + 10)
			console.log(`  • Nascent trends are ${(nascentPct - exhaustedPct).toFixed(0)}% more stable than exhausted ones`);
		else if (exhaustedPct > nascentPct + 10)
			console.log(`  • Exhausted trends are surprisingly ${(exhaustedPct - nascentPct).toFixed(0)}% more stable`);
	}

	// Volume insight
	if (metrics.breakoutQuality?.volumeAnalysis) {
		const va = metrics.breakoutQuality.volumeAnalysis;
		if (va.confirmed && va.notConfirmed) {
			const withVol = parseFloat(va.confirmed.pct);
			const withoutVol = parseFloat(va.notConfirmed.pct);
			if (withVol > withoutVol + 10)
				console.log(`  • Volume-confirmed breakouts are ${(withVol - withoutVol).toFixed(0)}% more stable`);
		}
	}

	// Confidence insight
	const highConfPct = parseFloat(metrics.basic.confidence.high.pct || 0);
	const lowConfPct = parseFloat(metrics.basic.confidence.low.pct || 0);
	if (highConfPct > lowConfPct + 15)
		console.log(`  • High-confidence detections are ${(highConfPct - lowConfPct).toFixed(0)}% more reliable`);

	console.log(`\n${line}\n`);
}

function displayConfusionMatrix(confusion) {
	const activeRegimes = REGIMES.filter(r =>
		Object.values(confusion[r]).some(v => v > 0) ||
		REGIMES.some(r2 => confusion[r2][r] > 0)
	);

	if (activeRegimes.length === 0) return;

	console.log(`\n${'─'.repeat(60)}`);
	console.log('CONFUSION MATRIX (truth → predicted):');

	const shortName = {
		trending_bullish: 'TR_BUL', trending_bearish: 'TR_BEA',
		breakout_bullish: 'BK_BUL', breakout_bearish: 'BK_BEA', breakout_neutral: 'BK_NEU',
		range_normal: 'RG_NOR', range_low_vol: 'RG_LOW', range_high_vol: 'RG_HIG', range_directional: 'RG_DIR',
	};

	// Header
	process.stdout.write('\n              ');
	for (const r of activeRegimes) process.stdout.write(shortName[r].padStart(8));
	console.log();

	// Rows
	for (const truth of activeRegimes) {
		process.stdout.write(`  ${shortName[truth].padEnd(10)}  `);
		for (const pred of activeRegimes) {
			const val = confusion[truth][pred] || 0;
			process.stdout.write(val.toString().padStart(8));
		}
		console.log();
	}
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
	CONFIG.lookforward = parseInt(getArg('lookforward', String(CONFIG.lookforward)));

	console.log('\n' + '═'.repeat(60));
	console.log('         ENHANCED REGIME STABILITY BACKTEST');
	console.log('═'.repeat(60));
	console.log(`Symbol: ${symbol}  |  Timeframe: ${timeframe}  |  Bars: ${barsToLoad}`);
	console.log(`Lookforward: ${CONFIG.lookforward} bars  |  Warmup: ${CONFIG.warmupBars} bars`);
	console.log('');
	console.log('Testing: Regime(t) vs Regime(t + lookforward)');
	console.log('Analyzing: Phase, Volume, Compression, Quality, Transitions');
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

	// Pre-load all historical data once
	console.log('Loading historical data...');
	const totalBars = barsToLoad + CONFIG.warmupBars + CONFIG.lookforward;
	const ohlcv = await dataProvider.loadOHLCV({ symbol, timeframe, count: totalBars });

	if (!ohlcv?.bars || ohlcv.bars.length < CONFIG.warmupBars + CONFIG.lookforward + 100) {
		console.error(`Insufficient data: got ${ohlcv?.bars?.length || 0} bars, need ${totalBars}`);
		process.exit(1);
	}
	console.log(`Loaded ${ohlcv.bars.length} bars (data will be cached for regime detection)\n`);

	// Run backtest
	const results = [];
	const startIdx = CONFIG.warmupBars;
	const endIdx = ohlcv.bars.length - CONFIG.lookforward;
	const totalSamples = endIdx - startIdx;
	let processed = 0;
	let errors = 0;

	console.log(`Processing ${totalSamples} samples...`);
	console.log(`(2 regime detections per sample: current + future)\n`);

	const startTime = Date.now();

	for (let i = startIdx; i < endIdx; i++) {
		const currentDate = new Date(ohlcv.bars[i].timestamp).toISOString();
		const futureDate = new Date(ohlcv.bars[i + CONFIG.lookforward].timestamp).toISOString();

		try {
			// Current regime detection (what the service predicts)
			const predictedRegime = await regimeService.detectRegime({
				symbol,
				timeframe,
				count: 200,
				analysisDate: currentDate,
			});

			// Future regime detection (ground truth)
			const futureRegime = await regimeService.detectRegime({
				symbol,
				timeframe,
				count: 200,
				analysisDate: futureDate,
			});

			const predictedData = extractFullData(predictedRegime);
			const truthData = extractFullData(futureRegime);

			if (predictedData && truthData)
				results.push({
					predicted: predictedData,
					truth: truthData,
					timestamp: currentDate,
				});
			processed++;

			if (processed % CONFIG.batchSize === 0) {
				const pct = (processed / totalSamples * 100).toFixed(0);
				const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
				const rate = (processed / parseFloat(elapsed)).toFixed(1);
				process.stdout.write(`\r  Progress: ${processed}/${totalSamples} (${pct}%) | ${elapsed}s | ${rate} samples/s`);
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

	// Compute all metrics
	const metrics = {
		basic: computeBasicMetrics(results),
		phaseCorrelation: computePhaseCorrelation(results),
		breakoutQuality: computeBreakoutQualityCorrelation(results),
		transitions: computeTransitionPatterns(results),
		scoringCorrelation: computeScoringCorrelation(results),
		perRegime: computePerRegimeBreakdown(results),
		confusion: computeConfusionMatrix(results),
	};

	// Display results
	displayResults(metrics, CONFIG);
}

main().catch((e) => {
	console.error('Error:', e.message);
	console.error(e.stack);
	process.exit(1);
});
