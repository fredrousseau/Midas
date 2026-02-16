export class GenericAdapter {
	constructor(parameters = {}) {
		if (new.target === GenericAdapter)
			throw new Error('Cannot instantiate abstract class GenericAdapter. Use a concrete implementation instead.');
		this.logger = parameters.logger;
		this.timeout = parameters.timeout || 15000;
	}

	async fetchOHLC(_params) {
		throw new Error('fetchOHLC() must be implemented by subclass');
	}

	_validateSymbol(symbol) {
		if (!symbol || typeof symbol !== 'string')
			throw new Error('Symbol is required and must be a string');
	}

	_validateTimeframe(timeframe, validTimeframes) {
		if (!validTimeframes.includes(timeframe))
			throw new Error(`Invalid timeframe '${timeframe}'. Valid values: ${validTimeframes.join(', ')}`);
	}

	_validateLimit(count, maxLimit = 1000) {
		if (typeof count !== 'number' || count < 1)
			throw new Error('Count must be a positive number');
		if (count > maxLimit)
			this.logger.warn(`Count ${count} exceeds max (${maxLimit}), capping to ${maxLimit}`);
	}

	_validateOHLCV(ohlcv) {
		if (!Array.isArray(ohlcv) || !ohlcv.length)
			throw new Error('Invalid OHLCV data: empty or not an array');

		const firstBar = ohlcv[0];
		const requiredFields = ['timestamp', 'open', 'high', 'low', 'close', 'volume'];

		for (const field of requiredFields)
			if (!(field in firstBar))
				throw new Error(`Missing required field: ${field}`);

		let invalidBars = 0;
		for (let i = 0; i < Math.min(ohlcv.length, 10); i++) {
			const bar = ohlcv[i];
			if (bar.high < bar.low || bar.high < bar.open || bar.high < bar.close ||
				bar.low > bar.open || bar.low > bar.close)
				invalidBars++;
		}
		if (invalidBars > 0)
			this.logger.warn(`Found ${invalidBars} bars with invalid OHLC relationships`);
	}

	async _fetchWithTimeout(url, timeout, options = {}) {
		const controller = new AbortController();
		const timeoutId = setTimeout(() => controller.abort(), timeout);
		try {
			const response = await fetch(url, { ...options, signal: controller.signal });
			clearTimeout(timeoutId);
			return response;
		} catch (error) {
			clearTimeout(timeoutId);
			if (error.name === 'AbortError')
				throw new Error(`Request timeout after ${timeout}ms`);
			throw error;
		}
	}

	async _fetchWithRetry(url, timeout, options = {}) {
		const { maxRetries = 3, initialBackoff = 100, maxBackoff = 5000 } = options;
		let lastError;

		for (let attempt = 0; attempt <= maxRetries; attempt++)
			try {
				return await this._fetchWithTimeout(url, timeout, options);
			} catch (error) {
				lastError = error;
				const isLastAttempt = attempt === maxRetries;
				const isRetryable = this._isRetryableError(error);

				if (isLastAttempt || !isRetryable)
					throw error;

				const backoffMs = Math.min(
					initialBackoff * Math.pow(2, attempt) + Math.random() * 1000,
					maxBackoff
				);

				this.logger.warn(
					`[RETRY] Attempt ${attempt + 1}/${maxRetries} failed: ${error.message}. ` +
					`Retrying in ${Math.round(backoffMs)}ms...`
				);

				await new Promise((resolve) => setTimeout(resolve, backoffMs));
			}

		throw lastError;
	}

	_isRetryableError(error) {
		const msg = error.message;
		// Never retry client errors (4xx except 429 rate limit)
		if (msg.includes('400') || msg.includes('401') || msg.includes('403') || msg.includes('404'))
			return false;
		return msg.includes('timeout') || msg.includes('ECONNREFUSED') || msg.includes('ENOTFOUND') ||
			msg.includes('500') || msg.includes('502') || msg.includes('503') || msg.includes('504') ||
			msg.includes('429');
	}
}
