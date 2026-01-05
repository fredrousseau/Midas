/**
 * Statistical Context Service (Unified)
 * Complete enriched context generation with specialized enrichers
 * Generates the IDEAL context format for LLM analysis
 */

import MovingAveragesEnricher from './enrichers/MovingAveragesEnricher.js';
import MomentumEnricher from './enrichers/MomentumEnricher.js';
import VolatilityEnricher from './enrichers/VolatilityEnricher.js';
import VolumeEnricher from './enrichers/VolumeEnricher.js';
import PriceActionEnricher from './enrichers/PriceActionEnricher.js';
import PatternDetector from './enrichers/PatternDetector.js';
import { calculateStats, getPercentileRank, getTypicalRange, detectTrend, detectAnomaly, rateOfChange, round } from '../../../Utils/statisticalHelpers.js';

export class StatisticalContextService {
	constructor(options = {}) {
		this.logger = options.logger || console;
		if (!this.logger) throw new Error('StatisticalContextService requires a logger instance in options');

		this.dataProvider = options.dataProvider;
		if (!this.dataProvider) throw new Error('StatisticalContextService requires a dataProvider instance in options');

		this.regimeDetectionService = options.regimeDetectionService;

		this.indicatorService = options.indicatorService;
		if (!this.indicatorService) throw new Error('StatisticalContextService requires an indicatorService instance in options');

		this.maEnricher = new MovingAveragesEnricher({ logger: this.logger });
		this.momentumEnricher = new MomentumEnricher({ logger: this.logger });
		this.volatilityEnricher = new VolatilityEnricher({ logger: this.logger });
		this.volumeEnricher = new VolumeEnricher({ logger: this.logger });
		this.priceActionEnricher = new PriceActionEnricher({ logger: this.logger });
		this.patternDetector = new PatternDetector({ logger: this.logger });

		this.logger.info('StatisticalContextService initialized.');
	}

	/**
	 * Enrich a single indicator with statistical context
	 */
	enrichIndicator(name, currentValue, history, options = {}) {
		const { periods = [20, 50, 90] } = options;
		const isComposite = typeof currentValue === 'object' && currentValue !== null;
		const value = isComposite ? currentValue.value || currentValue.macd || currentValue.rsi : currentValue;

		const enriched = {
			name,
			value: isComposite ? currentValue : value,
			timestamp: new Date().toISOString(),
		};

		const simpleHistory = history
			.map((h) => {
				if (typeof h === 'number') return h;
				if (h && typeof h === 'object') return h.value || h.macd || h.rsi || h.close;
				return null;
			})
			.filter((v) => v !== null && !isNaN(v));

		for (const period of periods) {
			const slice = simpleHistory.slice(-period);
			if (slice.length < Math.min(10, period)) {
				enriched[`${period}d`] = { error: 'insufficient_data' };
				continue;
			}

			const stats = calculateStats(slice);
			if (!stats) {
				enriched[`${period}d`] = { error: 'calculation_failed' };
				continue;
			}

			enriched[`${period}d`] = {
				percentile: round(getPercentileRank(value, slice), 3),
				mean: round(stats.mean, 2),
				std: round(stats.std, 2),
				min: round(stats.min, 2),
				max: round(stats.max, 2),
				typical_range: getTypicalRange(slice).map((v) => round(v, 2)),
				vs_mean: stats.mean !== 0 ? `${round(((value - stats.mean) / stats.mean) * 100, 1)}%` : '0%',
			};
		}

		const trendData = detectTrend(simpleHistory.slice(-20));
		enriched.trend = trendData.direction;
		enriched.trend_strength = round(trendData.strength, 3);

		const roc5 = rateOfChange(simpleHistory, 5);
		const roc10 = rateOfChange(simpleHistory, 10);
		if (roc5 !== null) enriched.rate_of_change = { '5_bars': `${round(roc5, 2)}%`, '10_bars': roc10 !== null ? `${round(roc10, 2)}%` : null };

		const anomalyData = detectAnomaly(value, simpleHistory.slice(-90));
		if (anomalyData.isAnomaly)
			enriched.anomaly = {
				detected: true,
				z_score: round(anomalyData.zScore, 2),
				std_deviations: round(anomalyData.stdDeviations, 2),
				direction: anomalyData.direction,
			};

		return enriched;
	}

	/**
	 * Generate complete statistical context
	 * @param {Object} params
	 * @param {string} params.symbol - Trading symbol
	 * @param {Object} params.timeframes - Object mapping temporality to timeframe
	 *                                     Example: { long: '1w', medium: '1d', short: '1h' }
	 * @param {number} params.count - Number of bars to analyze
	 * @param {string} params.analysisDate - Optional date for historical analysis
	 */
	async generateFullContext({ symbol, timeframes, count = 200, analysisDate }) {
		const startTime = Date.now();

		// Validate and parse timeframes configuration
		if (!timeframes || typeof timeframes !== 'object' || Array.isArray(timeframes)) {
			throw new Error('timeframes must be an object with long/medium/short keys. Example: { long: "1w", medium: "1d", short: "1h" }');
		}

		const { timeframesArray, temporalityMap } = this._parseTimeframesConfig(timeframes);

		this.logger.info(`Generating statistical context for ${symbol} across ${timeframesArray.length} timeframes`);

		const contexts = {};
		const higherTFData = {};
		const sortedTFs = this._sortTimeframes(timeframesArray);

		for (const tf of sortedTFs) {
			// Strict mode: any error on a timeframe should fail the entire request
			// This ensures API returns proper error status when timeframe is invalid
			const tfContext = await this._generateTimeframeContext(symbol, tf, count, higherTFData, analysisDate);
			contexts[tf] = tfContext;
			higherTFData[tf] = {
				timeframe: tf,
				rsi: tfContext.momentum_indicators?.rsi?.value,
				macd: tfContext.momentum_indicators?.macd?.macd,
				atr: tfContext.volatility_indicators?.atr?.value,
			};
		}

		const alignment = this._analyzeMultiTimeframeAlignment(contexts);

		// Group timeframes by temporality (long, medium, short)
		const timeframesByTemporality = {
			long: null,
			medium: null,
			short: null
		};

		for (const [tf, data] of Object.entries(contexts)) {
			// Use explicit mapping from user configuration
			const temporality = temporalityMap[tf];

			// Assign to the corresponding temporality
			// Since we now require explicit mapping, each timeframe goes to its designated slot
			if (temporality) {
				timeframesByTemporality[temporality] = {
					timeframe: tf,
					...data
				};
			}
		}

		return {
			metadata: {
				symbol,
				timestamp: new Date().toISOString(),
				analysisDate: analysisDate || null,
				analysis_window: `${count} bars per timeframe`,
				generation_time_ms: Date.now() - startTime,
				data_quality: this._assessDataQuality(contexts),
			},
			timeframes: timeframesByTemporality,
			multi_timeframe_alignment: alignment,
		};
	}

	/**
	 * Generate context for a single timeframe
	 */
	async _generateTimeframeContext(symbol, timeframe, count, higherTFData, analysisDate) {
		const ohlcvData = await this.dataProvider.loadOHLCV({
			symbol,
			timeframe,
			count: Math.max(count, 250),
			analysisDate,
			useCache: true,
			detectGaps: false,
		});

		if (!ohlcvData || !ohlcvData.bars || ohlcvData.bars.length === 0) throw new Error(`No OHLCV data available for ${symbol} on ${timeframe}`);

		const currentPrice = ohlcvData.bars[ohlcvData.bars.length - 1].close;
		const regimeData = await this.regimeDetectionService.detectRegime({ symbol, timeframe, count: Math.min(count, 200), analysisDate });
		const contextDepth = this._getContextDepth(timeframe);

		const enriched = { timeframe, context_depth: contextDepth.level, purpose: contextDepth.purpose, regime: this._enrichRegimeData(regimeData, timeframe) };

		// Base enrichment for all levels
		enriched.moving_averages = await this.maEnricher.enrich({ ohlcvData, indicatorService: this.indicatorService, symbol, timeframe, currentPrice });
		enriched.trend_indicators = { adx: this._extractADXInfo(regimeData) };

		// Light level: basic price action only
		if (contextDepth.level === 'light') {
			enriched.price_action = this._extractBasicPriceAction(ohlcvData);
		}
		// Medium and Full: add momentum, volatility, volume
		else {
			const htf = this._getHigherTimeframe(timeframe, Object.keys(higherTFData));
			const htfData = htf ? higherTFData[htf] : null;

			enriched.momentum_indicators = await this.momentumEnricher.enrich({ ohlcvData, indicatorService: this.indicatorService, symbol, timeframe, higherTimeframeData: htfData });
			enriched.volatility_indicators = await this.volatilityEnricher.enrich({
				ohlcvData,
				indicatorService: this.indicatorService,
				symbol,
				timeframe,
				currentPrice,
				higherTimeframeData: htfData,
			});
			enriched.volume_indicators = await this.volumeEnricher.enrich({ ohlcvData, indicatorService: this.indicatorService, symbol, timeframe });
			enriched.trend_indicators.psar = await this._getPSAR(symbol, timeframe, analysisDate);
			enriched.price_action = this.priceActionEnricher.enrich({ ohlcvData, currentPrice });
			enriched.support_resistance = this._identifySupportResistance(ohlcvData, enriched);

			// Full level only: add micro patterns
			if (contextDepth.level === 'full')
				enriched.micro_patterns = this.patternDetector.detect({
					ohlcvData,
					currentPrice,
					volatilityIndicators: enriched.volatility_indicators,
					volumeIndicators: enriched.volume_indicators
				});
		}

		enriched.summary = this._generateSummary(enriched, contextDepth.level);

		return enriched;
	}

	/**
	 * Parse timeframes configuration
	 * @param {Object} timeframes - Object mapping temporality to timeframe
	 *                              Example: { long: '1w', medium: '1d', short: '1h' }
	 * @returns {Object} { timeframesArray, temporalityMap }
	 */
	_parseTimeframesConfig(timeframes) {
		const timeframesArray = [];
		const temporalityMap = {};

		// Extract timeframes and build reverse mapping
		for (const [temporality, tf] of Object.entries(timeframes)) {
			if (tf && ['long', 'medium', 'short'].includes(temporality)) {
				timeframesArray.push(tf);
				temporalityMap[tf] = temporality;
			}
		}

		// Validate that at least one timeframe was provided
		if (timeframesArray.length === 0) {
			throw new Error('No valid timeframes found. Expected object with long/medium/short keys.');
		}

		return { timeframesArray, temporalityMap };
	}

	/**
	 * Get context depth based on timeframe granularity
	 * Uses time-based logic instead of hardcoded values
	 */
	_getContextDepth(timeframe) {
		// Don't convert to lowercase - preserve M (month) vs m (minute)
		// Calculate timeframe in minutes for comparison
		const timeframeMinutes = this._getTimeframeInMinutes(timeframe);

		// Light context: Daily and above (>= 1440 minutes)
		if (timeframeMinutes >= 1440) {
			return { level: 'light', purpose: 'macro trend direction' };
		}

		// Medium context: 4h to less than daily (240-1439 minutes)
		if (timeframeMinutes >= 240) {
			return { level: 'medium', purpose: 'structure and trend phase' };
		}

		// Full context: Hourly and below (< 240 minutes)
		return { level: 'full', purpose: 'precise entry/exit timing' };
	}

	/**
	 * Convert timeframe to minutes for comparison
	 */
	_getTimeframeInMinutes(timeframe) {
		// Don't convert to lowercase to preserve M (month) vs m (minute)
		const match = timeframe.match(/^(\d+)([mhdwM])$/);

		if (!match) return 60; // Default to 1h if invalid format

		const value = parseInt(match[1]);
		const unit = match[2];

		switch (unit) {
			case 'm': return value;            // minutes
			case 'h': return value * 60;       // hours to minutes
			case 'd': return value * 1440;     // days to minutes (24 * 60)
			case 'w': return value * 10080;    // weeks to minutes (7 * 24 * 60)
			case 'M': return value * 43200;    // months to minutes (30 * 24 * 60)
			default: return 60;
		}
	}

	/**
	 * Sort timeframes by duration (longest to shortest)
	 * Uses time-based calculation instead of hardcoded values
	 */
	_sortTimeframes(timeframes) {
		return [...timeframes].sort((a, b) => {
			const minutesA = this._getTimeframeInMinutes(a);
			const minutesB = this._getTimeframeInMinutes(b);
			return minutesB - minutesA; // Descending order (longest first)
		});
	}

	/**
	 * Get the next higher timeframe from available timeframes
	 * Uses duration calculation instead of hardcoded order
	 */
	_getHigherTimeframe(currentTF, availableTFs) {
		const currentMinutes = this._getTimeframeInMinutes(currentTF);

		// Find all timeframes that are larger than current
		const higherTFs = availableTFs
			.filter(tf => this._getTimeframeInMinutes(tf) > currentMinutes)
			.sort((a, b) => this._getTimeframeInMinutes(a) - this._getTimeframeInMinutes(b));

		// Return the smallest timeframe that's still higher than current
		return higherTFs.length > 0 ? higherTFs[0] : null;
	}

	_enrichRegimeData(regimeData, timeframe) {
		if (!regimeData) return null;
		return {
			type: regimeData.regime,
			confidence: regimeData.confidence,
			interpretation: this._interpretRegime(regimeData.regime, regimeData.confidence),
			components: regimeData.components,
			timeframe,
		};
	}

	_interpretRegime(regime, confidence) {
		const interpretations = {
			trending_bullish: 'Strong upward trend with directional momentum',
			trending_bearish: 'Strong downward trend with directional momentum',
			trending_neutral: 'Trending market without clear direction',
			range_low_vol: 'Low volatility consolidation, potential breakout setup',
			range_normal: 'Normal ranging market, no clear trend',
			range_high_vol: 'High volatility chop, uncertain direction',
			breakout_bullish: 'Bullish breakout with expanding volatility',
			breakout_bearish: 'Bearish breakout with expanding volatility',
			breakout_neutral: 'Volatility expansion without clear direction',
		};
		return interpretations[regime] || 'Unknown market regime';
	}

	_extractADXInfo(regimeData) {
		if (!regimeData?.components) return null;
		const { adx, direction } = regimeData.components;
		let interpretation;
		if (adx > 30) interpretation = 'strong trend';
		else if (adx > 25) interpretation = 'trend forming';
		else if (adx < 20) interpretation = 'weak or no trend';
		else interpretation = 'neutral';
		return { value: adx, interpretation, di_plus: direction?.diPlus, di_minus: direction?.diMinus, trend: direction?.trend };
	}

	async _getPSAR(symbol, timeframe, analysisDate) {
		try {
			const series = await this.indicatorService.getIndicatorTimeSeries({
				symbol,
				indicator: 'psar',
				timeframe,
				bars: 50,
				analysisDate,
				config: { step: 0.02, max: 0.2 },
			});
			if (!series || !series.data || series.data.length === 0) return null;
			const current = series.data[series.data.length - 1];
			const psarValue = current.value;
			if (psarValue === null || psarValue === undefined || isNaN(psarValue)) return null;
			const bars = await this.dataProvider.loadOHLCV({ symbol, timeframe, count: 2, analysisDate });
			if (!bars?.bars || bars.bars.length === 0) return null;
			const currentPrice = bars.bars[bars.bars.length - 1].close;
			const position = psarValue < currentPrice ? 'below price (bullish)' : 'above price (bearish)';
			const distance = Math.abs(currentPrice - psarValue);
			return {
				value: Math.round(psarValue),
				position,
				distance: `${Math.round(distance)} points`,
				interpretation: psarValue < currentPrice ? 'trend intact' : 'potential reversal',
			};
		} catch (error) {
			this.logger.warn(`PSAR calculation failed for ${symbol} ${timeframe}: ${error.message}`);
			return null;
		}
	}

	_extractBasicPriceAction(ohlcvData) {
		const bars = ohlcvData.bars;
		const current = bars[bars.length - 1];
		const previous = bars[bars.length - 2];
		const change = ((current.close - previous.close) / previous.close) * 100;
		let structure = 'neutral';
		const last10 = bars.slice(-10);
		const highs = last10.map((b) => b.high);
		const highsIncreasing = highs[highs.length - 1] > highs[0];
		const lows = last10.map((b) => b.low);
		const lowsIncreasing = lows[lows.length - 1] > lows[0];
		if (highsIncreasing && lowsIncreasing) structure = 'uptrend';
		else if (!highsIncreasing && !lowsIncreasing) structure = 'downtrend';
		return { current: current.close, daily_change: `${change >= 0 ? '+' : ''}${Math.round(change * 10) / 10}%`, structure };
	}

	_identifySupportResistance(ohlcvData, enriched) {
		const bars = ohlcvData.bars.slice(-50);
		const currentPrice = bars[bars.length - 1].close;
		const resistanceLevels = [];
		const supportLevels = [];

		if (enriched.moving_averages?.ema) {
			const { ema12, ema26, ema50 } = enriched.moving_averages.ema;
			if (ema12) (ema12 < currentPrice ? supportLevels : resistanceLevels).push({ level: ema12, type: 'ema12', strength: 'weak' });
			if (ema26) (ema26 < currentPrice ? supportLevels : resistanceLevels).push({ level: ema26, type: 'ema26', strength: 'medium' });
			if (ema50) (ema50 < currentPrice ? supportLevels : resistanceLevels).push({ level: ema50, type: 'ema50', strength: 'strong' });
		}

		if (enriched.price_action?.swing_points) {
			const { recent_high, recent_low } = enriched.price_action.swing_points;
			if (recent_high > currentPrice) resistanceLevels.push({ level: recent_high, type: 'recent high', strength: 'medium' });
			if (recent_low < currentPrice) supportLevels.push({ level: recent_low, type: 'recent low', strength: 'medium' });
		}

		resistanceLevels.sort((a, b) => a.level - b.level);
		supportLevels.sort((a, b) => b.level - a.level);
		resistanceLevels.forEach((r) => (r.distance = `+${Math.round(((r.level - currentPrice) / currentPrice) * 10000) / 100}%`));
		supportLevels.forEach((s) => (s.distance = `-${Math.round(((currentPrice - s.level) / currentPrice) * 10000) / 100}%`));

		return {
			resistance_levels: resistanceLevels.slice(0, 3),
			support_levels: supportLevels.slice(0, 3),
			nearest_zone: supportLevels.length > 0 ? `support at ${supportLevels[0].level} (${supportLevels[0].type})` : 'no nearby support',
		};
	}

	_generateSummary(enriched, depth) {
		const parts = [];
		if (enriched.regime) parts.push(`${enriched.timeframe} ${enriched.regime.type.replace('_', ' ')}`);
		if (enriched.moving_averages?.ema?.alignment) parts.push(enriched.moving_averages.ema.alignment);
		if (depth !== 'light' && enriched.momentum_indicators?.rsi) parts.push(`RSI ${enriched.momentum_indicators.rsi.value}`);
		if (enriched.support_resistance?.nearest_zone) parts.push(enriched.support_resistance.nearest_zone);
		return parts.join(' | ');
	}

	_assessDataQuality(contexts) {
		const timeframes = Object.keys(contexts);
		const total = timeframes.length;

		// With strict error handling, all contexts should be valid
		// Quality is based on data completeness rather than error count
		if (total >= 3) return 'high';
		if (total >= 2) return 'medium';
		return 'low';
	}

	_analyzeMultiTimeframeAlignment(contexts) {
		const signals = [];
		const conflicts = [];

		// Timeframe weights for importance scoring
		const weights = { '1m': 2.5, '1w': 2.5, '1d': 3.0, '4h': 2.0, '1h': 1.5, '30m': 1.0, '15m': 0.8, '5m': 0.5 };

		for (const [tf, ctx] of Object.entries(contexts)) {
			if (!ctx?.regime) continue;

			// Extract regime class and direction
			// Regime types: trending_bullish, trending_bearish, trending_neutral, range_*, breakout_bullish, etc.
			const regimeType = ctx.regime.type;
			let regimeClass = 'unknown';
			let direction = 'neutral';

			if (regimeType.startsWith('trending_')) {
				regimeClass = 'trending';
				const parts = regimeType.split('_');
				direction = parts[1] || 'neutral'; // bullish/bearish/neutral
			} else if (regimeType.startsWith('breakout_')) {
				regimeClass = 'breakout';
				const parts = regimeType.split('_');
				direction = parts[1] || 'neutral'; // bullish/bearish/neutral
			} else if (regimeType.startsWith('range_')) {
				regimeClass = 'range';
				// For range regimes, check direction from components
				direction = ctx.regime.components?.direction?.direction || 'neutral';
			}

			signals.push({
				timeframe: tf,
				contextDepth: ctx.context_depth,
				regimeClass,
				direction,
				confidence: ctx.regime.confidence,
				weight: weights[tf] || 1.0,
				adx: ctx.trend_indicators?.adx?.value ?? null,
				atr: ctx.volatility_indicators?.atr?.value ?? null,
				rsi: ctx.momentum_indicators?.rsi?.value ?? null,
				macd: ctx.momentum_indicators?.macd?.macd ?? null,
			});
		}

		// Calculate weighted direction scores
		let bullishScore = 0;
		let bearishScore = 0;
		let neutralScore = 0;
		let totalWeight = 0;

		for (const signal of signals) {
			const weight = signal.weight * signal.confidence;
			totalWeight += weight;

			if (signal.direction === 'bullish') bullishScore += weight;
			else if (signal.direction === 'bearish') bearishScore += weight;
			else neutralScore += weight;
		}

		// Determine dominant direction
		const maxScore = Math.max(bullishScore, bearishScore, neutralScore);
		let dominant_direction = 'neutral';
		if (bullishScore === maxScore && bullishScore > 0) dominant_direction = 'bullish';
		else if (bearishScore === maxScore && bearishScore > 0) dominant_direction = 'bearish';

		// Calculate alignment score (0-1)
		const alignment_score = totalWeight > 0 ? maxScore / totalWeight : 0;

		// Detect conflicts
		const bullishSignals = signals.filter((s) => s.direction === 'bullish');
		const bearishSignals = signals.filter((s) => s.direction === 'bearish');

		if (bullishSignals.length > 0 && bearishSignals.length > 0) {
			// Check for high-weight conflicts (e.g., 1D bullish vs 4H bearish)
			const highWeightBullish = bullishSignals.filter((s) => s.weight >= 2.0);
			const highWeightBearish = bearishSignals.filter((s) => s.weight >= 2.0);

			if (highWeightBullish.length > 0 && highWeightBearish.length > 0)
				conflicts.push({
					type: 'high_timeframe_conflict',
					description: `Major conflict: ${highWeightBullish.map((s) => s.timeframe).join(',')} bullish vs ${highWeightBearish.map((s) => s.timeframe).join(',')} bearish`,
					severity: 'high',
					bullish_timeframes: highWeightBullish.map((s) => s.timeframe),
					bearish_timeframes: highWeightBearish.map((s) => s.timeframe),
				});
			else
				conflicts.push({
					type: 'directional_conflict',
					description: `${bullishSignals.length} bullish vs ${bearishSignals.length} bearish timeframes`,
					severity: Math.min(bullishSignals.length, bearishSignals.length) >= 2 ? 'moderate' : 'low',
					bullish_timeframes: bullishSignals.map((s) => s.timeframe),
					bearish_timeframes: bearishSignals.map((s) => s.timeframe),
				});
		}

		// Detect momentum divergence (HTF vs LTF)
		const htfSignals = signals.filter((s) => s.weight >= 2.0);
		const ltfSignals = signals.filter((s) => s.weight < 2.0);

		if (htfSignals.length > 0 && ltfSignals.length > 0) {
			const htfDirection = htfSignals[0].direction;
			const ltfOpposite = ltfSignals.filter((s) => (htfDirection === 'bullish' && s.direction === 'bearish') || (htfDirection === 'bearish' && s.direction === 'bullish'));

			if (ltfOpposite.length > 0)
				conflicts.push({
					type: 'htf_ltf_divergence',
					description: `HTF ${htfDirection} but LTF showing ${ltfOpposite[0].direction} signals`,
					severity: 'low',
					htf_direction: htfDirection,
					ltf_divergent: ltfOpposite.map((s) => s.timeframe),
				});
		}

		return {
			count: signals.length,
			signals,
			alignment_score: round(alignment_score, 2),
			dominant_direction,
			conflicts,
			weighted_scores: {
				bullish: round(bullishScore / totalWeight, 2),
				bearish: round(bearishScore / totalWeight, 2),
				neutral: round(neutralScore / totalWeight, 2),
			},
		};
	}
}

export default StatisticalContextService;
