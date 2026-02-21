/**
 * Volatility Enricher
 * ATR, Bollinger Bands with squeeze detection and breakout signals
 */

import { round } from '#utils/statisticalHelpers.js';
import { getBarCount } from '../config/barCounts.js';
import { STATISTICAL_PERIODS, TREND_PERIODS } from '../config/lookbackPeriods.js';

export class VolatilityEnricher {
	constructor(options = {}) {
		this.logger = options.logger || console;
	}

	/**
	 * Calculate timeframe scaling multiplier
	 * Returns how many times larger the higher timeframe is compared to current
	 */
	_getTimeframeMultiplier(currentTF, higherTF) {
		const tfMinutes = {
			'5m': 5,
			'15m': 15,
			'30m': 30,
			'1h': 60,
			'4h': 240,
			'1d': 1440,
			'1w': 10080,
			'1M': 43200
		};

		const currentMinutes = tfMinutes[currentTF];
		const higherMinutes = tfMinutes[higherTF];

		if (!currentMinutes || !higherMinutes) {
			this.logger.warn(`Unknown timeframe for scaling: ${currentTF} or ${higherTF}, defaulting to 4x`);
			return 4; // Fallback to default
		}

		return higherMinutes / currentMinutes;
	}

	/**
	 * Enrich volatility indicators
	 */
	async enrich({ ohlcvData, indicatorService, symbol, timeframe, currentPrice, higherTimeframeData, referenceDate }) {
		// Get indicator series (in parallel)
		const [atrSeries, bbSeries, bbWidthSeries] = await Promise.all([
			this._getIndicatorSafe(indicatorService, symbol, 'atr', timeframe, referenceDate),
			this._getIndicatorSafe(indicatorService, symbol, 'bb', timeframe, referenceDate),
			this._getIndicatorSafe(indicatorService, symbol, 'bbWidth', timeframe, referenceDate),
		]);

		return {
			atr: atrSeries ? this._enrichATR(atrSeries, timeframe, higherTimeframeData) : null,
			bollinger_bands: bbSeries ? this._enrichBB(bbSeries, bbWidthSeries, currentPrice) : null,
			atr_ratio: this._calculateATRRatio(ohlcvData),
			historical_volatility: this._calculateHistoricalVolatility(ohlcvData)
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
	 * Enrich ATR
	 */
	_enrichATR(atrSeries, currentTimeframe, higherTFData) {
		const atrValues = atrSeries.data.map(d => d.value);
		const currentATR = atrValues[atrValues.length - 1];

		// Calculate percentiles
		const percentile50d = this._getPercentile(currentATR, atrValues.slice(-STATISTICAL_PERIODS.medium));

		// Calculate mean
		const mean50d = this._mean(atrValues.slice(-STATISTICAL_PERIODS.medium));

		// Detect trend
		const trend = this._detectATRTrend(atrValues.slice(-TREND_PERIODS.short));

		// Interpretation
		let interpretation;
		if (percentile50d > 0.8)
			interpretation = 'elevated volatility (trending or volatile market)';
		else if (percentile50d > 0.6)
			interpretation = 'above average volatility';
		else if (percentile50d < 0.3)
			interpretation = 'low volatility (consolidation)';
		else
			interpretation = 'normal volatility';

		// Compare with higher timeframe
		let vs_htf_scaled = null;
		if (higherTFData && higherTFData.atr && higherTFData.timeframe) {
			// Calculate actual timeframe multiplier (not hardcoded 4x)
			const multiplier = this._getTimeframeMultiplier(currentTimeframe, higherTFData.timeframe);
			const ratio = currentATR / (higherTFData.atr / multiplier);
			const diff = ((ratio - 1) * 100);
			vs_htf_scaled = `${diff > 0 ? '+' : ''}${round(diff, 0)}% vs ${higherTFData.timeframe} (${diff > 20 ? 'elevated' : diff < -20 ? 'relative quiet' : 'aligned'})`;
		}

		return {
			value: round(currentATR, 0),
			percentile_50d: round(percentile50d, 2),
			vs_mean: this._formatPercentage(currentATR, mean50d),
			interpretation,
			trend,
			context_for_stops: `1 ATR = ${round(currentATR, 0)} points`,
			vs_htf_scaled
		};
	}

	/**
	 * Enrich Bollinger Bands
	 */
	_enrichBB(bbSeries, bbWidthSeries, currentPrice) {
		const bbData = bbSeries.data;
		const current = bbData[bbData.length - 1];

		if (!current || !current.values) return null;

		const upper = current.values.bbUpper;
		const middle = current.values.bbMiddle;
		const lower = current.values.bbLower;
		const width = upper - lower;

		// Calculate position in bands (0 = lower, 0.5 = middle, 1 = upper)
		const position = (currentPrice - lower) / (upper - lower);

		// Get width percentile
		// bbWidthSeries returns bandwidth as ratio (width / middle), not absolute points
		let widthPercentile = null;
		let bandwidthPercentile = null;
		if (bbWidthSeries) {
			const widthValues = bbWidthSeries.data.map(d => d.value);
			const currentBandwidth = middle !== 0 ? width / middle : 0;
			widthPercentile = this._getPercentile(currentBandwidth, widthValues.slice(-STATISTICAL_PERIODS.medium));

			// Calculate bandwidth percentile for squeeze detection
			const recentWidths = widthValues.slice(-STATISTICAL_PERIODS.short);
			bandwidthPercentile = this._getPercentile(currentBandwidth, recentWidths);
		}

		// Detect BB squeeze
		const squeeze = this._detectBBSqueeze(widthPercentile, bandwidthPercentile);

		// Interpretation
		let interpretation;
		if (squeeze.isSqueezing) 
			interpretation = squeeze.interpretation;
		 else if (widthPercentile > 0.7) 
			interpretation = 'wide bands (high volatility)';
		 else if (widthPercentile < 0.3) 
			interpretation = 'narrow range';
		 else 
			interpretation = 'normal width for trending market';

		// Price vs bands
		let price_vs_bands;
		if (position > 1.0)
			price_vs_bands = 'above upper band (overextended — potential mean reversion)';
		 else if (position < 0.0)
			price_vs_bands = 'below lower band (overextended — potential mean reversion)';
		 else if (position > 0.8)
			price_vs_bands = 'approaching upper band (potential resistance)';
		 else if (position < 0.2)
			price_vs_bands = 'approaching lower band (potential support)';
		 else if (position > 0.6)
			price_vs_bands = 'upper half (bullish)';
		 else if (position < 0.4)
			price_vs_bands = 'lower half (bearish)';
		 else
			price_vs_bands = 'middle (neutral)';

		// Context
		let context = null;
		if (squeeze.isSqueezing) 
			context = squeeze.context;

		return {
			upper: round(upper, 0),
			middle: round(middle, 0),
			lower: round(lower, 0),
			current_position: `${position > 1.0 ? 'above upper band' : position < 0.0 ? 'below lower band' : position > 0.5 ? 'upper half' : 'lower half'} (${round(position, 2)})`,
			width: round(width, 0),
			width_percentile: widthPercentile ? round(widthPercentile, 2) : null,
			interpretation,
			bandwidth_percentile: bandwidthPercentile ? `${round(bandwidthPercentile * 100, 0)}% of readings` : null,
			context,
			price_vs_bands,
			squeeze_detected: squeeze.isSqueezing
		};
	}

	/**
	 * Calculate ATR Ratio (short/long)
	 */
	_calculateATRRatio(ohlcvData) {
		const highs = ohlcvData.bars.map(b => b.high);
		const lows = ohlcvData.bars.map(b => b.low);
		const closes = ohlcvData.bars.map(b => b.close);

		// Calculate short and long ATR
		const atrShort = this._calculateATR(highs, lows, closes, 14);
		const atrLong = this._calculateATR(highs, lows, closes, 50);

		if (!atrShort || !atrLong || atrLong === 0) 
			return null;

		const currentShort = atrShort[atrShort.length - 1];
		const currentLong = atrLong[atrLong.length - 1];
		const ratio = currentShort / currentLong;

		// Interpretation
		let interpretation;
		let context;
		
		if (ratio > 1.3) {
			interpretation = 'high (breakout or spike)';
			context = 'ratio > 1.3 signals breakout phase';
		} else if (ratio > 1.1) {
			interpretation = 'slightly elevated (momentum phase)';
			context = 'ratio > 1.3 would signal breakout';
		} else if (ratio < 0.8) {
			interpretation = 'low (compression)';
			context = 'compression often precedes expansion';
		} else {
			interpretation = 'normal';
			context = 'stable volatility regime';
		}

		return {
			short_long: round(ratio, 2),
			interpretation,
			context
		};
	}

	/**
	 * Calculate historical volatility percentile
	 * Uses rolling standard deviation of log returns to measure where current vol sits historically
	 */
	_calculateHistoricalVolatility(ohlcvData) {
		const closes = ohlcvData.bars.map(b => b.close);
		if (closes.length < STATISTICAL_PERIODS.long + 1) return null;

		// Calculate log returns (skip invalid prices)
		const logReturns = [];
		for (let i = 1; i < closes.length; i++)
			if (closes[i] > 0 && closes[i - 1] > 0)
				logReturns.push(Math.log(closes[i] / closes[i - 1]));

		// Rolling volatility (std dev of log returns) over a 20-bar window
		const window = STATISTICAL_PERIODS.short;
		const rollingVol = [];
		for (let i = window; i <= logReturns.length; i++) {
			const slice = logReturns.slice(i - window, i);
			const mean = slice.reduce((a, b) => a + b, 0) / slice.length;
			const variance = slice.reduce((a, v) => a + (v - mean) ** 2, 0) / slice.length;
			rollingVol.push(Math.sqrt(variance));
		}

		if (rollingVol.length < 2) return null;

		const currentVol = rollingVol[rollingVol.length - 1];
		const percentile = this._getPercentile(currentVol, rollingVol);

		// Annualized volatility: 365 trading days for crypto (24/7), 252 for equities
		const tradingDaysPerYear = ohlcvData.assetClass === 'equity' ? 252 : 365;
		const annualized = round(currentVol * Math.sqrt(tradingDaysPerYear) * 100, 1);

		let interpretation;
		if (percentile > 0.9)
			interpretation = 'extreme volatility (top 10% historically)';
		else if (percentile > 0.75)
			interpretation = 'high volatility (above 75th percentile)';
		else if (percentile < 0.1)
			interpretation = 'extremely low volatility (bottom 10% — expansion likely)';
		else if (percentile < 0.25)
			interpretation = 'low volatility (below 25th percentile)';
		else
			interpretation = 'normal volatility range';

		return {
			current_annualized: `${annualized}%`,
			percentile: round(percentile, 2),
			interpretation,
			context: percentile < 0.15
				? 'vol compression often precedes large moves'
				: percentile > 0.85
					? 'elevated vol often mean-reverts'
					: null
		};
	}

	/**
	 * Calculate ATR
	 */
	_calculateATR(highs, lows, closes, period) {
		if (highs.length < period + 1) return null;

		// Calculate True Range
		const tr = [];
		for (let i = 1; i < highs.length; i++) {
			const highLow = highs[i] - lows[i];
			const highClose = Math.abs(highs[i] - closes[i - 1]);
			const lowClose = Math.abs(lows[i] - closes[i - 1]);
			tr[i] = Math.max(highLow, highClose, lowClose);
		}

		// Calculate ATR using RMA (Wilder's smoothing)
		const atr = [];
		let sum = 0;
		for (let i = 1; i <= period; i++) 
			sum += tr[i];
		
		atr[period] = sum / period;

		for (let i = period + 1; i < tr.length; i++) 
			atr[i] = (atr[i - 1] * (period - 1) + tr[i]) / period;

		return atr;
	}

	/**
	 * Detect ATR trend
	 */
	_detectATRTrend(atrValues) {
		if (atrValues.length < TREND_PERIODS.immediate) return 'insufficient data';

		const recent = atrValues.slice(-TREND_PERIODS.immediate);
		const first = recent[0];
		const last = recent[recent.length - 1];
		const change = ((last - first) / first) * 100;

		if (change > 10) 
			return 'expanding (breakout potential)';
		 else if (change < -10) 
			return 'contracting (consolidation)';
		 else if (Math.abs(change) < 3) 
			return 'stable';
		 else 
			return change > 0 ? 'slightly rising' : 'slightly falling';
		
	}

	/**
	 * Detect Bollinger Band squeeze
	 */
	_detectBBSqueeze(widthPercentile, bandwidthPercentile) {
		if (!widthPercentile || !bandwidthPercentile) 
			return { isSqueezing: false };

		// Squeeze = bandwidth in lowest 30% of recent readings
		if (bandwidthPercentile < 0.30) 
			return {
				isSqueezing: true,
				interpretation: 'narrow range (squeeze forming)',
				context: 'BB squeeze suggests imminent breakout',
				severity: bandwidthPercentile < 0.20 ? 'extreme' : 'moderate'
			};

		// Post-squeeze expansion
		if (widthPercentile > 0.70 && bandwidthPercentile > 0.70) 
			return {
				isSqueezing: false,
				interpretation: 'expanding (breakout in progress)',
				context: 'volatility expansion following squeeze'
			};

		return { isSqueezing: false };
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
	 * Format percentage
	 */
	_formatPercentage(value, reference) {
		const pct = ((value - reference) / reference) * 100;
		const sign = pct >= 0 ? '+' : '';
		return `${sign}${round(pct, 1)}%`;
	}
}

export default VolatilityEnricher;
