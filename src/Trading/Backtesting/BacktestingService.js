/**
 * Backtesting Service
 *
 * Analyzes historical market data to generate entry/exit signals and evaluate
 * trading strategy performance over a specified time period.
 *
 * Features:
 * - Historical market analysis replay
 * - Entry/exit signal detection
 * - Performance metrics calculation
 * - Parameter optimization support
 * - Trade-by-trade breakdown
 */

import { timeframeToMs } from '../../Utils/timeframe.js';

export class BacktestingService {
	constructor(options = {}) {
		this.logger = options.logger || console;
		this.marketDataService = options.marketDataService;
		this.marketAnalysisService = options.marketAnalysisService;

		if (!this.marketDataService) throw new Error('BacktestingService requires marketDataService');

		if (!this.marketAnalysisService) throw new Error('BacktestingService requires marketAnalysisService');

		this.logger.info('BacktestingService initialized');
	}

	/**
	 * Run backtest over a historical period
	 *
	 * @param {Object} params - Backtest parameters
	 * @param {string} params.symbol - Trading symbol (e.g., 'BTCUSDT')
	 * @param {Date} params.startDate - Start date of backtest period
	 * @param {Date} params.endDate - End date of backtest period
	 * @param {string} params.timeframe - Primary timeframe for analysis (e.g., '1h')
	 * @param {Object} params.strategy - Strategy configuration (optional)
	 * @param {Object} params.parameters - Custom parameters for testing (optional)
	 * @returns {Object} Backtest results with signals and performance metrics
	 */
	async runBacktest(params) {
		const { symbol, startDate, endDate, timeframe = '1h', strategy = {}, parameters = {} } = params;

		this.logger.info(`Starting backtest for ${symbol} from ${startDate.toISOString()} to ${endDate.toISOString()}`);

		// Step 1: Get historical candles for the period
		const candles = await this._getHistoricalCandles(symbol, timeframe, startDate, endDate);

		if (!candles || candles.length === 0) throw new Error(`No historical data available for ${symbol} on ${timeframe} between ${startDate} and ${endDate}`);

		this.logger.info(`Retrieved ${candles.length} candles for analysis`);

		// Step 2: Iterate through each candle and generate signals
		const signals = [];
		const analysisResults = [];

		for (let i = 0; i < candles.length; i++) {
			const candle = candles[i];
			const analysisDate = new Date(candle.timestamp);

			// Skip if we don't have enough historical data for indicators
			// (typically need ~200 bars before first analysis)
			const progressPct = (((i + 1) / candles.length) * 100).toFixed(1);

			if (i % 100 === 0) this.logger.info(`Backtesting progress: ${i + 1}/${candles.length} (${progressPct}%)`);

			try {
				// Generate complete market analysis at this point in time
				// Use generateCompleteAnalysis which includes trading_context
				const analysis = await this.marketAnalysisService.generateCompleteAnalysis({
					symbol,
					timeframes: this._getTimeframesForBacktest(timeframe),
					analysisDate,
				});

				// Extract trading context (entry/exit signals)
				const tradingContext = analysis.trading_context;

				// Detect entry/exit signals
				const signal = this._detectSignal(tradingContext, candle, strategy);

				if (signal)
					signals.push({
						timestamp: analysisDate,
						...signal,
					});

				// Store analysis result
				analysisResults.push({
					timestamp: analysisDate,
					price: candle.close,
					analysis: {
						market_phase: tradingContext.current_market_phase,
						recommended_action: tradingContext.recommended_action,
						confidence: tradingContext.confidence,
						trade_quality_score: tradingContext.trade_quality_score,
					},
				});
			} catch (error) {
				this.logger.warn(`Analysis failed at ${analysisDate.toISOString()}: ${error.message}`);
				// Continue with next candle
			}
		}

		this.logger.info(`Backtest complete: Generated ${signals.length} signals from ${candles.length} candles`);

		// Step 3: Simulate trades and calculate performance
		const trades = this._simulateTrades(signals, candles);
		const performance = this._calculatePerformance(trades, candles[0].close, candles[candles.length - 1].close);

		return {
			summary: {
				symbol,
				timeframe,
				period: {
					start: startDate,
					end: endDate,
					duration_days: Math.ceil((endDate - startDate) / (1000 * 60 * 60 * 24)),
				},
				candles_analyzed: candles.length,
				signals_generated: signals.length,
				trades_executed: trades.length,
			},
			signals,
			trades,
			performance,
			analysis_results: analysisResults,
		};
	}

	/**
	 * Get historical candles for the backtest period
	 * Uses MarketDataService which handles DataProvider caching
	 */
	async _getHistoricalCandles(symbol, timeframe, startDate, endDate) {
		// Calculate how many candles we need
		const timeframeMs = timeframeToMs(timeframe);
		const periodMs = endDate - startDate;
		const estimatedCandles = Math.ceil(periodMs / timeframeMs);

		this.logger.info(`Fetching ~${estimatedCandles} candles for ${timeframe} timeframe`);

		// Get OHLCV data using MarketDataService
		// This goes through DataProvider which handles Redis caching
		const ohlcvData = await this.marketDataService.loadOHLCV({
			symbol,
			timeframe,
			count: estimatedCandles + 100, // Extra margin for warmup
			to: endDate.getTime(), // Convert Date to timestamp in milliseconds
		});

		if (!ohlcvData || !ohlcvData.data || ohlcvData.data.length === 0) throw new Error('No OHLCV data returned from market data service');

		// MarketDataService returns { data: [...], bars: undefined }
		// Each data item has { timestamp, values: { open, high, low, close, volume } }
		// We need to convert to flat structure for backtesting
		const bars = ohlcvData.data.map((bar) => ({
			timestamp: bar.timestamp,
			open: bar.values.open,
			high: bar.values.high,
			low: bar.values.low,
			close: bar.values.close,
			volume: bar.values.volume,
		}));

		// Filter candles to exact date range
		const filteredCandles = bars.filter((candle) => {
			const candleDate = new Date(candle.timestamp);
			return candleDate >= startDate && candleDate <= endDate;
		});

		return filteredCandles;
	}

	/**
	 * Get appropriate timeframes for backtest based on primary timeframe
	 * Returns object with long/medium/short keys as expected by MarketAnalysisService
	 */
	_getTimeframesForBacktest(primaryTimeframe) {
		// Map primary timeframe to multi-timeframe setup
		// Format: { short: primary, medium: 1 level up, long: 2 levels up }
		const timeframeMaps = {
			'5m': { short: '5m', medium: '15m', long: '1h' },
			'15m': { short: '15m', medium: '1h', long: '4h' },
			'30m': { short: '30m', medium: '1h', long: '4h' },
			'1h': { short: '1h', medium: '4h', long: '1d' },
			'4h': { short: '4h', medium: '1d', long: '1w' },
			'1d': { short: '1d', medium: '1w', long: '1M' },
		};

		return timeframeMaps[primaryTimeframe] || { short: primaryTimeframe, medium: primaryTimeframe, long: primaryTimeframe };
	}

	/**
	 * Detect entry/exit signal from trading context
	 * Uses stop_loss and targets calculated by TradingContextService for consistency
	 */
	_detectSignal(tradingContext, candle, strategy) {
		const { recommended_action, confidence, trade_quality_score, optimal_entry_strategy, scenario_analysis } = tradingContext;

		// Extract scenarios from scenario_analysis
		const bullish_scenario = scenario_analysis?.bullish_scenario;
		const bearish_scenario = scenario_analysis?.bearish_scenario;

		// Strategy filters (customizable)
		const minConfidence = strategy.minConfidence || 0.6;
		const minQualityScore = strategy.minQualityScore || 60;

		// Entry signals - LONG
		if (recommended_action === 'LONG' && confidence >= minConfidence && trade_quality_score.total >= minQualityScore) {
			// Use stop_loss and targets from TradingContextService for consistency
			const stopLoss = bullish_scenario?.stop_loss?.price || candle.close * 0.97; // 3% fallback
			const takeProfit = bullish_scenario?.targets?.[0]?.price || candle.close * 1.06; // 6% fallback

			return {
				type: 'ENTRY',
				direction: 'LONG',
				price: candle.close,
				confidence,
				quality_score: trade_quality_score.total,
				strategy: optimal_entry_strategy?.bullish || 'breakout',
				stop_loss: stopLoss,
				take_profit: takeProfit,
				stop_loss_basis: bullish_scenario?.stop_loss?.basis || 'default',
				take_profit_basis: bullish_scenario?.targets?.[0]?.basis || 'default',
			};
		}

		// Entry signals - SHORT
		if (recommended_action === 'SHORT' && confidence >= minConfidence && trade_quality_score.total >= minQualityScore) {
			// Use stop_loss and targets from TradingContextService for consistency
			const stopLoss = bearish_scenario?.stop_loss?.price || candle.close * 1.03; // 3% fallback
			const takeProfit = bearish_scenario?.targets?.[0]?.price || candle.close * 0.94; // 6% fallback

			return {
				type: 'ENTRY',
				direction: 'SHORT',
				price: candle.close,
				confidence,
				quality_score: trade_quality_score.total,
				strategy: optimal_entry_strategy?.bearish || 'breakdown',
				stop_loss: stopLoss,
				take_profit: takeProfit,
				stop_loss_basis: bearish_scenario?.stop_loss?.basis || 'default',
				take_profit_basis: bearish_scenario?.targets?.[0]?.basis || 'default',
			};
		}

		// Exit signal (risk warnings, phase changes)
		if (recommended_action === 'AVOID' || recommended_action === 'WAIT')
			return {
				type: 'EXIT',
				price: candle.close,
				reason: recommended_action,
				confidence,
			};

		return null;
	}

	/**
	 * Simulate trades from signals
	 * Checks for stop_loss and take_profit hits on each candle
	 */
	_simulateTrades(signals, candles) {
		const trades = [];
		let currentTrade = null;
		let currentCandleIndex = 0;

		for (const signal of signals) {
			if (signal.type === 'ENTRY' && !currentTrade) {
				// Open new trade
				currentTrade = {
					entry_time: signal.timestamp,
					entry_price: signal.price,
					direction: signal.direction,
					stop_loss: signal.stop_loss,
					take_profit: signal.take_profit,
					confidence: signal.confidence,
					quality_score: signal.quality_score,
				};

				// Find the candle index for this entry
				currentCandleIndex = candles.findIndex(c => c.timestamp >= signal.timestamp);

			} else if (signal.type === 'EXIT' && currentTrade) {
				// Explicit exit signal
				const exitCandle = candles.find(c => c.timestamp >= signal.timestamp);
				if (exitCandle) {
					currentTrade.exit_time = signal.timestamp;
					currentTrade.exit_price = signal.price;
					currentTrade.exit_reason = signal.reason;

					const pnl = currentTrade.direction === 'LONG'
						? currentTrade.exit_price - currentTrade.entry_price
						: currentTrade.entry_price - currentTrade.exit_price;

					currentTrade.pnl = pnl;
					currentTrade.pnl_percent = (pnl / currentTrade.entry_price) * 100;
					currentTrade.result = pnl > 0 ? 'WIN' : pnl < 0 ? 'LOSS' : 'BREAKEVEN';

					trades.push(currentTrade);
					currentTrade = null;
				}
			}

			// Check for stop_loss or take_profit hit on subsequent candles
			if (currentTrade) {
				const nextSignalIndex = signals.indexOf(signal) + 1;
				const nextSignalTime = nextSignalIndex < signals.length
					? signals[nextSignalIndex].timestamp
					: new Date(Date.now() + 999999999999);

				for (let i = currentCandleIndex + 1; i < candles.length; i++) {
					const candle = candles[i];

					// Stop checking if we reach the next signal
					if (candle.timestamp >= nextSignalTime) break;

					// Check stop loss hit
					if (currentTrade.direction === 'LONG' && candle.low <= currentTrade.stop_loss) {
						currentTrade.exit_time = new Date(candle.timestamp);
						currentTrade.exit_price = currentTrade.stop_loss;
						currentTrade.exit_reason = 'stop_loss';

						const pnl = currentTrade.exit_price - currentTrade.entry_price;
						currentTrade.pnl = pnl;
						currentTrade.pnl_percent = (pnl / currentTrade.entry_price) * 100;
						currentTrade.result = 'LOSS';

						trades.push(currentTrade);
						currentTrade = null;
						break;
					}

					if (currentTrade && currentTrade.direction === 'SHORT' && candle.high >= currentTrade.stop_loss) {
						currentTrade.exit_time = new Date(candle.timestamp);
						currentTrade.exit_price = currentTrade.stop_loss;
						currentTrade.exit_reason = 'stop_loss';

						const pnl = currentTrade.entry_price - currentTrade.exit_price;
						currentTrade.pnl = pnl;
						currentTrade.pnl_percent = (pnl / currentTrade.entry_price) * 100;
						currentTrade.result = 'LOSS';

						trades.push(currentTrade);
						currentTrade = null;
						break;
					}

					// Check take profit hit
					if (currentTrade && currentTrade.direction === 'LONG' && candle.high >= currentTrade.take_profit) {
						currentTrade.exit_time = new Date(candle.timestamp);
						currentTrade.exit_price = currentTrade.take_profit;
						currentTrade.exit_reason = 'take_profit';

						const pnl = currentTrade.exit_price - currentTrade.entry_price;
						currentTrade.pnl = pnl;
						currentTrade.pnl_percent = (pnl / currentTrade.entry_price) * 100;
						currentTrade.result = 'WIN';

						trades.push(currentTrade);
						currentTrade = null;
						break;
					}

					if (currentTrade && currentTrade.direction === 'SHORT' && candle.low <= currentTrade.take_profit) {
						currentTrade.exit_time = new Date(candle.timestamp);
						currentTrade.exit_price = currentTrade.take_profit;
						currentTrade.exit_reason = 'take_profit';

						const pnl = currentTrade.entry_price - currentTrade.exit_price;
						currentTrade.pnl = pnl;
						currentTrade.pnl_percent = (pnl / currentTrade.entry_price) * 100;
						currentTrade.result = 'WIN';

						trades.push(currentTrade);
						currentTrade = null;
						break;
					}
				}
			}
		}

		// Close any open trade at end of period
		if (currentTrade && candles.length > 0) {
			const lastCandle = candles[candles.length - 1];
			currentTrade.exit_time = new Date(lastCandle.timestamp);
			currentTrade.exit_price = lastCandle.close;
			currentTrade.exit_reason = 'end_of_period';

			const pnl = currentTrade.direction === 'LONG'
				? currentTrade.exit_price - currentTrade.entry_price
				: currentTrade.entry_price - currentTrade.exit_price;

			currentTrade.pnl = pnl;
			currentTrade.pnl_percent = (pnl / currentTrade.entry_price) * 100;
			currentTrade.result = pnl > 0 ? 'WIN' : pnl < 0 ? 'LOSS' : 'BREAKEVEN';

			trades.push(currentTrade);
		}

		return trades;
	}

	/**
	 * Calculate performance metrics
	 */
	_calculatePerformance(trades, initialPrice, finalPrice) {
		const buyAndHoldPnl = ((finalPrice - initialPrice) / initialPrice) * 100;

		if (trades.length === 0)
			return {
				total_trades: 0,
				winning_trades: 0,
				losing_trades: 0,
				win_rate: 0,
				total_pnl: 0,
				total_pnl_percent: 0,
				average_win: 0,
				average_loss: 0,
				profit_factor: 0,
				sharpe_ratio: 0,
				max_drawdown: 0,
				buy_and_hold_pnl_percent: buyAndHoldPnl,
				strategy_vs_hold: 0 - buyAndHoldPnl,
			};

		// Basic metrics
		const winningTrades = trades.filter((t) => t.result === 'WIN');
		const losingTrades = trades.filter((t) => t.result === 'LOSS');

		const totalPnl = trades.reduce((sum, t) => sum + t.pnl, 0);
		const totalPnlPercent = trades.reduce((sum, t) => sum + t.pnl_percent, 0);

		const averageWin = winningTrades.length > 0 ? winningTrades.reduce((sum, t) => sum + t.pnl, 0) / winningTrades.length : 0;

		const averageLoss = losingTrades.length > 0 ? Math.abs(losingTrades.reduce((sum, t) => sum + t.pnl, 0) / losingTrades.length) : 0;

		const profitFactor = averageLoss > 0 ? averageWin / averageLoss : 0;

		// Drawdown calculation
		let peak = 0;
		let maxDrawdown = 0;
		let cumPnl = 0;

		for (const trade of trades) {
			cumPnl += trade.pnl_percent;
			if (cumPnl > peak) peak = cumPnl;
			const drawdown = peak - cumPnl;
			if (drawdown > maxDrawdown) maxDrawdown = drawdown;
		}

		// Sharpe ratio (simplified)
		const returns = trades.map((t) => t.pnl_percent);
		const avgReturn = returns.reduce((a, b) => a + b, 0) / returns.length;
		const stdDev = Math.sqrt(returns.reduce((sum, r) => sum + Math.pow(r - avgReturn, 2), 0) / returns.length);
		const sharpeRatio = stdDev > 0 ? avgReturn / stdDev : 0;

		// Buy and hold comparison
		const buyAndHoldPnlPercent = ((finalPrice - initialPrice) / initialPrice) * 100;

		return {
			total_trades: trades.length,
			winning_trades: winningTrades.length,
			losing_trades: losingTrades.length,
			breakeven_trades: trades.filter((t) => t.result === 'BREAKEVEN').length,
			win_rate: (winningTrades.length / trades.length) * 100,
			total_pnl: totalPnl,
			total_pnl_percent: totalPnlPercent,
			average_win: averageWin,
			average_loss: averageLoss,
			profit_factor: profitFactor,
			sharpe_ratio: sharpeRatio,
			max_drawdown: maxDrawdown,
			buy_and_hold_pnl_percent: buyAndHoldPnlPercent,
			strategy_vs_hold: totalPnlPercent - buyAndHoldPnlPercent,
		};
	}
}
