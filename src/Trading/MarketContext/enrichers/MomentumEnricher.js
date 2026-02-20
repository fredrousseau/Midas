/**
 * Momentum Enricher
 * RSI, MACD, Stochastic with HTF comparisons and divergence detection
 */

import { round } from '#utils/statisticalHelpers.js';
import { getBarCount } from '../config/barCounts.js';
import { STATISTICAL_PERIODS, TREND_PERIODS } from '../config/lookbackPeriods.js';

export class MomentumEnricher {
	constructor(options = {}) {
		this.logger = options.logger || console;
	}

	/**
	 * Enrich momentum indicators
	 */
	async enrich({ ohlcvData, indicatorService, symbol, timeframe, higherTimeframeData, referenceDate }) {
		const closes = ohlcvData.bars.map(b => b.close);
		const _highs = ohlcvData.bars.map(b => b.high);
		const _lows = ohlcvData.bars.map(b => b.low);

		// Get indicator series from IndicatorService (in parallel)
		const [rsiSeries, macdSeries, stochSeries] = await Promise.all([
			this._getIndicatorSafe(indicatorService, symbol, 'rsi', timeframe, referenceDate),
			this._getIndicatorSafe(indicatorService, symbol, 'macd', timeframe, referenceDate),
			this._getIndicatorSafe(indicatorService, symbol, 'stochastic', timeframe, referenceDate),
		]);

		return {
			rsi: rsiSeries ? this._enrichRSI(rsiSeries, closes, higherTimeframeData) : null,
			macd: macdSeries ? this._enrichMACD(macdSeries, closes, higherTimeframeData) : null,
			stochastic: stochSeries ? this._enrichStochastic(stochSeries) : null,
			roc: this._calculateROC(closes)
		};
	}

	/**
	 * Get adaptive bar count based on timeframe
	 * Uses centralized configuration from config/barCounts.js
	 */
	_getAdaptiveBarCount(timeframe) {
		return getBarCount('indicator', timeframe);
	}

	/**
	 * Get indicator series
	 * @throws {Error} If indicator calculation fails
	 */
	async _getIndicatorSafe(indicatorService, symbol, indicator, timeframe, referenceDate) {
		const bars = this._getAdaptiveBarCount(timeframe);
		const series = await indicatorService.getIndicatorTimeSeries({
			symbol,
			indicator,
			timeframe,
			bars,
			referenceDate,
			config: {}
		});
		return series;
	}

	/**
	 * Enrich RSI
	 */
	_enrichRSI(rsiSeries, closes, higherTFData) {
		const rsiValues = rsiSeries.data.map(d => d.value);
		const currentRSI = rsiValues[rsiValues.length - 1];

		// Calculate percentiles
		const percentile20d = this._getPercentile(currentRSI, rsiValues.slice(-STATISTICAL_PERIODS.short));
		const percentile50d = this._getPercentile(currentRSI, rsiValues.slice(-STATISTICAL_PERIODS.medium));

		// Calculate stats
		const mean50d = this._mean(rsiValues.slice(-STATISTICAL_PERIODS.medium));
		const typical_range = this._getTypicalRange(rsiValues.slice(-STATISTICAL_PERIODS.medium));

		// Detect trend
		const trend = this._detectTrend(rsiValues.slice(-TREND_PERIODS.short));

		// Detect divergence with price (use medium window for peak-finding)
		const divergence = this._detectRSIDivergence(rsiValues.slice(-STATISTICAL_PERIODS.medium), closes.slice(-STATISTICAL_PERIODS.medium));

		// Compare with higher timeframe
		let vs_htf = null;
		if (higherTFData && higherTFData.rsi) {
			const diff = currentRSI - higherTFData.rsi;
			vs_htf = `${diff > 0 ? '+' : ''}${round(diff, 1)} points (${diff < -10 ? 'cooling from HTF' : diff > 10 ? 'heating vs HTF' : 'aligned with HTF'})`;
		}

		// Interpretation
		let interpretation;
		if (currentRSI > 70) 
			interpretation = 'overbought (potential resistance)';
		 else if (currentRSI > 65) 
			interpretation = 'strong momentum, not yet overbought';
		 else if (currentRSI > 50) 
			interpretation = 'bullish momentum';
		 else if (currentRSI > 35) 
			interpretation = 'neutral to bearish momentum';
		 else if (currentRSI > 30) 
			interpretation = 'oversold zone but can extend';
		 else 
			interpretation = 'oversold (potential support)';

		// Support level
		let support_level = null;
		if (currentRSI > 45 && currentRSI < 55) 
			support_level = '50 (key level)';

		// Historical context
		let historical_context = null;
		const avg70Plus = rsiValues.filter(v => v > 70).length;
		if (currentRSI > 65 && avg70Plus > 5) 
			historical_context = `RSI above 65 maintained during previous rallies (${avg70Plus} bars)`;

		return {
			value: round(currentRSI, 1),
			percentile_20d: round(percentile20d, 2),
			percentile_50d: round(percentile50d, 2),
			vs_mean_50d: this._formatPercentage(currentRSI, mean50d),
			typical_range_50d: typical_range.map(v => round(v, 0)),
			interpretation,
			trend: trend.direction,
			divergence: divergence,
			vs_htf,
			support_level,
			historical_context
		};
	}

	/**
	 * Enrich MACD
	 */
	_enrichMACD(macdSeries, closes, higherTFData) {
		const macdData = macdSeries.data;
		const current = macdData[macdData.length - 1];

		if (!current || !current.values) return null;

		const macd = current.values.macd;
		const signal = current.values.macdSignal;
		const histogram = current.values.macdHistogram;

		// Histogram trend
		const histogramValues = macdData.slice(-TREND_PERIODS.short).map(d => d.values?.macdHistogram).filter(Boolean);
		const histogramTrend = this._analyzeHistogramTrend(histogramValues);

		// Detect cross
		const crossData = this._detectMACDCross(macdData);

		// Interpretation
		let interpretation;
		const prevHistogram = histogramValues.length >= 2 ? histogramValues[histogramValues.length - 2] : null;
		if (macd > signal && histogram > 0)
			interpretation = prevHistogram !== null && histogram > prevHistogram
				? 'strong bullish momentum (expanding)'
				: 'bullish momentum';
		 else if (macd < signal && histogram < 0)
			interpretation = prevHistogram !== null && histogram < prevHistogram
				? 'strong bearish momentum (expanding)'
				: 'bearish momentum';
		 else 
			interpretation = 'weak momentum (transition)';

		// Divergence with price
		const macdValues = macdData.slice(-TREND_PERIODS.medium).map(d => d.values?.macd).filter(Boolean);
		const divergence = this._detectMACDDivergence(macdValues, closes.slice(-TREND_PERIODS.medium));

		// Compare with HTF
		let context = null;
		if (higherTFData && higherTFData.macd) 
			if (macd > 0 && higherTFData.macd > 0) 
				context = 'aligned with HTF bullish momentum';
			 else if (macd < 0 && higherTFData.macd < 0) 
				context = 'aligned with HTF bearish momentum';
			 else 
				context = 'minor divergence vs HTF MACD';

		return {
			macd: round(macd, 2),
			signal: round(signal, 2),
			histogram: round(histogram, 2),
			histogram_trend: histogramTrend,
			cross: crossData,
			interpretation,
			histogram_vs_price: divergence,
			context
		};
	}

	/**
	 * Enrich Stochastic
	 */
	_enrichStochastic(stochSeries) {
		const stochData = stochSeries.data;
		const current = stochData[stochData.length - 1];

		if (!current || !current.values) return null;

		const k = current.values.stochasticK;
		const d = current.values.stochasticD;

		// Interpretation
		let interpretation;
		if (k > 80) 
			interpretation = 'overbought zone but can stay elevated in strong trends';
		 else if (k > 70) 
			interpretation = 'approaching overbought';
		 else if (k < 20) 
			interpretation = 'oversold zone';
		 else if (k < 30) 
			interpretation = 'approaching oversold';
		 else 
			interpretation = 'neutral zone';

		// Cross
		const cross = k > d ? 'k > d (bullish)' : 'k < d (bearish)';

		// Context for trending markets
		let context = null;
		if (k > 70) 
			context = 'can stay elevated in strong trends';
		 else if (k < 30) 
			context = 'typically bounces from 30 level in uptrends';

		return {
			k: round(k, 1),
			d: round(d, 1),
			interpretation,
			cross,
			context
		};
	}

	/**
	 * Calculate Rate of Change
	 */
	_calculateROC(closes) {
		const current = closes[closes.length - 1];

		const roc5 = closes.length >= 6 ? this._roc(current, closes[closes.length - 6]) : 0;
		const roc10 = closes.length >= 11 ? this._roc(current, closes[closes.length - 11]) : 0;

		let interpretation;
		if (roc5 > 2 && roc10 > 2) 
			interpretation = 'strong upward momentum';
		 else if (roc5 < -2 && roc10 < -2) 
			interpretation = 'strong downward momentum';
		 else if (roc5 > 0 && roc10 > 0) 
			interpretation = 'upward momentum';
		 else if (roc5 < 0 && roc10 < 0) 
			interpretation = 'downward momentum';
		 else 
			interpretation = 'short-term pullback in larger trend';

		return {
			'5_period': this._formatPct(roc5),
			'10_period': this._formatPct(roc10),
			interpretation
		};
	}

	/**
	 * Calculate ROC
	 */
	_roc(current, past) {
		if (!past || past === 0) return 0;
		return ((current - past) / past) * 100;
	}

	/**
	 * Detect trend in values
	 */
	_detectTrend(values) {
		if (values.length < 3) return { direction: 'unknown' };
		
		const first = values[0];
		const last = values[values.length - 1];
		const slope = (last - first) / values.length;

		if (slope > 0.5) return { direction: 'rising (bullish)' };
		if (slope < -0.5) return { direction: 'declining (bearish)' };
		return { direction: 'flat (range-bound)' };
	}

	/**
	 * Detect RSI divergence with price using both peaks (bearish) and troughs (bullish)
	 */
	_detectRSIDivergence(rsiValues, priceValues) {
		if (rsiValues.length < 10 || priceValues.length < 10)
			return 'none';

		// Bearish divergence: compare peaks (highs)
		const rsiPeaks = this._findPeaks(rsiValues);
		const pricePeaks = this._findPeaks(priceValues);

		if (rsiPeaks.length >= 2 && pricePeaks.length >= 2) {
			const rsiTrend = rsiPeaks[rsiPeaks.length - 1] - rsiPeaks[rsiPeaks.length - 2];
			const priceTrend = pricePeaks[pricePeaks.length - 1] - pricePeaks[pricePeaks.length - 2];

			if (rsiTrend < 0 && priceTrend > 0)
				return 'bearish divergence (price higher high, RSI lower high)';
		}

		// Bullish divergence: compare troughs (lows)
		const rsiTroughs = this._findTroughs(rsiValues);
		const priceTroughs = this._findTroughs(priceValues);

		if (rsiTroughs.length >= 2 && priceTroughs.length >= 2) {
			const rsiTrend = rsiTroughs[rsiTroughs.length - 1] - rsiTroughs[rsiTroughs.length - 2];
			const priceTrend = priceTroughs[priceTroughs.length - 1] - priceTroughs[priceTroughs.length - 2];

			if (rsiTrend > 0 && priceTrend < 0)
				return 'bullish divergence (price lower low, RSI higher low)';
		}

		return 'none (price and RSI aligned)';
	}

	/**
	 * Detect MACD divergence with price
	 */
	_detectMACDDivergence(macdValues, priceValues) {
		if (macdValues.length < 10 || priceValues.length < 10)
			return 'aligned';

		const pricePeaks = this._findPeaks(priceValues);
		const macdPeaks = this._findPeaks(macdValues);
		const priceTroughs = this._findTroughs(priceValues);
		const macdTroughs = this._findTroughs(macdValues);

		// Bearish divergence: price makes higher highs, MACD makes lower highs
		if (pricePeaks.length >= 2 && macdPeaks.length >= 2) {
			const priceRising = pricePeaks[pricePeaks.length - 1] > pricePeaks[pricePeaks.length - 2];
			const macdFalling = macdPeaks[macdPeaks.length - 1] < macdPeaks[macdPeaks.length - 2];
			if (priceRising && macdFalling)
				return 'bearish divergence';
		}

		// Bullish divergence: price makes lower lows, MACD makes higher lows
		if (priceTroughs.length >= 2 && macdTroughs.length >= 2) {
			const priceFalling = priceTroughs[priceTroughs.length - 1] < priceTroughs[priceTroughs.length - 2];
			const macdRising = macdTroughs[macdTroughs.length - 1] > macdTroughs[macdTroughs.length - 2];
			if (priceFalling && macdRising)
				return 'bullish divergence';
		}

		return 'aligned (no divergence)';
	}

	/**
	 * Analyze histogram trend
	 */
	_analyzeHistogramTrend(histogramValues) {
		if (histogramValues.length < TREND_PERIODS.immediate) return 'insufficient data';

		const recent = histogramValues.slice(-TREND_PERIODS.immediate);
		const increasing = recent.every((val, i) => i === 0 || val > recent[i - 1]);
		const decreasing = recent.every((val, i) => i === 0 || val < recent[i - 1]);

		if (increasing && recent[recent.length - 1] > 0) 
			return 'expanding (momentum increasing)';
		 else if (decreasing && recent[recent.length - 1] < 0) 
			return 'declining (momentum weakening)';
		 else if (increasing) 
			return 'recovering';
		 else if (decreasing) 
			return 'weakening';

		return 'stable';
	}

	/**
	 * Detect MACD cross
	 */
	_detectMACDCross(macdData) {
		if (macdData.length < 2) return 'insufficient data';
		
		const current = macdData[macdData.length - 1];
		const previous = macdData[macdData.length - 2];

		if (!current.values || !previous.values) return 'insufficient data';

		const currentCross = current.values.macd > current.values.macdSignal;
		const _previousCross = previous.values.macd > previous.values.macdSignal;

		// Find bars since cross
		let barsSinceCross = 0;
		for (let i = macdData.length - 2; i >= 0; i--) {
			if (!macdData[i].values) break;
			const wasCross = macdData[i].values.macd > macdData[i].values.macdSignal;
			if (wasCross !== currentCross) break;
			barsSinceCross++;
		}

		if (currentCross) 
			return `bullish (macd > signal since ${barsSinceCross} bars)`;
		 else 
			return `bearish (macd < signal since ${barsSinceCross} bars)`;
		
	}

	/**
	 * Find peaks (local maxima) in array
	 */
	_findPeaks(values) {
		const peaks = [];
		for (let i = 1; i < values.length - 1; i++)
			if (values[i] > values[i - 1] && values[i] > values[i + 1])
				peaks.push(values[i]);

		return peaks;
	}

	/**
	 * Find troughs (local minima) in array
	 */
	_findTroughs(values) {
		const troughs = [];
		for (let i = 1; i < values.length - 1; i++)
			if (values[i] < values[i - 1] && values[i] < values[i + 1])
				troughs.push(values[i]);

		return troughs;
	}

	/**
	 * Calculate percentile
	 */
	_getPercentile(value, distribution) {
		const sorted = [...distribution].sort((a, b) => a - b);
		const count = sorted.filter(v => v <= value).length;
		return count / sorted.length;
	}

	/**
	 * Calculate mean
	 */
	_mean(values) {
		return values.reduce((a, b) => a + b, 0) / values.length;
	}

	/**
	 * Get typical range (Q1-Q3)
	 */
	_getTypicalRange(values) {
		const sorted = [...values].sort((a, b) => a - b);
		const q1Index = Math.floor(sorted.length * 0.25);
		const q3Index = Math.floor(sorted.length * 0.75);
		return [sorted[q1Index], sorted[q3Index]];
	}

	/**
	 * Format percentage
	 */
	_formatPercentage(value, reference) {
		const pct = ((value - reference) / reference) * 100;
		const sign = pct >= 0 ? '+' : '';
		return `${sign}${round(pct, 1)}%`;
	}

	/**
	 * Format percentage simple
	 */
	_formatPct(value) {
		const sign = value >= 0 ? '+' : '';
		return `${sign}${round(value, 2)}%`;
	}
}

export default MomentumEnricher;
