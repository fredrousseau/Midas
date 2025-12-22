/**
 * Moving Averages Enricher
 * Uses EXISTING indicator calculations from indicatorService
 * No custom EMA/SMA calculations - 100% reuses existing system
 *
 * HARMONIZED with other enrichers (MomentumEnricher, VolatilityEnricher, VolumeEnricher)
 */

import { round } from '#utils/statisticalHelpers.js';

export class MovingAveragesEnricher {
	constructor(options = {}) {
		this.logger = options.logger || console;
		this.emaPeriods = [12, 26, 50, 200];
		this.smaPeriods = [20, 50];
	}

	/**
	 * Enrich moving averages with detailed analysis
	 * USES EXISTING CALCULATIONS from indicatorService (like all other enrichers)
	 *
	 * @param {Object} ohlcvData - OHLCV bars data (for consistency with other enrichers)
	 * @param {Object} indicatorService - Indicator service to fetch calculations
	 * @param {string} symbol - Symbol to analyze
	 * @param {string} timeframe - Timeframe to analyze
	 * @param {number} currentPrice - Current price
	 */
	async enrich({ _ohlcvData, indicatorService, symbol, timeframe, currentPrice }) {
		// ✅ Get EMAs from EXISTING calculations via indicatorService
		const emas = {};
		for (const period of this.emaPeriods)
			try {
				const series = await indicatorService.getIndicatorTimeSeries({
					symbol,
					indicator: 'ema',
					timeframe,
					bars: 250, // Extra for EMA200
					config: { period },
				});

				if (series && series.data && series.data.length > 0)
					emas[period] = {
						current: series.data[series.data.length - 1].value,
						history: series.data.map((d) => d.value),
					};
			} catch (error) {
				this.logger.warn(`Failed to get EMA${period}: ${error.message}`);
			}

		// ✅ Get SMAs from EXISTING calculations via indicatorService
		const smas = {};
		for (const period of this.smaPeriods)
			try {
				const series = await indicatorService.getIndicatorTimeSeries({
					symbol,
					indicator: 'sma',
					timeframe,
					bars: 200,
					config: { period },
				});

				if (series && series.data && series.data.length > 0)
					smas[period] = {
						current: series.data[series.data.length - 1].value,
						history: series.data.map((d) => d.value),
					};
			} catch (error) {
				this.logger.warn(`Failed to get SMA${period}: ${error.message}`);
			}

		// Build enriched context (same as before, but with existing calculations)
		return {
			ema: {
				// Current values
				ema12: emas[12]?.current ? round(emas[12].current, 0) : null,
				ema26: emas[26]?.current ? round(emas[26].current, 0) : null,
				ema50: emas[50]?.current ? round(emas[50].current, 0) : null,
				ema200: emas[200]?.current ? round(emas[200].current, 0) : null,

				// Price vs EMAs
				price_vs_ema12: emas[12] ? this._formatPercentage(currentPrice, emas[12].current) : null,
				price_vs_ema26: emas[26] ? this._formatPercentage(currentPrice, emas[26].current) : null,
				price_vs_ema50: emas[50] ? this._formatPercentage(currentPrice, emas[50].current) : null,
				price_vs_ema200: emas[200] ? this._formatPercentage(currentPrice, emas[200].current) : null,

				// Crosses
				cross_12_26: emas[12] && emas[26] ? this._detectCross(emas[12].history, emas[26].history, 'EMA12/EMA26') : null,
				cross_50_200: emas[50] && emas[200] ? this._detectCross(emas[50].history, emas[200].history, 'EMA50/EMA200') : null,

				// Slopes
				slope_ema12: emas[12] ? this._calculateSlope(emas[12].history, 10) : null,
				slope_ema26: emas[26] ? this._calculateSlope(emas[26].history, 10) : null,
				slope_ema50: emas[50] ? this._calculateSlope(emas[50].history, 20) : null,

				// Divergence
				divergence: emas[12] && emas[26] && emas[50] ? this._analyzeDivergence(emas[12].history, emas[26].history, emas[50].history) : null,

				// Alignment
				alignment: this._analyzeAlignment(emas, currentPrice),

				// Support/Resistance
				support_cluster: this._identifySupportCluster(emas, currentPrice),
				nearest_support: this._identifyNearestSupport(emas, currentPrice),
			},
			sma: {
				sma20: smas[20]?.current ? round(smas[20].current, 0) : null,
				sma50: smas[50]?.current ? round(smas[50].current, 0) : null,
				vs_ema: smas[20] && emas[26] ? this._compareSMAvsEMA(smas, emas) : null,
			},
		};
	}

	/**
	 * Format percentage
	 */
	_formatPercentage(value, reference) {
		if (!reference || reference === 0) return null;
		const pct = ((value - reference) / reference) * 100;
		const sign = pct >= 0 ? '+' : '';
		return `${sign}${round(pct, 2)}%`;
	}

	/**
	 * Detect cross between two EMAs
	 */
	_detectCross(fast, slow, label) {
		if (!fast || !slow || fast.length < 2 || slow.length < 2) return 'insufficient data';

		const currentFast = fast[fast.length - 1];
		const currentSlow = slow[slow.length - 1];
		const previousFast = fast[fast.length - 2];
		const previousSlow = slow[slow.length - 2];

		if (currentFast > currentSlow && previousFast <= previousSlow) return 'bullish (just crossed)';

		if (currentFast < currentSlow && previousFast >= previousSlow) return 'bearish (just crossed)';

		// Count bars since cross
		let barsSinceCross = 0;
		const isBullish = currentFast > currentSlow;

		for (let i = fast.length - 1; i >= 1; i--) {
			const f = fast[i];
			const s = slow[i];
			const prevF = fast[i - 1];
			const prevS = slow[i - 1];

			if (isBullish) {
				if (f > s && prevF <= prevS) break;
				if (f > s) barsSinceCross++;
				else break;
			} else {
				if (f < s && prevF >= prevS) break;
				if (f < s) barsSinceCross++;
				else break;
			}
		}

		if (barsSinceCross === 0) return 'no clear cross';

		return isBullish
			? `bullish (${label.split('/')[0]} > ${label.split('/')[1]} since ${barsSinceCross} bars)`
			: `bearish (${label.split('/')[0]} < ${label.split('/')[1]} since ${barsSinceCross} bars)`;
	}

	/**
	 * Calculate slope (rate of change per bar)
	 */
	_calculateSlope(history, lookback = 10) {
		if (!history || history.length < lookback) return 'insufficient data';

		const recent = history.slice(-lookback);

		// Linear regression
		const n = recent.length;
		const x = Array.from({ length: n }, (_, i) => i);
		const y = recent;

		const sumX = x.reduce((a, b) => a + b, 0);
		const sumY = y.reduce((a, b) => a + b, 0);
		const sumXY = x.reduce((acc, xi, i) => acc + xi * y[i], 0);
		const sumX2 = x.reduce((acc, xi) => acc + xi * xi, 0);

		const slope = (n * sumXY - sumX * sumY) / (n * sumX2 - sumX * sumX);
		const avgValue = sumY / n;

		// Normalize by value
		const slopePercent = (slope / avgValue) * 100;

		// Interpretation
		let interpretation;
		if (Math.abs(slopePercent) < 0.05) interpretation = 'flat';
		else if (slopePercent > 0.3) interpretation = 'accelerating up';
		else if (slopePercent > 0.1) interpretation = 'rising';
		else if (slopePercent < -0.3) interpretation = 'accelerating down';
		else if (slopePercent < -0.1) interpretation = 'declining';
		else interpretation = 'stable';

		return `${slopePercent >= 0 ? '+' : ''}${round(slopePercent, 2)}% per bar (${interpretation})`;
	}

	/**
	 * Analyze divergence between EMAs
	 */
	_analyzeDivergence(ema12, ema26, ema50) {
		if (!ema12 || !ema26 || !ema50) return 'insufficient data';
		if (ema12.length < 20) return 'insufficient data';

		const recent12 = ema12.slice(-20);
		const recent26 = ema26.slice(-20);
		const recent50 = ema50.slice(-20);

		// Calculate slopes
		const slope12 = this._getSimpleSlope(recent12);
		const slope26 = this._getSimpleSlope(recent26);
		const slope50 = this._getSimpleSlope(recent50);

		// Check if slopes are similar (parallel)
		const diff12_26 = Math.abs(slope12 - slope26);
		const diff26_50 = Math.abs(slope26 - slope50);

		if (diff12_26 < 0.001 && diff26_50 < 0.001) return 'parallel (healthy trend)';

		// Expanding (EMAs diverging)
		if (slope12 > slope26 && slope26 > slope50) return 'expanding (strengthening)';

		if (slope12 < slope26 && slope26 < slope50) return 'expanding (weakening)';

		// Converging
		if ((slope12 < slope26 && slope26 < slope50 && slope12 > 0) || (slope12 > slope26 && slope26 > slope50 && slope12 < 0)) return 'converging (momentum fading)';

		return 'mixed';
	}

	/**
	 * Get simple slope
	 */
	_getSimpleSlope(values) {
		if (!values || values.length < 2) return 0;
		const first = values[0];
		const last = values[values.length - 1];
		return (last - first) / values.length;
	}

	/**
	 * Analyze alignment
	 */
	_analyzeAlignment(emas, currentPrice) {
		const ema12 = emas[12]?.current;
		const ema26 = emas[26]?.current;
		const ema50 = emas[50]?.current;
		const ema200 = emas[200]?.current;

		if (!ema12 || !ema26 || !ema50) return 'insufficient data';

		// Perfect bullish: price > ema12 > ema26 > ema50 > ema200
		if (currentPrice > ema12 && ema12 > ema26 && ema26 > ema50) {
			if (ema200 && ema50 > ema200) return 'perfect bullish (price > ema12 > ema26 > ema50 > ema200)';

			return 'strong bullish (price > ema12 > ema26 > ema50)';
		}

		// Perfect bearish
		if (currentPrice < ema12 && ema12 < ema26 && ema26 < ema50) {
			if (ema200 && ema50 < ema200) return 'perfect bearish (price < ema12 < ema26 < ema50 < ema200)';

			return 'strong bearish (price < ema12 < ema26 < ema50)';
		}

		// Mixed
		return 'mixed alignment (no clear structure)';
	}

	/**
	 * Identify support cluster
	 */
	_identifySupportCluster(emas, currentPrice) {
		const supports = [];

		for (const [period, data] of Object.entries(emas))
			if (data && data.current < currentPrice) {
				const distance = currentPrice - data.current;
				supports.push({ period: parseInt(period), value: data.current, distance });
			}

		if (supports.length === 0) return 'none below price';
		if (supports.length === 1) {
			const s = supports[0];
			return `ema${s.period} at ${round(s.value, 0)}`;
		}

		// Multiple EMAs close together form a cluster
		supports.sort((a, b) => b.value - a.value); // Sort by value descending

		const cluster = [];
		const tolerance = currentPrice * 0.02; // 2% tolerance

		for (let i = 0; i < supports.length - 1; i++) {
			const diff = Math.abs(supports[i].value - supports[i + 1].value);
			if (diff < tolerance) {
				if (cluster.length === 0) cluster.push(supports[i]);
				cluster.push(supports[i + 1]);
			}
		}

		if (cluster.length >= 2) {
			const lowest = cluster[cluster.length - 1];
			const highest = cluster[0];
			return `${round(lowest.value, 0)}-${round(highest.value, 0)} (ema${lowest.period}-ema${highest.period} zone)`;
		}

		return `ema${supports[0].period} at ${round(supports[0].value, 0)}`;
	}

	/**
	 * Identify nearest support
	 */
	_identifyNearestSupport(emas, currentPrice) {
		let nearestSupport = null;
		let minDistance = Infinity;

		for (const [period, data] of Object.entries(emas))
			if (data && data.current < currentPrice) {
				const distance = currentPrice - data.current;
				if (distance < minDistance) {
					minDistance = distance;
					nearestSupport = { period: parseInt(period), value: data.current };
				}
			}

		if (!nearestSupport) return 'none below price';

		const distancePct = (minDistance / currentPrice) * 100;
		return `ema${nearestSupport.period} at ${round(nearestSupport.value, 0)} (-${round(distancePct, 2)}%)`;
	}

	/**
	 * Compare SMA vs EMA
	 */
	_compareSMAvsEMA(smas, emas) {
		const sma20 = smas[20]?.current;
		const ema26 = emas[26]?.current;

		if (!sma20 || !ema26) return 'insufficient data';

		if (ema26 > sma20) return 'emas leading (bullish signal)';
		else if (ema26 < sma20) return 'smas leading (bearish signal)';
		else return 'aligned (neutral)';
	}
}

export default MovingAveragesEnricher;
