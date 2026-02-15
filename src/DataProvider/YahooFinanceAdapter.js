import { GenericAdapter } from './GenericAdapter.js';
import YahooFinance from 'yahoo-finance2';

/**
 * Yahoo Finance Adapter
 *
 * Provides OHLCV data for stocks, ETFs, indices (CAC40, Euronext, US equities, etc.)
 * via the yahoo-finance2 library. Implements the same interface as BinanceAdapter.
 *
 * Symbol format: Yahoo Finance tickers
 *   - Euronext/CAC40 : 'MC.PA', 'AIR.PA', 'SAN.PA', 'TTE.PA'
 *   - US stocks      : 'AAPL', 'MSFT', 'TSLA'
 *   - ETFs           : 'SPY', 'QQQ', 'LYXE.PA'
 *   - Indices        : '^FCHI' (CAC40), '^GSPC' (S&P500), '^IXIC' (Nasdaq)
 *   - Crypto (Yahoo) : 'BTC-USD', 'ETH-USD'
 *
 * Timeframe mapping (Midas → Yahoo Finance intervals):
 *   1m → 1m   | 5m → 5m   | 15m → 15m | 30m → 30m
 *   1h → 60m  | 2h → (not supported, falls back to 1h)
 *   4h → (not supported, falls back to 1h)
 *   1d → 1d   | 1w → 1wk  | 1M → 1mo
 *
 * Limitations vs Binance:
 *   - Intraday data (< 1d) only available for the last 60 days
 *   - 1m data only available for the last 7 days
 *   - Market hours gaps are normal (overnight, weekends) — DataProvider will detect them
 *   - Rate limits: ~2000 requests/hour (no authentication required)
 */
export class YahooFinanceAdapter extends GenericAdapter {

	static VALID_TIMEFRAMES = ['1m', '5m', '15m', '30m', '1h', '2h', '4h', '1d', '1w', '1M'];
	static MAX_LIMIT = 2000;

	// Mapping from Midas timeframe format to Yahoo Finance interval strings
	static TIMEFRAME_MAP = {
		'1m':  '1m',
		'5m':  '5m',
		'15m': '15m',
		'30m': '30m',
		'1h':  '60m',
		'2h':  '60m',  // Yahoo doesn't support 2h — falls back to 1h
		'4h':  '60m',  // Yahoo doesn't support 4h — falls back to 1h
		'1d':  '1d',
		'1w':  '1wk',
		'1M':  '1mo',
	};

	/**
	 * @param {Object} parameters
	 * @param {Object} [parameters.logger] - Logger instance
	 * @param {number} [parameters.timeout=15000] - Request timeout in ms
	 */
	constructor(parameters = {}) {
		super(parameters);
		this._yf = new YahooFinance({ suppressNotices: ['yahooSurvey'] });
		this.logger.info('YahooFinanceAdapter initialized (yahoo-finance2 v3)');
	}

	/**
	 * Fetch OHLCV data from Yahoo Finance
	 *
	 * @param {Object} params
	 * @param {string} params.symbol - Yahoo Finance ticker (e.g., 'MC.PA', 'AAPL', '^FCHI')
	 * @param {string} [params.timeframe='1d'] - Timeframe string (Midas format)
	 * @param {number} [params.count=200] - Number of bars to fetch
	 * @param {number} [params.from] - Start time (Unix timestamp in ms)
	 * @param {number} [params.to] - End time (Unix timestamp in ms)
	 * @returns {Promise<Array>} Array of OHLCV objects
	 */
	async fetchOHLC({ symbol, timeframe = '1d', count = 200, from, to }) {
		this._validateSymbol(symbol);
		this._validateTimeframe(timeframe, YahooFinanceAdapter.VALID_TIMEFRAMES);
		this._validateLimit(count, YahooFinanceAdapter.MAX_LIMIT);

		const yahooInterval = YahooFinanceAdapter.TIMEFRAME_MAP[timeframe];

		// Warn when timeframe is approximated
		if ((timeframe === '2h' || timeframe === '4h') && !this._warned2h4h) {
			this.logger.warn(`YahooFinanceAdapter: timeframe '${timeframe}' is not supported by Yahoo Finance — using 60m instead`);
			this._warned2h4h = true;
		}

		// Calculate date range from count + to/from
		const endDate = to ? new Date(to) : new Date();
		const startDate = from ? new Date(from) : this._calcStartDate(endDate, timeframe, count);

		this.logger.info(`Fetching ${count} bars for ${symbol} (${timeframe} → ${yahooInterval}) from ${startDate.toISOString()} to ${endDate.toISOString()}`);

		try {
			const startTime = Date.now();

			const result = await this._yf.chart(symbol, {
				period1: startDate,
				period2: endDate,
				interval: yahooInterval,
			});

			const duration = Date.now() - startTime;

			if (!result?.quotes || result.quotes.length === 0)
				throw new Error(`No data returned by Yahoo Finance for ${symbol} (${yahooInterval})`);

			// Transform Yahoo Finance format to standard OHLCV format
			const ohlcv = result.quotes
				.filter(q => q.open !== null && q.high !== null && q.low !== null && q.close !== null && q.volume !== null)
				.map(q => ({
					timestamp: new Date(q.date).getTime(),
					open:      parseFloat(q.open),
					high:      parseFloat(q.high),
					low:       parseFloat(q.low),
					close:     parseFloat(q.close),
					volume:    parseFloat(q.volume ?? 0),
					symbol,
				}));

			if (ohlcv.length === 0)
				throw new Error(`All bars for ${symbol} had null values — symbol may be delisted or invalid`);

			// Take only the last `count` bars to match expected behavior
			const trimmed = ohlcv.slice(-count);

			this._validateOHLCV(trimmed);

			this.logger.info(`YahooFinanceAdapter: fetched ${trimmed.length} bars for ${symbol} in ${duration}ms`);

			return trimmed;
		} catch (error) {
			this.logger.error(`YahooFinanceAdapter: error fetching ${symbol}: ${error.message}`);
			throw error;
		}
	}

	/**
	 * Get current price for a symbol
	 *
	 * @param {string} symbol - Yahoo Finance ticker
	 * @returns {Promise<number>} Current price
	 */
	async getPrice(symbol) {
		this._validateSymbol(symbol);

		try {
			this.logger.info(`YahooFinanceAdapter: fetching current price for ${symbol}`);
			const quote = await this._yf.quote(symbol);
			const price = quote?.regularMarketPrice;

			if (price === undefined || price === null)
				throw new Error(`No price data available for ${symbol}`);

			this.logger.info(`YahooFinanceAdapter: current price for ${symbol}: ${price}`);
			return parseFloat(price);
		} catch (error) {
			this.logger.error(`YahooFinanceAdapter: error fetching price for ${symbol}: ${error.message}`);
			throw error;
		}
	}

	/**
	 * Get list of available pairs/symbols
	 * For Yahoo Finance, returns a curated list of major CAC40 + international symbols.
	 * Optionally accepts a search query to find specific tickers.
	 *
	 * @param {Object} [options={}]
	 * @param {string} [options.query] - Search query (e.g., 'LVMH', 'Total')
	 * @param {string} [options.market] - Market filter: 'FR' (Euronext), 'US', 'all'
	 * @returns {Promise<Array>} Array of symbol objects
	 */
	async getPairs(options = {}) {
		const { query, market = 'all' } = options;

		// If a search query is provided, use Yahoo Finance search
		if (query) 
			try {
				const results = await this._yf.search(query);
				return (results?.quotes || []).map(q => ({
					symbol:     q.symbol,
					name:       q.shortname || q.longname || q.symbol,
					exchange:   q.exchange || '',
					type:       q.quoteType || '',
					baseAsset:  q.symbol,
					quoteAsset: q.currency || 'EUR',
					status:     'TRADING',
				}));
			} catch (error) {
				this.logger.error(`YahooFinanceAdapter: search error: ${error.message}`);
				return [];
			}

		// Default: return curated CAC40 + major indices list
		const cac40 = [
			{ symbol: 'MC.PA',   name: 'LVMH',              quoteAsset: 'EUR' },
			{ symbol: 'TTE.PA',  name: 'TotalEnergies',      quoteAsset: 'EUR' },
			{ symbol: 'SAN.PA',  name: 'Sanofi',             quoteAsset: 'EUR' },
			{ symbol: 'AIR.PA',  name: 'Airbus',             quoteAsset: 'EUR' },
			{ symbol: 'OR.PA',   name: "L'Oréal",            quoteAsset: 'EUR' },
			{ symbol: 'BNP.PA',  name: 'BNP Paribas',        quoteAsset: 'EUR' },
			{ symbol: 'CS.PA',   name: 'AXA',                quoteAsset: 'EUR' },
			{ symbol: 'SU.PA',   name: 'Schneider Electric',  quoteAsset: 'EUR' },
			{ symbol: 'AI.PA',   name: 'Air Liquide',         quoteAsset: 'EUR' },
			{ symbol: 'BN.PA',   name: 'Danone',              quoteAsset: 'EUR' },
			{ symbol: 'KER.PA',  name: 'Kering',              quoteAsset: 'EUR' },
			{ symbol: 'RI.PA',   name: 'Pernod Ricard',       quoteAsset: 'EUR' },
			{ symbol: 'DSY.PA',  name: 'Dassault Systèmes',   quoteAsset: 'EUR' },
			{ symbol: 'CAP.PA',  name: 'Capgemini',           quoteAsset: 'EUR' },
			{ symbol: 'DG.PA',   name: 'Vinci',               quoteAsset: 'EUR' },
			{ symbol: 'HO.PA',   name: 'Thales',              quoteAsset: 'EUR' },
			{ symbol: 'VIE.PA',  name: 'Veolia',              quoteAsset: 'EUR' },
			{ symbol: 'ENGI.PA', name: 'Engie',               quoteAsset: 'EUR' },
			{ symbol: 'SGO.PA',  name: 'Saint-Gobain',        quoteAsset: 'EUR' },
			{ symbol: 'MT.AS',   name: 'ArcelorMittal',       quoteAsset: 'EUR' },
		];

		const indices = [
			{ symbol: '^FCHI',  name: 'CAC 40',     quoteAsset: 'EUR' },
			{ symbol: '^STOXX50E', name: 'Euro Stoxx 50', quoteAsset: 'EUR' },
			{ symbol: '^GSPC',  name: 'S&P 500',    quoteAsset: 'USD' },
			{ symbol: '^IXIC',  name: 'Nasdaq',     quoteAsset: 'USD' },
			{ symbol: '^DJI',   name: 'Dow Jones',  quoteAsset: 'USD' },
		];

		const all = [
			...cac40.map(s => ({ ...s, exchange: 'Euronext', type: 'EQUITY', status: 'TRADING' })),
			...indices.map(s => ({ ...s, exchange: 'INDEX', type: 'INDEX', status: 'TRADING' })),
		];

		if (market === 'FR')  return all.filter(s => s.quoteAsset === 'EUR' && s.type === 'EQUITY');
		if (market === 'US')  return all.filter(s => s.quoteAsset === 'USD');
		return all;
	}

	/**
	 * Calculate start date from end date, timeframe, and bar count.
	 * Adds a 50% buffer to account for market closure gaps (weekends, holidays).
	 *
	 * @private
	 * @param {Date} endDate - End of the period
	 * @param {string} timeframe - Midas timeframe string
	 * @param {number} count - Number of bars needed
	 * @returns {Date} Calculated start date
	 */
	_calcStartDate(endDate, timeframe, count) {
		const tfMs = this._timeframeToMs(timeframe);
		// Buffer factor: 1.7 accounts for weekends (~2/7 days) + holidays + partial candles
		const bufferFactor = 1.7;
		const rangeMs = tfMs * count * bufferFactor;
		return new Date(endDate.getTime() - rangeMs);
	}

	/**
	 * Convert Midas timeframe string to milliseconds
	 * @private
	 */
	_timeframeToMs(timeframe) {
		const map = {
			'1m':  60 * 1000,
			'5m':  5  * 60 * 1000,
			'15m': 15 * 60 * 1000,
			'30m': 30 * 60 * 1000,
			'1h':  60 * 60 * 1000,
			'2h':  2  * 60 * 60 * 1000,
			'4h':  4  * 60 * 60 * 1000,
			'1d':  24 * 60 * 60 * 1000,
			'1w':  7  * 24 * 60 * 60 * 1000,
			'1M':  30 * 24 * 60 * 60 * 1000,
		};
		return map[timeframe] || 60 * 60 * 1000;
	}
}

export default YahooFinanceAdapter;
