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
		if (!this.logger)
			throw new Error('RegimeDetectionService requires a logger instance in options');

		this.dataProvider = parameters.dataProvider || null;
		if (!this.dataProvider)
			throw new Error('RegimeDetectionService requires a dataProvider instance in options');

		this.indicatorService = parameters.indicatorService || null;
		if (!this.indicatorService)
			throw new Error('RegimeDetectionService requires an indicatorService instance in options');

		this.logger.info('RegimeDetectionService initialized.');
	}

	/**
	 * Detect market regime for a symbol
	 * @param {Object} options - { symbol, timeframe, count, analysisDate, useCache, detectGaps }
	 * @returns {Promise<Object>} Regime detection result
	 */
	async detectRegime(options = {}) {
		const { symbol, timeframe = '1h', count = 200, analysisDate } = options;

		if (!symbol)
			throw new Error('Symbol is required');

		const startTime = Date.now();

		this.logger.info(`Detecting regime for ${symbol} on ${timeframe}${analysisDate ? ` at ${analysisDate}` : ''}`);

		// Load OHLCV data
		const ohlcv = await this.dataProvider.loadOHLCV({
			symbol,
			timeframe,
			count: Math.max(count, config.minBars + 50), // Extra bars for indicator warmup
			analysisDate,
			useCache: options.useCache !== false,
			detectGaps: options.detectGaps !== false,
		});

		if (!ohlcv?.bars || ohlcv.bars.length < config.minBars)
			throw new Error(`Insufficient data: need at least ${config.minBars} bars, got ${ohlcv?.bars?.length || 0}`);

		// Extract price arrays (for Efficiency Ratio calculation)
		const closes = ohlcv.bars.map((b) => b.close);

		// Calculate indicators using IndicatorService
		const [adxData, atrShort, atrLong, er, emaShort, emaLong] = await Promise.all([
			this._getADX(symbol, timeframe, ohlcv.bars.length, analysisDate),
			this._getATR(symbol, timeframe, ohlcv.bars.length, config.atrShortPeriod, analysisDate),
			this._getATR(symbol, timeframe, ohlcv.bars.length, config.atrLongPeriod, analysisDate),
			this._getEfficiencyRatio(closes, config.erPeriod),
			this._getEMA(symbol, timeframe, ohlcv.bars.length, config.maShortPeriod, analysisDate),
			this._getEMA(symbol, timeframe, ohlcv.bars.length, config.maLongPeriod, analysisDate),
		]);

		// Get current values
		const adxValue = adxData.adx.at(-1);
		const plusDI = adxData.plusDI?.at(-1) || 0;
		const minusDI = adxData.minusDI?.at(-1) || 0;
		const erValue = er.at(-1);
		const atrShortValue = atrShort.at(-1);
		const atrLongValue = atrLong.at(-1);
		const atrRatio = this._calculateATRRatio(atrShortValue, atrLongValue);
		const emaShortValue = emaShort.at(-1);
		const emaLongValue = emaLong.at(-1);
		const currentPrice = closes.at(-1);

		// Calculate direction
		const dir = this._calculateDirection({
			price: currentPrice,
			emaShort: emaShortValue,
			emaLong: emaLongValue,
			atrLong: atrLongValue,
		});

		// Detect regime type
		const regime = this._detectRegimeType({
			adxValue,
			erValue,
			atrRatio,
			dir,
		});

		// Calculate confidence
		const confidence = this._calculateConfidence({
			adxValue,
			erValue,
			atrRatio,
			dir,
			regime,
		});

		const result = {
			regime,
			confidence,
			components: {
				adx: round2(adxValue),
				plusDI: round2(plusDI),
				minusDI: round2(minusDI),
				efficiency_ratio: round4(erValue),
				atr_ratio: round4(atrRatio),
				direction: {
					direction: dir.direction,
					strength: round4(dir.strength),
					emaShort: round2(dir.emaShort),
					emaLong: round2(dir.emaLong),
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

		this.logger.info(`Regime detected: ${regime} (confidence: ${confidence}) in ${result.metadata.detectionDuration}ms`);

		return result;
	}

	/**
	 * Get ADX indicator using IndicatorService
	 * @private
	 */
	async _getADX(symbol, timeframe, bars, analysisDate) {
		try {
			const series = await this.indicatorService.getIndicatorTimeSeries({
				symbol,
				indicator: 'adx',
				timeframe,
				bars,
				analysisDate,
				config: { period: config.adxPeriod },
			});

			if (!series?.data || series.data.length === 0)
				throw new Error('No ADX data returned');

			// Extract ADX values
			const adx = series.data.map((d) => d.value || d.adx || 0);

			// trading-signals ADX doesn't return plusDI/minusDI, so calculate them separately
			const ohlcv = await this.dataProvider.loadOHLCV({ symbol, timeframe, count: bars, analysisDate });
			const { plusDI, minusDI } = this._calculateDI(
				ohlcv.bars.map((b) => b.high),
				ohlcv.bars.map((b) => b.low),
				ohlcv.bars.map((b) => b.close),
				config.adxPeriod
			);

			return { adx, plusDI, minusDI };
		} catch (error) {
			this.logger.warn(`Failed to get ADX from IndicatorService: ${error.message}. Using fallback calculation.`);
			return this._calculateADXFallback(symbol, timeframe, bars, analysisDate);
		}
	}

	/**
	 * Fallback ADX calculation (if IndicatorService fails)
	 * @private
	 */
	async _calculateADXFallback(symbol, timeframe, bars, analysisDate) {
		const ohlcv = await this.dataProvider.loadOHLCV({ symbol, timeframe, count: bars, analysisDate });
		const highs = ohlcv.bars.map((b) => b.high);
		const lows = ohlcv.bars.map((b) => b.low);
		const closes = ohlcv.bars.map((b) => b.close);

		return calculateADX(highs, lows, closes, config.adxPeriod);
	}

	/**
	 * Calculate Directional Indicators (plusDI and minusDI) only
	 * @private
	 */
	_calculateDI(highs, lows, closes, period) {
		const len = highs.length;

		const dmPlus = [];
		const dmMinus = [];
		for (let i = 1; i < len; i++) {
			const up = highs[i] - highs[i - 1];
			const down = lows[i - 1] - lows[i];

			dmPlus.push(up > down && up > 0 ? up : 0);
			dmMinus.push(down > up && down > 0 ? down : 0);
		}

		const tr = calculateTrueRange(highs, lows, closes).slice(1);

		const smTR = rma(tr, period);
		const smDMp = rma(dmPlus, period);
		const smDMm = rma(dmMinus, period);

		const plusDI = [];
		const minusDI = [];

		for (let i = 0; i < smTR.length; i++) {
			const atr = smTR[i];
			const p = atr === 0 ? 0 : (smDMp[i] / atr) * 100;
			const m = atr === 0 ? 0 : (smDMm[i] / atr) * 100;

			plusDI.push(p);
			minusDI.push(m);
		}

		return { plusDI, minusDI };
	}

	/**
	 * Get ATR indicator using IndicatorService
	 * @private
	 */
	async _getATR(symbol, timeframe, bars, period, analysisDate) {
		try {
			const series = await this.indicatorService.getIndicatorTimeSeries({
				symbol,
				indicator: 'atr',
				timeframe,
				bars,
				analysisDate,
				config: { period },
			});

			if (!series?.data || series.data.length === 0)
				throw new Error('No ATR data returned');

			return series.data.map((d) => d.value || d.atr || 0);
		} catch (error) {
			this.logger.warn(`Failed to get ATR from IndicatorService: ${error.message}. Using fallback.`);
			return this._calculateATRFallback(symbol, timeframe, bars, period, analysisDate);
		}
	}

	/**
	 * Fallback ATR calculation
	 * @private
	 */
	async _calculateATRFallback(symbol, timeframe, bars, period, analysisDate) {
		const ohlcv = await this.dataProvider.loadOHLCV({ symbol, timeframe, count: bars, analysisDate });
		const highs = ohlcv.bars.map((b) => b.high);
		const lows = ohlcv.bars.map((b) => b.low);
		const closes = ohlcv.bars.map((b) => b.close);

		const tr = calculateTrueRange(highs, lows, closes);
		return rma(tr, period);
	}

	/**
	 * Get EMA indicator using IndicatorService
	 * @private
	 */
	async _getEMA(symbol, timeframe, bars, period, analysisDate) {
		try {
			const series = await this.indicatorService.getIndicatorTimeSeries({
				symbol,
				indicator: 'ema',
				timeframe,
				bars,
				analysisDate,
				config: { period },
			});

			if (!series?.data || series.data.length === 0)
				throw new Error('No EMA data returned');

			return series.data.map((d) => d.value || d.ema || 0);
		} catch (error) {
			this.logger.warn(`Failed to get EMA from IndicatorService: ${error.message}. Using fallback.`);
			return this._calculateEMAFallback(symbol, timeframe, bars, period, analysisDate);
		}
	}

	/**
	 * Fallback EMA calculation
	 * @private
	 */
	async _calculateEMAFallback(symbol, timeframe, bars, period, analysisDate) {
		const ohlcv = await this.dataProvider.loadOHLCV({ symbol, timeframe, count: bars, analysisDate });
		const closes = ohlcv.bars.map((b) => b.close);
		return ema(closes, period);
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
			for (let j = i - period + 1; j <= i; j++)
				sum += Math.abs(closes[j] - closes[j - 1]);

			raw[i] = sum === 0 ? 0 : net / sum;
		}

		// Smooth ER for stability
		return ema(raw, 3);
	}

	/**
	 * Calculate ATR ratio
	 * @private
	 */
	_calculateATRRatio(atrShort, atrLong) {
		if (atrLong < 1e-12) return 1;
		return atrShort / atrLong;
	}

	/**
	 * Calculate direction
	 * @private
	 */
	_calculateDirection({ price, emaShort, emaLong, atrLong }) {
		let direction = 'neutral';
		if (price > emaLong && emaShort > emaLong) direction = 'bullish';
		else if (price < emaLong && emaShort < emaLong) direction = 'bearish';

		const strength = atrLong < 1e-12 ? 0 : (emaShort - emaLong) / atrLong;

		return { direction, strength, emaShort, emaLong, price };
	}

	/**
	 * Detect regime type
	 * @private
	 */
	_detectRegimeType({ adxValue, erValue, atrRatio, dir }) {
		const trending = adxValue >= config.adx.trending && erValue >= config.er.trending;

		/* ----------- TRENDING ----------- */
		if (trending) {
			if (dir.direction === 'bullish') return 'trending_bullish';
			if (dir.direction === 'bearish') return 'trending_bearish';
			return 'trending_neutral';
		}

		/* ----------- BREAKOUT ----------- */
		if (atrRatio > config.atrRatio.high && adxValue > config.adx.trending) {
			if (dir.direction === 'bullish') return 'breakout_bullish';
			if (dir.direction === 'bearish') return 'breakout_bearish';
			return 'breakout_neutral';
		}

		/* ----------- RANGING ----------- */
		if (atrRatio < config.atrRatio.low) return 'range_low_vol';
		if (atrRatio > config.atrRatio.high) return 'range_high_vol';
		return 'range_normal';
	}

	/**
	 * Calculate confidence score
	 * @private
	 */
	_calculateConfidence({ adxValue, erValue, atrRatio, dir, regime }) {
		const scores = [];

		/* Regime clarity score */
		let regimeClarityScore = 0.3;

		if (regime.includes('trending') || regime.includes('breakout')) {
			if (adxValue > config.adx.strong) regimeClarityScore = 1;
			else if (adxValue > config.adx.trending) regimeClarityScore = 0.7;
			else if (adxValue > config.adx.weak) regimeClarityScore = 0.5;
		} else if (regime.startsWith('range_')) {
			if (adxValue < config.adx.weak) regimeClarityScore = 0.8;
			else if (adxValue < config.adx.trending) regimeClarityScore = 0.6;
			else regimeClarityScore = 0.4;
		}

		scores.push(regimeClarityScore);

		/* ER score */
		let erScore = 0.4;
		if (regime.includes('trending')) {
			if (erValue > 0.7) erScore = 1;
			else if (erValue > 0.5) erScore = 0.7;
		} else {
			if (erValue < 0.25) erScore = 1;
			else if (erValue < 0.35) erScore = 0.7;
		}
		scores.push(erScore);

		/* Direction score */
		const absDir = Math.abs(dir.strength);
		let directionScore = 0.3;
		if (absDir > 0.8) directionScore = 1;
		else if (absDir > 0.5) directionScore = 0.7;
		else if (absDir > 0.25) directionScore = 0.5;
		scores.push(directionScore);

		/* Coherence score */
		let coherence = 0;
		const signals = {
			adxHigh: adxValue >= config.adx.trending,
			erHigh: erValue >= config.er.trending,
			erLow: erValue <= config.er.choppy,
			lowVol: atrRatio <= config.atrRatio.low,
			highVol: atrRatio >= config.atrRatio.high,
			bull: dir.direction === 'bullish',
			bear: dir.direction === 'bearish',
			neut: dir.direction === 'neutral',
		};

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
		if (r.length > 0) coherence = r.filter(Boolean).length / r.length;
		scores.push(coherence);

		/* Final confidence mean */
		return Math.round((scores.reduce((a, b) => a + b, 0) / scores.length) * 100) / 100;
	}
}

/* ===========================================================
   FALLBACK CALCULATION UTILITIES (Pure Functions)
   Used when IndicatorService is unavailable
   =========================================================== */

/**
 * Calculate EMA
 */
function ema(values, period) {
	const k = 2 / (period + 1);
	const out = [];
	out[0] = values[0];
	for (let i = 1; i < values.length; i++)
		out[i] = values[i] * k + out[i - 1] * (1 - k);
	return out;
}

/**
 * Calculate RMA (Wilder's smoothing)
 */
function rma(values, period) {
	const res = [];
	let prev = 0;
	for (let i = 0; i < values.length; i++)
		if (i === 0) {
			prev = values[0];
			res[0] = prev;
		} else {
			prev = (prev * (period - 1) + values[i]) / period;
			res[i] = prev;
		}
	return res;
}

/**
 * Calculate True Range
 */
function calculateTrueRange(highs, lows, closes) {
	const tr = new Array(highs.length);
	tr[0] = highs[0] - lows[0];

	for (let i = 1; i < highs.length; i++) {
		const high = highs[i];
		const low = lows[i];
		const prev = closes[i - 1];
		tr[i] = Math.max(high - low, Math.abs(high - prev), Math.abs(low - prev));
	}
	return tr;
}

/**
 * Calculate ADX
 */
function calculateADX(highs, lows, closes, period) {
	const len = highs.length;

	const dmPlus = [];
	const dmMinus = [];
	for (let i = 1; i < len; i++) {
		const up = highs[i] - highs[i - 1];
		const down = lows[i - 1] - lows[i];

		dmPlus.push(up > down && up > 0 ? up : 0);
		dmMinus.push(down > up && down > 0 ? down : 0);
	}

	const tr = calculateTrueRange(highs, lows, closes).slice(1);

	const smTR = rma(tr, period);
	const smDMp = rma(dmPlus, period);
	const smDMm = rma(dmMinus, period);

	const plusDI = [];
	const minusDI = [];
	const dx = [];

	for (let i = 0; i < smTR.length; i++) {
		const atr = smTR[i];
		const p = atr === 0 ? 0 : (smDMp[i] / atr) * 100;
		const m = atr === 0 ? 0 : (smDMm[i] / atr) * 100;

		plusDI.push(p);
		minusDI.push(m);

		const den = p + m;
		dx.push(den === 0 ? 0 : (Math.abs(p - m) / den) * 100);
	}

	const adxArr = rma(dx, period);

	return { adx: adxArr, plusDI, minusDI };
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
