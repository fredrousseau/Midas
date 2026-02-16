/**
 * AdapterRouter
 *
 * Routes data requests to the appropriate adapter based on symbol format,
 * with automatic fallback when the primary adapter rejects the symbol.
 *
 * Primary routing (by symbol format):
 *   - Yahoo first  : contains '.', '-', '^', or lowercase  (e.g. MC.PA, ^FCHI, BTC-USD)
 *   - Binance first: uppercase alphanumeric only            (e.g. BTCUSDT, ETHUSDT)
 *
 * Fallback: if the primary adapter returns an "Invalid symbol" error, the request
 * is transparently retried on the other adapter. This handles ambiguous symbols
 * like 'AAPL' or 'LVMH' that look like Binance pairs but are Yahoo equities.
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

		// Symbol → adapter name cache to avoid repeated fallback attempts
		this._symbolCache = new Map();
	}

	/**
	 * Select the primary adapter for a given symbol based on format heuristics.
	 * Returns [primary, fallback].
	 *
	 * @param {string} symbol
	 * @returns {[import('./GenericAdapter.js').GenericAdapter, import('./GenericAdapter.js').GenericAdapter]}
	 */
	_resolvePrimary(symbol) {
		// Cached routing from a previous successful request
		const cached = this._symbolCache.get(symbol);
		if (cached === 'yahoo')   return [this.yahooAdapter,   this.binanceAdapter];
		if (cached === 'binance') return [this.binanceAdapter, this.yahooAdapter];

		// Yahoo symbols contain '.', '-', '^' or lowercase letters
		if (/[.\-^]/.test(symbol) || /[a-z]/.test(symbol))
			return [this.yahooAdapter, this.binanceAdapter];

		// Default: try Binance first (crypto pairs), fall back to Yahoo (US equities)
		return [this.binanceAdapter, this.yahooAdapter];
	}

	/**
	 * Returns true if the error indicates an unknown/invalid symbol on the adapter,
	 * meaning we should retry on the other adapter.
	 *
	 * @param {Error} error
	 * @returns {boolean}
	 */
	_isInvalidSymbolError(error) {
		const msg = error.message || '';
		return msg.includes('Invalid symbol') ||
			msg.includes('-1121') ||
			msg.includes('No data returned') ||
			msg.includes('not found') ||
			msg.includes('delisted');
	}

	/**
	 * Try the primary adapter, automatically fall back to the secondary on symbol errors.
	 *
	 * @param {string} symbol
	 * @param {Function} fn - (adapter) => Promise
	 * @returns {Promise<*>}
	 */
	async _withFallback(symbol, fn) {
		const [primary, fallback] = this._resolvePrimary(symbol);
		const primaryName  = primary  === this.binanceAdapter ? 'binance' : 'yahoo';
		const fallbackName = fallback === this.binanceAdapter ? 'binance' : 'yahoo';

		try {
			this.logger.verbose(`AdapterRouter: ${symbol} → ${primaryName} (primary)`);
			const result = await fn(primary);
			this._symbolCache.set(symbol, primaryName);
			return result;
		} catch (primaryError) {
			if (!this._isInvalidSymbolError(primaryError)) throw primaryError;

			this.logger.info(`AdapterRouter: ${symbol} not found on ${primaryName}, trying ${fallbackName}`);
			try {
				const result = await fn(fallback);
				this._symbolCache.set(symbol, fallbackName);
				this.logger.info(`AdapterRouter: ${symbol} resolved via ${fallbackName} (cached for future requests)`);
				return result;
			} catch (fallbackError) {
				// Both failed — throw the most meaningful error
				if (this._isInvalidSymbolError(fallbackError))
					throw new Error(`Symbol '${symbol}' not found on Binance or Yahoo Finance`);
				throw fallbackError;
			}
		}
	}

	// ──────────────────────────────────────────────────────────────────────────
	// GenericAdapter interface
	// ──────────────────────────────────────────────────────────────────────────

	/**
	 * Fetch OHLCV data — delegates to the appropriate adapter with fallback.
	 *
	 * @param {Object} params - Same parameters as GenericAdapter.fetchOHLC()
	 * @returns {Promise<Array>}
	 */
	async fetchOHLC(params) {
		return this._withFallback(params.symbol, adapter => adapter.fetchOHLC(params));
	}

	/**
	 * Get current price — delegates to the appropriate adapter with fallback.
	 *
	 * @param {string} symbol
	 * @returns {Promise<number>}
	 */
	async getPrice(symbol) {
		return this._withFallback(symbol, adapter => adapter.getPrice(symbol));
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
