/**
 * Backtesting Service - SIMPLE VERSION
 *
 * Simple loop that iterates through each interval and calls the analysis API.
 * No complex warmup, no filtering - just raw analysis results for each timestamp.
 *
 * Input: symbol, startDate, endDate, interval (1h, 4h, 1d)
 * Output: Table with timestamp, price, direction, action, confidence, quality, alignment, phase, regime, rsi, scenarios
 */

import { timeframeToMs } from '../../Utils/timeframe.js';

export class BacktestingService {
	constructor(options = {}) {
		this.logger = options.logger || console;
		this.marketAnalysisService = options.marketAnalysisService;

		if (!this.marketAnalysisService) throw new Error('BacktestingService requires marketAnalysisService');

		this.logger.info('BacktestingService initialized (simple loop version)');
	}

	/**
	 * Run backtest - simple loop version
	 *
	 * @param {Object} params
	 * @param {string} params.symbol - Trading pair (e.g., 'BTCUSDT')
	 * @param {Date} params.startDate - Backtest start date
	 * @param {Date} params.endDate - Backtest end date
	 * @param {string} params.interval - Interval between analyses (1h, 4h, 1d)
	 * @returns {Object} Results table
	 */
	async runBacktest(params) {
		const { symbol, startDate, endDate, interval = '1h' } = params;

		// Validate dates
		const start = new Date(startDate);
		const end = new Date(endDate);

		if (isNaN(start.getTime()) || isNaN(end.getTime())) throw new Error('Invalid dates provided');

		if (start >= end) throw new Error('Start date must be before end date');

		// Validate interval
		const validIntervals = ['1h', '4h', '1d'];
		if (!validIntervals.includes(interval)) throw new Error(`Invalid interval: ${interval}. Must be one of: ${validIntervals.join(', ')}`);

		// Calculate period
		const periodMs = end - start;
		const periodDays = periodMs / (1000 * 60 * 60 * 24);

		// Limit backtest period
		const MAX_DAYS = 90;
		if (periodDays > MAX_DAYS) throw new Error(`Backtest period too long: ${periodDays.toFixed(1)} days. Maximum: ${MAX_DAYS} days.`);

		const intervalMs = timeframeToMs(interval);
		const expectedIntervals = Math.ceil(periodMs / intervalMs);

		this.logger.info(`Starting backtest for ${symbol}`);
		this.logger.info(`Period: ${start.toISOString()} to ${end.toISOString()} (${periodDays.toFixed(1)} days)`);
		this.logger.info(`Interval: ${interval} (~${expectedIntervals} analysis calls)`);

		// Fixed timeframes for multi-timeframe analysis
		const timeframes = { short: '1h', medium: '4h', long: '1d' };

		const results = [];
		let currentDate = new Date(start);
		let processed = 0;

		// Simple loop through each interval
		while (currentDate <= end) {
			processed++;

			// Progress log every 10 intervals
			if (processed % 10 === 0 || processed === 1) this.logger.info(`Processing ${processed}/${expectedIntervals}: ${currentDate.toISOString()}`);

			try {
				// Call analysis API
				const analysis = await this.marketAnalysisService.generateCompleteAnalysis({
					symbol,
					timeframes,
					analysisDate: currentDate,
				});

				// Extract key data
				const tradingContext = analysis.trading_context || {};
				const mtfAlignment = analysis.multi_timeframe_alignment || {};
				const scenarios = tradingContext.scenario_analysis || {};
				const shortTF = analysis.statistical_context?.timeframes?.short || {};

				results.push({
					timestamp: currentDate.toISOString(),
					price: this._extractCurrentPrice(analysis),
					direction: mtfAlignment.dominant_direction || 'neutral',
					action: tradingContext.recommended_action || 'N/A',
					confidence: tradingContext.confidence || 0,
					quality: tradingContext.trade_quality_score?.overall || 0,
					alignment: mtfAlignment.alignment_score || 0,
					phase: tradingContext.current_market_phase || 'unknown',
					regime: shortTF.regime?.type || 'unknown',
					rsi: shortTF.momentum_indicators?.rsi?.value || null,
					scenarios: {
						bullish: scenarios.bullish_scenario?.probability || 0,
						bearish: scenarios.bearish_scenario?.probability || 0,
						neutral: scenarios.neutral_scenario?.probability || 0,
					},
				});
			} catch (error) {
				this.logger.warn(`Analysis failed at ${currentDate.toISOString()}: ${error.message}`);

				// Still record the timestamp with error
				results.push({
					timestamp: currentDate.toISOString(),
					price: null,
					direction: 'error',
					action: 'ERROR',
					confidence: 0,
					quality: 0,
					alignment: 0,
					phase: 'error',
					regime: 'error',
					rsi: null,
					scenarios: { bullish: 0, bearish: 0, neutral: 0 },
					error: error.message,
				});
			}

			// Move to next interval
			currentDate = new Date(currentDate.getTime() + intervalMs);
		}

		this.logger.info(`Backtest complete: ${results.length} intervals processed`);

		return {
			symbol,
			interval,
			period: {
				start: start.toISOString(),
				end: end.toISOString(),
				days: periodDays,
			},
			total_intervals: results.length,
			results,
		};
	}

	/**
	 * Extract current price from analysis
	 * @private
	 */
	_extractCurrentPrice(analysis) {
		// Try timeframes in statistical context (short > medium > long)
		const timeframes = analysis.statistical_context?.timeframes;
		if (timeframes) {
			if (timeframes.short?.price_action?.current) return timeframes.short.price_action.current;
			if (timeframes.medium?.price_action?.current) return timeframes.medium.price_action.current;
			if (timeframes.long?.price_action?.current) return timeframes.long.price_action.current;
		}

		return null;
	}
}
