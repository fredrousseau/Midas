/**
 * Regime Detection Service
 * Detects market regimes using ADX, Efficiency Ratio, ATR, Volume and moving averages
 * Aligned with project architecture: uses dataProvider and indicatorService
 *
 * Improvements:
 * - ADX slope detection (trend nascent vs exhausted)
 * - Volume confirmation for breakouts
 * - Regime transition tracking
 * - Adaptive ER thresholds
 * - Compression context for breakout quality
 * - Continuous ER scoring (not binary)
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

		// Track previous regime for transition detection
		this._previousRegimes = new Map(); // key: symbol_timeframe, value: { regime, timestamp }

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
		const volatilityWindow = Math.min(config.adaptive.volatilityWindow, atrShort.length);
		const recentWindow = Math.max(volatilityWindow, 20);

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
			Math.min(config.adaptive.volatility.maxMultiplier, 0.7 + volatilityRatio * 0.6)
		);

		// 3. Combined adjustment factor
		const combinedMultiplier = timeframeMultiplier * volatilityMultiplier;

		// 4. Apply adjustments - now includes ER thresholds
		const adaptiveThresholds = {
			adx: {
				weak: Math.max(10, Math.min(100, config.adx.weak * combinedMultiplier)),
				trending: Math.max(15, Math.min(100, config.adx.trending * combinedMultiplier)),
				strong: Math.max(25, Math.min(100, config.adx.strong * combinedMultiplier)),
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
	async _analyzeVolume(symbol, timeframe, bars, analysisDate) {
		try {
			const ohlcv = await this.dataProvider.loadOHLCV({
				symbol,
				timeframe,
				count: Math.max(bars, config.volumePeriod + 10),
				analysisDate,
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
			compressionRatio: round(compressionRatio, 2),
			minAtrRatio: round(minRatio, 4),
			barsCompressed: compressedBars,
		};
	}

	/**
	 * Track regime transitions
	 * @private
	 */
	_trackRegimeTransition(symbol, timeframe, currentRegime, confidence) {
		const key = `${symbol}_${timeframe}`;
		const previous = this._previousRegimes.get(key);
		const now = Date.now();

		let transition = null;

		if (previous && previous.regime !== currentRegime)
			transition = {
				from: previous.regime,
				to: currentRegime,
				duration_ms: now - previous.timestamp,
				significance: this._assessTransitionSignificance(previous.regime, currentRegime),
			};

		// Update stored regime
		this._previousRegimes.set(key, {
			regime: currentRegime,
			confidence,
			timestamp: now,
		});

		// Cleanup old entries (keep last 100)
		if (this._previousRegimes.size > 100) {
			const oldestKey = this._previousRegimes.keys().next().value;
			this._previousRegimes.delete(oldestKey);
		}

		return transition;
	}

	/**
	 * Assess significance of regime transition
	 * @private
	 */
	_assessTransitionSignificance(fromRegime, toRegime) {
		// High significance transitions (trading signals)
		const highSignificance = [
			['range_low_vol', 'breakout_bullish'],
			['range_low_vol', 'breakout_bearish'],
			['range_normal', 'breakout_bullish'],
			['range_normal', 'breakout_bearish'],
			['trending_bullish', 'range_normal'],
			['trending_bearish', 'range_normal'],
			['trending_bullish', 'breakout_bearish'],
			['trending_bearish', 'breakout_bullish'],
		];

		for (const [from, to] of highSignificance)
			if (fromRegime === from && toRegime === to) return 'high';

		// Medium significance
		const mediumSignificance = [
			['range_normal', 'trending_bullish'],
			['range_normal', 'trending_bearish'],
			['range_high_vol', 'trending_bullish'],
			['range_high_vol', 'trending_bearish'],
		];

		for (const [from, to] of mediumSignificance)
			if (fromRegime === from && toRegime === to) return 'medium';

		return 'low';
	}

	/**
	 * Calculate continuous ER score (not binary)
	 * Differentiates between ER of 0.51 vs 0.95
	 * @private
	 */
	_calculateERScore(erValue, regimeType, thresholds) {
		if (regimeType === 'trending') {
			// For trending: higher ER = higher score (linear scaling)
			if (erValue >= 0.8) return 1.0;
			if (erValue >= thresholds.er.trending)
				return 0.5 + ((erValue - thresholds.er.trending) / (0.8 - thresholds.er.trending)) * 0.5;
			return 0.3;
		} else if (regimeType === 'breakout') {
			// For breakout: intermediate ER is acceptable
			if (erValue >= 0.6) return 1.0;
			if (erValue >= 0.4) return 0.8;
			if (erValue >= 0.3) return 0.6;
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
	 * @param {Object} options - { symbol, timeframe, count, analysisDate, useCache, detectGaps }
	 * @returns {Promise<Object>} Regime detection result
	 */
	async detectRegime(options = {}) {
		const { symbol, timeframe = '1h', count = 200, analysisDate } = options;

		if (!symbol) throw new Error('Symbol is required');

		const startTime = Date.now();

		/* =====================================================
		1. Load market data
		===================================================== */

		const ohlcv = await this.dataProvider.loadOHLCV({
			symbol,
			timeframe,
			count: Math.max(count, config.minBars + 50),
			analysisDate,
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
			this._getADX(symbol, timeframe, ohlcv.bars.length, analysisDate),
			this._getATR(symbol, timeframe, ohlcv.bars.length, config.atrShortPeriod, analysisDate),
			this._getATR(symbol, timeframe, ohlcv.bars.length, config.atrLongPeriod, analysisDate),
			this._getEfficiencyRatio(closes, config.erPeriod),
			this._getEMA(symbol, timeframe, ohlcv.bars.length, config.maShortPeriod, analysisDate),
			this._getEMA(symbol, timeframe, ohlcv.bars.length, config.maLongPeriod, analysisDate),
			this._analyzeVolume(symbol, timeframe, ohlcv.bars.length, analysisDate),
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
		else if (currentPrice < emaLongValue && emaShortValue < emaLongValue) direction = 'bearish';

		// DI confirmation filter
		if (plusDI !== null && plusDI !== undefined && minusDI !== null && minusDI !== undefined) {
			if (direction === 'bullish' && plusDI < minusDI) direction = 'neutral';
			if (direction === 'bearish' && minusDI < plusDI) direction = 'neutral';
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
			if (adxValue < thresholds.adx.weak) regimeClarityScore = 0.8;
			else if (adxValue < thresholds.adx.trending) regimeClarityScore = 0.6;
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
		8. Regime transition tracking
		===================================================== */

		const transition = this._trackRegimeTransition(symbol, timeframe, regime, confidence);

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
				interpretation:
					adxSlope.phase === 'nascent'
						? 'Trend strengthening - good entry opportunity'
						: adxSlope.phase === 'exhausted'
							? 'Trend weakening - consider taking profits'
							: 'Trend stable',
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
						ratio: compression.compressionRatio,
						min_atr_ratio: compression.minAtrRatio,
					}
				: { detected: false },
			breakout_quality: breakoutQuality,
			transition: transition,
			scoring_details: {
				regime_clarity: round(regimeClarityScore, 2),
				er_score: round(erScore, 2),
				direction_score: round(directionScore, 2),
				coherence: round(coherence, 2),
				phase_bonus: round(phaseBonus, 2),
			},
		};

		this.logger.info(
			`Detecting regime for ${symbol} on ${timeframe}${analysisDate ? ` at ${analysisDate}` : ''} — Regime: ${regime} (confidence: ${confidence}, phase: ${adxSlope.phase}) in ${result.metadata.detectionDuration}ms`
		);

		return result;
	}

	/**
	 * Get ADX indicator with plusDI and minusDI using IndicatorService
	 * @private
	 */
	async _getADX(symbol, timeframe, bars, analysisDate) {
		const series = await this.indicatorService.getIndicatorTimeSeries({
			symbol,
			indicator: 'adx',
			timeframe,
			bars,
			analysisDate,
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
	async _getATR(symbol, timeframe, bars, period, analysisDate) {
		const series = await this.indicatorService.getIndicatorTimeSeries({
			symbol,
			indicator: 'atr',
			timeframe,
			bars,
			analysisDate,
			config: { period },
		});

		if (!series?.data || series.data.length === 0) throw new Error('No ATR data returned from IndicatorService');

		return series.data.map((d) => d.value ?? d.atr ?? null);
	}

	/**
	 * Get EMA indicator using IndicatorService
	 * @private
	 */
	async _getEMA(symbol, timeframe, bars, period, analysisDate) {
		const series = await this.indicatorService.getIndicatorTimeSeries({
			symbol,
			indicator: 'ema',
			timeframe,
			bars,
			analysisDate,
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
