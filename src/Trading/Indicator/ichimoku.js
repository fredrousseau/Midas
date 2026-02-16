/**
 * Ichimoku Cloud (Ichimoku Kinko Hyo) - Custom Implementation
 *
 * A comprehensive technical indicator developed by Goichi Hosoda that provides
 * support/resistance levels, momentum, and trend direction at a glance.
 *
 * Components:
 * 1. Tenkan-sen (Conversion Line) - (9-period high + 9-period low) / 2
 * 2. Kijun-sen (Base Line) - (26-period high + 26-period low) / 2
 * 3. Senkou Span A (Leading Span A) - (Tenkan-sen + Kijun-sen) / 2, shifted +26
 * 4. Senkou Span B (Leading Span B) - (52-period high + 52-period low) / 2, shifted +26
 * 5. Chikou Span (Lagging Span) - Close price, shifted -26
 *
 * @example
 * const ichimoku = new IchimokuCloud({ tenkan: 9, kijun: 26, senkou: 52, displacement: 26 });
 * ichimoku.update({ high: 100, low: 95, close: 98 });
 * const result = ichimoku.getResult();
 * // { tenkan, kijun, senkouA, senkouB, chikou }
 */
export class IchimokuCloud {
  /**
   * @param {Object} config - Configuration object
   * @param {number} [config.tenkan=9] - Tenkan-sen period
   * @param {number} [config.kijun=26] - Kijun-sen period
   * @param {number} [config.senkou=52] - Senkou Span B period
   * @param {number} [config.displacement=26] - Displacement for Senkou spans
   */
  constructor(config = {}) {
    this.tenkanPeriod = config.tenkan || 9;
    this.kijunPeriod = config.kijun || 26;
    this.senkouPeriod = config.senkou || 52;
    this.displacement = config.displacement || 26;

    // Price history buffers
    this.highs = [];
    this.lows = [];
    this.closes = [];

    // Component values
    this.tenkanValues = [];
    this.kijunValues = [];
    this.senkouAValues = [];
    this.senkouBValues = [];

    // Maximum history needed
    this.maxHistory = Math.max(
      this.tenkanPeriod,
      this.kijunPeriod,
      this.senkouPeriod,
      this.displacement
    );
  }

  /**
   * Update the indicator with new candle data
   * @param {Object} candle - { high, low, close }
   */
  update(candle) {
    if (!candle || typeof candle.high === 'undefined' ||
        typeof candle.low === 'undefined' ||
        typeof candle.close === 'undefined')
      throw new Error('IchimokuCloud: candle must have high, low, and close properties');

    // Add new values
    this.highs.push(candle.high);
    this.lows.push(candle.low);
    this.closes.push(candle.close);

    // Keep only necessary history
    const keepLength = this.maxHistory + this.displacement + 10; // Extra buffer
    if (this.highs.length > keepLength) {
      this.highs.shift();
      this.lows.shift();
      this.closes.shift();
    }

    // Calculate components
    this._calculate();
  }

  /**
   * Calculate all Ichimoku components
   * @private
   */
  _calculate() {
    const _len = this.highs.length;

    // Calculate Tenkan-sen (Conversion Line)
    const tenkan = this._calculateMidpoint(this.tenkanPeriod);
    this.tenkanValues.push(tenkan);

    // Calculate Kijun-sen (Base Line)
    const kijun = this._calculateMidpoint(this.kijunPeriod);
    this.kijunValues.push(kijun);

    // Calculate Senkou Span A (Leading Span A)
    // (Tenkan + Kijun) / 2, projected 26 periods ahead
    let senkouA = null;
    if (tenkan !== null && kijun !== null)
      senkouA = (tenkan + kijun) / 2;

    this.senkouAValues.push(senkouA);

    // Calculate Senkou Span B (Leading Span B)
    // 52-period midpoint, projected 26 periods ahead
    const senkouB = this._calculateMidpoint(this.senkouPeriod);
    this.senkouBValues.push(senkouB);

    // Keep only necessary history for component values
    const maxLength = this.displacement + 100;
    if (this.tenkanValues.length > maxLength) {
      this.tenkanValues.shift();
      this.kijunValues.shift();
      this.senkouAValues.shift();
      this.senkouBValues.shift();
    }
  }

  /**
   * Calculate midpoint (highest high + lowest low) / 2 for given period
   * @private
   * @param {number} period - Lookback period
   * @returns {number|null} Midpoint value or null if insufficient data
   */
  _calculateMidpoint(period) {
    const len = this.highs.length;
    if (len < period)
      return null;

    const start = len - period;
    const periodHighs = this.highs.slice(start);
    const periodLows = this.lows.slice(start);

    const highest = Math.max(...periodHighs);
    const lowest = Math.min(...periodLows);

    return (highest + lowest) / 2;
  }

  /**
   * Get the current Ichimoku values
   * @returns {Object|null} { tenkan, kijun, senkouA, senkouB, chikou } or null
   */
  getResult() {
    const len = this.highs.length;

    if (len === 0)
      return null;

    const currentIdx = this.tenkanValues.length - 1;

    // Current values (not projected)
    const tenkan = currentIdx >= 0 ? this.tenkanValues[currentIdx] : null;
    const kijun = currentIdx >= 0 ? this.kijunValues[currentIdx] : null;

    // Senkou Spans are projected forward by displacement periods
    // So we need to look back displacement periods to get current cloud values
    const senkouIdx = currentIdx - this.displacement;
    const senkouA = senkouIdx >= 0 ? this.senkouAValues[senkouIdx] : null;
    const senkouB = senkouIdx >= 0 ? this.senkouBValues[senkouIdx] : null;

    // Chikou Span is current close shifted back 26 periods
    const chikouIdx = len - this.displacement;
    const chikou = chikouIdx >= 0 ? this.closes[chikouIdx] : null;

    return {
      tenkan,
      kijun,
      senkouA,
      senkouB,
      chikou
    };
  }

  /**
   * Reset the indicator
   */
  reset() {
    this.highs = [];
    this.lows = [];
    this.closes = [];
    this.tenkanValues = [];
    this.kijunValues = [];
    this.senkouAValues = [];
    this.senkouBValues = [];
  }
}

export default IchimokuCloud;
