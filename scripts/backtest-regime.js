/**
 * Backtest Regime Detection - Validation Prédictive
 *
 * OBJECTIF: Mesurer la CAPACITÉ PRÉDICTIVE des régimes détectés.
 *
 * MÉTHODOLOGIE (SANS CHEVAUCHEMENT):
 * - À l'instant T, on détecte le régime avec les données [T-200, T]
 * - On analyse le mouvement RÉEL du prix sur [T+1, T+N] (données futures)
 * - On compare: le régime détecté correspond-il au comportement réel du prix ?
 *
 * DONNÉES UTILISÉES:
 *   Détection:  [T-200, T]     → RegimeDetectionService
 *   Validation: [T+1, T+N]     → Analyse du prix réel (detectTrend, efficiency)
 *   → AUCUN chevauchement entre détection et validation
 *
 * CE QUE MESURE CE TEST:
 * "Le régime détecté à l'instant T prédit-il correctement ce qui va se passer
 *  sur les N bougies SUIVANTES ?" (validation prédictive)
 *
 * TRANSITIONS ACCEPTÉES COMME SUCCÈS:
 * - breakout → trending (même direction) = succès (breakout réussi)
 * - trending → breakout (même direction) = succès (catégories proches)
 *
 * BASELINE NAÏVE:
 * Le script compare les résultats à des stratégies naïves pour mesurer
 * la valeur ajoutée réelle du système de détection.
 *
 * Usage:
 *   node scripts/backtest-regime.js --symbol BTCUSDT --timeframe 1h --bars 2000
 *   node scripts/backtest-regime.js --symbol ETHUSDT --timeframe 4h --bars 1000 --lookforward 50
 */

// Environment is loaded via import 'dotenv/config' at file top so other modules see process.env
import 'dotenv/config';

import { DataProvider } from '../src/DataProvider/DataProvider.js';
import { BinanceAdapter } from '../src/DataProvider/BinanceAdapter.js';
import { IndicatorService } from '../src/Trading/Indicator/IndicatorService.js';
import { RegimeDetectionService } from '../src/Trading/MarketAnalysis/RegimeDetection/RegimeDetectionService.js';
import { logger } from '../src/Logger/LoggerService.js';
import { calculateStats, detectTrend } from '../src/Utils/statisticalHelpers.js';

/* ===========================================================
   CONFIGURATION
   =========================================================== */

const CONFIG = {
	lookforward: 20,        // Bars into future for validation
	warmupBars: 250,        // Indicator warmup
	batchSize: 50,          // Progress update frequency
	minSamplesForStats: 10, // Minimum samples for statistical analysis

	// Seuils pour la validation du prix réel
	trendThreshold: 0.02,      // 2% de mouvement minimum pour confirmer une tendance
	rangeThreshold: 0.015,     // 1.5% max pour confirmer un range
	breakoutThreshold: 0.025,  // 2.5% pour confirmer un breakout
};

const PHASES = ['nascent', 'mature', 'exhausted', 'unknown'];
const BREAKOUT_GRADES = ['high', 'medium', 'low'];

/* ===========================================================
   PRICE MOVEMENT ANALYSIS (GROUND TRUTH)
   =========================================================== */

/**
 * Analyse le mouvement réel du prix sur les N bougies suivantes
 * Utilise detectTrend de statisticalHelpers pour une détection robuste
 * Retourne les caractéristiques objectives du mouvement
 */
function analyzePriceMovement(bars, startIdx, lookforward) {
	const futureBars = bars.slice(startIdx + 1, startIdx + 1 + lookforward);
	if (futureBars.length < lookforward) return null;

	const startPrice = bars[startIdx].close;
	const endPrice = futureBars[futureBars.length - 1].close;
	const futurecloses = futureBars.map(b => b.close);
	const highestHigh = Math.max(...futureBars.map(b => b.high));
	const lowestLow = Math.min(...futureBars.map(b => b.low));

	// Calculs de base
	const netChange = (endPrice - startPrice) / startPrice;
	const maxDrawup = (highestHigh - startPrice) / startPrice;
	const maxDrawdown = (startPrice - lowestLow) / startPrice;
	const totalRange = (highestHigh - lowestLow) / startPrice;

	// Utilise detectTrend de statisticalHelpers pour une détection de tendance robuste
	// basée sur la régression linéaire (plus fiable que le simple netChange)
	const trendAnalysis = detectTrend(futurecloses, CONFIG.trendThreshold);

	// Direction basée sur detectTrend (régression linéaire)
	let actualDirection;
	if (trendAnalysis.direction === 'rising') actualDirection = 'bullish';
	else if (trendAnalysis.direction === 'declining') actualDirection = 'bearish';
	else actualDirection = 'neutral';

	// Efficacité du mouvement (Efficiency Ratio style)
	// Similaire à RegimeDetectionService._getEfficiencyRatio mais sur données futures
	const efficiency = totalRange > 0 ? Math.abs(netChange) / totalRange : 0;

	// Détection du type de mouvement réel
	let actualCategory;
	if (efficiency > 0.6 && trendAnalysis.strength > CONFIG.trendThreshold)
		// Mouvement directionnel efficace = tendance
		actualCategory = 'trending';
	else if (Math.abs(netChange) > CONFIG.breakoutThreshold && efficiency > 0.4)
		// Grand mouvement avec efficacité moyenne = breakout
		actualCategory = 'breakout';
	else if (totalRange < CONFIG.rangeThreshold * 2)
		// Peu de mouvement total = range serré
		actualCategory = 'range';
	else if (efficiency < 0.3)
		// Beaucoup de mouvement mais peu de progression nette = range volatile
		actualCategory = 'range';
	else
		// Cas intermédiaires - utilise la force de tendance de detectTrend
		actualCategory = trendAnalysis.strength > CONFIG.trendThreshold ? 'trending' : 'range';

	// Volatilité sur la période via calculateStats
	const barRanges = futureBars.map(b => (b.high - b.low) / b.open);
	const volatilityStats = calculateStats(barRanges);

	return {
		netChange,           // Variation nette en %
		netChangePct: (netChange * 100).toFixed(2),
		actualDirection,     // bullish/bearish/neutral basé sur detectTrend
		actualCategory,      // trending/breakout/range basé sur le comportement réel
		maxDrawup,           // Plus haut atteint depuis le départ
		maxDrawdown,         // Plus bas atteint depuis le départ
		totalRange,          // Amplitude totale parcourue
		efficiency,          // Efficacité du mouvement (0-1)
		trendStrength: trendAnalysis.strength, // Force de tendance (régression linéaire)
		avgVolatility: volatilityStats?.mean || 0, // Volatilité moyenne par bougie
		highestHigh,
		lowestLow,
		endPrice,
	};
}

/**
 * Compare le régime détecté avec le mouvement réel du prix
 * Retourne un score de validation
 *
 * TRANSITIONS ACCEPTÉES COMME SUCCÈS:
 * - breakout → trending (même direction) = breakout réussi qui devient tendance
 * - trending ↔ breakout (même direction) = catégories proches, comportement similaire
 */
function validateRegimeVsReality(detected, actual) {
	// Détection des transitions acceptées comme succès
	const sameDirection = detected.direction === actual.actualDirection;
	const isBreakoutToTrend = detected.category === 'breakout' && actual.actualCategory === 'trending' && sameDirection;
	const isTrendToBreakout = detected.category === 'trending' && actual.actualCategory === 'breakout' && sameDirection;
	const isSuccessfulTransition = isBreakoutToTrend || isTrendToBreakout;

	const validation = {
		// Direction correcte ?
		directionCorrect: detected.direction === actual.actualDirection,
		directionPartial: detected.direction !== 'neutral' && actual.actualDirection !== 'neutral' &&
			detected.direction === actual.actualDirection,

		// Catégorie correcte ? (inclut les transitions acceptées)
		categoryCorrect: detected.category === actual.actualCategory,
		categoryAccepted: detected.category === actual.actualCategory || isSuccessfulTransition,

		// Transition breakout → trend réussie ?
		successfulTransition: isSuccessfulTransition,
		transitionType: isBreakoutToTrend ? 'breakout→trend' : (isTrendToBreakout ? 'trend→breakout' : null),

		// Pour les tendances: le prix a-t-il bougé dans la bonne direction ?
		trendValidated: false,
		trendProfit: 0,

		// Pour les breakouts: y a-t-il eu un mouvement significatif ?
		breakoutValidated: false,

		// Pour les ranges: le prix est-il resté contenu ?
		rangeValidated: false,

		// Score global de validation (0-100)
		score: 0,
	};

	// Validation spécifique par catégorie détectée
	if (detected.category === 'trending') {
		// Une tendance est validée si le prix va dans la direction prédite
		if (detected.direction === 'bullish') {
			validation.trendValidated = actual.netChange > 0;
			validation.trendProfit = actual.netChange;
		} else if (detected.direction === 'bearish') {
			validation.trendValidated = actual.netChange < 0;
			validation.trendProfit = -actual.netChange; // Profit si short
		}
	} else if (detected.category === 'breakout') {
		// Un breakout est validé si le mouvement est significatif
		validation.breakoutValidated = Math.abs(actual.netChange) > CONFIG.breakoutThreshold ||
			actual.totalRange > CONFIG.breakoutThreshold * 1.5;

		// Bonus si la direction est correcte
		if (detected.direction !== 'neutral' && validation.breakoutValidated)
			validation.trendProfit = detected.direction === 'bullish' ? actual.netChange : -actual.netChange;

		// Un breakout qui devient trending dans la même direction = succès total
		if (isBreakoutToTrend)
			validation.breakoutValidated = true;
	} else if (detected.category === 'range') {
		// Un range est validé si le prix reste contenu
		validation.rangeValidated = actual.totalRange < CONFIG.rangeThreshold * 3 ||
			actual.efficiency < 0.4;
	}

	// Calcul du score global
	let score = 0;

	// Points pour la catégorie (40 points max)
	if (validation.categoryCorrect)
		score += 40;
	else if (isSuccessfulTransition)
		// Transition acceptée = presque aussi bon qu'une correspondance exacte
		score += 35;
	else if (
		(detected.category === 'trending' && actual.actualCategory === 'breakout') ||
		(detected.category === 'breakout' && actual.actualCategory === 'trending')
	)
		// Catégories proches mais direction différente
		score += 15;

	// Points pour la direction (30 points max)
	if (validation.directionCorrect) score += 30;
	else if (detected.direction === 'neutral' || actual.actualDirection === 'neutral') score += 15;

	// Points pour la validation spécifique (30 points max)
	if (detected.category === 'trending' && validation.trendValidated) score += 30;
	else if (detected.category === 'breakout' && validation.breakoutValidated) score += 30;
	else if (detected.category === 'range' && validation.rangeValidated) score += 30;

	validation.score = score;

	return validation;
}

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

/**
 * Calcule les scores de baselines naïves pour comparaison
 * Permet de mesurer la valeur ajoutée réelle du système de détection
 */
function computeNaiveBaselines(results) {
	const total = results.length;
	if (total === 0) return null;

	// Baseline 1: "Toujours Range" - prédit toujours un range neutral
	const alwaysRange = results.filter(r => r.truth.category === 'range').length;
	const alwaysRangeScore = (alwaysRange / total * 100);

	// Baseline 2: "Toujours Trending" - prédit toujours une tendance
	const alwaysTrending = results.filter(r => r.truth.category === 'trending').length;
	const alwaysTrendingScore = (alwaysTrending / total * 100);

	// Baseline 3: "Direction précédente" - prédit que la direction reste la même
	// Simule: si le prix montait avant T, il continuera à monter
	let prevDirectionCorrect = 0;
	for (let i = 1; i < results.length; i++) {
		const prevDirection = results[i - 1].truth.direction;
		const currentDirection = results[i].truth.direction;
		if (prevDirection === currentDirection && prevDirection !== 'neutral')
			prevDirectionCorrect++;
	}
	const prevDirectionScore = results.length > 1 ? (prevDirectionCorrect / (results.length - 1) * 100) : 0;

	// Baseline 4: "Catégorie la plus fréquente" - prédit toujours la catégorie majoritaire
	const categoryCounts = { trending: 0, breakout: 0, range: 0 };
	for (const r of results)
		categoryCounts[r.truth.category] = (categoryCounts[r.truth.category] || 0) + 1;
	const mostFrequentCategory = Object.entries(categoryCounts).sort((a, b) => b[1] - a[1])[0];
	const mostFrequentScore = (mostFrequentCategory[1] / total * 100);

	// Baseline 5: "Random" - précision attendue si on choisit au hasard (33% pour 3 catégories)
	const randomScore = 33.3;

	// Score du système (pour comparaison)
	const systemCategoryCorrect = results.filter(r => r.predicted.category === r.truth.category).length;
	const systemScore = (systemCategoryCorrect / total * 100);

	// Score avec transitions acceptées
	const systemAccepted = results.filter(r => r.validation?.categoryAccepted).length;
	const systemAcceptedScore = (systemAccepted / total * 100);

	return {
		alwaysRange: { score: alwaysRangeScore.toFixed(1), count: alwaysRange },
		alwaysTrending: { score: alwaysTrendingScore.toFixed(1), count: alwaysTrending },
		prevDirection: { score: prevDirectionScore.toFixed(1), count: prevDirectionCorrect },
		mostFrequent: { category: mostFrequentCategory[0], score: mostFrequentScore.toFixed(1), count: mostFrequentCategory[1] },
		random: { score: randomScore.toFixed(1) },
		system: { score: systemScore.toFixed(1), count: systemCategoryCorrect },
		systemAccepted: { score: systemAcceptedScore.toFixed(1), count: systemAccepted },
		// Avantage du système sur les baselines
		advantage: {
			vsRandom: (systemScore - randomScore).toFixed(1),
			vsMostFrequent: (systemScore - mostFrequentScore).toFixed(1),
			vsPrevDirection: (systemScore - prevDirectionScore).toFixed(1),
		},
	};
}

function computeBasicMetrics(results) {
	const total = results.length;
	if (total === 0) return null;

	// Exact match (catégorie + direction)
	const exact = results.filter(r => r.predicted.regime === r.truth.regime).length;

	// Category match
	const category = results.filter(r => r.predicted.category === r.truth.category).length;

	// Direction match
	const directionalPairs = results.filter(r =>
		r.truth.direction !== 'neutral' && r.predicted.direction !== 'neutral'
	);
	const directionCorrect = directionalPairs.filter(r =>
		r.predicted.direction === r.truth.direction
	).length;

	// Validation scores (basé sur le prix réel)
	const withValidation = results.filter(r => r.validation);
	const avgValidationScore = withValidation.length > 0
		? withValidation.reduce((sum, r) => sum + r.validation.score, 0) / withValidation.length
		: 0;

	// Validation par type de régime détecté
	const trendResults = results.filter(r => r.predicted.category === 'trending' && r.validation);
	const trendValidated = trendResults.filter(r => r.validation.trendValidated).length;

	const breakoutResults = results.filter(r => r.predicted.category === 'breakout' && r.validation);
	const breakoutValidated = breakoutResults.filter(r => r.validation.breakoutValidated).length;

	const rangeResults = results.filter(r => r.predicted.category === 'range' && r.validation);
	const rangeValidated = rangeResults.filter(r => r.validation.rangeValidated).length;

	// Profit/Loss moyen sur les tendances (si on avait suivi le signal)
	const avgTrendProfit = trendResults.length > 0
		? trendResults.reduce((sum, r) => sum + (r.validation.trendProfit || 0), 0) / trendResults.length
		: 0;

	// Confidence buckets
	const highConf = results.filter(r => r.predicted.confidence >= 0.7);
	const medConf = results.filter(r => r.predicted.confidence >= 0.5 && r.predicted.confidence < 0.7);
	const lowConf = results.filter(r => r.predicted.confidence < 0.5);

	const highConfCorrect = highConf.filter(r => r.predicted.category === r.truth.category).length;
	const medConfCorrect = medConf.filter(r => r.predicted.category === r.truth.category).length;
	const lowConfCorrect = lowConf.filter(r => r.predicted.category === r.truth.category).length;

	return {
		total,
		exact: { count: exact, pct: (exact / total * 100).toFixed(1) },
		category: { count: category, pct: (category / total * 100).toFixed(1) },
		direction: {
			correct: directionCorrect,
			total: directionalPairs.length,
			pct: directionalPairs.length > 0 ? (directionCorrect / directionalPairs.length * 100).toFixed(1) : 'N/A',
		},
		validation: {
			avgScore: avgValidationScore.toFixed(1),
			trending: {
				total: trendResults.length,
				validated: trendValidated,
				pct: trendResults.length > 0 ? (trendValidated / trendResults.length * 100).toFixed(1) : 'N/A',
				avgProfit: (avgTrendProfit * 100).toFixed(2),
			},
			breakout: {
				total: breakoutResults.length,
				validated: breakoutValidated,
				pct: breakoutResults.length > 0 ? (breakoutValidated / breakoutResults.length * 100).toFixed(1) : 'N/A',
			},
			range: {
				total: rangeResults.length,
				validated: rangeValidated,
				pct: rangeResults.length > 0 ? (rangeValidated / rangeResults.length * 100).toFixed(1) : 'N/A',
			},
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

function computeCategorySynthesis(results) {
	const categories = ['trending', 'breakout', 'range'];
	const synthesis = {};

	for (const category of categories) {
		const categoryResults = results.filter(r => r.predicted.category === category);
		if (categoryResults.length < CONFIG.minSamplesForStats) continue;

		const exactMatch = categoryResults.filter(r => r.predicted.regime === r.truth.regime).length;
		const categoryMatch = categoryResults.filter(r => r.predicted.category === r.truth.category).length;

		// Direction accuracy within category
		const directionalPairs = categoryResults.filter(r =>
			r.predicted.direction !== 'neutral' && r.truth.direction !== 'neutral'
		);
		const directionMatch = directionalPairs.filter(r => r.predicted.direction === r.truth.direction).length;

		// Average confidence
		const avgConfidence = categoryResults.reduce((sum, r) => sum + r.predicted.confidence, 0) / categoryResults.length;

		// What this category typically becomes
		const outcomes = {};
		for (const r of categoryResults) {
			const truthCat = r.truth.category;
			outcomes[truthCat] = (outcomes[truthCat] || 0) + 1;
		}

		synthesis[category] = {
			total: categoryResults.length,
			exactMatch: { count: exactMatch, pct: (exactMatch / categoryResults.length * 100).toFixed(1) },
			categoryMatch: { count: categoryMatch, pct: (categoryMatch / categoryResults.length * 100).toFixed(1) },
			directionMatch: directionalPairs.length > 0 ? {
				count: directionMatch,
				total: directionalPairs.length,
				pct: (directionMatch / directionalPairs.length * 100).toFixed(1),
			} : null,
			avgConfidence: avgConfidence.toFixed(2),
			outcomes: Object.entries(outcomes)
				.sort((a, b) => b[1] - a[1])
				.map(([cat, count]) => ({ category: cat, count, pct: (count / categoryResults.length * 100).toFixed(1) })),
		};
	}

	return synthesis;
}

function computeDirectionSynthesis(results) {
	const directions = ['bullish', 'bearish', 'neutral'];
	const synthesis = {};

	for (const direction of directions) {
		const directionResults = results.filter(r => r.predicted.direction === direction);
		if (directionResults.length < CONFIG.minSamplesForStats) continue;

		const exactMatch = directionResults.filter(r => r.predicted.regime === r.truth.regime).length;
		const directionMatch = directionResults.filter(r => r.predicted.direction === r.truth.direction).length;
		const categoryMatch = directionResults.filter(r => r.predicted.category === r.truth.category).length;

		// Average confidence
		const avgConfidence = directionResults.reduce((sum, r) => sum + r.predicted.confidence, 0) / directionResults.length;

		// What this direction typically becomes
		const outcomes = {};
		for (const r of directionResults) {
			const truthDir = r.truth.direction;
			outcomes[truthDir] = (outcomes[truthDir] || 0) + 1;
		}

		synthesis[direction] = {
			total: directionResults.length,
			exactMatch: { count: exactMatch, pct: (exactMatch / directionResults.length * 100).toFixed(1) },
			directionMatch: { count: directionMatch, pct: (directionMatch / directionResults.length * 100).toFixed(1) },
			categoryMatch: { count: categoryMatch, pct: (categoryMatch / directionResults.length * 100).toFixed(1) },
			avgConfidence: avgConfidence.toFixed(2),
			outcomes: Object.entries(outcomes)
				.sort((a, b) => b[1] - a[1])
				.map(([dir, count]) => ({ direction: dir, count, pct: (count / directionResults.length * 100).toFixed(1) })),
		};
	}

	return synthesis;
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
	const line = '═'.repeat(70);
	const thinLine = '─'.repeat(70);

	console.log(`\n${line}`);
	console.log('          RAPPORT DE BACKTEST - RÉGIME vs PRIX RÉEL');
	console.log(`${line}`);

	// ========== MÉTHODOLOGIE ==========
	console.log(`\n${thinLine}`);
	console.log('🔬 MÉTHODOLOGIE DU TEST (SANS CHEVAUCHEMENT)');
	console.log(`${thinLine}`);

	console.log(`
  CE QUE MESURE CE TEST:
    "Le régime détecté à l'instant T prédit-il correctement
     ce qui va se passer sur les ${config.lookforward} bougies SUIVANTES ?"

  DONNÉES UTILISÉES:
    • Détection:  bougies [T-200, T] pour identifier le régime
    • Validation: bougies [T+1, T+${config.lookforward}] pour vérifier le mouvement réel
    → AUCUN chevauchement entre détection et validation

  SEUILS DE VALIDATION:
    • Tendance confirmée si mouvement > ${(config.trendThreshold * 100).toFixed(1)}%
    • Range confirmé si amplitude < ${(config.rangeThreshold * 100).toFixed(1)}%
    • Breakout confirmé si mouvement > ${(config.breakoutThreshold * 100).toFixed(1)}%
`);

	// ========== GLOSSAIRE ==========
	console.log(`${thinLine}`);
	console.log('📖 GLOSSAIRE - COMPRENDRE LES TERMES');
	console.log(`${thinLine}`);
	console.log(`
  CATÉGORIES DE MARCHÉ (ce que fait le prix):
    • TRENDING  = Tendance : le prix monte ou descend de façon directionnelle
    • BREAKOUT  = Percée : le prix sort d'une zone de consolidation
    • RANGE     = Latéral : le prix oscille dans une fourchette sans direction

  SOUS-TYPES DE RANGE (nuances du marché latéral):
    • range_normal      = Volatilité et ADX normaux (cas par défaut)
    • range_low_vol     = Basse volatilité + faible efficacité (marché calme, compression)
    • range_high_vol    = Haute volatilité mais sans direction (agité, erratique)
    • range_directional = ADX élevé mais mouvement inefficace (faux signaux directionnels)

  DIRECTIONS (où va le prix):
    • BULLISH   = Haussier : mouvement vers le haut
    • BEARISH   = Baissier : mouvement vers le bas
    • NEUTRAL   = Neutre : pas de direction claire

  MÉTRIQUES:
    • Validation = Le régime détecté correspond-il au mouvement réel du prix ?
    • Confiance = Certitude du système (0-100%). Plus c'est haut, plus c'est fiable.
`);

	// ========== RÉSUMÉ GLOBAL ==========
	console.log(`${thinLine}`);
	console.log('📊 RÉSUMÉ GLOBAL - PRÉCISION PRÉDICTIVE');
	console.log(`${thinLine}`);

	const catPct = parseFloat(metrics.basic.category.pct);
	const avgScore = parseFloat(metrics.basic.validation.avgScore);

	console.log(`
  Sur ${metrics.basic.total} analyses effectuées:

  ┌─────────────────────────────────────────────────────────────────┐
  │ SCORE DE VALIDATION MOYEN:          ${metrics.basic.validation.avgScore.padStart(5)}/100                     │
  │ → Mesure composite: catégorie + direction + validation spécif.  │
  │                                                                 │
  │ CATÉGORIE correcte:                 ${metrics.basic.category.pct.padStart(5)}%  (${String(metrics.basic.category.count).padStart(4)}/${metrics.basic.total})    │
  │ → Le type prédit (trending/breakout/range) = mouvement réel     │
  │                                                                 │
  │ DIRECTION correcte:                 ${metrics.basic.direction.pct.padStart(5)}%  (${String(metrics.basic.direction.correct).padStart(4)}/${metrics.basic.direction.total})    │
  │ → La direction prédite = direction réelle du prix               │
  └─────────────────────────────────────────────────────────────────┘
`);

	// Interpretation visuelle
	let validationIcon, validationText;
	if (avgScore >= 70) { validationIcon = '🟢'; validationText = 'Excellente précision - Les régimes prédisent bien le marché'; }
	else if (avgScore >= 55) { validationIcon = '🟡'; validationText = 'Bonne précision - Les régimes sont globalement fiables'; }
	else if (avgScore >= 40) { validationIcon = '🟠'; validationText = 'Précision moyenne - À utiliser avec prudence'; }
	else { validationIcon = '🔴'; validationText = 'Faible précision - Les régimes ne prédisent pas bien'; }

	console.log(`  ${validationIcon} ${validationText}`);

	// ========== COMPARAISON AVEC BASELINES NAÏVES ==========
	if (metrics.baselines) {
		console.log(`\n${thinLine}`);
		console.log('📏 COMPARAISON AVEC BASELINES NAÏVES');
		console.log(`${thinLine}`);
		console.log('  Question: "Le système fait-il mieux que des stratégies triviales ?"');
		console.log('');

		const b = metrics.baselines;

		console.log('  ┌───────────────────────────────┬──────────┬─────────────────────────────┐');
		console.log('  │ Stratégie                     │ Précision│ Description                 │');
		console.log('  ├───────────────────────────────┼──────────┼─────────────────────────────┤');
		console.log(`  │ 🎯 SYSTÈME (notre détection)  │ ${b.system.score.padStart(6)}%  │ RegimeDetectionService      │`);
		console.log(`  │ 🎯 + transitions acceptées    │ ${b.systemAccepted.score.padStart(6)}%  │ breakout↔trend = succès     │`);
		console.log('  ├───────────────────────────────┼──────────┼─────────────────────────────┤');
		console.log(`  │ 📊 Catégorie majoritaire      │ ${b.mostFrequent.score.padStart(6)}%  │ Toujours "${b.mostFrequent.category}"        │`);
		console.log(`  │ 📈 Toujours "trending"        │ ${b.alwaysTrending.score.padStart(6)}%  │ Prédit toujours tendance    │`);
		console.log(`  │ 📉 Toujours "range"           │ ${b.alwaysRange.score.padStart(6)}%  │ Prédit toujours latéral     │`);
		console.log(`  │ 🔄 Direction précédente       │ ${b.prevDirection.score.padStart(6)}%  │ Même direction que avant    │`);
		console.log(`  │ 🎲 Aléatoire                  │ ${b.random.score.padStart(6)}%  │ 1 chance sur 3              │`);
		console.log('  └───────────────────────────────┴──────────┴─────────────────────────────┘');
		console.log('');

		// Interprétation
		const advantage = parseFloat(b.advantage.vsMostFrequent);
		if (advantage > 10)
			console.log(`  🟢 Le système bat la meilleure baseline de +${advantage}% (valeur ajoutée significative)`);
		else if (advantage > 5)
			console.log(`  🟡 Le système bat la meilleure baseline de +${advantage}% (valeur ajoutée modérée)`);
		else if (advantage > 0)
			console.log(`  🟠 Le système bat la meilleure baseline de +${advantage}% (valeur ajoutée faible)`);
		else
			console.log(`  🔴 Le système ne bat PAS la baseline majoritaire (${advantage}%)`);
	}

	// ========== VALIDATION PAR TYPE DE RÉGIME ==========
	console.log(`\n${thinLine}`);
	console.log('🎯 VALIDATION PAR TYPE DE RÉGIME DÉTECTÉ');
	console.log(`${thinLine}`);
	console.log('  Question: "Quand le système détecte un régime, le prix confirme-t-il ?"');
	console.log('');

	const v = metrics.basic.validation;

	console.log('  ┌── TRENDING (Tendances détectées)');
	console.log(`  │   ${v.trending.total} détections de tendance`);
	console.log(`  │   Validées par le prix: ${v.trending.pct}% (${v.trending.validated}/${v.trending.total})`);
	console.log(`  │   → Le prix a bougé dans la direction prédite`);
	if (parseFloat(v.trending.avgProfit) !== 0)
		console.log(`  │   Profit moyen si suivi: ${v.trending.avgProfit}%`);
	console.log(`  └${'─'.repeat(60)}`);
	console.log('');

	console.log('  ┌── BREAKOUT (Percées détectées)');
	console.log(`  │   ${v.breakout.total} détections de breakout`);
	console.log(`  │   Validées par le prix: ${v.breakout.pct}% (${v.breakout.validated}/${v.breakout.total})`);
	console.log(`  │   → Un mouvement significatif (>${(config.breakoutThreshold * 100).toFixed(1)}%) a eu lieu`);
	console.log(`  └${'─'.repeat(60)}`);
	console.log('');

	console.log('  ┌── RANGE (Latéraux détectés)');
	console.log(`  │   ${v.range.total} détections de range`);
	console.log(`  │   Validées par le prix: ${v.range.pct}% (${v.range.validated}/${v.range.total})`);
	console.log(`  │   → Le prix est resté contenu sans tendance forte`);
	console.log(`  └${'─'.repeat(60)}`);

	// ========== SYNTHÈSE PAR CATÉGORIE ==========
	if (Object.keys(metrics.categorySynthesis).length > 0) {
		console.log(`\n${thinLine}`);
		console.log('📈 ANALYSE PAR CATÉGORIE DE MARCHÉ');
		console.log(`${thinLine}`);
		console.log('  Question: "Quand le système détecte une catégorie, reste-t-elle stable ?"');
		console.log('');

		const catLabels = {
			trending: { name: 'TRENDING (Tendance)', desc: 'Prix en mouvement directionnel' },
			breakout: { name: 'BREAKOUT (Percée)', desc: 'Sortie de zone de consolidation' },
			range: { name: 'RANGE (Latéral)', desc: 'Prix oscillant sans direction' },
		};

		for (const [category, data] of Object.entries(metrics.categorySynthesis)) {
			const label = catLabels[category];
			console.log(`  ┌── ${label.name} (${data.total} détections)`);
			console.log(`  │   ${label.desc}`);
			console.log(`  │`);
			console.log(`  │   Stabilité catégorie: ${data.categoryMatch.pct.padStart(5)}%  → Sur ${data.total}, ${data.categoryMatch.count} restent ${category}`);
			console.log(`  │   Stabilité exacte:    ${data.exactMatch.pct.padStart(5)}%  → Régime précis inchangé`);
			console.log(`  │   Confiance moyenne:   ${(parseFloat(data.avgConfidence) * 100).toFixed(0)}%`);

			// Transitions
			const transitions = data.outcomes.filter(o => o.category !== category);
			if (transitions.length > 0) {
				console.log(`  │`);
				console.log(`  │   Quand ça change, ça devient:`);
				for (const t of transitions)
					console.log(`  │     → ${t.category}: ${t.pct}% des cas`);
			}
			console.log(`  └${'─'.repeat(60)}`);
			console.log('');
		}
	}

	// ========== SYNTHÈSE PAR DIRECTION ==========
	if (Object.keys(metrics.directionSynthesis).length > 0) {
		console.log(`${thinLine}`);
		console.log('🧭 ANALYSE PAR DIRECTION');
		console.log(`${thinLine}`);
		console.log('  Question: "Quand le système détecte une direction, reste-t-elle stable ?"');
		console.log('');

		const dirLabels = {
			bullish: { name: 'BULLISH (Haussier)', icon: '↗️', desc: 'Mouvement vers le haut' },
			bearish: { name: 'BEARISH (Baissier)', icon: '↘️', desc: 'Mouvement vers le bas' },
			neutral: { name: 'NEUTRAL (Neutre)', icon: '↔️', desc: 'Pas de direction claire' },
		};

		for (const [direction, data] of Object.entries(metrics.directionSynthesis)) {
			const label = dirLabels[direction];
			console.log(`  ┌── ${label.icon} ${label.name} (${data.total} détections)`);
			console.log(`  │   ${label.desc}`);
			console.log(`  │`);
			console.log(`  │   Direction stable:    ${data.directionMatch.pct.padStart(5)}%  → Sur ${data.total}, ${data.directionMatch.count} gardent cette direction`);
			console.log(`  │   Catégorie stable:    ${data.categoryMatch.pct.padStart(5)}%  → Le type de marché persiste`);
			console.log(`  │   Confiance moyenne:   ${(parseFloat(data.avgConfidence) * 100).toFixed(0)}%`);

			// Transitions
			const transitions = data.outcomes.filter(o => o.direction !== direction);
			if (transitions.length > 0) {
				console.log(`  │`);
				console.log(`  │   Quand ça change, ça devient:`);
				for (const t of transitions)
					console.log(`  │     → ${t.direction}: ${t.pct}% des cas`);
			}
			console.log(`  └${'─'.repeat(60)}`);
			console.log('');
		}
	}

	// ========== FIABILITÉ PAR NIVEAU DE CONFIANCE ==========
	console.log(`${thinLine}`);
	console.log('🎯 FIABILITÉ SELON LE NIVEAU DE CONFIANCE');
	console.log(`${thinLine}`);
	console.log('  Question: "Les détections à haute confiance sont-elles plus fiables ?"');
	console.log('');
	console.log('  ┌───────────────────┬────────────┬─────────────────────────────────┐');
	console.log('  │ Niveau confiance  │ Nb analyses│ Régime stable après (précision) │');
	console.log('  ├───────────────────┼────────────┼─────────────────────────────────┤');
	console.log(`  │ 🟢 Haute (≥70%)   │ ${String(metrics.basic.confidence.high.total).padStart(6)}     │ ${String(metrics.basic.confidence.high.pct).padStart(5)}% (${metrics.basic.confidence.high.correct}/${metrics.basic.confidence.high.total})                   │`);
	console.log(`  │ 🟡 Moyenne (50-70)│ ${String(metrics.basic.confidence.medium.total).padStart(6)}     │ ${String(metrics.basic.confidence.medium.pct).padStart(5)}% (${metrics.basic.confidence.medium.correct}/${metrics.basic.confidence.medium.total})                   │`);
	console.log(`  │ 🔴 Basse (<50%)   │ ${String(metrics.basic.confidence.low.total).padStart(6)}     │ ${String(metrics.basic.confidence.low.pct).padStart(5)}% (${metrics.basic.confidence.low.correct}/${metrics.basic.confidence.low.total})                   │`);
	console.log('  └───────────────────┴────────────┴─────────────────────────────────┘');

	const highConfPct = parseFloat(metrics.basic.confidence.high.pct || 0);
	const lowConfPct = parseFloat(metrics.basic.confidence.low.pct || 0);
	if (highConfPct > lowConfPct + 10)
		console.log(`\n  💡 Insight: Les détections haute confiance sont ${(highConfPct - lowConfPct).toFixed(0)}% plus fiables`);

	// ========== TRANSITIONS LES PLUS FRÉQUENTES ==========
	if (metrics.transitions.length > 0) {
		console.log(`\n${thinLine}`);
		console.log('🔄 TRANSITIONS LES PLUS FRÉQUENTES');
		console.log(`${thinLine}`);
		console.log('  Les changements de régime les plus courants sur la période:');
		console.log('');

		for (const t of metrics.transitions.slice(0, 8)) {
			const [from, to] = t.transition.split(' → ');
			const bar = '█'.repeat(Math.max(1, Math.round(parseFloat(t.pct))));
			console.log(`  ${from.padEnd(18)} → ${to.padEnd(18)} ${bar} ${t.pct}% (${t.count}x)`);
		}
	}

	// ========== INSIGHTS CLÉS ==========
	console.log(`\n${thinLine}`);
	console.log('💡 INSIGHTS CLÉS');
	console.log(`${thinLine}`);

	const insights = [];

	// Phase insight
	const phaseData = metrics.phaseCorrelation;
	if (phaseData.nascent && phaseData.exhausted) {
		const nascentPct = parseFloat(phaseData.nascent.exactMatch.pct);
		const exhaustedPct = parseFloat(phaseData.exhausted.exactMatch.pct);
		if (nascentPct > exhaustedPct + 10)
			insights.push(`Les tendances naissantes sont ${(nascentPct - exhaustedPct).toFixed(0)}% plus stables que les tendances épuisées`);
		else if (exhaustedPct > nascentPct + 10)
			insights.push(`Les tendances épuisées sont étonnamment ${(exhaustedPct - nascentPct).toFixed(0)}% plus stables`);
	}

	// Volume insight
	if (metrics.breakoutQuality?.volumeAnalysis) {
		const va = metrics.breakoutQuality.volumeAnalysis;
		if (va.confirmed && va.notConfirmed) {
			const withVol = parseFloat(va.confirmed.pct);
			const withoutVol = parseFloat(va.notConfirmed.pct);
			if (withVol > withoutVol + 10)
				insights.push(`Les breakouts confirmés par le volume sont ${(withVol - withoutVol).toFixed(0)}% plus stables`);
		}
	}

	// Confidence insight
	if (highConfPct > lowConfPct + 15)
		insights.push(`Les détections haute confiance sont ${(highConfPct - lowConfPct).toFixed(0)}% plus fiables que les basses`);

	// Category insights
	if (metrics.categorySynthesis.trending && metrics.categorySynthesis.range) {
		const trendStab = parseFloat(metrics.categorySynthesis.trending.categoryMatch.pct);
		const rangeStab = parseFloat(metrics.categorySynthesis.range.categoryMatch.pct);
		if (trendStab > rangeStab + 10)
			insights.push(`Les tendances sont ${(trendStab - rangeStab).toFixed(0)}% plus stables que les ranges`);
		else if (rangeStab > trendStab + 10)
			insights.push(`Les ranges sont ${(rangeStab - trendStab).toFixed(0)}% plus stables que les tendances`);
	}

	if (insights.length === 0)
		insights.push('Pas de différence significative détectée entre les différents facteurs');

	for (const insight of insights)
		console.log(`  • ${insight}`);

	// ========== CONCLUSION ==========
	console.log(`\n${line}`);
	console.log('📋 CONCLUSION');
	console.log(`${line}`);

	console.log(`
  QUESTION TESTÉE:
  "Le régime détecté à l'instant T prédit-il correctement
   le mouvement du prix sur les ${config.lookforward} bougies suivantes ?"

  ✓ Aucun chevauchement de données entre détection et validation
`);

	if (avgScore >= 70)
		console.log('  ✅ EXCELLENT: Les régimes prédisent bien le comportement du marché.');
	else if (avgScore >= 55)
		console.log('  ✅ BON: Les régimes sont globalement prédictifs. Privilégiez les hautes confiances.');
	else if (avgScore >= 40)
		console.log('  ⚠️  MOYEN: Précision limitée, à utiliser avec d\'autres confirmations.');
	else
		console.log('  ❌ FAIBLE: Les régimes ne prédisent pas bien le marché.');

	if (catPct >= 60)
		console.log('  ✅ Les catégories (trending/range/breakout) sont souvent correctes.');
	else if (catPct >= 45)
		console.log('  ⚠️  Les catégories sont parfois incorrectes.');
	else
		console.log('  ❌ Les catégories prédites ne correspondent pas au mouvement réel.');

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
	const barsToLoad = parseInt(getArg('bars', '2000'));
	CONFIG.lookforward = parseInt(getArg('lookforward', String(CONFIG.lookforward)));

	console.log('\n' + '═'.repeat(60));
	console.log('      BACKTEST RÉGIME vs PRIX RÉEL (SANS CHEVAUCHEMENT)');
	console.log('═'.repeat(60));
	console.log(`Symbol: ${symbol}  |  Timeframe: ${timeframe}  |  Bars: ${barsToLoad}`);
	console.log(`Lookforward: ${CONFIG.lookforward} bars  |  Warmup: ${CONFIG.warmupBars} bars`);
	console.log('');
	console.log('Testing: Régime détecté à T vs Mouvement réel du prix [T+1, T+N]');
	console.log('Seuils: Trend >' + (CONFIG.trendThreshold * 100) + '%, Range <' + (CONFIG.rangeThreshold * 100) + '%, Breakout >' + (CONFIG.breakoutThreshold * 100) + '%');
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
	console.log(`(1 détection de régime + analyse du prix réel par sample)\n`);

	const startTime = Date.now();

	for (let i = startIdx; i < endIdx; i++) {
		const currentDate = new Date(ohlcv.bars[i].timestamp).toISOString();

		try {
			// Détection du régime à l'instant T
			// Utilise les données de [T-200, T] pour déterminer le régime
			const currentRegime = await regimeService.detectRegime({
				symbol,
				timeframe,
				count: 200,
				analysisDate: currentDate,
			});

			// Analyse du mouvement RÉEL du prix sur les N bougies suivantes [T+1, T+N]
			// AUCUN chevauchement avec les données utilisées pour la détection
			const priceMovement = analyzePriceMovement(ohlcv.bars, i, CONFIG.lookforward);

			const detectedData = extractFullData(currentRegime);

			if (detectedData && priceMovement) {
				// Valider le régime détecté contre la réalité
				const validation = validateRegimeVsReality(detectedData, priceMovement);

				results.push({
					predicted: detectedData,        // régime détecté à T
					truth: {                        // "vérité terrain" basée sur le prix réel
						regime: `${priceMovement.actualCategory}_${priceMovement.actualDirection}`,
						category: priceMovement.actualCategory,
						direction: priceMovement.actualDirection,
						confidence: priceMovement.efficiency, // utilise l'efficacité comme proxy
					},
					priceMovement,                  // données brutes du mouvement
					validation,                     // résultat de la validation
					timestamp: currentDate,
				});
			}
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
		baselines: computeNaiveBaselines(results),
		categorySynthesis: computeCategorySynthesis(results),
		directionSynthesis: computeDirectionSynthesis(results),
		phaseCorrelation: computePhaseCorrelation(results),
		breakoutQuality: computeBreakoutQualityCorrelation(results),
		transitions: computeTransitionPatterns(results),
	};

	// Display results
	displayResults(metrics, CONFIG);
}

main().catch((e) => {
	console.error('Error:', e.message);
	console.error(e.stack);
	process.exit(1);
});