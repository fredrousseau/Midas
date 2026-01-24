/**
 * Price Action Enricher
 * Candle patterns, structure analysis, swing points, support/resistance
 */

import { round } from '#utils/statisticalHelpers.js';
import { STATISTICAL_PERIODS, TREND_PERIODS, PATTERN_PERIODS, SUPPORT_RESISTANCE_PERIODS } from '../config/lookbackPeriods.js';

export class PriceActionEnricher {
	constructor(options = {}) {
		this.logger = options.logger || console;
	}

	/**
	 * Enrich price action
	 */
	enrich({ ohlcvData, currentPrice }) {
		const bars = ohlcvData.bars;
		const currentBar = bars[bars.length - 1];

		return {
			current: currentPrice,
			open: currentBar.open,
			high: currentBar.high,
			low: currentBar.low,

			// Bar analysis
			bar_type: this._getBarType(currentBar),
			body_to_range: this._getBodyToRange(currentBar),

			// Wick analysis
			wick_analysis: this._analyzeWicks(currentBar),

			// Structure
			recent_structure: this._analyzeStructure(bars.slice(-STATISTICAL_PERIODS.short)),

			// Candle patterns
			candle_patterns: this._detectCandlePatterns(bars.slice(-TREND_PERIODS.immediate)),

			// Swing points
			swing_points: this._identifySwingPoints(bars.slice(-SUPPORT_RESISTANCE_PERIODS.lookback)),

			// Range analysis
			range_24h: this._analyzeRange(bars.slice(-PATTERN_PERIODS.range24h)),

			// Micro structure
			micro_structure: this._analyzeMicroStructure(bars.slice(-PATTERN_PERIODS.microPattern)),

			// Breakout levels
			breakout_levels: this._identifyBreakoutLevels(bars.slice(-STATISTICAL_PERIODS.short), currentPrice)
		};
	}

	/**
	 * Get bar type
	 */
	_getBarType(bar) {
		const { open, high, low, close } = bar;
		const body = Math.abs(close - open);
		const range = high - low;
		
		if (range === 0) return 'flat';
		
		const bodyRatio = body / range;
		
		// Doji
		if (bodyRatio < 0.1) return 'doji';
		
		// Strong directional
		if (bodyRatio > 0.7) {
			if (close > open) return 'strong bullish';
			return 'strong bearish';
		}
		
		// Engulfing check (needs previous bar, simplified here)
		if (bodyRatio > 0.6) {
			if (close > open) return 'bullish engulfing';
			return 'bearish engulfing';
		}
		
		// Regular
		if (close > open) return 'bullish';
		if (close < open) return 'bearish';
		return 'neutral';
	}

	/**
	 * Get body to range ratio
	 */
	_getBodyToRange(bar) {
		const body = Math.abs(bar.close - bar.open);
		const range = bar.high - bar.low;
		
		if (range === 0) return 0;
		return round(body / range, 2);
	}

	/**
	 * Analyze wicks
	 */
	_analyzeWicks(bar) {
		const { open, high, low, close } = bar;
		const range = high - low;
		
		if (range === 0) 
			return {
				upper_wick_pct: 0,
				lower_wick_pct: 0,
				interpretation: 'no range'
			};
		
		const upperWick = high - Math.max(open, close);
		const lowerWick = Math.min(open, close) - low;
		
		const upperPct = (upperWick / range) * 100;
		const lowerPct = (lowerWick / range) * 100;
		
		// Interpretation
		let interpretation;
		if (lowerPct > 40) 
			interpretation = 'rejection from lows (buyers defending)';
		 else if (upperPct > 40) 
			interpretation = 'rejection from highs (sellers defending)';
		 else if (upperPct < 10 && lowerPct < 10) 
			interpretation = 'strong directional move';
		 else if (upperPct > 25 && lowerPct > 25) 
			interpretation = 'indecision (long wicks both sides)';
		 else 
			interpretation = 'balanced';
		
		return {
			upper_wick_pct: `${round(upperPct, 0)}%`,
			lower_wick_pct: `${round(lowerPct, 0)}%`,
			interpretation
		};
	}

	/**
	 * Analyze structure (HH, HL, LH, LL)
	 */
	_analyzeStructure(bars) {
		let higherHighs = 0, higherLows = 0, lowerHighs = 0, lowerLows = 0;

		for (let i = 1; i < bars.length; i++) {
			if (bars[i].high > bars[i - 1].high) higherHighs++;
			if (bars[i].high < bars[i - 1].high) lowerHighs++;
			if (bars[i].low > bars[i - 1].low) higherLows++;
			if (bars[i].low < bars[i - 1].low) lowerLows++;
		}

		// Determine pattern
		let pattern, interpretation;
		
		if (higherHighs > lowerHighs * 1.5 && higherLows > lowerLows * 1.5) {
			pattern = 'strong uptrend';
			interpretation = 'consistent uptrend structure';
		} else if (higherHighs > lowerHighs && higherLows > lowerLows) {
			pattern = 'uptrend';
			interpretation = 'bullish structure';
		} else if (lowerHighs > higherHighs * 1.5 && lowerLows > higherLows * 1.5) {
			pattern = 'strong downtrend';
			interpretation = 'consistent downtrend structure';
		} else if (lowerHighs > higherHighs && lowerLows > higherLows) {
			pattern = 'downtrend';
			interpretation = 'bearish structure';
		} else {
			pattern = 'range/consolidation';
			interpretation = 'no clear trend';
		}

		return {
			higher_highs: higherHighs,
			higher_lows: higherLows,
			lower_highs: lowerHighs,
			lower_lows: lowerLows,
			pattern,
			interpretation
		};
	}

	/**
	 * Detect candle patterns
	 */
	_detectCandlePatterns(bars) {
		if (bars.length < 2) return [];
		
		const patterns = [];
		const current = bars[bars.length - 1];
		const previous = bars[bars.length - 2];

		// Doji
		const bodyRatio = Math.abs(current.close - current.open) / (current.high - current.low);
		if (bodyRatio < 0.1 && (current.high - current.low) > 0) 
			patterns.push({
				name: 'doji',
				bars_ago: 0,
				reliability: 'medium',
				context: 'indecision'
			});

		// Engulfing
		const currentBody = Math.abs(current.close - current.open);
		const previousBody = Math.abs(previous.close - previous.open);
		
		if (currentBody > previousBody * 1.5) 
			if (current.close > current.open && previous.close < previous.open) 
				patterns.push({
					name: 'bullish engulfing',
					bars_ago: 0,
					reliability: 'high',
					context: 'reversal signal'
				});
			 else if (current.close < current.open && previous.close > previous.open) 
				patterns.push({
					name: 'bearish engulfing',
					bars_ago: 0,
					reliability: 'high',
					context: 'reversal signal'
				});

		// Hammer / Shooting star
		const range = current.high - current.low;
		const upperWick = current.high - Math.max(current.open, current.close);
		const lowerWick = Math.min(current.open, current.close) - current.low;
		
		if (lowerWick > range * 0.6 && currentBody < range * 0.3) 
			patterns.push({
				name: 'hammer',
				bars_ago: 0,
				reliability: 'medium',
				context: 'potential reversal up'
			});
		
		if (upperWick > range * 0.6 && currentBody < range * 0.3) 
			patterns.push({
				name: 'shooting star',
				bars_ago: 0,
				reliability: 'medium',
				context: 'potential reversal down'
			});

		return patterns.length > 0 ? patterns : null;
	}

	/**
	 * Identify swing points
	 */
	_identifySwingPoints(bars) {
		if (bars.length < 5) return null;
		
		// Find recent high and low
		let recentHigh = bars[0].high;
		let recentLow = bars[0].low;
		let highIndex = 0;
		let lowIndex = 0;

		for (let i = 1; i < Math.min(bars.length, STATISTICAL_PERIODS.short); i++) {
			if (bars[i].high > recentHigh) {
				recentHigh = bars[i].high;
				highIndex = i;
			}
			if (bars[i].low < recentLow) {
				recentLow = bars[i].low;
				lowIndex = i;
			}
		}

		const swingRange = recentHigh - recentLow;

		return {
			recent_high: round(recentHigh, 0),
			recent_low: round(recentLow, 0),
			swing_range: round(swingRange, 0),
			high_bars_ago: bars.length - 1 - highIndex,
			low_bars_ago: bars.length - 1 - lowIndex
		};
	}

	/**
	 * Analyze range
	 */
	_analyzeRange(bars) {
		if (!bars || bars.length === 0) return null;
		
		const high24h = Math.max(...bars.map(b => b.high));
		const low24h = Math.min(...bars.map(b => b.low));
		const range = high24h - low24h;
		const currentPrice = bars[bars.length - 1].close;
		
		// Position in range
		const position = ((currentPrice - low24h) / range) * 100;

		return `${round(low24h, 0)}-${round(high24h, 0)} (${round(range, 0)} points)`;
	}

	/**
	 * Analyze micro structure
	 */
	_analyzeMicroStructure(bars) {
		if (bars.length < 5) return 'insufficient data';
		
		// Find key levels with multiple touches
		const levels = this._findKeyLevels(bars);
		
		if (levels.resistance && levels.support) {
			const touchesText = `${levels.resistance.touches} touches of ${round(levels.resistance.level, 0)}, ${levels.support.touches} touches of ${round(levels.support.level, 0)}`;
			return `range-bound (${touchesText})`;
		}
		
		// Check for trending
		const firstClose = bars[0].close;
		const lastClose = bars[bars.length - 1].close;
		const change = ((lastClose - firstClose) / firstClose) * 100;
		
		if (change > 2) return 'trending up';
		if (change < -2) return 'trending down';
		return 'consolidating';
	}

	/**
	 * Find key levels with multiple touches
	 */
	_findKeyLevels(bars) {
		const tolerance = 0.002; // 0.2% tolerance for level matching
		
		// Collect highs and lows
		const highs = bars.map(b => b.high);
		const lows = bars.map(b => b.low);
		
		// Find most touched resistance
		const resistanceLevels = this._groupLevels(highs, tolerance);
		const supportLevels = this._groupLevels(lows, tolerance);
		
		return {
			resistance: resistanceLevels[0] || null,
			support: supportLevels[0] || null
		};
	}

	/**
	 * Group levels by proximity
	 */
	_groupLevels(values, tolerance) {
		const groups = [];
		
		for (const value of values) {
			let foundGroup = false;
			
			for (const group of groups) {
				const avgLevel = group.sum / group.count;
				if (Math.abs(value - avgLevel) / avgLevel < tolerance) {
					group.sum += value;
					group.count++;
					foundGroup = true;
					break;
				}
			}
			
			if (!foundGroup) 
				groups.push({ sum: value, count: 1 });
			
		}
		
		// Convert to levels with touches
		const levels = groups
			.filter(g => g.count >= 2)
			.map(g => ({
				level: g.sum / g.count,
				touches: g.count
			}))
			.sort((a, b) => b.touches - a.touches);
		
		return levels;
	}

	/**
	 * Identify breakout levels
	 */
	_identifyBreakoutLevels(bars, currentPrice) {
		if (bars.length < PATTERN_PERIODS.microPattern) return null;

		const highs = bars.map(b => b.high);
		const lows = bars.map(b => b.low);

		// Recent high/low (last 10 bars)
		const recentHigh = Math.max(...highs.slice(-PATTERN_PERIODS.microPattern));
		const recentLow = Math.min(...lows.slice(-PATTERN_PERIODS.microPattern));
		
		return {
			upside: round(recentHigh, 0),
			downside: round(recentLow, 0),
			current_position: currentPrice > (recentHigh + recentLow) / 2 ? 'upper half' : 'lower half'
		};
	}
}

export default PriceActionEnricher;
