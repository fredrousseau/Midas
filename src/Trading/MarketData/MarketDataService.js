export class MarketDataService {
	/**
	 * Create a MarketDataService instance
	 * @param {Object} parameters - Configuration parameters
	 * @param {Object} parameters.logger - Logger instance for logging operations
	 * @param {Object} parameters.dataProvider - Data provider instance for fetching market data
	 * @throws {Error} If logger or dataProvider is not provided
	 */
	constructor(parameters = {}) {
		this.logger = parameters.logger || null;

		if (!this.logger)
			throw new Error('MarketDataService requires a logger instance in options');

		this.dataProvider = parameters.dataProvider || null;

		if (!this.dataProvider)
			throw new Error('MarketDataService requires a dataProvider instance in options');

		this.logger.info('MarketDataService initialized.');
	}

	/**
	 * Get current price for a symbol
	 * @param {string} symbol - Trading symbol (e.g., 'BTCUSDT')
	 * @returns {Promise<number>} Current price
	 */
	async getPrice(symbol) {
		return await this.dataProvider.getPrice(symbol);
	}

	/**
	 * Get available trading pairs
	 * @param {Object} options - Filter options
	 * @returns {Promise<Array>} Array of trading pairs
	 */
	async getPairs(options = {}) {
		return await this.dataProvider.getPairs(options);
	}

	/**
	 * Load OHLCV data for a symbol
	 * @param {Object} options - Load options
	 * @returns {Promise<Object>} OHLCV data
	 */
	async loadOHLCV(options) {
		const result = await this.dataProvider.loadOHLCV(options);

		// Transform bars to structured format with timestamp and values
		const data =
			result.bars?.map((bar) => ({
				timestamp: bar.timestamp,
				values: {
					open: bar.open,
					high: bar.high,
					low: bar.low,
					close: bar.close,
					volume: bar.volume,
				},
			})) || [];

		return {
			...result,
			data,
			bars: undefined, // Remove raw bars from API response
		};
	}

}

export default MarketDataService;
