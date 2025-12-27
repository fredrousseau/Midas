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
import {
	calculateStats,
	getPercentileRank,
	getTypicalRange,
	detectTrend,
	detectAnomaly,
	rateOfChange,
	round
} from '#utils/statisticalHelpers.js';

export class StatisticalContextService {
	constructor(options = {}) {
		this.logger = options.logger || console;
		this.dataProvider = options.dataProvider;
		this.regimeDetectionService = options.regimeDetectionService;
		this.indicatorService = options.indicatorService;
		
		// Initialize enrichers
		this.maEnricher = new MovingAveragesEnricher({ logger: this.logger });
		this.momentumEnricher = new MomentumEnricher({ logger: this.logger });
		this.volatilityEnricher = new VolatilityEnricher({ logger: this.logger });
		this.volumeEnricher = new VolumeEnricher({ logger: this.logger });
		this.priceActionEnricher = new PriceActionEnricher({ logger: this.logger });
		this.patternDetector = new PatternDetector({ logger: this.logger });

		this.logger.info('StatisticalContextService initialized.');
	}

	/**
	 * Enrich a single indicator with statistical context (from V1)
	 * Generic method that can enrich any indicator with percentiles, trends, anomalies
	 * @param {string} name - Indicator name
	 * @param {number|Object} currentValue - Current value (can be number or object for composite indicators)
	 * @param {Array} history - Historical values
	 * @param {Object} options - Enrichment options
	 * @returns {Object} Enriched indicator context
	 */
	enrichIndicator(name, currentValue, history, options = {}) {
		const { periods = [20, 50, 90] } = options;

		// Handle composite indicators (like MACD with multiple values)
		const isComposite = typeof currentValue === 'object' && currentValue !== null;
		const value = isComposite ? (currentValue.value || currentValue.macd || currentValue.rsi) : currentValue;

		const enriched = {
			name,
			value: isComposite ? currentValue : value,
			timestamp: new Date().toISOString()
		};

		// Extract simple values from history if it's an array of objects
		const simpleHistory = history.map(h => {
			if (typeof h === 'number') return h;
			if (h && typeof h === 'object') 
				return h.value || h.macd || h.rsi || h.close;
			
			return null;
		}).filter(v => v !== null && !isNaN(v));

		// For each period, calculate statistics
		for (const period of periods) {
			const slice = simpleHistory.slice(-period);

			if (slice.length < Math.min(10, period)) {
				enriched[`${period}d`] = { error: 'insufficient_data' };
				continue;
			}

			// Calculate basic statistics
			const stats = calculateStats(slice);
			if (!stats) {
				enriched[`${period}d`] = { error: 'calculation_failed' };
				continue;
			}

			// Get percentile rank of current value
			const percentile = getPercentileRank(value, slice);

			// Get typical range (Q1-Q3)
			const typicalRange = getTypicalRange(slice);

			enriched[`${period}d`] = {
				percentile: round(percentile, 3),
				mean: round(stats.mean, 2),
				std: round(stats.std, 2),
				min: round(stats.min, 2),
				max: round(stats.max, 2),
				typical_range: typicalRange.map(v => round(v, 2)),
				vs_mean: stats.mean !== 0 ? `${round(((value - stats.mean) / stats.mean) * 100, 1)}%` : '0%'
			};
		}

		// Detect trend (using last 20 values)
		const trendData = detectTrend(simpleHistory.slice(-20));
		enriched.trend = trendData.direction;
		enriched.trend_strength = round(trendData.strength, 3);

		// Rate of change
		const roc5 = rateOfChange(simpleHistory, 5);
		const roc10 = rateOfChange(simpleHistory, 10);
		if (roc5 !== null) 
			enriched.rate_of_change = {
				'5_bars': `${round(roc5, 2)}%`,
				'10_bars': roc10 !== null ? `${round(roc10, 2)}%` : null
			};

		// Detect anomalies (using last 90 values)
		const anomalyData = detectAnomaly(value, simpleHistory.slice(-90));
		if (anomalyData.isAnomaly) 
			enriched.anomaly = {
				detected: true,
				z_score: round(anomalyData.zScore, 2),
				std_deviations: round(anomalyData.stdDeviations, 2),
				direction: anomalyData.direction
			};

		return enriched;
	}

	/**
	 * Generate complete statistical context (NO TRADING CONTEXT)
	 * @param {Object} params - { symbol, timeframes, count, analysisDate }
	 * @returns {Promise<Object>} Complete statistical context with multi-timeframe alignment
	 */
	async generateFullContext({ symbol, timeframes, count = 200, analysisDate }) {
		const startTime = Date.now();

		this.logger.info(`Generating statistical context for ${symbol} across ${timeframes.length} timeframes${analysisDate ? ` at ${analysisDate}` : ''}`);

		// Generate context for each timeframe
		const contexts = {};
		const higherTFData = {}; // Store for HTF comparisons

		// Process timeframes from highest to lowest for HTF references
		const sortedTFs = this._sortTimeframes(timeframes);

		for (const tf of sortedTFs)
			try {
				const tfContext = await this._generateTimeframeContext(
					symbol,
					tf,
					count,
					higherTFData,
					analysisDate
				);
				contexts[tf] = tfContext;

				// Store for next (lower) timeframe
				higherTFData[tf] = {
					timeframe: tf, // Add timeframe for proper scaling calculations
					rsi: tfContext.momentum_indicators?.rsi?.value,
					macd: tfContext.momentum_indicators?.macd?.macd,
					atr: tfContext.volatility_indicators?.atr?.value
				};
			} catch (error) {
				this.logger.error(`Failed to generate context for ${tf}: ${error.message}`);
				contexts[tf] = { error: error.message };
			}

		// Analyze multi-timeframe alignment
		const alignment = this._analyzeMultiTimeframeAlignment(contexts);

		const result = {
			metadata: {
				symbol,
				timestamp: new Date().toISOString(),
				analysisDate: analysisDate || null,
				analysis_window: `${count} bars per timeframe`,
				generation_time_ms: Date.now() - startTime,
				data_quality: this._assessDataQuality(contexts)
			},
			timeframes: contexts,
			multi_timeframe_alignment: alignment
		};

		this.logger.info(`Statistical context generated in ${result.metadata.generation_time_ms}ms`);

		return result;
	}

	/**
	 * Generate context for a single timeframe (COMPLETE)
	 * @private
	 */
	async _generateTimeframeContext(symbol, timeframe, count, higherTFData, analysisDate) {
		// Get OHLCV data
		const ohlcvData = await this.dataProvider.loadOHLCV({
			symbol,
			timeframe,
			count: Math.max(count, 250), // Need extra for EMA200
			analysisDate,
			useCache: true,
			detectGaps: false
		});

		// Validate that we have data
		if (!ohlcvData || !ohlcvData.bars || ohlcvData.bars.length === 0)
			throw new Error(`No OHLCV data available for ${symbol} on ${timeframe}`);

		const currentPrice = ohlcvData.bars[ohlcvData.bars.length - 1].close;

		// Get regime data
		const regimeData = await this.regimeDetectionService.detectRegime({
			symbol,
			timeframe,
			count: Math.min(count, 200),
			analysisDate
		});

		// Determine context depth based on timeframe
		const contextDepth = this._getContextDepth(timeframe);

		// Base enrichment (all timeframes)
		const enriched = {
			timeframe,
			context_depth: contextDepth.level,
			purpose: contextDepth.purpose,
			
			// Regime (always included)
			regime: this._enrichRegimeData(regimeData, timeframe),
		};

		// LIGHT context (D1, W1)
		if (contextDepth.level === 'light') {
			enriched.moving_averages = await this.maEnricher.enrich({
				ohlcvData,
				indicatorService: this.indicatorService,
				symbol,
				timeframe,
				currentPrice
			});
			
			enriched.trend_indicators = {
				adx: this._extractADXInfo(regimeData)
			};
			
			enriched.price_action = this._extractBasicPriceAction(ohlcvData);
			
			enriched.summary = this._generateSummary(enriched, 'light');
		}
		// MEDIUM context (H4)
		else if (contextDepth.level === 'medium') {
			enriched.moving_averages = await this.maEnricher.enrich({
				ohlcvData,
				indicatorService: this.indicatorService,
				symbol,
				timeframe,
				currentPrice
			});
			
			// Get higher timeframe for comparisons
			const htf = this._getHigherTimeframe(timeframe, Object.keys(higherTFData));
			const htfData = htf ? higherTFData[htf] : null;
			
			enriched.momentum_indicators = await this.momentumEnricher.enrich({
				ohlcvData,
				indicatorService: this.indicatorService,
				symbol,
				timeframe,
				higherTimeframeData: htfData
			});

			enriched.volatility_indicators = await this.volatilityEnricher.enrich({
				ohlcvData,
				indicatorService: this.indicatorService,
				symbol,
				timeframe,
				currentPrice,
				higherTimeframeData: htfData
			});

			enriched.volume_indicators = await this.volumeEnricher.enrich({
				ohlcvData,
				indicatorService: this.indicatorService,
				symbol,
				timeframe
			});
			
			enriched.trend_indicators = {
				adx: this._extractADXInfo(regimeData),
				psar: await this._getPSAR(symbol, timeframe, analysisDate)
			};
			
			enriched.price_action = this.priceActionEnricher.enrich({
				ohlcvData,
				currentPrice
			});
			
			enriched.support_resistance = this._identifySupportResistance(ohlcvData, enriched);
			
			enriched.summary = this._generateSummary(enriched, 'medium');
		}
		// FULL context (H1, lower)
		else {
			enriched.moving_averages = await this.maEnricher.enrich({
				ohlcvData,
				indicatorService: this.indicatorService,
				symbol,
				timeframe,
				currentPrice
			});
			
			const htf = this._getHigherTimeframe(timeframe, Object.keys(higherTFData));
			const htfData = htf ? higherTFData[htf] : null;
			
			enriched.momentum_indicators = await this.momentumEnricher.enrich({
				ohlcvData,
				indicatorService: this.indicatorService,
				symbol,
				timeframe,
				higherTimeframeData: htfData
			});

			enriched.volatility_indicators = await this.volatilityEnricher.enrich({
				ohlcvData,
				indicatorService: this.indicatorService,
				symbol,
				timeframe,
				currentPrice,
				higherTimeframeData: htfData
			});

			enriched.volume_indicators = await this.volumeEnricher.enrich({
				ohlcvData,
				indicatorService: this.indicatorService,
				symbol,
				timeframe
			});
			
			enriched.trend_indicators = {
				adx: this._extractADXInfo(regimeData),
				psar: await this._getPSAR(symbol, timeframe, analysisDate)
			};
			
			enriched.price_action = this.priceActionEnricher.enrich({
				ohlcvData,
				currentPrice
			});
			
			enriched.micro_patterns = this.patternDetector.detect({
				ohlcvData,
				currentPrice
			});
			
			enriched.support_resistance = this._identifySupportResistance(ohlcvData, enriched);
			
			enriched.summary = this._generateSummary(enriched, 'full');
		}

		return enriched;
	}

	/**
	 * Get context depth strategy based on timeframe
	 * @private
	 */
	_getContextDepth(timeframe) {
		const tf = timeframe.toLowerCase();
		
		if (tf === '1d' || tf === '1w' || tf === '1m') 
			return { level: 'light', purpose: 'macro trend direction' };
		
		if (tf === '4h') 
			return { level: 'medium', purpose: 'structure and trend phase' };
		
		return { level: 'full', purpose: 'precise entry/exit timing' };
	}

	/**
	 * Sort timeframes from highest to lowest
	 * @private
	 */
	_sortTimeframes(timeframes) {
		const order = { '1m': 7, '1w': 6, '1d': 5, '4h': 4, '1h': 3, '30m': 2, '15m': 1, '5m': 0 };
		return [...timeframes].sort((a, b) => (order[b] || 0) - (order[a] || 0));
	}

	/**
	 * Get higher timeframe for comparisons
	 * @private
	 */
	_getHigherTimeframe(currentTF, availableTFs) {
		const order = ['5m', '15m', '30m', '1h', '4h', '1d', '1w', '1m'];
		const currentIndex = order.indexOf(currentTF);

		if (currentIndex === -1) return null;

		for (let i = currentIndex + 1; i < order.length; i++) 
			if (availableTFs.includes(order[i])) 
				return order[i];

		return null;
	}

	/**
	 * Enrich regime data
	 * @private
	 */
	_enrichRegimeData(regimeData, timeframe) {
		if (!regimeData) return null;

		return {
			type: regimeData.regime,
			confidence: regimeData.confidence,
			interpretation: this._interpretRegime(regimeData.regime, regimeData.confidence),
			components: regimeData.components,
			timeframe
		};
	}

	/**
	 * Interpret regime
	 * @private
	 */
	_interpretRegime(regime, confidence) {
		const interpretations = {
			'trending_bullish': 'Strong upward trend with directional momentum',
			'trending_bearish': 'Strong downward trend with directional momentum',
			'trending_neutral': 'Trending market without clear direction',
			'range_low_vol': 'Low volatility consolidation, potential breakout setup',
			'range_normal': 'Normal ranging market, no clear trend',
			'range_high_vol': 'High volatility chop, uncertain direction',
			'breakout_bullish': 'Bullish breakout with expanding volatility',
			'breakout_bearish': 'Bearish breakout with expanding volatility',
			'breakout_neutral': 'Volatility expansion without clear direction'
		};

		return interpretations[regime] || 'Unknown market regime';
	}

	/**
	 * Extract ADX info from regime
	 * @private
	 */
	_extractADXInfo(regimeData) {
		if (!regimeData?.components) return null;

		const { adx, direction } = regimeData.components;
		
		let interpretation;
		if (adx > 30) interpretation = 'strong trend';
		else if (adx > 25) interpretation = 'trend forming';
		else if (adx < 20) interpretation = 'weak or no trend';
		else interpretation = 'neutral';

		return {
			value: adx,
			interpretation,
			di_plus: direction?.diPlus,
			di_minus: direction?.diMinus,
			trend: direction?.trend
		};
	}

	/**
	 * Get PSAR indicator
	 * @private
	 */
	async _getPSAR(symbol, timeframe, analysisDate) {
		try {
			// Use IndicatorService with custom PSAR implementation
			const series = await this.indicatorService.getIndicatorTimeSeries({
				symbol,
				indicator: 'psar',
				timeframe,
				bars: 50,
				analysisDate,
				config: { step: 0.02, max: 0.2 }
			});

			if (!series || !series.data || series.data.length === 0) {
				this.logger.warn(`PSAR: No data returned for ${symbol} ${timeframe}`);
				return null;
			}

			const current = series.data[series.data.length - 1];
			const psarValue = current.value;

			if (psarValue === null || psarValue === undefined || isNaN(psarValue)) {
				this.logger.warn(`PSAR: Invalid current value for ${symbol} ${timeframe}`);
				return null;
			}

			const bars = await this.dataProvider.loadOHLCV({ symbol, timeframe, count: 2, analysisDate });

			if (!bars || !bars.bars || bars.bars.length === 0) {
				this.logger.warn(`PSAR: No OHLCV data for ${symbol} ${timeframe}`);
				return null;
			}

			const currentPrice = bars.bars[bars.bars.length - 1].close;

			const position = psarValue < currentPrice ? 'below price (bullish)' : 'above price (bearish)';
			const distance = Math.abs(currentPrice - psarValue);

			return {
				value: Math.round(psarValue),
				position,
				distance: `${Math.round(distance)} points`,
				interpretation: psarValue < currentPrice ? 'trend intact' : 'potential reversal'
			};
		} catch (error) {
			this.logger.warn(`PSAR calculation failed for ${symbol} ${timeframe}: ${error.message}`);
			return null;
		}
	}

	/**
	 * Extract basic price action for light context
	 * @private
	 */
	_extractBasicPriceAction(ohlcvData) {
		const bars = ohlcvData.bars;
		const current = bars[bars.length - 1];
		const previous = bars[bars.length - 2];
		
		const change = ((current.close - previous.close) / previous.close) * 100;
		
		// Simple structure analysis
		let structure = 'neutral';
		const last10 = bars.slice(-10);
		const highs = last10.map(b => b.high);
		const highsIncreasing = highs[highs.length - 1] > highs[0];
		const lows = last10.map(b => b.low);
		const lowsIncreasing = lows[lows.length - 1] > lows[0];
		
		if (highsIncreasing && lowsIncreasing) structure = 'uptrend';
		else if (!highsIncreasing && !lowsIncreasing) structure = 'downtrend';
		
		return {
			current: current.close,
			daily_change: `${change >= 0 ? '+' : ''}${Math.round(change * 10) / 10}%`,
			structure: structure
		};
	}

	/**
	 * Identify support/resistance levels
	 * @private
	 */
	_identifySupportResistance(ohlcvData, enriched) {
		const bars = ohlcvData.bars.slice(-50);
		const currentPrice = bars[bars.length - 1].close;
		
		// Collect potential levels
		const resistanceLevels = [];
		const supportLevels = [];
		
		// From EMAs
		if (enriched.moving_averages?.ema) {
			const { ema12, ema26, ema50, ema200 } = enriched.moving_averages.ema;
			
			if (ema12 && ema12 < currentPrice) 
				supportLevels.push({ level: ema12, type: 'ema12', strength: 'weak' });
			 else if (ema12 && ema12 > currentPrice) 
				resistanceLevels.push({ level: ema12, type: 'ema12', strength: 'weak' });
			
			if (ema26 && ema26 < currentPrice) 
				supportLevels.push({ level: ema26, type: 'ema26', strength: 'medium' });
			 else if (ema26 && ema26 > currentPrice) 
				resistanceLevels.push({ level: ema26, type: 'ema26', strength: 'medium' });
			
			if (ema50 && ema50 < currentPrice) 
				supportLevels.push({ level: ema50, type: 'ema50', strength: 'strong' });
			 else if (ema50 && ema50 > currentPrice) 
				resistanceLevels.push({ level: ema50, type: 'ema50', strength: 'strong' });
			
		}
		
		// From swing points
		if (enriched.price_action?.swing_points) {
			const { recent_high, recent_low } = enriched.price_action.swing_points;
			
			if (recent_high > currentPrice) 
				resistanceLevels.push({ level: recent_high, type: 'recent high', strength: 'medium' });
			
			if (recent_low < currentPrice) 
				supportLevels.push({ level: recent_low, type: 'recent low', strength: 'medium' });
			
		}
		
		// Sort and add distance
		resistanceLevels.sort((a, b) => a.level - b.level);
		supportLevels.sort((a, b) => b.level - a.level);
		
		resistanceLevels.forEach(r => {
			r.distance = `+${Math.round(((r.level - currentPrice) / currentPrice) * 10000) / 100}%`;
		});
		
		supportLevels.forEach(s => {
			s.distance = `-${Math.round(((currentPrice - s.level) / currentPrice) * 10000) / 100}%`;
		});
		
		return {
			resistance_levels: resistanceLevels.slice(0, 3),
			support_levels: supportLevels.slice(0, 3),
			nearest_zone: supportLevels.length > 0 
				? `support at ${supportLevels[0].level} (${supportLevels[0].type})`
				: 'no nearby support'
		};
	}

	/**
	 * Generate summary for timeframe
	 * @private
	 */
	_generateSummary(enriched, depth) {
		const parts = [];
		
		// Regime
		if (enriched.regime) 
			parts.push(`${enriched.timeframe} ${enriched.regime.type.replace('_', ' ')}`);
		
		// EMAs
		if (enriched.moving_averages?.ema?.alignment) 
			parts.push(enriched.moving_averages.ema.alignment);
		
		// Momentum (medium/full only)
		if (depth !== 'light' && enriched.momentum_indicators?.rsi) 
			parts.push(`RSI ${enriched.momentum_indicators.rsi.value}`);
		
		// Key levels
		if (enriched.support_resistance?.nearest_zone) 
			parts.push(enriched.support_resistance.nearest_zone);
		
		return parts.join('. ') + '.';
	}

	/**
	 * Analyze multi-timeframe alignment
	 * @private
	 */
	_analyzeMultiTimeframeAlignment(contexts) {
		const timeframes = Object.keys(contexts);
		
		if (timeframes.length < 2) 
			return {
				alignment_score: 1.0,
				quality: 'single_timeframe',
				conflicts: []
			};

		// Extract regimes
		const regimes = timeframes
			.map(tf => contexts[tf]?.regime?.type)
			.filter(Boolean);

		if (regimes.length === 0) 
			return {
				alignment_score: 0,
				quality: 'unknown',
				conflicts: ['No regime data available']
			};

		// Count directional bias
		const bullishCount = regimes.filter(r => r.includes('bullish')).length;
		const bearishCount = regimes.filter(r => r.includes('bearish')).length;
		const neutralCount = regimes.filter(r => r.includes('neutral') || r.includes('range')).length;

		// Calculate alignment score
		const totalRegimes = regimes.length;
		const maxCount = Math.max(bullishCount, bearishCount, neutralCount);
		const alignmentScore = totalRegimes > 0 ? maxCount / totalRegimes : 0;

		// Determine dominant direction
		let dominantDirection = 'neutral';
		if (bullishCount > bearishCount && bullishCount > neutralCount) 
			dominantDirection = 'bullish';
		 else if (bearishCount > bullishCount && bearishCount > neutralCount) 
			dominantDirection = 'bearish';

		// Detect conflicts
		const conflicts = [];
		if (bullishCount > 0 && bearishCount > 0) 
			conflicts.push({
				type: 'directional_conflict',
				description: `${bullishCount} bullish vs ${bearishCount} bearish timeframes`,
				severity: Math.min(bullishCount, bearishCount) >= 2 ? 'high' : 'moderate'
			});

		// Determine quality
		let quality = 'poor';
		if (alignmentScore >= 0.8) quality = 'perfect';
		else if (alignmentScore >= 0.6) quality = 'good';
		else if (alignmentScore >= 0.4) quality = 'mixed';

		return {
			alignment_score: Math.round(alignmentScore * 100) / 100,
			quality,
			dominant_direction: dominantDirection,
			distribution: {
				bullish: bullishCount,
				bearish: bearishCount,
				neutral: neutralCount
			},
			conflicts,
			recommendation: this._getAlignmentRecommendation(quality, conflicts, dominantDirection)
		};
	}

	/**
	 * Get alignment recommendation
	 * @private
	 */
	_getAlignmentRecommendation(quality, conflicts, dominantDirection) {
		if (conflicts.length > 0 && conflicts[0].severity === 'high')
			return 'WAIT - Major timeframe conflicts detected';

		// If all timeframes are ranging/neutral, wait for breakout
		if (dominantDirection === 'neutral')
			return 'WAIT - All timeframes ranging, no clear directional bias';

		if (quality === 'perfect' || quality === 'good')
			return `TRADE - Strong ${dominantDirection} alignment across timeframes`;

		if (quality === 'mixed')
			return 'CAUTION - Mixed signals across timeframes';

		return 'WAIT - Poor alignment, unclear direction';
	}

	/**
	 * Assess data quality
	 * @private
	 */
	_assessDataQuality(contexts) {
		const quality = {};

		for (const [tf, ctx] of Object.entries(contexts)) 
			quality[tf] = {
				complete: !ctx.error,
				gaps: 0,
				from_cache: ctx.regime ? true : false
			};

		return quality;
	}

	/**
	 * Analyze price structure (HH, HL, LH, LL) - from V1
	 * @private
	 */
	_analyzeStructure(bars) {
		let higherHighs = 0, higherLows = 0, lowerHighs = 0, lowerLows = 0;

		for (let i = 1; i < bars.length; i++) {
			if (bars[i].high > bars[i - 1].high) higherHighs++;
			if (bars[i].high < bars[i - 1].high) lowerHighs++;
			if (bars[i].low > bars[i - 1].low) higherLows++;
			if (bars[i].low < bars[i - 1].low) lowerLows++;
		}

		let pattern = 'neutral';
		if (higherHighs > lowerHighs && higherLows > lowerLows) 
			pattern = 'strong_uptrend';
		 else if (higherHighs > lowerHighs) 
			pattern = 'uptrend';
		 else if (lowerHighs > higherHighs && lowerLows > higherLows) 
			pattern = 'strong_downtrend';
		 else if (lowerHighs > higherHighs) 
			pattern = 'downtrend';

		return {
			higher_highs: higherHighs,
			higher_lows: higherLows,
			lower_highs: lowerHighs,
			lower_lows: lowerLows,
			pattern
		};
	}

	/**
	 * Interpret wick patterns - from V1
	 * @private
	 */
	_interpretWicks(upperWick, lowerWick, totalRange) {
		if (totalRange === 0) return 'no range';

		const upperPct = upperWick / totalRange;
		const lowerPct = lowerWick / totalRange;

		if (lowerPct > 0.4) return 'rejection from lows';
		if (upperPct > 0.4) return 'rejection from highs';
		if (upperPct < 0.1 && lowerPct < 0.1) return 'strong directional move';
		return 'balanced';
	}
}

export default StatisticalContextService;
