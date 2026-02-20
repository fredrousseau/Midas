/**
 * Regime Detection Service
 * Detects market regimes using ADX, Efficiency Ratio, ATR, Volume and moving averages
 * Aligned with project architecture: uses dataProvider and indicatorService
 *
 * Features:
 * - ADX slope detection (trend nascent vs exhausted)
 * - Volume confirmation for breakouts
 * - Adaptive thresholds (timeframe + volatility)
 * - Compression detection for breakout quality
 * - Continuous ER scoring (not binary)
 * - Range bounds detection (support/resistance via swing clustering)
 *
 * ═══════════════════════════════════════════════════════════════════════════════
 * DETECTED REGIMES (10 total)
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * RANGE REGIMES (lateral market) - includes range_bounds in result
 * ─────────────────────────────────────────────────────────────────────────────────
 * - range_normal      : Classic range, normal volatility
 *                       Conditions: ADX < trending, ATR ratio normal
 * - range_low_vol     : Compression range (squeeze)
 *                       Conditions: ATR ratio < low threshold (low volatility)
 * - range_high_vol    : Volatile/chaotic range
 *                       Conditions: ATR ratio > high threshold, but ADX weak
 * - range_directional : Range with directional bias
 *                       Conditions: ADX high but ER choppy (strong but inefficient movement)
 *
 * TRENDING REGIMES (directional market)
 * ─────────────────────────────────────────────────────────────────────────────────
 * - trending_bullish  : Bullish trend
 *                       Conditions: ADX ≥ trending, ER ≥ trending, bullish direction
 * - trending_bearish  : Bearish trend
 *                       Conditions: ADX ≥ trending, ER ≥ trending, bearish direction
 * - trending_neutral  : Trend without clear direction
 *                       Conditions: ADX ≥ trending, ER ≥ trending, neutral direction
 *
 * BREAKOUT REGIMES (volatility expansion)
 * ─────────────────────────────────────────────────────────────────────────────────
 * - breakout_bullish  : Bullish breakout
 *                       Conditions: Volatility expansion + trending ADX + bullish direction
 * - breakout_bearish  : Bearish breakout
 *                       Conditions: Volatility expansion + trending ADX + bearish direction
 * - breakout_neutral  : Breakout without clear direction
 *                       Conditions: Volatility expansion + trending ADX + neutral direction
 *
 * ═══════════════════════════════════════════════════════════════════════════════
 * RESULT STRUCTURE
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * {
 *   // Core detection
 *   regime: string,              // One of the 10 regimes above
 *   direction: string,           // 'bullish' | 'bearish' | 'neutral'
 *   confidence: number,          // 0-1, detection confidence score
 *
 *   // Indicator components
 *   components: {
 *     adx: number,               // ADX value (trend strength)
 *     plusDI: number,            // +DI (bullish pressure)
 *     minusDI: number,           // -DI (bearish pressure)
 *     efficiency_ratio: number,  // ER value (price efficiency)
 *     atr_ratio: number,         // ATR short/long ratio (volatility state)
 *     direction: { direction, strength, emaShort, emaLong }
 *   },
 *
 *   // Adaptive thresholds used for detection
 *   thresholds: {
 *     adx: { weak, trending, strong },
 *     er: { choppy, trending },
 *     atrRatio: { low, high },
 *     adjustmentFactors: { timeframe, volatility, combined }
 *   },
 *
 *   // Request metadata
 *   metadata: { symbol, timeframe, barsUsed, timestamps, durations, ... },
 *
 *   // Trend phase (ADX slope analysis)
 *   trend_phase: {
 *     adx_slope: { direction, strength, normalizedSlope },
 *     phase: string              // 'nascent' | 'mature' | 'exhausted'
 *   },
 *
 *   // Volume analysis (if available)
 *   volume_analysis: {
 *     ratio: number,             // Current vs average volume
 *     is_spike: boolean,         // Volume spike detected
 *     trend: string,             // 'rising' | 'declining' | 'flat'
 *     confirms_breakout: boolean
 *   } | null,
 *
 *   // Prior compression detection
 *   compression: {
 *     detected: boolean,
 *     ratio: number,             // % of bars in compression
 *     min_atr_ratio: number      // Lowest ATR ratio during compression
 *   },
 *
 *   // Breakout quality (only for breakout_* regimes)
 *   breakout_quality: {
 *     score: number,             // 0-100
 *     grade: string,             // 'low' | 'medium' | 'high'
 *     factors: string[]          // Contributing factors
 *   } | null,
 *
 *   // Range bounds (only for range_* regimes)
 *   range_bounds: {
 *     high: number,              // Resistance level
 *     low: number,               // Support level
 *     midpoint: number,
 *     width: number,             // Absolute width
 *     width_percent: number,     // Width as % of price
 *     width_atr: number,         // Width in ATR units
 *     current_position: number,  // 0 (support) to 1 (resistance)
 *     high_touches: number,      // Times resistance was tested
 *     low_touches: number,       // Times support was tested
 *     strength: string,          // 'weak' | 'moderate' | 'strong'
 *     proximity: string,         // 'near_support' | 'near_resistance' | 'middle' | ...
 *     method: string,            // 'swing_clusters' | 'minmax_fallback'
 *     all_resistances: [{price, touches}],
 *     all_supports: [{price, touches}]
 *   } | null,
 *
 *   // Confidence scoring breakdown
 *   scoring_details: {
 *     regime_clarity: number,    // How clear is the regime classification
 *     er_score: number,          // ER contribution to confidence
 *     direction_score: number,   // Direction clarity contribution
 *     coherence: number,         // Signal coherence score
 *     phase_bonus: number        // Bonus/penalty for trend phase
 *   }
 * }
 *
 * ═══════════════════════════════════════════════════════════════════════════════
 */

import { round, detectTrend, calculateStats } from '#utils/statisticalHelpers.js';

/* ===========================================================
   CONFIGURATION
   =========================================================== */

export const config = {
	adxPeriod: 14,
	erPeriod: 10,
	erSmoothPeriod: 3,
	atrShortPeriod: 14,
	atrLongPeriod: 50,
	maShortPeriod: 20,
	maLongPeriod: 50,

	// ADX slope detection
	adxSlopePeriod: 5, // Number of bars to calculate ADX slope
	adxSlopeThreshold: 0.02, // Minimum normalized slope to consider rising/falling

	// Volume confirmation
	volumePeriod: 20, // Period for volume average
	volumeSpikeThreshold: 1.5, // Multiple of average volume for spike detection

	// Compression detection (for breakout quality)
	compressionWindow: 10, // Bars to check for prior compression
	compressionThreshold: 0.7, // ATR ratio below this indicates compression

	// Base thresholds (will be adjusted adaptively)
	adx: {
		weak: 20,
		trending: 25,
		strong: 40,
	},

	er: {
		choppy: 0.3,
		trending: 0.5,
	},

	atrRatio: {
		low: 0.8,
		high: 1.3,
	},

	// Adaptive threshold configuration
	adaptive: {
		enabled: true,
		volatilityWindow: 100,

		// Timeframe multipliers for thresholds
		timeframeMultipliers: {
			'1m': 1.3,
			'5m': 1.2,
			'15m': 1.1,
			'30m': 1.05,
			'1h': 1.0,
			'2h': 0.95,
			'4h': 0.9,
			'1d': 0.85,
			'1w': 0.8,
		},

		volatility: {
			minMultiplier: 0.7,
			maxMultiplier: 1.5,
		},
	},

	minBars: 60,
};

/* ===========================================================
   REGIME DETECTION SERVICE CLASS
   =========================================================== */

export class RegimeDetectionService {
	constructor(parameters = {}) {
		this.logger = parameters.logger || null;
		if (!this.logger) throw new Error('RegimeDetectionService requires a logger instance in options');

		this.dataProvider = parameters.dataProvider || null;
		if (!this.dataProvider) throw new Error('RegimeDetectionService requires a dataProvider instance in options');

		this.indicatorService = parameters.indicatorService || null;
		if (!this.indicatorService) throw new Error('RegimeDetectionService requires an indicatorService instance in options');

		this.logger.info('RegimeDetectionService initialized.');
	}

	/**
	 * Calculate adaptive thresholds based on volatility and timeframe
	 * Now also adapts ER thresholds
	 * @private
	 */
	_calculateAdaptiveThresholds(timeframe, atrShort, atrLong) {
		if (!config.adaptive.enabled)
			return {
				adx: { ...config.adx },
				er: { ...config.er },
				atrRatio: { ...config.atrRatio },
				adjustmentFactors: { timeframe: 1.0, volatility: 1.0 },
			};

		// 1. Timeframe adjustment
		const timeframeMultiplier = config.adaptive.timeframeMultipliers[timeframe] || 1.0;

		// 2. Volatility adjustment
		// Ensure recentWindow never exceeds array length
		const recentWindow = Math.min(
			atrShort.length,
			Math.max(config.adaptive.volatilityWindow, 20)
		);

		const atrRatios = [];
		for (let i = atrShort.length - recentWindow; i < atrShort.length; i++) {
			const shortVal = atrShort[i];
			const longVal = atrLong[i];
			if (i >= 0 && shortVal !== null && shortVal !== undefined && longVal !== null && longVal !== undefined && longVal > 1e-12)
				atrRatios.push(shortVal / longVal);
		}

		const sortedRatios = [...atrRatios].sort((a, b) => a - b);
		const medianAtrRatio = sortedRatios[Math.floor(sortedRatios.length / 2)] || 1.0;

		const currentAtrShort = atrShort.at(-1);
		const currentAtrLong = atrLong.at(-1);
		const currentAtrRatio =
			currentAtrShort !== null && currentAtrLong !== null && currentAtrLong > 1e-12 ? currentAtrShort / currentAtrLong : 1.0;

		const volatilityRatio = medianAtrRatio > 1e-12 ? currentAtrRatio / medianAtrRatio : 1.0;
		const volatilityMultiplier = Math.max(
			config.adaptive.volatility.minMultiplier,
			Math.min(config.adaptive.volatility.maxMultiplier, 0.5 + volatilityRatio * 0.5)
		);

		// 3. Combined adjustment factor
		const combinedMultiplier = timeframeMultiplier * volatilityMultiplier;

		// 4. ADX multiplier - less aggressive (volatility should not raise ADX thresholds too much)
		// High volatility makes trends harder to detect, so we cap the ADX adjustment
		const adxMultiplier = timeframeMultiplier * Math.min(1.2, volatilityMultiplier);

		// 5. Apply adjustments - now includes ER thresholds
		const adaptiveThresholds = {
			adx: {
				weak: Math.max(10, Math.min(35, config.adx.weak * adxMultiplier)),
				trending: Math.max(15, Math.min(35, config.adx.trending * adxMultiplier)),
				strong: Math.max(25, Math.min(50, config.adx.strong * adxMultiplier)),
			},
			er: {
				// ER thresholds now also adaptive based on timeframe
				choppy: Math.max(0.1, Math.min(0.5, config.er.choppy * (0.8 + timeframeMultiplier * 0.2))),
				trending: Math.max(0.3, Math.min(0.8, config.er.trending * (0.8 + timeframeMultiplier * 0.2))),
			},
			atrRatio: {
				low: Math.max(0.3, config.atrRatio.low / Math.sqrt(volatilityMultiplier)),
				high: Math.max(1.0, config.atrRatio.high / Math.sqrt(volatilityMultiplier)),
			},
			adjustmentFactors: {
				timeframe: round(timeframeMultiplier, 4),
				volatility: round(volatilityMultiplier, 4),
				combined: round(combinedMultiplier, 4),
			},
		};

		return adaptiveThresholds;
	}

	/**
	 * Calculate ADX slope to detect trend phase (nascent vs exhausted)
	 * @private
	 */
	_calculateADXSlope(adxValues) {
		if (!adxValues || adxValues.length < config.adxSlopePeriod)
			return { direction: 'unknown', strength: 0, phase: 'unknown' };

		// Get last N ADX values for slope calculation
		const recentADX = adxValues.slice(-config.adxSlopePeriod).filter((v) => v !== null && v !== undefined);
		if (recentADX.length < 3)
			return { direction: 'unknown', strength: 0, phase: 'unknown' };

		const trendResult = detectTrend(recentADX, config.adxSlopeThreshold);

		// Determine trend phase based on ADX slope
		let phase = 'mature';
		if (trendResult.direction === 'rising') phase = 'nascent';
		else if (trendResult.direction === 'declining') phase = 'exhausted';

		return {
			direction: trendResult.direction,
			strength: round(trendResult.strength, 4),
			normalizedSlope: round(trendResult.normalizedSlope, 4),
			phase,
		};
	}

	/**
	 * Analyze volume for breakout confirmation
	 * @private
	 */
	async _analyzeVolume(symbol, timeframe, bars, referenceDate) {
		try {
			const ohlcv = await this.dataProvider.loadOHLCV({
				symbol,
				timeframe,
				count: Math.max(bars, config.volumePeriod + 10),
				referenceDate,
				useCache: true,
				detectGaps: false,
			});

			if (!ohlcv?.bars || ohlcv.bars.length < config.volumePeriod)
				return { available: false };

			const volumes = ohlcv.bars.map((b) => b.volume);
			const recentVolumes = volumes.slice(-config.volumePeriod);

			// Calculate average volume
			const stats = calculateStats(recentVolumes);
			if (!stats) return { available: false };

			const currentVolume = volumes.at(-1);
			const avgVolume = stats.mean;
			const volumeRatio = avgVolume > 0 ? currentVolume / avgVolume : 1;

			// Check for volume spike
			const isSpike = volumeRatio >= config.volumeSpikeThreshold;

			// Volume trend (is volume increasing?)
			const volumeTrend = detectTrend(recentVolumes.slice(-5), 0.05);

			return {
				available: true,
				current: round(currentVolume, 2),
				average: round(avgVolume, 2),
				ratio: round(volumeRatio, 2),
				isSpike,
				trend: volumeTrend.direction,
				confirmsBreakout: isSpike && volumeTrend.direction === 'rising',
			};
		} catch (error) {
			this.logger.warn(`Volume analysis failed for ${symbol}: ${error.message}`);
			return { available: false };
		}
	}

	/**
	 * Detect prior compression (for breakout quality assessment)
	 * @private
	 */
	_detectPriorCompression(atrRatios) {
		if (!atrRatios || atrRatios.length < config.compressionWindow + 1)
			return { detected: false };

		// Check ATR ratios in the compression window (excluding current)
		const priorRatios = atrRatios.slice(-(config.compressionWindow + 1), -1).filter((v) => v !== null && v !== undefined);

		if (priorRatios.length < 3)
			return { detected: false };

		// Count how many bars were in compression
		const compressedBars = priorRatios.filter((r) => r < config.compressionThreshold).length;
		const compressionRatio = compressedBars / priorRatios.length;

		// Find minimum ATR ratio in compression period
		const minRatio = Math.min(...priorRatios);

		return {
			detected: compressionRatio >= 0.5, // At least 50% of bars were compressed
			ratio: round(compressionRatio, 2),
			minAtrRatio: round(minRatio, 4),
			barsCompressed: compressedBars,
		};
	}

	/**
	 * Detect swing points (local highs and lows) in price data
	 * @private
	 * @param {Array<Object>} bars - OHLCV bars
	 * @param {number} atrValue - Current ATR for significance filtering
	 * @param {number} lookback - Bars to look left/right for swing detection (default: 3)
	 * @returns {Object} { swingHighs: [{price, index, timestamp}], swingLows: [...] }
	 */
	_detectSwingPoints(bars, atrValue, lookback = 3) {
		const swingHighs = [];
		const swingLows = [];

		// Minimum significance threshold: swing must exceed 0.3 * ATR
		const minSignificance = atrValue * 0.3;

		for (let i = lookback; i < bars.length - lookback; i++) {
			const currentBar = bars[i];
			let isSwingHigh = true;
			let isSwingLow = true;

			// Check if current bar is higher/lower than surrounding bars
			for (let j = 1; j <= lookback; j++) {
				const leftBar = bars[i - j];
				const rightBar = bars[i + j];

				// Swing high: current high must be >= all surrounding highs
				if (currentBar.high < leftBar.high || currentBar.high < rightBar.high)
					isSwingHigh = false;

				// Swing low: current low must be <= all surrounding lows
				if (currentBar.low > leftBar.low || currentBar.low > rightBar.low)
					isSwingLow = false;
			}

			// Validate significance using ATR
			if (isSwingHigh) {
				// Check that this high is significantly above nearby lows
				const nearbyLows = bars.slice(Math.max(0, i - lookback * 2), i + lookback * 2 + 1).map(b => b.low);
				const minNearbyLow = Math.min(...nearbyLows);
				if (currentBar.high - minNearbyLow >= minSignificance)
					swingHighs.push({
						price: currentBar.high,
						index: i,
						timestamp: currentBar.timestamp,
					});
			}

			if (isSwingLow) {
				// Check that this low is significantly below nearby highs
				const nearbyHighs = bars.slice(Math.max(0, i - lookback * 2), i + lookback * 2 + 1).map(b => b.high);
				const maxNearbyHigh = Math.max(...nearbyHighs);
				if (maxNearbyHigh - currentBar.low >= minSignificance)
					swingLows.push({
						price: currentBar.low,
						index: i,
						timestamp: currentBar.timestamp,
					});
			}
		}

		return { swingHighs, swingLows };
	}

	/**
	 * Cluster price levels that are close together
	 * @private
	 * @param {Array<Object>} swings - Array of {price, index, timestamp}
	 * @param {number} clusterThreshold - Max distance to consider same cluster (in price units)
	 * @returns {Array<Object>} Clustered levels [{price, touches, firstIndex, lastIndex}]
	 */
	_clusterLevels(swings, clusterThreshold) {
		if (!swings || swings.length === 0) return [];

		// Sort by price
		const sorted = [...swings].sort((a, b) => a.price - b.price);
		const clusters = [];
		let currentCluster = {
			prices: [sorted[0].price],
			indices: [sorted[0].index],
			timestamps: [sorted[0].timestamp],
		};

		for (let i = 1; i < sorted.length; i++) {
			const swing = sorted[i];
			const clusterAvg = currentCluster.prices.reduce((a, b) => a + b, 0) / currentCluster.prices.length;

			if (Math.abs(swing.price - clusterAvg) <= clusterThreshold) {
				// Add to current cluster
				currentCluster.prices.push(swing.price);
				currentCluster.indices.push(swing.index);
				currentCluster.timestamps.push(swing.timestamp);
			} else {
				// Finalize current cluster and start new one
				clusters.push(this._finalizeCluster(currentCluster));
				currentCluster = {
					prices: [swing.price],
					indices: [swing.index],
					timestamps: [swing.timestamp],
				};
			}
		}

		// Don't forget last cluster
		clusters.push(this._finalizeCluster(currentCluster));

		return clusters;
	}

	/**
	 * Finalize a cluster into a single level
	 * @private
	 */
	_finalizeCluster(cluster) {
		const avgPrice = cluster.prices.reduce((a, b) => a + b, 0) / cluster.prices.length;
		return {
			price: round(avgPrice, 8), // High precision for crypto
			touches: cluster.prices.length,
			firstIndex: Math.min(...cluster.indices),
			lastIndex: Math.max(...cluster.indices),
			priceRange: {
				min: Math.min(...cluster.prices),
				max: Math.max(...cluster.prices),
			},
		};
	}

	/**
	 * Calculate range bounds when a range regime is detected
	 * Uses swing point detection and clustering for robust S/R levels
	 * @private
	 * @param {Array<Object>} bars - OHLCV bars
	 * @param {number} atrValue - Current ATR value
	 * @param {number} currentPrice - Current price
	 * @returns {Object} Range bounds information
	 */
	_calculateRangeBounds(bars, atrValue, currentPrice) {
		// Use recent bars for range detection (last 50-100 bars typically)
		const lookbackBars = Math.min(bars.length, 100);
		const recentBars = bars.slice(-lookbackBars);

		// Calculate the price range of recent bars to filter relevant swings
		const recentHighs = recentBars.map(b => b.high);
		const recentLows = recentBars.map(b => b.low);
		const recentMax = Math.max(...recentHighs);
		const recentMin = Math.min(...recentLows);
		const priceRange = recentMax - recentMin;

		// Maximum distance for relevant levels: 2x the recent price range or 10x ATR
		const maxRelevantDistance = Math.max(priceRange * 2, atrValue * 10);

		// Detect swing points
		const { swingHighs, swingLows } = this._detectSwingPoints(recentBars, atrValue, 3);

		// Filter swings that are within relevant distance from current price
		const relevantSwingHighs = swingHighs.filter(s => Math.abs(s.price - currentPrice) <= maxRelevantDistance);
		const relevantSwingLows = swingLows.filter(s => Math.abs(s.price - currentPrice) <= maxRelevantDistance);

		// If not enough relevant swings, fall back to simple min/max of recent bars
		if (relevantSwingHighs.length < 2 || relevantSwingLows.length < 2) 
			return {
				high: round(recentMax, 8),
				low: round(recentMin, 8),
				midpoint: round((recentMax + recentMin) / 2, 8),
				width: round(recentMax - recentMin, 8),
				width_percent: round(((recentMax - recentMin) / recentMin) * 100, 2),
				width_atr: round((recentMax - recentMin) / atrValue, 2),
				current_position: round(Math.max(0, Math.min(1, (currentPrice - recentMin) / (recentMax - recentMin))), 2),
				high_touches: 1,
				low_touches: 1,
				strength: 'weak',
				proximity: this._calculateProximity(currentPrice, recentMax, recentMin, atrValue),
				method: 'minmax_fallback',
			};

		// Cluster threshold: levels within 0.5 * ATR are considered the same
		const clusterThreshold = atrValue * 0.5;

		// Cluster swing highs and lows
		const resistanceClusters = this._clusterLevels(relevantSwingHighs, clusterThreshold);
		const supportClusters = this._clusterLevels(relevantSwingLows, clusterThreshold);

		// Find the most relevant resistance (closest above current price, or highest touched)
		const resistanceAbove = resistanceClusters
			.filter(c => c.price > currentPrice)
			.sort((a, b) => a.price - b.price);

		const supportBelow = supportClusters
			.filter(c => c.price < currentPrice)
			.sort((a, b) => b.price - a.price);

		// Select primary resistance and support
		let primaryResistance, primarySupport;

		if (resistanceAbove.length > 0)
			// Prefer the nearest resistance with at least 2 touches, otherwise take nearest
			primaryResistance = resistanceAbove.find(r => r.touches >= 2) || resistanceAbove[0];
		else if (resistanceClusters.length > 0)
			// All resistances below current price - take the highest (price broke above)
			primaryResistance = resistanceClusters.sort((a, b) => b.price - a.price)[0];
		else
			// No clusters - use recent max
			primaryResistance = { price: recentMax, touches: 1 };

		if (supportBelow.length > 0)
			// Prefer the nearest support with at least 2 touches, otherwise take nearest
			primarySupport = supportBelow.find(s => s.touches >= 2) || supportBelow[0];
		else if (supportClusters.length > 0)
			// All supports above current price - take the lowest (price broke below)
			primarySupport = supportClusters.sort((a, b) => a.price - b.price)[0];
		else
			// No clusters - use recent min
			primarySupport = { price: recentMin, touches: 1 };

		const high = primaryResistance.price;
		const low = primarySupport.price;
		const highTouches = primaryResistance.touches;
		const lowTouches = primarySupport.touches;

		// Calculate strength based on number of touches
		const totalTouches = highTouches + lowTouches;
		let strength = 'weak';
		if (totalTouches >= 6) strength = 'strong';
		else if (totalTouches >= 4) strength = 'moderate';

		const width = high - low;
		const position = width > 0 ? (currentPrice - low) / width : 0.5;

		return {
			high: round(high, 8),
			low: round(low, 8),
			midpoint: round((high + low) / 2, 8),
			width: round(width, 8),
			width_percent: round((width / low) * 100, 2),
			width_atr: round(width / atrValue, 2),
			current_position: round(Math.max(0, Math.min(1, position)), 2),
			high_touches: highTouches,
			low_touches: lowTouches,
			strength,
			proximity: this._calculateProximity(currentPrice, high, low, atrValue),
			method: 'swing_clusters',
			// Additional detail for advanced usage
			all_resistances: resistanceClusters.slice(0, 3).map(c => ({
				price: c.price,
				touches: c.touches,
			})),
			all_supports: supportClusters.slice(0, 3).map(c => ({
				price: c.price,
				touches: c.touches,
			})),
		};
	}

	/**
	 * Calculate proximity to range boundaries
	 * @private
	 */
	_calculateProximity(currentPrice, high, low, atrValue) {
		const distanceToHigh = high - currentPrice;
		const distanceToLow = currentPrice - low;
		const proximityThreshold = atrValue * 0.5; // Within 0.5 ATR = "near"

		if (distanceToHigh <= proximityThreshold) return 'near_resistance';
		if (distanceToLow <= proximityThreshold) return 'near_support';
		if (distanceToHigh < distanceToLow) return 'upper_half';
		if (distanceToLow < distanceToHigh) return 'lower_half';
		return 'middle';
	}

	/**
	 * Calculate continuous ER score (not binary)
	 * Differentiates between ER of 0.51 vs 0.95
	 * @private
	 */
	_calculateERScore(erValue, regimeType, thresholds) {
		// Dynamic high ER threshold based on adaptive thresholds
		const highERThreshold = Math.max(0.7, thresholds.er.trending + 0.2);

		if (regimeType === 'trending') {
			// For trending: higher ER = higher score (linear scaling)
			if (erValue >= highERThreshold) return 1.0;
			if (erValue >= thresholds.er.trending)
				return 0.5 + ((erValue - thresholds.er.trending) / (highERThreshold - thresholds.er.trending)) * 0.5;
			return 0.3;
		} else if (regimeType === 'breakout') {
			// For breakout: intermediate ER is acceptable (adaptive thresholds)
			const breakoutHigh = thresholds.er.trending + 0.1;
			if (erValue >= breakoutHigh) return 1.0;
			if (erValue >= thresholds.er.trending) return 0.8;
			if (erValue >= thresholds.er.choppy) return 0.6;
			return 0.4;
		} else {
			// For range: lower ER = higher score
			if (erValue <= 0.2) return 1.0;
			if (erValue <= thresholds.er.choppy)
				return 0.7 + ((thresholds.er.choppy - erValue) / thresholds.er.choppy) * 0.3;
			if (erValue <= 0.45) return 0.5;
			return 0.3;
		}
	}

	/**
	 * Detect market regime for a symbol
	 * @param {Object} options - { symbol, timeframe, count, referenceDate, useCache, detectGaps }
	 * @returns {Promise<Object>} Regime detection result
	 */
	async detectRegime(options = {}) {
		const { symbol, timeframe = '1h', count = 200, referenceDate } = options;

		if (!symbol) throw new Error('Symbol is required');

		const startTime = Date.now();

		/* =====================================================
		1. Load market data
		===================================================== */

		const ohlcv = await this.dataProvider.loadOHLCV({
			symbol,
			timeframe,
			count: Math.max(count, config.minBars + 50),
			referenceDate,
			useCache: options.useCache !== false,
			detectGaps: options.detectGaps !== false,
		});

		if (!ohlcv?.bars || ohlcv.bars.length < config.minBars)
			throw new Error(`Insufficient data: need at least ${config.minBars} bars, got ${ohlcv?.bars?.length || 0}`);

		const closes = ohlcv.bars.map((b) => b.close);

		/* =====================================================
		2. Indicator calculation (parallel)
		===================================================== */

		const [adxData, atrShort, atrLong, er, emaShort, emaLong, volumeAnalysis] = await Promise.all([
			this._getADX(symbol, timeframe, ohlcv.bars.length, referenceDate),
			this._getATR(symbol, timeframe, ohlcv.bars.length, config.atrShortPeriod, referenceDate),
			this._getATR(symbol, timeframe, ohlcv.bars.length, config.atrLongPeriod, referenceDate),
			this._getEfficiencyRatio(closes, config.erPeriod),
			this._getEMA(symbol, timeframe, ohlcv.bars.length, config.maShortPeriod, referenceDate),
			this._getEMA(symbol, timeframe, ohlcv.bars.length, config.maLongPeriod, referenceDate),
			this._analyzeVolume(symbol, timeframe, ohlcv.bars.length, referenceDate),
		]);

		// Extract current values with null safety
		const adxValue = adxData.adx.at(-1);
		const plusDI = adxData.plusDI?.at(-1);
		const minusDI = adxData.minusDI?.at(-1);
		const erValue = er.at(-1);
		const atrShortValue = atrShort.at(-1);
		const atrLongValue = atrLong.at(-1);
		const emaShortValue = emaShort.at(-1);
		const emaLongValue = emaLong.at(-1);
		const currentPrice = closes.at(-1);

		// Validate critical values
		if (adxValue === null || adxValue === undefined)
			throw new Error('ADX calculation returned null - insufficient data for regime detection');
		if (atrShortValue === null || atrShortValue === undefined || atrLongValue === null || atrLongValue === undefined)
			throw new Error('ATR calculation returned null - insufficient data for regime detection');
		if (emaShortValue === null || emaShortValue === undefined || emaLongValue === null || emaLongValue === undefined)
			throw new Error('EMA calculation returned null - insufficient data for regime detection');
		if (erValue === null || erValue === undefined)
			throw new Error('Efficiency Ratio calculation returned null - insufficient data for regime detection');

		const atrRatio = atrLongValue < 1e-12 ? 1 : atrShortValue / atrLongValue;

		/* =====================================================
		2.5. Calculate adaptive thresholds
		===================================================== */

		const thresholds = this._calculateAdaptiveThresholds(timeframe, atrShort, atrLong);

		/* =====================================================
		2.6. Calculate ADX slope for trend phase detection
		===================================================== */

		const adxSlope = this._calculateADXSlope(adxData.adx);

		/* =====================================================
		2.7. Detect prior compression for breakout quality
		===================================================== */

		// Build ATR ratio history
		const atrRatios = [];
		for (let i = 0; i < atrShort.length; i++)
			if (atrShort[i] !== null && atrLong[i] !== null && atrLong[i] > 1e-12)
				atrRatios.push(atrShort[i] / atrLong[i]);
		const compression = this._detectPriorCompression(atrRatios);

		/* =====================================================
		3. Direction detection
		===================================================== */

		let direction = 'neutral';

		if (currentPrice > emaShortValue && emaShortValue > emaLongValue) direction = 'bullish';
		else if (currentPrice < emaShortValue && emaShortValue < emaLongValue) direction = 'bearish';

		// DI confirmation: only downgrade if DI strongly contradicts EMA direction
		if (plusDI !== null && plusDI !== undefined && minusDI !== null && minusDI !== undefined) {
			const diSpread = Math.abs(plusDI - minusDI);
			if (direction === 'bullish' && plusDI < minusDI && diSpread > 10) direction = 'neutral';
			if (direction === 'bearish' && minusDI < plusDI && diSpread > 10) direction = 'neutral';
		}

		const directionStrength = atrLongValue < 1e-12 ? 0 : Math.max(-2, Math.min(2, (emaShortValue - emaLongValue) / atrLongValue));

		/* =====================================================
		4. Regime type detection (with volume confirmation)
		===================================================== */

		let regimeType = '';
		let rangeType = '';
		let breakoutQuality = null;

		// Check for breakout with enhanced criteria
		const isVolatilityExpansion = atrRatio > thresholds.atrRatio.high;
		const hasStrongTrend = adxValue >= thresholds.adx.trending;
		const volumeConfirms = volumeAnalysis.available && volumeAnalysis.confirmsBreakout;
		const hadCompression = compression.detected;

		if (isVolatilityExpansion && hasStrongTrend) {
			regimeType = 'breakout';

			// Assess breakout quality
			let qualityScore = 0;
			const qualityFactors = [];

			if (volumeConfirms) {
				qualityScore += 30;
				qualityFactors.push('volume_confirmed');
			} else if (volumeAnalysis.available && volumeAnalysis.isSpike) {
				qualityScore += 15;
				qualityFactors.push('volume_spike');
			}

			if (hadCompression) {
				qualityScore += 30;
				qualityFactors.push('prior_compression');
			}

			if (adxSlope.phase === 'nascent') {
				qualityScore += 25;
				qualityFactors.push('trend_nascent');
			} else if (adxSlope.phase === 'mature') {
				qualityScore += 10;
				qualityFactors.push('trend_mature');
			} else if (adxSlope.phase === 'exhausted') {
				qualityScore -= 15;
				qualityFactors.push('trend_exhausted');
			}

			if (direction !== 'neutral') {
				qualityScore += 15;
				qualityFactors.push('clear_direction');
			}

			breakoutQuality = {
				score: qualityScore,
				grade: qualityScore >= 70 ? 'high' : qualityScore >= 40 ? 'medium' : 'low',
				factors: qualityFactors,
			};
		} else if (adxValue >= thresholds.adx.trending && erValue >= thresholds.er.trending) {
			regimeType = 'trending';
		} else {
			regimeType = 'range';

			if (adxValue >= thresholds.adx.trending) rangeType = 'directional';
			else if (atrRatio < thresholds.atrRatio.low) rangeType = 'low_vol';
			else if (atrRatio > thresholds.atrRatio.high) rangeType = 'high_vol';
			else rangeType = 'normal';
		}

		/* =====================================================
		5. Confidence scoring (improved ER scoring)
		===================================================== */

		// Regime clarity score
		let regimeClarityScore = 0.3;

		if (regimeType === 'trending' || regimeType === 'breakout') {
			if (adxValue > thresholds.adx.strong) regimeClarityScore = 1;
			else if (adxValue > thresholds.adx.trending) regimeClarityScore = 0.7;
			else if (adxValue > thresholds.adx.weak) regimeClarityScore = 0.5;
		} else {
			// Range regimes: low ADX = clear range, but high-ADX range (directional range) is also valid
			if (adxValue < thresholds.adx.weak) regimeClarityScore = 0.8;
			else if (adxValue < thresholds.adx.trending) regimeClarityScore = 0.6;
			else if (rangeType === 'directional') regimeClarityScore = 0.7;
			else regimeClarityScore = 0.4;
		}

		// Continuous ER score (not binary)
		const erScore = this._calculateERScore(erValue, regimeType, thresholds);

		// Direction score
		const absDir = Math.abs(directionStrength);
		let directionScore = 0.3;
		if (absDir > 0.8) directionScore = 1;
		else if (absDir > 0.5) directionScore = 0.7;
		else if (absDir > 0.25) directionScore = 0.5;

		// ADX phase bonus (nascent trends get bonus)
		let phaseBonus = 0;
		if (regimeType === 'trending' && adxSlope.phase === 'nascent') phaseBonus = 0.1;
		else if (regimeType === 'trending' && adxSlope.phase === 'exhausted') phaseBonus = -0.1;

		/* =====================================================
		6. Signal coherence
		===================================================== */

		const signals = {
			adxHigh: adxValue >= thresholds.adx.trending,
			erHigh: erValue >= thresholds.er.trending,
			erLow: erValue <= thresholds.er.choppy,
			lowVol: atrRatio <= thresholds.atrRatio.low,
			highVol: atrRatio >= thresholds.atrRatio.high,
			bull: direction === 'bullish',
			bear: direction === 'bearish',
			neut: direction === 'neutral',
			volumeConfirm: volumeConfirms,
		};

		let regime;
		if (regimeType === 'trending' || regimeType === 'breakout') regime = `${regimeType}_${direction}`;
		else regime = `range_${rangeType}`;

		const rules = {
			trending_bullish: [signals.adxHigh, signals.erHigh, signals.bull],
			trending_bearish: [signals.adxHigh, signals.erHigh, signals.bear],
			range_low_vol: [signals.lowVol, signals.erLow],
			range_high_vol: [signals.highVol, !signals.adxHigh, signals.erLow],
			range_directional: [signals.adxHigh, signals.erLow, !signals.highVol],
			range_normal: [!signals.highVol, !signals.lowVol, !signals.adxHigh],
			breakout_bullish: [signals.highVol, signals.adxHigh, signals.bull, signals.volumeConfirm || !volumeAnalysis.available],
			breakout_bearish: [signals.highVol, signals.adxHigh, signals.bear, signals.volumeConfirm || !volumeAnalysis.available],
			breakout_neutral: [signals.highVol, signals.adxHigh, signals.neut],
		};

		const r = rules[regime] || [];
		const coherence = r.length ? r.filter(Boolean).length / r.length : 0;

		/* =====================================================
		7. Final confidence
		===================================================== */

		let confidence = 0.35 * regimeClarityScore + 0.25 * coherence + 0.2 * directionScore + 0.2 * erScore + phaseBonus;
		confidence = Math.max(0, Math.min(1, confidence));
		confidence = round(confidence, 2);

		/* =====================================================
		8. Calculate range bounds (only for range regimes)
		===================================================== */

		let rangeBounds = null;
		if (regimeType === 'range')
			rangeBounds = this._calculateRangeBounds(ohlcv.bars, atrShortValue, currentPrice);

		/* =====================================================
		9. Result object (backward compatible)
		===================================================== */

		const result = {
			// Core fields (backward compatible)
			regime,
			direction,
			confidence,
			components: {
				adx: round(adxValue, 2),
				plusDI: plusDI !== null && plusDI !== undefined ? round(plusDI, 2) : null,
				minusDI: minusDI !== null && minusDI !== undefined ? round(minusDI, 2) : null,
				efficiency_ratio: round(erValue, 4),
				atr_ratio: round(atrRatio, 4),
				direction: {
					direction,
					strength: round(directionStrength, 4),
					emaShort: round(emaShortValue, 2),
					emaLong: round(emaLongValue, 2),
				},
			},
			thresholds: {
				adx: {
					weak: round(thresholds.adx.weak, 2),
					trending: round(thresholds.adx.trending, 2),
					strong: round(thresholds.adx.strong, 2),
				},
				er: {
					choppy: round(thresholds.er.choppy, 4),
					trending: round(thresholds.er.trending, 4),
				},
				atrRatio: {
					low: round(thresholds.atrRatio.low, 4),
					high: round(thresholds.atrRatio.high, 4),
				},
				adjustmentFactors: thresholds.adjustmentFactors,
			},
			metadata: {
				symbol: ohlcv.symbol,
				timeframe: ohlcv.timeframe,
				barsUsed: ohlcv.count,
				firstTimestamp: ohlcv.firstTimestamp,
				lastTimestamp: ohlcv.lastTimestamp,
				gapCount: ohlcv.gapCount,
				fromCache: ohlcv.fromCache,
				loadDuration: ohlcv.loadDuration,
				detectionDuration: Date.now() - startTime,
				loadedAt: ohlcv.loadedAt,
			},

			// New enhanced fields
			trend_phase: {
				adx_slope: adxSlope,
				phase: adxSlope.phase,
			},
			volume_analysis: volumeAnalysis.available
				? {
						ratio: volumeAnalysis.ratio,
						is_spike: volumeAnalysis.isSpike,
						trend: volumeAnalysis.trend,
						confirms_breakout: volumeAnalysis.confirmsBreakout,
					}
				: null,
			compression: compression.detected
				? {
						detected: true,
						ratio: compression.ratio,
						min_atr_ratio: compression.minAtrRatio,
					}
				: { detected: false },
			breakout_quality: breakoutQuality,
			range_bounds: rangeBounds,
			scoring_details: {
				regime_clarity: round(regimeClarityScore, 2),
				er_score: round(erScore, 2),
				direction_score: round(directionScore, 2),
				coherence: round(coherence, 2),
				phase_bonus: round(phaseBonus, 2),
			},
		};

		this.logger.info(
			`Detecting regime for ${symbol} on ${timeframe}${referenceDate ? ` at ${referenceDate}` : ''} — Regime: ${regime} (confidence: ${confidence}, phase: ${adxSlope.phase}) in ${result.metadata.detectionDuration}ms`
		);

		return result;
	}

	/**
	 * Get ADX indicator with plusDI and minusDI using IndicatorService
	 * @private
	 */
	async _getADX(symbol, timeframe, bars, referenceDate) {
		const series = await this.indicatorService.getIndicatorTimeSeries({
			symbol,
			indicator: 'adx',
			timeframe,
			bars,
			referenceDate,
			config: { period: config.adxPeriod },
		});

		if (!series?.data || series.data.length === 0) throw new Error('No ADX data returned from IndicatorService');

		const adx = series.data.map((d) => d.values?.adx ?? null);
		const plusDI = series.data.map((d) => d.values?.plusDI ?? null);
		const minusDI = series.data.map((d) => d.values?.minusDI ?? null);

		return { adx, plusDI, minusDI };
	}

	/**
	 * Get ATR indicator using IndicatorService
	 * @private
	 */
	async _getATR(symbol, timeframe, bars, period, referenceDate) {
		const series = await this.indicatorService.getIndicatorTimeSeries({
			symbol,
			indicator: 'atr',
			timeframe,
			bars,
			referenceDate,
			config: { period },
		});

		if (!series?.data || series.data.length === 0) throw new Error('No ATR data returned from IndicatorService');

		return series.data.map((d) => d.value ?? d.atr ?? null);
	}

	/**
	 * Get EMA indicator using IndicatorService
	 * @private
	 */
	async _getEMA(symbol, timeframe, bars, period, referenceDate) {
		const series = await this.indicatorService.getIndicatorTimeSeries({
			symbol,
			indicator: 'ema',
			timeframe,
			bars,
			referenceDate,
			config: { period },
		});

		if (!series?.data || series.data.length === 0) throw new Error('No EMA data returned from IndicatorService');

		return series.data.map((d) => d.value ?? d.ema ?? null);
	}

	/**
	 * Calculate Efficiency Ratio
	 * @private
	 */
	_getEfficiencyRatio(closes, period) {
		const raw = new Array(closes.length);

		for (let i = 0; i < closes.length; i++) {
			if (i < period) {
				raw[i] = 0.5;
				continue;
			}

			const net = Math.abs(closes[i] - closes[i - period]);
			let sum = 0;
			for (let j = i - period + 1; j <= i; j++) sum += Math.abs(closes[j] - closes[j - 1]);

			raw[i] = sum === 0 ? 0 : net / sum;
		}

		// Smooth ER for stability
		const smoothPeriod = config.erSmoothPeriod;
		const k = 2 / (smoothPeriod + 1);

		const smoothed = [raw[0]];
		for (let i = 1; i < raw.length; i++) smoothed[i] = raw[i] * k + smoothed[i - 1] * (1 - k);

		return smoothed;
	}
}

export default RegimeDetectionService;
