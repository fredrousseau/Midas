/**
 * Test script for backtesting data fix
 * Validates that the dynamic bar calculation works correctly
 */

import 'dotenv/config';
import { BacktestingService } from '../src/Trading/Backtesting/BacktestingService.js';
import { MarketDataService } from '../src/Trading/MarketData/MarketDataService.js';
import { MarketAnalysisService } from '../src/Trading/MarketAnalysis/MarketAnalysisService.js';
import { DataProvider } from '../src/DataProvider/DataProvider.js';
import { BinanceAdapter } from '../src/DataProvider/BinanceAdapter.js';
import { IndicatorService } from '../src/Trading/Indicator/IndicatorService.js';
import { RegimeDetectionService } from '../src/Trading/MarketAnalysis/RegimeDetection/RegimeDetectionService.js';
import { StatisticalContextService } from '../src/Trading/MarketAnalysis/StatisticalContext/StatisticalContextService.js';
import { TradingContextService } from '../src/Trading/MarketAnalysis/TradingContext/TradingContextService.js';
import winston from 'winston';

// Setup logger
const logger = winston.createLogger({
	level: 'info',
	format: winston.format.combine(
		winston.format.timestamp(),
		winston.format.colorize(),
		winston.format.printf(({ timestamp, level, message }) => {
			return `${timestamp} [${level}]: ${message}`;
		})
	),
	transports: [new winston.transports.Console()]
});

async function testBacktest() {
	try {
		logger.info('=== Testing Backtest Data Fix ===\n');

		// Initialize services
		const binanceAdapter = new BinanceAdapter({ logger });

		const maxDataPoints = parseInt(process.env.MAX_DATA_POINTS || '5000');

		const dataProvider = new DataProvider({
			dataAdapter: binanceAdapter,
			logger,
			maxDataPoints: maxDataPoints,
			redisConfig: {
				enabled: String(process.env.REDIS_ENABLED || 'false').toLowerCase() === 'true',
				host: process.env.REDIS_HOST || 'localhost',
				port: parseInt(process.env.REDIS_PORT || '6379'),
				password: process.env.REDIS_PASSWORD || undefined,
				db: parseInt(process.env.REDIS_DB || '0'),
				ttl: parseInt(process.env.REDIS_CACHE_TTL || '300'),
				maxBars: parseInt(process.env.REDIS_MAX_BARS_PER_KEY || '10000'),
			}
		});

		const marketDataService = new MarketDataService({
			logger,
			dataProvider
		});

		const indicatorService = new IndicatorService({
			dataProvider,
			logger,
			precision: 3
		});

		const regimeDetectionService = new RegimeDetectionService({
			dataProvider,
			indicatorService,
			logger
		});

		const statisticalContextService = new StatisticalContextService({
			dataProvider,
			indicatorService,
			regimeDetectionService,
			logger
		});

		const tradingContextService = new TradingContextService({
			logger
		});

		const marketAnalysisService = new MarketAnalysisService({
			dataProvider,
			indicatorService,
			statisticalContextService,
			regimeDetectionService,
			tradingContextService,
			logger
		});

		const backtestingService = new BacktestingService({
			marketDataService,
			marketAnalysisService,
			logger
		});

		// Test configuration: 1-day backtest ending 2 days ago
		// Note: With 1h timeframe → {1h, 4h, 1d} mapping, we need ~5040 bars (210 days) of warmup
		// Binance only provides ~1000 bars of historical data, so this test will demonstrate:
		// 1. Dynamic bar calculation working correctly
		// 2. Batch loading triggered (Count exceeds adapter limit)
		// 3. Helpful error message when insufficient data is available
		const endDate = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000); // 2 days ago
		const startDate = new Date(endDate.getTime() - 1 * 24 * 60 * 60 * 1000); // 1-day backtest

		logger.info('Test Parameters:');
		logger.info(`  Symbol: BTCUSDT`);
		logger.info(`  Timeframe: 1h`);
		logger.info(`  Period: ${startDate.toISOString()} to ${endDate.toISOString()}`);
		logger.info(`  Duration: 1 day`);
		logger.info(`  MAX_DATA_POINTS: ${maxDataPoints}`);
		logger.info(`  Redis: ${process.env.REDIS_ENABLED || 'false'}\n`);

		// Run backtest
		const result = await backtestingService.runBacktest({
			symbol: 'BTCUSDT',
			startDate,
			endDate,
			timeframe: '1h',
			strategy: {
				minConfidence: 0.7,
				minQualityScore: 60
			}
		});

		// Display results
		logger.info('\n=== Backtest Results ===');
		logger.info(`Total candles analyzed: ${result.summary.total_candles}`);
		logger.info(`Entry signals detected: ${result.summary.entry_signals}`);
		logger.info(`  - Long signals: ${result.summary.long_signals}`);
		logger.info(`  - Short signals: ${result.summary.short_signals}`);

		if (result.signals.length > 0) {
			logger.info('\nFirst 3 signals:');
			result.signals.slice(0, 3).forEach((signal, i) => {
				logger.info(`  ${i + 1}. ${signal.direction} at ${new Date(signal.timestamp).toISOString()}`);
				logger.info(`     Price: $${signal.price.toFixed(2)}, Confidence: ${(signal.confidence * 100).toFixed(1)}%, Quality: ${signal.quality_score.toFixed(0)}`);
			});
		}

		logger.info('\n=== Test PASSED ===');
		process.exit(0);

	} catch (error) {
		logger.error(`\n=== Test FAILED ===`);
		logger.error(`Error: ${error.message}`);
		logger.error(`Stack: ${error.stack}`);
		process.exit(1);
	}
}

// Run test
testBacktest();
