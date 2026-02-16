/**
 * Volume Enricher
 * Volume analysis, OBV, VWAP with pattern detection
 */

import { round } from '#utils/statisticalHelpers.js';
import { getBarCount } from '../config/barCounts.js';
import { STATISTICAL_PERIODS, VOLUME_PERIODS } from '../config/lookbackPeriods.js';

export class VolumeEnricher {
	constructor(options = {}) {
		this.logger = options.logger || console;
	}

	/**
	 * Enrich volume indicators
	 */
	async enrich({ ohlcvData, indicatorService, symbol, timeframe, referenceDate }) {
		const bars = ohlcvData.bars;

		// Get indicator series (in parallel)
		const [obvSeries, vwapSeries] = await Promise.all([
			this._getIndicatorSafe(indicatorService, symbol, 'obv', timeframe, referenceDate),
			this._getIndicatorSafe(indicatorService, symbol, 'vwap', timeframe, referenceDate),
		]);

		return {
			volume: this._enrichVolume(bars),
			obv: obvSeries ? this._enrichOBV(obvSeries, bars) : null,
			vwap: vwapSeries ? this._enrichVWAP(vwapSeries, bars) : null
		};
	}

	/**
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
	 * Enrich basic volume using z-score for distribution-aware anomaly detection
	 */
	_enrichVolume(bars) {
		const volumes = bars.map(b => b.volume);
		const currentVolume = volumes[volumes.length - 1];

		// Calculate average and standard deviation over lookback window
		const lookbackVolumes = volumes.slice(-STATISTICAL_PERIODS.medium);
		const avg = this._mean(lookbackVolumes);
		const stdDev = this._stdDev(lookbackVolumes);

		// Z-score: how many std deviations from mean (distribution-aware)
		const zScore = stdDev > 0 ? (currentVolume - avg) / stdDev : 0;

		// Simple ratio for display
		const ratio = avg > 0 ? currentVolume / avg : 0;

		// Z-score based interpretation (adapts to the asset's typical distribution)
		let interpretation;
		if (zScore > 3.0)
			interpretation = 'extreme volume anomaly (>3σ — climax or news event)';
		else if (zScore > 2.0)
			interpretation = 'very high volume (>2σ — significant institutional activity)';
		else if (zScore > 1.0)
			interpretation = 'above average volume (>1σ — good participation)';
		else if (zScore < -1.5)
			interpretation = 'unusually low volume (<-1.5σ — indecision/holiday)';
		else if (zScore < -0.5)
			interpretation = 'below average volume';
		else
			interpretation = 'normal volume';

		// Recent bars analysis
		const recentBars = this._analyzeRecentVolumeBars(bars.slice(-VOLUME_PERIODS.recentBars));

		// Context
		let context = null;
		if (zScore > 2.0)
			context = 'volume spike — watch for reversal or continuation confirmation';
		else if (zScore < -1.5)
			context = 'volume drought — typical during consolidation, breakout may follow';

		return {
			current: round(currentVolume, 0),
			vs_avg_50: `${ratio > 1 ? '+' : ''}${round((ratio - 1) * 100, 0)}% (${ratio > 1 ? 'above' : 'below'} average)`,
			z_score: round(zScore, 2),
			interpretation,
			recent_bars: recentBars,
			context
		};
	}

	/**
	 * Analyze recent volume bars
	 */
	_analyzeRecentVolumeBars(bars) {
		const analysis = [];
		
		for (let i = 0; i < Math.min(3, bars.length); i++) {
			const bar = bars[bars.length - 1 - i];
			const type = bar.close > bar.open ? 'bullish' : bar.close < bar.open ? 'bearish' : 'neutral';
			
			analysis.push({
				bars_ago: i,
				volume: round(bar.volume, 0),
				type
			});
		}

		return analysis;
	}

	/**
	 * Enrich OBV
	 */
	_enrichOBV(obvSeries, bars) {
		const obvValues = obvSeries.data.map(d => d.value);
		const currentOBV = obvValues[obvValues.length - 1];

		// Detect trend
		const trend = this._detectOBVTrend(obvValues.slice(-VOLUME_PERIODS.obvTrend));

		// Calculate percentile
		const percentile50d = this._getPercentile(currentOBV, obvValues.slice(-STATISTICAL_PERIODS.medium));

		// Divergence with price
		const prices = bars.slice(-VOLUME_PERIODS.obvTrend).map(b => b.close);
		const divergence = this._detectOBVDivergence(obvValues.slice(-VOLUME_PERIODS.divergence), prices.slice(-VOLUME_PERIODS.divergence));

		// Interpretation
		let interpretation;
		if (trend.direction === 'rising strongly') 
			interpretation = 'volume supporting the uptrend';
		 else if (trend.direction === 'declining strongly') 
			interpretation = 'volume supporting the downtrend';
		 else if (trend.direction === 'rising') 
			interpretation = 'accumulation phase';
		 else if (trend.direction === 'declining') 
			interpretation = 'distribution phase';
		 else 
			interpretation = 'neutral accumulation/distribution';

		return {
			value: round(currentOBV, 0),
			trend: trend.description,
			percentile_50d: round(percentile50d, 2),
			divergence,
			interpretation
		};
	}

	/**
	 * Detect OBV trend
	 */
	_detectOBVTrend(obvValues) {
		if (obvValues.length < 5) 
			return { direction: 'unknown', description: 'insufficient data' };

		const first = obvValues[0];
		const last = obvValues[obvValues.length - 1];
		const change = ((last - first) / Math.abs(first)) * 100;

		let direction, description;
		
		if (change > 5) {
			direction = 'rising strongly';
			description = 'rising strongly';
		} else if (change > 2) {
			direction = 'rising';
			description = 'rising';
		} else if (change < -5) {
			direction = 'declining strongly';
			description = 'declining strongly';
		} else if (change < -2) {
			direction = 'declining';
			description = 'declining';
		} else {
			direction = 'flat';
			description = 'flat';
		}

		return { direction, description };
	}

	/**
	 * Detect OBV divergence with price
	 */
	_detectOBVDivergence(obvValues, priceValues) {
		if (obvValues.length < 10 || priceValues.length < 10) 
			return 'insufficient data';

		// Compare trends
		const obvTrend = obvValues[obvValues.length - 1] - obvValues[0];
		const priceTrend = priceValues[priceValues.length - 1] - priceValues[0];

		if (obvTrend > 0 && priceTrend < 0) 
			return 'bullish divergence (price down, OBV up)';
		 else if (obvTrend < 0 && priceTrend > 0) 
			return 'bearish divergence (price up, OBV down)';
		 else if ((obvTrend > 0 && priceTrend > 0) || (obvTrend < 0 && priceTrend < 0)) 
			return 'none (confirming price move)';

		return 'none';
	}

	/**
	 * Enrich VWAP
	 */
	_enrichVWAP(vwapSeries, bars) {
		const vwapValues = vwapSeries.data.map(d => d.value);
		const currentVWAP = vwapValues[vwapValues.length - 1];
		const currentPrice = bars[bars.length - 1].close;

		// Price vs VWAP
		const diff = ((currentPrice - currentVWAP) / currentVWAP) * 100;
		const sign = diff >= 0 ? '+' : '';

		// Interpretation
		let interpretation;
		if (diff > 1) 
			interpretation = 'price well above VWAP (strong institutional buying)';
		 else if (diff > 0.3) 
			interpretation = 'price above VWAP (institutional support)';
		 else if (diff < -1) 
			interpretation = 'price well below VWAP (institutional selling)';
		 else if (diff < -0.3) 
			interpretation = 'price below VWAP (institutional resistance)';
		 else 
			interpretation = 'price near VWAP (fair value)';

		// Support/resistance
		let sr_role;
		if (currentPrice > currentVWAP) 
			sr_role = 'VWAP acting as support';
		 else 
			sr_role = 'VWAP acting as resistance';

		return {
			value: round(currentVWAP, 0),
			price_vs_vwap: `${sign}${round(diff, 2)}%`,
			interpretation,
			sr_role
		};
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
	 * Calculate standard deviation
	 */
	_stdDev(values) {
		const mean = this._mean(values);
		const variance = values.reduce((sum, v) => sum + (v - mean) ** 2, 0) / values.length;
		return Math.sqrt(variance);
	}
}

export default VolumeEnricher;
