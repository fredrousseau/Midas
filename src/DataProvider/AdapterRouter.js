/**
 * AdapterRouter
 *
 * Routes data requests to the appropriate adapter based on the symbol format.
 *
 * Routing rules:
 *   - Binance : uppercase alphanumeric only, no dots/dashes/carets (e.g. BTCUSDT, ETHUSDT)
 *   - Yahoo   : contains '.', '-', '^', or lowercase letters (e.g. MC.PA, AAPL, ^FCHI, BTC-USD)
 *
 * Implements the same interface as GenericAdapter so it can be used as a drop-in
 * replacement for the dataAdapter parameter of DataProvider.
 */
export class AdapterRouter {

	// Used by DataProvider for batch sizing — set to the lower of the two adapters
	// so batches never exceed what either adapter can handle
	static MAX_LIMIT = 1500; // BinanceAdapter.MAX_LIMIT (the more restrictive)

	/**
	 * @param {Object} options
	 * @param {import('./BinanceAdapter.js').BinanceAdapter} options.binanceAdapter
	 * @param {import('./YahooFinanceAdapter.js').YahooFinanceAdapter} options.yahooAdapter
	 * @param {Object} options.logger
	 */
	constructor({ binanceAdapter, yahooAdapter, logger }) {
		if (!binanceAdapter) throw new Error('AdapterRouter requires a binanceAdapter');
		if (!yahooAdapter)   throw new Error('AdapterRouter requires a yahooAdapter');
		if (!logger)         throw new Error('AdapterRouter requires a logger');

		this.binanceAdapter = binanceAdapter;
		this.yahooAdapter   = yahooAdapter;
		this.logger         = logger;
	}

	/**
	 * Select the right adapter for a given symbol.
	 *
	 * @param {string} symbol
	 * @returns {import('./GenericAdapter.js').GenericAdapter}
	 */
	_resolve(symbol) {
		// Yahoo symbols contain '.', '-', '^' or lowercase letters
		const isYahoo = /[.\-^]/.test(symbol) || /[a-z]/.test(symbol);

		if (isYahoo) {
			this.logger.verbose(`AdapterRouter: ${symbol} → YahooFinanceAdapter`);
			return this.yahooAdapter;
		}

		this.logger.verbose(`AdapterRouter: ${symbol} → BinanceAdapter`);
		return this.binanceAdapter;
	}

	// ──────────────────────────────────────────────────────────────────────────
	// GenericAdapter interface
	// ──────────────────────────────────────────────────────────────────────────

	/**
	 * Fetch OHLCV data — delegates to the appropriate adapter.
	 *
	 * @param {Object} params - Same parameters as GenericAdapter.fetchOHLC()
	 * @returns {Promise<Array>}
	 */
	async fetchOHLC(params) {
		return this._resolve(params.symbol).fetchOHLC(params);
	}

	/**
	 * Get current price — delegates to the appropriate adapter.
	 *
	 * @param {string} symbol
	 * @returns {Promise<number>}
	 */
	async getPrice(symbol) {
		return this._resolve(symbol).getPrice(symbol);
	}

	/**
	 * Get available pairs.
	 *
	 * When no source is specified, returns the combined list from both adapters.
	 * Pass `options.source = 'binance'` or `'yahoo'` to restrict to one adapter.
	 *
	 * @param {Object} [options={}]
	 * @param {string} [options.source] - 'binance' | 'yahoo' | undefined (both)
	 * @returns {Promise<Array>}
	 */
	async getPairs(options = {}) {
		const { source, ...rest } = options;

		if (source === 'binance') return this.binanceAdapter.getPairs(rest);
		if (source === 'yahoo')   return this.yahooAdapter.getPairs(rest);

		// Both: fetch in parallel and merge
		const [binancePairs, yahooPairs] = await Promise.allSettled([
			this.binanceAdapter.getPairs(rest),
			this.yahooAdapter.getPairs(rest),
		]);

		const fromBinance = binancePairs.status === 'fulfilled'
			? binancePairs.value.map(p => ({ ...p, _adapter: 'binance' }))
			: (this.logger.warn(`AdapterRouter: Binance getPairs failed: ${binancePairs.reason?.message}`), []);

		const fromYahoo = yahooPairs.status === 'fulfilled'
			? yahooPairs.value.map(p => ({ ...p, _adapter: 'yahoo' }))
			: (this.logger.warn(`AdapterRouter: Yahoo getPairs failed: ${yahooPairs.reason?.message}`), []);

		return [...fromBinance, ...fromYahoo];
	}
}

export default AdapterRouter;
