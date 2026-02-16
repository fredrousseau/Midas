import { GenericAdapter } from './GenericAdapter.js';

export class BinanceAdapter extends GenericAdapter {
	static VALID_TIMEFRAMES = ['1m', '3m', '5m', '15m', '30m', '1h', '2h', '4h', '6h', '8h', '12h', '1d', '3d', '1w', '1M'];
	static MAX_LIMIT = 1500;
	static _pairsCache = { data: null, timestamp: 0, ttl: 30 * 60 * 1000 }; // 30 min cache

	/**
	 * @param {Object} parameters
	 * @param {string} [parameters.baseUrl='https://api.binance.com'] - Binance API base URL
	 * @param {Object} [parameters.log] - Logger instance
	 * @param {number} [parameters.timeout=10000] - Request timeout in ms
	 */
	constructor(parameters = {}) {
		super(parameters);
		this.baseUrl = parameters.baseUrl || 'https://api.binance.com';
		this.logger.info(`BinanceAdapter initialized - Base URL: ${this.baseUrl}`);
	}

	/**
	 * Fetch OHLCV data from Binance
	 *
	 * @param {Object} params
	 * @param {string} params.symbol - Trading pair symbol (e.g., 'BTCUSDT', 'ETHUSDT')
	 * @param {string} [params.timeframe='1h'] - Kline interval (1m, 3m, 5m, 15m, 30m, 1h, 2h, 4h, 6h, 8h, 12h, 1d, 3d, 1w, 1M)
	 * @param {number} [params.count=200] - Number of bars to fetch (max 1000)
	 * @param {number} [params.from] - Start time (Unix timestamp in ms)
	 * @param {number} [params.to] - End time (Unix timestamp in ms)
	 * @returns {Promise<Array>} Array of OHLCV objects
	 */
	async fetchOHLC({ symbol, timeframe = '1h', count = 200, from, to }) {
		// Validate inputs
		this._validateSymbol(symbol);
		this._validateTimeframe(timeframe, BinanceAdapter.VALID_TIMEFRAMES);
		this._validateLimit(count, BinanceAdapter.MAX_LIMIT);

		// Build request URL
		const endpoint = '/api/v3/klines';
		const params = new URLSearchParams({
			symbol: symbol.toUpperCase(),
			interval: timeframe,
			limit: Math.min(count, BinanceAdapter.MAX_LIMIT).toString(),
		});

		if (from) params.append('startTime', from.toString());
		if (to) params.append('endTime', to.toString());

		const url = `${this.baseUrl}${endpoint}?${params.toString()}`;

		try {
			const startTime = Date.now();

			// Fetch data from Binance (with retry logic from parent)
			const response = await this._fetchWithRetry(url, this.timeout);

			if (!response.ok) {
				const errorText = await response.text();
				throw new Error(`Binance API error (${response.status}): ${errorText}`);
			}

			const rawData = await response.json();
			const _duration = Date.now() - startTime;

			// Transform Binance format to standard OHLCV format
			const ohlcv = rawData.map((candle) => ({
				timestamp: candle[0], // Open time
				open: parseFloat(candle[1]),
				high: parseFloat(candle[2]),
				low: parseFloat(candle[3]),
				close: parseFloat(candle[4]),
				volume: parseFloat(candle[5]),
				symbol: symbol,
			}));

			this._validateOHLCV(ohlcv);

			return ohlcv;
		} catch (error) {
			this.logger.error(`Error fetching data for ${symbol}: ${error.message}`);
			throw error;
		}
	}

	/**
	 * Get current price for a symbol (simple)
	 *
	 * @param {string} symbol - Trading pair symbol
	 * @returns {Promise<number>} Current price
	 */
	async getPrice(symbol) {
		this._validateSymbol(symbol);
		const url = `${this.baseUrl}/api/v3/ticker/price?symbol=${symbol.toUpperCase()}`;

		try {
			this.logger.info(`Fetching current price for ${symbol}`);
			const response = await this._fetchWithRetry(url, this.timeout);

			if (!response.ok) throw new Error(`Failed to fetch current price (${response.status})`);

			const data = await response.json();
			const price = parseFloat(data.price);
			this.logger.info(`Current price for ${symbol}: ${price}`);
			return price;
		} catch (error) {
			this.logger.error(`Error fetching current price for ${symbol}: ${error.message}`);
			throw error;
		}
	}

	/**
	 * Get list of all available trading pairs on Binance
	 *
	 * @param {Object} [parameters] - Filter options
	 * @param {string} [parameters.quoteAsset] - Filter by quote asset (e.g., 'USDT', 'BTC', 'ETH')
	 * @param {string} [parameters.baseAsset] - Filter by base asset (e.g., 'BTC', 'ETH')
	 * @param {string} [parameters.status='TRADING'] - Filter by status ('TRADING', 'BREAK', etc.)
	 * @param {Array<string>} [parameters.permissions] - Filter by permissions (e.g., ['SPOT'])
	 * @returns {Promise<Array>} Array of trading pair objects with symbol info
	 *
	 * @example
	 * // Get all USDT pairs
	 * const usdtPairs = await provider.getPairs({ quoteAsset: 'USDT' });
	 *
	 * // Get all BTC pairs that are currently trading
	 * const btcPairs = await provider.getPairs({ quoteAsset: 'BTC', status: 'TRADING' });
	 *
	 * // Get all pairs
	 * const allPairs = await provider.getPairs();
	 */
	/**
	 * Search for symbols by ticker fragment (case-insensitive).
	 * Binance has no company names, so this filters pairs whose symbol contains the query.
	 *
	 * @param {string} query - Ticker fragment (e.g., 'BTC', 'ETH')
	 * @returns {Promise<Array>} Matching trading pairs
	 */
	async search(query) {
		if (!query || typeof query !== 'string' || query.trim().length === 0)
			throw new Error('search() requires a non-empty query string');

		const upper = query.trim().toUpperCase();
		const all = await this.getPairs({ status: 'TRADING' });
		return all.filter(p => p.symbol.includes(upper) || p.baseAsset.includes(upper));
	}

	async getPairs(options = {}) {
		const { quoteAsset, baseAsset, status = 'TRADING', permissions } = options;

		// Use cached exchangeInfo if available and fresh
		const cache = BinanceAdapter._pairsCache;
		let allSymbols;

		if (cache.data && (Date.now() - cache.timestamp) < cache.ttl) {
			allSymbols = cache.data;
		} else {
			const url = `${this.baseUrl}/api/v3/exchangeInfo`;

			this.logger.info('Fetching available trading pairs from Binance API...');
			const startTime = Date.now();

			const response = await this._fetchWithRetry(url, this.timeout);
			if (!response.ok) throw new Error(`Failed to fetch exchange info (${response.status})`);

			const data = await response.json();
			allSymbols = data.symbols || [];

			// Cache the raw symbols list
			cache.data = allSymbols;
			cache.timestamp = Date.now();

			this.logger.info(`Cached ${allSymbols.length} symbols from Binance exchangeInfo (${Date.now() - startTime}ms)`);
		}

		// Apply filters
		let symbols = allSymbols;
		if (status) symbols = symbols.filter((s) => s.status === status);
		if (quoteAsset) symbols = symbols.filter((s) => s.quoteAsset === quoteAsset.toUpperCase());
		if (baseAsset) symbols = symbols.filter((s) => s.baseAsset === baseAsset.toUpperCase());
		if (permissions && Array.isArray(permissions)) symbols = symbols.filter((s) => permissions.every((perm) => s.permissions?.includes(perm)));

		// Format response with essential info
		return symbols.map((s) => ({
			symbol: s.symbol,
			baseAsset: s.baseAsset,
			quoteAsset: s.quoteAsset,
			status: s.status,
			permissions: s.permissions,
			baseAssetPrecision: s.baseAssetPrecision,
			quoteAssetPrecision: s.quoteAssetPrecision,
			isSpotTradingAllowed: s.isSpotTradingAllowed,
			isMarginTradingAllowed: s.isMarginTradingAllowed,
		}));
	}
}
