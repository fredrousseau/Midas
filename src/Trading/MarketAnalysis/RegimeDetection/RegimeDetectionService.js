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

		const adxValue = adxData.adx.at(-1);
		const plusDI = adxData.plusDI?.at(-1) || 0;
		const minusDI = adxData.minusDI?.at(-1) || 0;
		const erValue = er.at(-1);
		const atrShortValue = atrShort.at(-1);
		const atrLongValue = atrLong.at(-1);
		const atrRatio = atrLongValue < 1e-12 ? 1 : atrShortValue / atrLongValue;
		const emaShortValue = emaShort.at(-1);
		const emaLongValue = emaLong.at(-1);
		const currentPrice = closes.at(-1);

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
		if (direction === 'bullish' && plusDI < minusDI) direction = 'neutral';
		if (direction === 'bearish' && minusDI < plusDI) direction = 'neutral';

		// Direction strength is normalized by long ATR to ensure
		// stability across volatility regimes and symbols.
		const directionStrength = atrLongValue < 1e-12 ? 0 : Math.max(-2, Math.min(2, (emaShortValue - emaLongValue) / atrLongValue));

		/* =====================================================
		4. Regime type detection
		Priority order reflects market structure:
		- Breakout: volatility expansion + trend strength
		- Trending: directional efficiency + trend strength
		- Range: absence of sustained directional structure
		===================================================== */

		let regimeType = '';
		let rangeType = '';

		if (atrRatio > config.atrRatio.high && adxValue >= config.adx.trending) {
			regimeType = 'breakout';
		} else if (adxValue >= config.adx.trending && erValue >= config.er.trending) {
			regimeType = 'trending';
		} else {
			regimeType = 'range';

			rangeType = 'normal';
			if (atrRatio < config.atrRatio.low) rangeType = 'low_vol';
			if (atrRatio > config.atrRatio.high) rangeType = 'high_vol';
		}

		/* =====================================================
		5. Confidence scoring
		Multiple independent components are scored and later
		combined using weighted averaging. This avoids relying
		on a single indicator and improves robustness.
		===================================================== */

		// Regime clarity score measures how clearly the market fits the detected regime type.
		let regimeClarityScore = 0.3;

		if (regimeType === 'trending' || regimeType === 'breakout') {
			if (adxValue > config.adx.strong) regimeClarityScore = 1;
			else if (adxValue > config.adx.trending) regimeClarityScore = 0.7;
			else if (adxValue > config.adx.weak) regimeClarityScore = 0.5;
		} else {
			if (adxValue < config.adx.weak) regimeClarityScore = 0.8;
			else if (adxValue < config.adx.trending) regimeClarityScore = 0.6;
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
			adxHigh: adxValue >= config.adx.trending,
			erHigh: erValue >= config.er.trending,
			erLow: erValue <= config.er.choppy,
			lowVol: atrRatio <= config.atrRatio.low,
			highVol: atrRatio >= config.atrRatio.high,
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
			range_normal: [!signals.adxHigh],
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
				plusDI: round2(plusDI),
				minusDI: round2(minusDI),
				efficiency_ratio: round4(erValue),
				atr_ratio: round4(atrRatio),
				direction: {
					direction,
					strength: round4(directionStrength),
					emaShort: round2(emaShortValue),
					emaLong: round2(emaLongValue),
				},
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
		const adx = series.data.map((d) => d.values?.adx || 0);
		const plusDI = series.data.map((d) => d.values?.plusDI || 0);
		const minusDI = series.data.map((d) => d.values?.minusDI || 0);

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

		return series.data.map((d) => d.value || d.atr || 0);
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

		return series.data.map((d) => d.value || d.ema || 0);
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
