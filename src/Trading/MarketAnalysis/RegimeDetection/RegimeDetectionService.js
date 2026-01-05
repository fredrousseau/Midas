/**
 * Regime Detection Service
 * Detects market regimes using ADX, Efficiency Ratio, ATR and moving averages
 * Aligned with project architecture: uses dataProvider and indicatorService
 */

/* ===========================================================
   CONFIGURATION
   =========================================================== */

export const config = {
	adxPeriod: 14,
	erPeriod: 10,
	erSmoothPeriod: 3, // Smoothing period for Efficiency Ratio
	atrShortPeriod: 14,
	atrLongPeriod: 50,
	maShortPeriod: 20,
	maLongPeriod: 50,

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
		volatilityWindow: 100, // Number of bars to calculate historical volatility

		// Timeframe multipliers for ADX thresholds
		// Shorter timeframes need higher thresholds due to noise
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

		// Volatility adjustment factors
		// When market is more volatile than historical median, increase ADX thresholds
		volatility: {
			minMultiplier: 0.7,  // Minimum threshold multiplier (calm markets)
			maxMultiplier: 1.5,  // Maximum threshold multiplier (volatile markets)
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
	 * @private
	 */
	_calculateAdaptiveThresholds(timeframe, atrShort, atrLong) {
		if (!config.adaptive.enabled) {
			return {
				adx: { ...config.adx },
				er: { ...config.er },
				atrRatio: { ...config.atrRatio },
				adjustmentFactors: { timeframe: 1.0, volatility: 1.0 },
			};
		}

		// 1. Timeframe adjustment
		const timeframeMultiplier = config.adaptive.timeframeMultipliers[timeframe] || 1.0;

		// 2. Volatility adjustment
		// Calculate historical volatility percentile using ATR ratio history
		const volatilityWindow = Math.min(config.adaptive.volatilityWindow, atrShort.length);
		const recentWindow = Math.max(volatilityWindow, 20);

		const atrRatios = [];
		for (let i = atrShort.length - recentWindow; i < atrShort.length; i++) {
			const shortVal = atrShort[i];
			const longVal = atrLong[i];

			// Skip null values to avoid contaminating statistical calculations
			if (i >= 0 && shortVal !== null && shortVal !== undefined &&
			    longVal !== null && longVal !== undefined && longVal > 1e-12) {
				atrRatios.push(shortVal / longVal);
			}
		}

		// Calculate median ATR ratio (more robust than mean)
		const sortedRatios = [...atrRatios].sort((a, b) => a - b);
		const medianAtrRatio = sortedRatios[Math.floor(sortedRatios.length / 2)] || 1.0;

		// Get current values, defaulting to safe fallback if null
		const currentAtrShort = atrShort.at(-1);
		const currentAtrLong = atrLong.at(-1);
		const currentAtrRatio = (currentAtrShort !== null && currentAtrLong !== null && currentAtrLong > 1e-12)
			? currentAtrShort / currentAtrLong
			: 1.0;

		// Volatility multiplier: higher when current volatility exceeds historical median
		// This makes thresholds stricter in volatile conditions
		const volatilityRatio = medianAtrRatio > 1e-12 ? currentAtrRatio / medianAtrRatio : 1.0;
		const volatilityMultiplier = Math.max(
			config.adaptive.volatility.minMultiplier,
			Math.min(config.adaptive.volatility.maxMultiplier, 0.7 + volatilityRatio * 0.6)
		);

		// 3. Combined adjustment factor
		const combinedMultiplier = timeframeMultiplier * volatilityMultiplier;

		// 4. Apply adjustments to thresholds
		const adaptiveThresholds = {
			adx: {
				weak: config.adx.weak * combinedMultiplier,
				trending: config.adx.trending * combinedMultiplier,
				strong: config.adx.strong * combinedMultiplier,
			},
			er: {
				// ER thresholds are less affected by volatility but still adjusted by timeframe
				choppy: config.er.choppy * (0.8 + timeframeMultiplier * 0.2),
				trending: config.er.trending * (0.8 + timeframeMultiplier * 0.2),
			},
			atrRatio: {
				// ATR ratio thresholds are adjusted inversely (lower in volatile markets)
				low: config.atrRatio.low / Math.sqrt(volatilityMultiplier),
				high: config.atrRatio.high / Math.sqrt(volatilityMultiplier),
			},
			adjustmentFactors: {
				timeframe: round4(timeframeMultiplier),
				volatility: round4(volatilityMultiplier),
				combined: round4(combinedMultiplier),
			},
		};

		return adaptiveThresholds;
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
		We intentionally load extra bars to avoid indicator
		warmup bias and unstable initial values.
		===================================================== */

		const ohlcv = await this.dataProvider.loadOHLCV({
			symbol,
			timeframe,
			count: Math.max(count, config.minBars + 50),
			analysisDate,
			useCache: options.useCache !== false,
			detectGaps: options.detectGaps !== false,
		});

		if (!ohlcv?.bars || ohlcv.bars.length < config.minBars) throw new Error(`Insufficient data: need at least ${config.minBars} bars, got ${ohlcv?.bars?.length || 0}`);

		const closes = ohlcv.bars.map((b) => b.close);

		/* =====================================================
		2. Indicator calculation
		All indicators are computed in parallel to minimize
		latency and keep the detection fast enough for
		real-time usage.
		===================================================== */

		const [adxData, atrShort, atrLong, er, emaShort, emaLong] = await Promise.all([
			this._getADX(symbol, timeframe, ohlcv.bars.length, analysisDate),
			this._getATR(symbol, timeframe, ohlcv.bars.length, config.atrShortPeriod, analysisDate),
			this._getATR(symbol, timeframe, ohlcv.bars.length, config.atrLongPeriod, analysisDate),
			this._getEfficiencyRatio(closes, config.erPeriod),
			this._getEMA(symbol, timeframe, ohlcv.bars.length, config.maShortPeriod, analysisDate),
			this._getEMA(symbol, timeframe, ohlcv.bars.length, config.maLongPeriod, analysisDate),
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

		// Validate critical values - throw if null as it indicates insufficient data
		if (adxValue === null || adxValue === undefined) {
			throw new Error('ADX calculation returned null - insufficient data for regime detection');
		}
		if (atrShortValue === null || atrShortValue === undefined || atrLongValue === null || atrLongValue === undefined) {
			throw new Error('ATR calculation returned null - insufficient data for regime detection');
		}
		if (emaShortValue === null || emaShortValue === undefined || emaLongValue === null || emaLongValue === undefined) {
			throw new Error('EMA calculation returned null - insufficient data for regime detection');
		}
		if (erValue === null || erValue === undefined) {
			throw new Error('Efficiency Ratio calculation returned null - insufficient data for regime detection');
		}

		// Calculate ATR ratio with validated non-null values
		const atrRatio = atrLongValue < 1e-12 ? 1 : atrShortValue / atrLongValue;

		/* =====================================================
		2.5. Calculate adaptive thresholds
		Thresholds are dynamically adjusted based on:
		- Timeframe characteristics (noise level)
		- Historical volatility (market conditions)
		===================================================== */

		const thresholds = this._calculateAdaptiveThresholds(timeframe, atrShort, atrLong);

		/* =====================================================
		3. Direction detection
		EMA structure provides a directional hypothesis.
		Directional Movement (DI) is then used as a filter
		to invalidate false EMA-based signals, especially
		in ranges or noisy conditions.
		===================================================== */

		let direction = 'neutral';

		if (currentPrice > emaShortValue && emaShortValue > emaLongValue) direction = 'bullish';
		else if (currentPrice < emaLongValue && emaShortValue < emaLongValue) direction = 'bearish';

		// DI confirmation filter: if DI contradicts EMA direction,
		// direction is neutralized to reduce false trends.
		// Only apply if DI values are valid (not null)
		if (plusDI !== null && plusDI !== undefined && minusDI !== null && minusDI !== undefined) {
			if (direction === 'bullish' && plusDI < minusDI) direction = 'neutral';
			if (direction === 'bearish' && minusDI < plusDI) direction = 'neutral';
		}

		// Direction strength is normalized by long ATR to ensure
		// stability across volatility regimes and symbols.
		const directionStrength = atrLongValue < 1e-12 ? 0 : Math.max(-2, Math.min(2, (emaShortValue - emaLongValue) / atrLongValue));

		/* =====================================================
		4. Regime type detection
		Priority order reflects market structure:
		- Breakout: volatility expansion + trend strength
		- Trending: directional efficiency + trend strength
		- Range: absence of sustained directional structure

		Now uses adaptive thresholds instead of fixed values.
		===================================================== */

		let regimeType = '';
		let rangeType = '';

		if (atrRatio > thresholds.atrRatio.high && adxValue >= thresholds.adx.trending) {
			regimeType = 'breakout';
		} else if (adxValue >= thresholds.adx.trending && erValue >= thresholds.er.trending) {
			regimeType = 'trending';
		} else {
			regimeType = 'range';

			rangeType = 'normal';
			if (atrRatio < thresholds.atrRatio.low) rangeType = 'low_vol';
			if (atrRatio > thresholds.atrRatio.high) rangeType = 'high_vol';
		}

		/* =====================================================
		5. Confidence scoring
		Multiple independent components are scored and later
		combined using weighted averaging. This avoids relying
		on a single indicator and improves robustness.
		===================================================== */

		// Regime clarity score measures how clearly the market fits the detected regime type.
		// Uses adaptive thresholds for more accurate scoring across market conditions.
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

		// Efficiency Ratio score is regime-aware.
		// Breakouts accept intermediate ER values,
		// while ranges favor low ER and trends favor high ER.
		let erScore = 0.4;

		if (regimeType === 'trending') {
			if (erValue > 0.7) erScore = 1;
			else if (erValue > 0.5) erScore = 0.7;
		} else if (regimeType === 'breakout') {
			if (erValue > 0.4) erScore = 1;
			else if (erValue > 0.3) erScore = 0.7;
		} else {
			if (erValue < 0.25) erScore = 1;
			else if (erValue < 0.35) erScore = 0.7;
		}

		// Direction score reflects how strong and exploitable
		// the directional bias is relative to volatility.
		const absDir = Math.abs(directionStrength);
		let directionScore = 0.3;

		if (absDir > 0.8) directionScore = 1;
		else if (absDir > 0.5) directionScore = 0.7;
		else if (absDir > 0.25) directionScore = 0.5;

		/* =====================================================
		6. Signal coherence
		Measures how well all signals agree with the final
		detected regime. This helps penalize contradictory
		conditions.
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
		};

		let regime;
		if (regimeType === 'trending' || regimeType === 'breakout') regime = `${regimeType}_${direction}`;
		else regime = `range_${rangeType}`;

		const rules = {
			trending_bullish: [signals.adxHigh, signals.erHigh, signals.bull],
			trending_bearish: [signals.adxHigh, signals.erHigh, signals.bear],
			range_low_vol: [signals.lowVol, signals.erLow],
			range_high_vol: [signals.highVol, !signals.adxHigh, signals.erLow],
			// range_normal: ADX can be high if ER is low (choppy market with volatility)
			range_normal: [!signals.highVol, !signals.lowVol],
			breakout_bullish: [signals.highVol, signals.adxHigh, signals.bull],
			breakout_bearish: [signals.highVol, signals.adxHigh, signals.bear],
			breakout_neutral: [signals.highVol, signals.adxHigh, signals.neut],
		};

		const r = rules[regime] || [];
		const coherence = r.length ? r.filter(Boolean).length / r.length : 0;

		/* =====================================================
		7. Final confidence
		Weighted confidence favors regime clarity and signal
		coherence over raw indicator strength.
		===================================================== */

		const confidence = Math.round((0.35 * regimeClarityScore + 0.3 * coherence + 0.2 * directionScore + 0.15 * erScore) * 100) / 100;

		/* =====================================================
		8. Result object
		===================================================== */

		const result = {
			regime,
			direction,
			confidence,
			components: {
				adx: round2(adxValue),
				plusDI: plusDI !== null && plusDI !== undefined ? round2(plusDI) : null,
				minusDI: minusDI !== null && minusDI !== undefined ? round2(minusDI) : null,
				efficiency_ratio: round4(erValue),
				atr_ratio: round4(atrRatio),
				direction: {
					direction,
					strength: round4(directionStrength),
					emaShort: round2(emaShortValue),
					emaLong: round2(emaLongValue),
				},
			},
			thresholds: {
				adx: {
					weak: round2(thresholds.adx.weak),
					trending: round2(thresholds.adx.trending),
					strong: round2(thresholds.adx.strong),
				},
				er: {
					choppy: round4(thresholds.er.choppy),
					trending: round4(thresholds.er.trending),
				},
				atrRatio: {
					low: round4(thresholds.atrRatio.low),
					high: round4(thresholds.atrRatio.high),
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
		};

		this.logger.info(
			`Detecting regime for ${symbol} on ${timeframe}${analysisDate ? ` at ${analysisDate}` : ''} — Regime: ${regime} (confidence: ${confidence}) in ${
				result.metadata.detectionDuration
			}ms`
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

		// Extract ADX, plusDI, and minusDI from the composite indicator
		// Preserve null values instead of replacing with 0 to maintain data integrity
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

		// Preserve null values to avoid contaminating statistical calculations
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

		// Preserve null values to avoid contaminating statistical calculations
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

		// Smooth ER for stability using EMA smoothing
		// The smoothing period controls how reactive the ER is to regime transitions
		const smoothPeriod = config.erSmoothPeriod;
		const k = 2 / (smoothPeriod + 1);

		const smoothed = [raw[0]];
		for (let i = 1; i < raw.length; i++) smoothed[i] = raw[i] * k + smoothed[i - 1] * (1 - k);

		return smoothed;
	}
}

/* ===========================================================
   HELPERS
   =========================================================== */

function round2(x) {
	return Math.round(x * 100) / 100;
}

function round4(x) {
	return Math.round(x * 10000) / 10000;
}

export default RegimeDetectionService;
