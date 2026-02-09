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
import { round } from '../../Utils/statisticalHelpers.js';
import { getBarCount } from './config/barCounts.js';
import { STATISTICAL_PERIODS, TREND_PERIODS, PATTERN_PERIODS, SUPPORT_RESISTANCE_PERIODS } from './config/lookbackPeriods.js';

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
	 * Generate complete statistical context
	 * Uses adaptive bar counts based on timeframe for optimal performance
	 * @param {Object} params
	 * @param {string} params.symbol - Trading symbol
	 * @param {Object} params.timeframes - Object mapping temporality to timeframe
	 *                                     Example: { long: '1w', medium: '1d', short: '1h' }
	 * @param {string} params.analysisDate - Optional date for historical analysis
	 */
	async generateFullContext({ symbol, timeframes, analysisDate }) {
		const startTime = Date.now();

		// Validate and parse timeframes configuration
		if (!timeframes || typeof timeframes !== 'object' || Array.isArray(timeframes)) 
			throw new Error('timeframes must be an object with long/medium/short keys. Example: { long: "1w", medium: "1d", short: "1h" }');

		const { timeframesArray, temporalityMap } = this._parseTimeframesConfig(timeframes);

		this.logger.info(`Generating statistical context for ${symbol} across ${timeframesArray.length} timeframes`);

		const contexts = {};
		const higherTFData = {};
		const sortedTFs = this._sortTimeframes(timeframesArray);

		for (const tf of sortedTFs) {
			// Strict mode: any error on a timeframe should fail the entire request
			// This ensures API returns proper error status when timeframe is invalid
			const tfContext = await this._generateTimeframeContext(symbol, tf, higherTFData, analysisDate);
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
			if (temporality) 
				timeframesByTemporality[temporality] = {
					timeframe: tf,
					...data
				};
			
		}

		// Build bars summary for metadata
		const barsSummary = {};
		for (const [tf, data] of Object.entries(contexts)) 
			barsSummary[tf] = {
				requested: data.bars_requested,
				analyzed: data.bars_analyzed
			};

		return {
			metadata: {
				symbol,
				timestamp: new Date().toISOString(),
				analysisDate: analysisDate || null,
				analysis_window: 'adaptive (timeframe-based)',
				bars_per_timeframe: barsSummary,
				generation_time_ms: Date.now() - startTime,
				data_quality: this._assessDataQuality(contexts),
			},
			timeframes: timeframesByTemporality,
			_internal_alignment: alignment, // Used internally by MarketContextService
		};
	}

	/**
	 * Get adaptive OHLCV bar count based on timeframe
	 * Larger timeframes need fewer bars to avoid excessive historical data requirements
	 * Uses centralized configuration from config/barCounts.js
	 */
	_getAdaptiveOHLCVCount(timeframe) {
		return getBarCount('ohlcv', timeframe);
	}

	/**
	 * Generate context for a single timeframe
	 * Uses adaptive bar count based on timeframe
	 */
	async _generateTimeframeContext(symbol, timeframe, higherTFData, analysisDate) {
		const barCount = this._getAdaptiveOHLCVCount(timeframe);

		const ohlcvData = await this.dataProvider.loadOHLCV({
			symbol,
			timeframe,
			count: barCount,
			analysisDate,
			useCache: true,
			detectGaps: false,
		});

		if (!ohlcvData || !ohlcvData.bars || ohlcvData.bars.length === 0) throw new Error(`No OHLCV data available for ${symbol} on ${timeframe}`);

		const currentPrice = ohlcvData.bars[ohlcvData.bars.length - 1].close;
		const regimeData = await this.regimeDetectionService.detectRegime({ symbol, timeframe, count: barCount, analysisDate });
		const contextDepth = this._getContextDepth(timeframe);

		const enriched = {
			timeframe,
			context_depth: contextDepth.level,
			purpose: contextDepth.purpose,
			bars_analyzed: ohlcvData.bars.length,
			bars_requested: barCount,
			regime: this._enrichRegimeData(regimeData, timeframe)
		};

		// Base enrichment for all levels
		enriched.moving_averages = await this.maEnricher.enrich({ ohlcvData, indicatorService: this.indicatorService, symbol, timeframe, currentPrice, analysisDate });
		enriched.trend_indicators = { adx: this._extractADXInfo(regimeData) };

		// Light level: basic price action only
		if (contextDepth.level === 'light') {
			enriched.price_action = this._extractBasicPriceAction(ohlcvData);
		}
		// Medium and Full: add momentum, volatility, volume
		else {
			const htf = this._getHigherTimeframe(timeframe, Object.keys(higherTFData));
			const htfData = htf ? higherTFData[htf] : null;

			enriched.momentum_indicators = await this.momentumEnricher.enrich({ ohlcvData, indicatorService: this.indicatorService, symbol, timeframe, higherTimeframeData: htfData, analysisDate });
			enriched.volatility_indicators = await this.volatilityEnricher.enrich({
				ohlcvData,
				indicatorService: this.indicatorService,
				symbol,
				timeframe,
				currentPrice,
				higherTimeframeData: htfData,
				analysisDate,
			});
			enriched.volume_indicators = await this.volumeEnricher.enrich({ ohlcvData, indicatorService: this.indicatorService, symbol, timeframe, analysisDate });
			enriched.trend_indicators.psar = await this._getPSAR(symbol, timeframe, analysisDate);
			enriched.price_action = this.priceActionEnricher.enrich({ ohlcvData, currentPrice });
			enriched.support_resistance = this._identifySupportResistance(ohlcvData, enriched);

			// Full level only: add micro patterns
			if (contextDepth.level === 'full')
				enriched.micro_patterns = this.patternDetector.detect({
					ohlcvData,
					currentPrice,
					volatilityIndicators: enriched.volatility_indicators,
					volumeIndicators: enriched.volume_indicators,
					momentumIndicators: enriched.momentum_indicators,
					trendIndicators: enriched.trend_indicators
				});
		}

		// Add coherence check for medium and full depth contexts
		if (contextDepth.level !== 'light') 
			enriched.coherence_check = this._assessCoherence({
				ema_alignment: enriched.moving_averages?.ema?.alignment,
				macd_cross: enriched.momentum_indicators?.macd?.cross,
				psar_position: enriched.trend_indicators?.psar?.position,
				rsi_trend: enriched.momentum_indicators?.rsi?.trend,
				regime: enriched.regime?.type
			});

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
		for (const [temporality, tf] of Object.entries(timeframes)) 
			if (tf && ['long', 'medium', 'short'].includes(temporality)) {
				timeframesArray.push(tf);
				temporalityMap[tf] = temporality;
			}

		// Validate that at least one timeframe was provided
		if (timeframesArray.length === 0) 
			throw new Error('No valid timeframes found. Expected object with long/medium/short keys.');

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
		if (timeframeMinutes >= 1440) 
			return { level: 'light', purpose: 'macro trend direction' };

		// Medium context: 4h to less than daily (240-1439 minutes)
		if (timeframeMinutes >= 240) 
			return { level: 'medium', purpose: 'structure and trend phase' };

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
			interpretation: this._interpretRegime(regimeData.regime),
			components: regimeData.components,
			timeframe,
			// Include range bounds for range regimes
			range_bounds: regimeData.range_bounds || null,
			// Include trend phase info
			trend_phase: regimeData.trend_phase?.phase || null,
			// Include compression info for breakout context
			compression: regimeData.compression?.detected ? regimeData.compression : null,
			// Include breakout quality for breakout regimes
			breakout_quality: regimeData.breakout_quality || null,
		};
	}

	_interpretRegime(regime) {
		const interpretations = {
			trending_bullish: 'Strong upward trend with directional momentum',
			trending_bearish: 'Strong downward trend with directional momentum',
			trending_neutral: 'Trending market without clear direction',
			range_low_vol: 'Low volatility consolidation, potential breakout setup',
			range_normal: 'Normal ranging market, no clear trend',
			range_directional: 'Range with strong directional moves but low trend efficiency',
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
				bars: getBarCount('indicator', timeframe),
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
		const last10 = bars.slice(-PATTERN_PERIODS.microPattern);
		const highs = last10.map((b) => b.high);
		const highsIncreasing = highs[highs.length - 1] > highs[0];
		const lows = last10.map((b) => b.low);
		const lowsIncreasing = lows[lows.length - 1] > lows[0];
		if (highsIncreasing && lowsIncreasing) structure = 'uptrend';
		else if (!highsIncreasing && !lowsIncreasing) structure = 'downtrend';
		return { current: current.close, daily_change: `${change >= 0 ? '+' : ''}${Math.round(change * 10) / 10}%`, structure };
	}

	_identifySupportResistance(ohlcvData, enriched) {
		const bars = ohlcvData.bars.slice(-SUPPORT_RESISTANCE_PERIODS.lookback);
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
		// Lower timeframes (< 1h) have reduced weight due to higher noise
		// Higher timeframes (>= 1d) have increased weight as they represent primary trend
		const weights = { '1m': 0.3, '5m': 0.5, '15m': 0.8, '30m': 1.0, '1h': 1.5, '4h': 2.0, '1d': 3.0, '1w': 2.5 };

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

	/**
	 * Transform full context into LLM-optimized format
	 * Removes technical metadata, keeps only actionable information
	 * @param {Object} fullContext - Result from generateFullContext()
	 * @param {Object} alignment - Multi-timeframe alignment data
	 * @returns {Object} LLM-ready context
	 */
	transformForLLM(fullContext, alignment) {
		const { metadata, timeframes } = fullContext;

		// Build LLM-optimized structure
		const llmContext = {
			symbol: metadata.symbol,
			analysis_time: metadata.timestamp,
			data_quality: metadata.data_quality,

			// Multi-timeframe summary
			alignment: {
				direction: alignment.dominant_direction,
				strength: this._interpretAlignmentScore(alignment.alignment_score),
				score: alignment.alignment_score,
				conflicts: alignment.conflicts.length > 0
					? alignment.conflicts.map(c => c.description)
					: null,
			},

			// Per-timeframe analysis (optimized)
			timeframes: {},
		};

		// Transform each timeframe
		for (const [temporality, tfData] of Object.entries(timeframes)) {
			if (!tfData) continue;

			llmContext.timeframes[temporality] = this._transformTimeframeForLLM(tfData);
		}

		// Add narrative synthesis
		llmContext.narrative = this._generateNarrative(fullContext, alignment);

		return llmContext;
	}

	/**
	 * Transform single timeframe data for LLM consumption
	 * @private
	 */
	_transformTimeframeForLLM(tfData) {
		const result = {
			timeframe: tfData.timeframe,
			purpose: tfData.purpose,

			// Regime (core decision factor)
			regime: tfData.regime?.type || 'unknown',
			regime_confidence: tfData.regime?.confidence || 0,
			regime_interpretation: tfData.regime?.interpretation || null,

			// Direction with strength
			direction: tfData.regime?.components?.direction?.direction || 'neutral',
			direction_strength: this._interpretDirectionStrength(tfData.regime?.components?.direction?.strength),

			// Key indicators (interpreted, not raw values)
			indicators: {
				adx: tfData.trend_indicators?.adx
					? { value: tfData.trend_indicators.adx.value, state: tfData.trend_indicators.adx.interpretation }
					: null,
				rsi: tfData.momentum_indicators?.rsi
					? {
						value: tfData.momentum_indicators.rsi.value,
						zone: tfData.momentum_indicators.rsi.zone,
						trend: tfData.momentum_indicators.rsi.trend,
					}
					: null,
				macd: tfData.momentum_indicators?.macd
					? { cross: tfData.momentum_indicators.macd.cross, histogram_trend: tfData.momentum_indicators.macd.histogram_trend }
					: null,
				volume: tfData.volume_indicators?.volume
					? { state: tfData.volume_indicators.volume.interpretation }
					: null,
			},

			// Volatility state
			volatility: tfData.volatility_indicators?.atr
				? {
					state: tfData.volatility_indicators.atr.interpretation,
					percentile: tfData.volatility_indicators.atr.percentile,
					bb_squeeze: tfData.volatility_indicators?.bollinger_bands?.squeeze_detected || false,
				}
				: null,

			// EMA alignment
			ema_alignment: tfData.moving_averages?.ema?.alignment || null,

			// Price action
			price: {
				current: tfData.price_action?.current || null,
				structure: tfData.price_action?.structure || null,
				bar_type: tfData.price_action?.bar_type || null,
			},

			// Support/Resistance (simplified)
			levels: this._simplifyLevels(tfData.support_resistance),

			// Range bounds (only for range regimes)
			range_bounds: tfData.regime?.type?.startsWith('range_')
				? this._extractRangeBounds(tfData)
				: null,

			// Breakout quality (only for breakout regimes)
			breakout_quality: tfData.regime?.type?.startsWith('breakout_')
				? this._extractBreakoutQuality(tfData)
				: null,

			// Trend phase (for trending regimes)
			trend_phase: tfData.regime?.trend_phase || null,

			// Prior compression (useful context for breakouts)
			had_compression: tfData.regime?.compression?.detected || false,

			// Coherence check
			coherence: tfData.coherence_check?.status || null,

			// Patterns (if detected)
			patterns: tfData.micro_patterns?.length > 0
				? tfData.micro_patterns.map(p => ({
					pattern: p.pattern,
					confidence: p.confidence,
					implication: p.implication,
				}))
				: null,
		};

		// Remove null values for cleaner output
		return this._removeNulls(result);
	}

	/**
	 * Interpret alignment score as text
	 * @private
	 */
	_interpretAlignmentScore(score) {
		if (score >= 0.85) return 'strong';
		if (score >= 0.7) return 'moderate';
		if (score >= 0.5) return 'weak';
		return 'conflicting';
	}

	/**
	 * Interpret direction strength (-2 to +2) as text
	 * @private
	 */
	_interpretDirectionStrength(strength) {
		if (strength === null || strength === undefined) return null;
		const absStrength = Math.abs(strength);
		if (absStrength >= 1.5) return 'strong';
		if (absStrength >= 0.8) return 'moderate';
		if (absStrength >= 0.3) return 'weak';
		return 'negligible';
	}

	/**
	 * Simplify S/R levels for LLM
	 * @private
	 */
	_simplifyLevels(sr) {
		if (!sr) return null;

		const result = {};

		if (sr.resistance_levels?.length > 0) 
			result.nearest_resistance = {
				price: sr.resistance_levels[0].level,
				type: sr.resistance_levels[0].type,
				distance: sr.resistance_levels[0].distance,
			};

		if (sr.support_levels?.length > 0) 
			result.nearest_support = {
				price: sr.support_levels[0].level,
				type: sr.support_levels[0].type,
				distance: sr.support_levels[0].distance,
			};

		return Object.keys(result).length > 0 ? result : null;
	}

	/**
	 * Extract range bounds from regime data
	 * @private
	 */
	_extractRangeBounds(tfData) {
		const rangeBounds = tfData.regime?.range_bounds;
		if (!rangeBounds) return null;

		return {
			high: rangeBounds.high,
			low: rangeBounds.low,
			width_percent: rangeBounds.width_percent,
			current_position: rangeBounds.current_position,
			strength: rangeBounds.strength,
			proximity: rangeBounds.proximity,
		};
	}

	/**
	 * Extract breakout quality for breakout regimes
	 * @private
	 */
	_extractBreakoutQuality(tfData) {
		const quality = tfData.regime?.breakout_quality;
		if (!quality) return null;

		return {
			grade: quality.grade,
			score: quality.score,
			factors: quality.factors,
		};
	}

	/**
	 * Recursively remove null/undefined values from object
	 * @private
	 */
	_removeNulls(obj) {
		if (obj === null || obj === undefined) return undefined;
		if (typeof obj !== 'object') return obj;
		if (Array.isArray(obj)) return obj.map(item => this._removeNulls(item)).filter(item => item !== undefined);

		const result = {};
		for (const [key, value] of Object.entries(obj)) {
			const cleaned = this._removeNulls(value);
			if (cleaned !== undefined && cleaned !== null) 
				result[key] = cleaned;
			
		}
		return Object.keys(result).length > 0 ? result : undefined;
	}

	/**
	 * Assess coherence between price structure and momentum indicators
	 * Detects divergences where structure (EMAs) suggests one direction but momentum suggests another
	 * @param {Object} indicators - Object containing alignment, momentum, and trend indicators
	 * @returns {Object} Coherence assessment with status, divergences, and interpretation
	 */
	_assessCoherence(indicators) {
		const { ema_alignment, macd_cross, psar_position, rsi_trend, regime } = indicators;

		// Skip if insufficient data
		if (!ema_alignment) 
			return {
				status: 'insufficient_data',
				divergences: [],
				interpretation: 'insufficient indicators for coherence check',
				severity: 'none'
			};

		const divergences = [];

		// Determine if EMA structure is bullish or bearish
		const isBullishStructure = ema_alignment.includes('bullish');
		const isBearishStructure = ema_alignment.includes('bearish');

		// Check MACD divergence
		if (macd_cross) 
			if (isBullishStructure && macd_cross === 'bearish') 
				divergences.push('macd_bearish');
			 else if (isBearishStructure && macd_cross === 'bullish') 
				divergences.push('macd_bullish');

		// Check PSAR divergence
		if (psar_position) 
			if (isBullishStructure && psar_position.includes('bearish')) 
				divergences.push('psar_bearish');
			 else if (isBearishStructure && psar_position.includes('bullish')) 
				divergences.push('psar_bullish');

		// Check RSI trend divergence
		if (rsi_trend) 
			if (isBullishStructure && rsi_trend === 'declining') 
				divergences.push('rsi_weakening');
			 else if (isBearishStructure && rsi_trend === 'rising') 
				divergences.push('rsi_strengthening');

		// Generate interpretation
		let interpretation;
		let severity;

		if (divergences.length === 0) {
			interpretation = 'aligned (structure and momentum coherent)';
			severity = 'none';
		} else if (divergences.length >= 2) {
			interpretation = `strong divergence (${divergences.join(', ')})`;
			severity = 'high';
		} else {
			interpretation = `mild divergence (${divergences.join(', ')})`;
			severity = 'medium';
		}

		// Add context based on regime
		if (regime && regime.includes('range') && divergences.length > 0) 
			interpretation += ' - common in ranging markets';

		return {
			status: divergences.length === 0 ? 'coherent' : 'diverging',
			divergences,
			interpretation,
			severity
		};
	}

	/**
	 * Get human-readable label for a timeframe code
	 * @private
	 */
	_getTimeframeLabel(timeframe) {
		const labels = {
			'1m': '1-minute (1m)', '5m': '5-minute (5m)', '15m': '15-minute (15m)',
			'30m': '30-minute (30m)', '1h': 'hourly (1h)', '2h': '2-hour (2h)',
			'4h': '4-hour (4h)', '1d': 'daily (1d)', '1w': 'weekly (1w)', '1M': 'monthly (1M)',
		};
		return labels[timeframe] || timeframe;
	}

	/**
	 * Get the primary (highest-priority) timeframe data from available timeframes
	 * Priority: long > medium > short
	 * @private
	 */
	_getPrimaryTimeframe(timeframes) {
		return timeframes.long || timeframes.medium || timeframes.short || null;
	}

	/**
	 * Get the most detailed timeframe data (lowest granularity with full enrichment)
	 * Priority: short > medium > long
	 * @private
	 */
	_getDetailedTimeframe(timeframes) {
		return timeframes.short || timeframes.medium || timeframes.long || null;
	}

	/**
	 * Extract nearest support and resistance from the most detailed available timeframe
	 * @private
	 */
	_getNearestLevels(timeframes) {
		const detailed = this._getDetailedTimeframe(timeframes);
		if (!detailed?.support_resistance) return null;

		const sr = detailed.support_resistance;
		return {
			support: sr.support_levels?.[0] || null,
			resistance: sr.resistance_levels?.[0] || null,
			timeframe: detailed.timeframe,
		};
	}

	/**
	 * Generate a narrative synthesis of the market state
	 * Produces dense, actionable text for LLM consumption
	 * @param {Object} fullContext - Result from generateFullContext()
	 * @param {Object} alignment - Multi-timeframe alignment data
	 * @returns {Object} Narrative with market_state, cross_timeframe, momentum_phase, key_levels, watch_for
	 * @private
	 */
	_generateNarrative(fullContext, alignment) {
		const { timeframes, metadata } = fullContext;
		const symbol = metadata.symbol;

		return {
			market_state: this._narrativeMarketState(symbol, timeframes, alignment),
			cross_timeframe: this._narrativeCrossTimeframe(timeframes, alignment),
			momentum_phase: this._narrativeMomentumPhase(timeframes),
			key_levels: this._narrativeKeyLevels(timeframes),
			watch_for: this._narrativeWatchFor(timeframes, alignment),
		};
	}

	/**
	 * Narrative: "What IS the market doing right now?"
	 * @private
	 */
	_narrativeMarketState(symbol, timeframes, alignment) {
		const primary = this._getPrimaryTimeframe(timeframes);
		if (!primary) return `${symbol}: insufficient data for analysis.`;

		const strength = this._interpretAlignmentScore(alignment.alignment_score);
		const direction = alignment.dominant_direction;
		const primaryLabel = this._getTimeframeLabel(primary.timeframe);
		const primaryRegime = primary.regime?.interpretation || primary.regime?.type?.replace(/_/g, ' ') || 'unknown regime';

		// Find confirming or contradicting timeframe
		const detailed = this._getDetailedTimeframe(timeframes);
		const detailedLabel = detailed && detailed !== primary ? this._getTimeframeLabel(detailed.timeframe) : null;
		const detailedRegime = detailed?.regime?.type?.replace(/_/g, ' ');

		if (strength === 'strong' || strength === 'moderate') {
			let sentence = `${symbol} is in a ${direction} environment. The ${primaryLabel} shows ${primaryRegime}`;
			if (detailedLabel && detailedRegime)
				sentence += `, confirmed by ${detailedRegime} on the ${detailedLabel}`;
			return sentence + '.';
		}

		// Weak or conflicting
		let sentence = `${symbol} shows mixed signals. The ${primaryLabel} shows ${primaryRegime}`;
		if (detailedLabel && detailedRegime)
			sentence += `, but the ${detailedLabel} shows ${detailedRegime}`;
		return sentence + '.';
	}

	/**
	 * Narrative: "Do timeframes agree or disagree?"
	 * @private
	 */
	_narrativeCrossTimeframe(timeframes, alignment) {
		const tfCount = Object.values(timeframes).filter(Boolean).length;

		if (tfCount <= 1)
			return 'Single timeframe analysis -- no cross-timeframe validation available.';

		const parts = [];

		if (alignment.conflicts.length === 0) {
			parts.push(`All ${tfCount} timeframes align ${alignment.dominant_direction} (score: ${alignment.alignment_score}). Structure and momentum are coherent across scales.`);
		} else {
			for (const conflict of alignment.conflicts) {
				const prefix = conflict.severity === 'high' ? 'CONFLICT' : conflict.severity === 'moderate' ? 'Warning' : 'Note';
				parts.push(`${prefix}: ${conflict.description}.`);
			}
		}

		// Add coherence context from the most detailed timeframe
		const detailed = this._getDetailedTimeframe(timeframes);
		if (detailed?.coherence_check?.status === 'diverging') {
			const label = this._getTimeframeLabel(detailed.timeframe);
			parts.push(`Within the ${label}, ${detailed.coherence_check.interpretation}.`);
		}

		return parts.join(' ');
	}

	/**
	 * Narrative: "Where are we in the trend lifecycle?"
	 * @private
	 */
	_narrativeMomentumPhase(timeframes) {
		// Find a timeframe with trend_phase info (prefer long, then medium)
		const trendSource = timeframes.long || timeframes.medium || timeframes.short;
		if (!trendSource) return 'Insufficient data for momentum phase assessment.';

		const label = this._getTimeframeLabel(trendSource.timeframe);
		const regimeType = trendSource.regime?.type || '';
		const phase = trendSource.regime?.trend_phase;
		const compression = trendSource.regime?.compression;

		// RSI context from the most detailed timeframe that has it
		const rsiSource = (timeframes.medium || timeframes.short);
		const rsi = rsiSource?.momentum_indicators?.rsi;
		const rsiContext = rsi ? `RSI at ${rsi.value} on the ${this._getTimeframeLabel(rsiSource.timeframe)} is ${rsi.interpretation}` : null;

		// Volatility context
		const volSource = (timeframes.medium || timeframes.short);
		const atr = volSource?.volatility_indicators?.atr;

		// Trending regime
		if (regimeType.startsWith('trending_')) {
			const phaseText = phase === 'nascent'
				? `Trend is nascent on the ${label} (ADX rising) -- early-stage momentum typically offers favorable risk/reward`
				: phase === 'exhausted'
					? `Trend appears exhausted on the ${label} (ADX declining)`
					: `Trend is mature on the ${label}`;

			const rsiAddition = rsi?.divergence && rsi.divergence !== 'none' && !rsi.divergence.includes('aligned')
				? `. ${rsi.divergence}`
				: rsiContext ? `. ${rsiContext}` : '';

			return phaseText + rsiAddition + '.';
		}

		// Breakout regime
		if (regimeType.startsWith('breakout_')) {
			const quality = trendSource.regime?.breakout_quality;
			const qualityText = quality ? ` (${quality.grade} quality: ${quality.factors?.join(', ')})` : '';
			const compressionText = compression?.detected ? ' Following prior volatility compression.' : '';
			return `Breakout detected on the ${label}${qualityText}.${compressionText}`;
		}

		// Range regime
		const rangeSubtype = regimeType.replace('range_', '').replace(/_/g, ' ');
		const subtypeImpliesVol = regimeType.includes('low_vol') || regimeType.includes('high_vol');
		const volText = (!subtypeImpliesVol && atr) ? ` ${atr.interpretation}.` : '.';
		const compressionText = compression?.detected ? ' ATR compression suggests imminent volatility expansion.' : '';
		return `No directional trend on the ${label}. Market is ranging (${rangeSubtype})${volText}${compressionText}`;
	}

	/**
	 * Narrative: "What prices matter?"
	 * @private
	 */
	_narrativeKeyLevels(timeframes) {
		const parts = [];

		// Nearest S/R from the most detailed timeframe
		const levels = this._getNearestLevels(timeframes);
		if (levels) {
			if (levels.support)
				parts.push(`Nearest support: ${levels.support.level} (${levels.support.type}, ${levels.support.distance})`);
			if (levels.resistance)
				parts.push(`Nearest resistance: ${levels.resistance.level} (${levels.resistance.type}, ${levels.resistance.distance})`);
		}

		// Range bounds from any range regime
		for (const [temporality, tfData] of Object.entries(timeframes)) {
			if (!tfData?.regime?.range_bounds) continue;
			const rb = tfData.regime.range_bounds;
			const label = this._getTimeframeLabel(tfData.timeframe);
			parts.push(`Range bounds on ${label}: ${rb.low}-${rb.high} (${rb.strength} strength, ${rb.proximity})`);
			break; // Only report from one timeframe
		}

		// Pattern invalidation from short timeframe
		const detailed = this._getDetailedTimeframe(timeframes);
		if (detailed?.micro_patterns)
			for (const p of detailed.micro_patterns)
				if (p.invalidation) {
					parts.push(`${p.pattern} invalidation at ${p.invalidation}`);
					break;
				}

		return parts.length > 0 ? parts.join('. ') + '.' : 'No clear support/resistance levels identified from recent structure.';
	}

	/**
	 * Narrative: "What would change the picture?"
	 * @private
	 */
	_narrativeWatchFor(timeframes, alignment) {
		const parts = [];
		const direction = alignment.dominant_direction;
		const levels = this._getNearestLevels(timeframes);

		// Direction-based watch items
		if (direction === 'bullish' && levels?.support)
			parts.push(`Failure to hold ${levels.support.level} (${levels.support.type}) would be the first sign of structural weakness`);
		else if (direction === 'bearish' && levels?.resistance)
			parts.push(`Break above ${levels.resistance.level} (${levels.resistance.type}) would invalidate the bearish structure`);

		// Range breakout watch
		for (const [, tfData] of Object.entries(timeframes)) {
			if (!tfData?.regime?.range_bounds) continue;
			const rb = tfData.regime.range_bounds;
			parts.push(`Break of ${rb.low} or ${rb.high} with volume confirmation would signal range resolution`);
			break;
		}

		// BB squeeze alert
		for (const [, tfData] of Object.entries(timeframes)) {
			if (!tfData?.volatility_indicators?.bollinger_bands?.squeeze_detected) continue;
			const label = this._getTimeframeLabel(tfData.timeframe);
			parts.push(`BB squeeze on ${label} may trigger the next directional leg`);
			break;
		}

		// Compression alert (if not already covered by range bounds)
		for (const [, tfData] of Object.entries(timeframes)) {
			if (!tfData?.regime?.compression?.detected) continue;
			if (tfData.regime?.type?.startsWith('range_')) continue; // Already covered by range bounds
			const label = this._getTimeframeLabel(tfData.timeframe);
			parts.push(`ATR compression on ${label} often precedes a significant move`);
			break;
		}

		// RSI extreme warning
		const detailed = this._getDetailedTimeframe(timeframes);
		const rsi = detailed?.momentum_indicators?.rsi;
		if (rsi) {
			if (rsi.value > 75)
				parts.push(`RSI at ${rsi.value} is deeply overbought -- pullback risk is elevated`);
			else if (rsi.value < 25)
				parts.push(`RSI at ${rsi.value} is deeply oversold -- bounce risk is elevated`);
		}

		// Pattern implication
		if (detailed?.micro_patterns)
			for (const p of detailed.micro_patterns) {
				parts.push(`${p.pattern} (${p.confidence} confidence) suggests ${p.implication}`);
				break;
			}

		// Conflict warning
		if (alignment.conflicts.some(c => c.severity === 'high'))
			parts.push('Until timeframes resolve their conflict, whipsaw risk is elevated');

		if (parts.length === 0)
			return 'No specific triggers identified. Monitor for regime changes on the primary timeframe.';

		return 'Watch for: ' + parts.join('. ') + '.';
	}
}

export default StatisticalContextService;
