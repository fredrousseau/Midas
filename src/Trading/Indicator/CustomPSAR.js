/**
 * Custom Parabolic SAR Implementation
 *
 * This implementation replaces trading-signals PSAR which returns NaN values.
 * The Parabolic SAR (Stop and Reverse) is a trend-following indicator that
 * provides potential entry and exit points.
 */
export class CustomPSAR {
	constructor(step = 0.02, max = 0.2) {
		this.step = step; // Acceleration factor increment
		this.max = max; // Maximum acceleration factor
		this.af = step; // Current acceleration factor
		this.isUptrend = true; // Current trend direction
		this.ep = null; // Extreme Point (highest high in uptrend, lowest low in downtrend)
		this.sar = null; // Current SAR value
		this.highsHistory = []; // Store last 3 highs for SAR calculation
		this.lowsHistory = []; // Store last 3 lows for SAR calculation
		this.isStable = false;
	}

	/**
	 * Update the indicator with a new bar
	 * @param {Object} input - { high, low }
	 */
	update(input) {
		const { high, low } = input;

		// Store history
		this.highsHistory.push(high);
		this.lowsHistory.push(low);

		// Keep only last 3 values
		if (this.highsHistory.length > 3) {
			this.highsHistory.shift();
			this.lowsHistory.shift();
		}

		// Initialize on first bar
		if (this.ep === null) {
			this.ep = high;
			this.sar = low;
			return;
		}

		// Calculate new SAR
		const newSar = this.sar + this.af * (this.ep - this.sar);

		if (this.isUptrend) 
			// In uptrend, SAR should be below price
			// Check if trend reverses (price crosses below SAR)
			{if (low < newSar) {
				this.isUptrend = false;
				this.sar = this.ep; // Switch SAR to previous extreme point
				this.ep = low; // New extreme point is current low
				this.af = this.step; // Reset acceleration factor
			} else {
				// Trend continues
				this.sar = newSar;

				// Make sure SAR doesn't go above prior two lows
				if (this.lowsHistory.length >= 3) 
					this.sar = Math.min(this.sar, this.lowsHistory[this.lowsHistory.length - 2], this.lowsHistory[this.lowsHistory.length - 3]);
				 else if (this.lowsHistory.length >= 2) 
					this.sar = Math.min(this.sar, this.lowsHistory[this.lowsHistory.length - 2]);

				// Update extreme point and acceleration factor
				if (high > this.ep) {
					this.ep = high;
					this.af = Math.min(this.af + this.step, this.max);
				}
			}}
		 else 
			// In downtrend, SAR should be above price
			// Check if trend reverses (price crosses above SAR)
			if (high > newSar) {
				this.isUptrend = true;
				this.sar = this.ep; // Switch SAR to previous extreme point
				this.ep = high; // New extreme point is current high
				this.af = this.step; // Reset acceleration factor
			} else {
				// Trend continues
				this.sar = newSar;

				// Make sure SAR doesn't go below prior two highs
				if (this.highsHistory.length >= 3) 
					this.sar = Math.max(this.sar, this.highsHistory[this.highsHistory.length - 2], this.highsHistory[this.highsHistory.length - 3]);
				 else if (this.highsHistory.length >= 2) 
					this.sar = Math.max(this.sar, this.highsHistory[this.highsHistory.length - 2]);

				// Update extreme point and acceleration factor
				if (low < this.ep) {
					this.ep = low;
					this.af = Math.min(this.af + this.step, this.max);
				}
			}

		this.isStable = true;
	}

	/**
	 * Get the current SAR value
	 * @returns {number|null} Current SAR value
	 */
	getResult() {
		if (!this.isStable) 
			return null;
		
		return this.sar;
	}

	/**
	 * Check if indicator is stable (has enough data)
	 * @returns {boolean}
	 */
	get stable() {
		return this.isStable;
	}

	/**
	 * Get current trend direction
	 * @returns {boolean} true if uptrend, false if downtrend
	 */
	get trend() {
		return this.isUptrend;
	}
}

export default CustomPSAR;
