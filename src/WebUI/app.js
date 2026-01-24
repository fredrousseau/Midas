// Configuration
const API_BASE = window.location.origin;

// State
let mainChart = null;
let candlestickSeries = null;
let indicatorChart = null;
let currentData = null;
let indicatorSeries = new Map();
let catalogData = null;
let indicatorDescriptions = new Map(); // Map indicator key to description
let seriesDisplayNames = new Map(); // Map series key to display name for data panel
let appTimezone = 'Europe/Paris'; // Default, will be loaded from API
let isSyncingCharts = false; // Flag to prevent circular sync
let originalTimestampMap = new Map(); // Map chart time (seconds) to original UTC timestamp (ms)

// Import auth client (will be loaded via script tag)
let authClient = null;

// Utility functions
function showStatus(message, type = 'loading') {
	const statusEl = document.getElementById('status');
	statusEl.textContent = message;
	statusEl.className = `status ${type}`;
	statusEl.style.display = 'block';
}

function hideStatus() {
	const statusEl = document.getElementById('status');
	statusEl.style.display = 'none';
}

function formatTimestamp(timestamp, options = {}) {
	const defaultOptions = {
		timeZone: appTimezone,
		year: 'numeric',
		month: '2-digit',
		day: '2-digit',
		hour: '2-digit',
		minute: '2-digit',
		second: '2-digit',
		hour12: false,
	};

	const mergedOptions = { ...defaultOptions, ...options };

	try {
		return new Intl.DateTimeFormat('fr-FR', mergedOptions).format(new Date(timestamp));
	} catch (error) {
		console.error('Error formatting timestamp:', error, 'timezone:', appTimezone);
		return new Date(timestamp).toLocaleString();
	}
}

// Initialize charts
function initCharts() {
	// Main chart (candlesticks + overlays)
	const mainChartEl = document.getElementById('mainChart');

	console.log('LightweightCharts object:', LightweightCharts);

	mainChart = LightweightCharts.createChart(mainChartEl, {
		layout: {
			background: { color: '#1a1a1a' },
			textColor: '#d1d4dc',
		},
		grid: {
			vertLines: { color: '#2a2a2a' },
			horzLines: { color: '#2a2a2a' },
		},
		crosshair: {
			mode: LightweightCharts.CrosshairMode.Normal,
		},
		rightPriceScale: {
			borderColor: '#2a2a2a',
			minimumWidth: 80, // Fixed width to align with indicator chart
		},
		timeScale: {
			borderColor: '#2a2a2a',
			timeVisible: true,
			secondsVisible: false,
			rightOffset: 10,
			barSpacing: 10,
			minBarSpacing: 0.5,
			fixLeftEdge: false,
			lockVisibleTimeRangeOnResize: false,
			rightBarStaysOnScroll: true,
			visible: true,
		},
		handleScroll: {
			mouseWheel: true,
			pressedMouseMove: true,
			horzTouchDrag: true,
			vertTouchDrag: true,
		},
		handleScale: {
			axisPressedMouseMove: true,
			mouseWheel: true,
			pinch: true,
		},
		width: mainChartEl.clientWidth,
		height: 500,
	});

	console.log('mainChart methods:', Object.keys(mainChart));

	candlestickSeries = mainChart.addCandlestickSeries({
		upColor: '#26a69a',
		downColor: '#ef5350',
		borderVisible: false,
		wickUpColor: '#26a69a',
		wickDownColor: '#ef5350',
	});

	// Indicator chart (oscillators like RSI, MACD)
	const indicatorChartEl = document.getElementById('indicatorChart');
	indicatorChart = LightweightCharts.createChart(indicatorChartEl, {
		layout: {
			background: { color: '#1a1a1a' },
			textColor: '#d1d4dc',
		},
		grid: {
			vertLines: { color: '#2a2a2a' },
			horzLines: { color: '#2a2a2a' },
		},
		crosshair: {
			mode: LightweightCharts.CrosshairMode.Normal,
		},
		rightPriceScale: {
			borderColor: '#2a2a2a',
			minimumWidth: 80, // Fixed width to align with main chart
		},
		timeScale: {
			borderColor: '#2a2a2a',
			visible: true,
			timeVisible: true,
			secondsVisible: false,
			rightOffset: 10,
			barSpacing: 10,
			minBarSpacing: 0.5,
			fixLeftEdge: false,
			lockVisibleTimeRangeOnResize: false,
			rightBarStaysOnScroll: true,
		},
		handleScroll: {
			mouseWheel: true,
			pressedMouseMove: true,
			horzTouchDrag: true,
			vertTouchDrag: true,
		},
		handleScale: {
			axisPressedMouseMove: true,
			mouseWheel: true,
			pinch: true,
		},
		width: indicatorChartEl.clientWidth,
		height: 200,
	});

	// Synchronize time scales using logical range (indices-based)
	// Logical range can extend beyond data boundaries, allowing proper zoom synchronization
	mainChart.timeScale().subscribeVisibleLogicalRangeChange((logicalRange) => {
		if (isSyncingCharts) return;
		if (!logicalRange) return;

		// Check if indicator chart wrapper is visible (has oscillators)
		const wrapper = document.getElementById('indicatorChartWrapper');
		if (!wrapper || wrapper.style.display === 'none') return;

		isSyncingCharts = true;
		try {
			indicatorChart.timeScale().setVisibleLogicalRange(logicalRange);
		} catch (error) {
			// Silently ignore errors when chart is not ready
			console.debug('Indicator chart sync error:', error.message);
		} finally {
			isSyncingCharts = false;
		}
	});

	indicatorChart.timeScale().subscribeVisibleLogicalRangeChange((logicalRange) => {
		if (isSyncingCharts) return;
		if (!logicalRange) return;

		isSyncingCharts = true;
		try {
			mainChart.timeScale().setVisibleLogicalRange(logicalRange);
		} catch (error) {
			// Silently ignore errors when chart is not ready
			console.debug('Main chart sync error:', error.message);
		} finally {
			isSyncingCharts = false;
		}
	});

	// Synchronize crosshair - Official pattern from TradingView documentation
	function getCrosshairDataPoint(series, param) {
		if (!param || !param.time || !param.seriesData) return null;
		const dataPoint = param.seriesData.get(series);
		return dataPoint || null;
	}

	function syncCrosshair(chart, series, dataPoint) {
		if (dataPoint) chart.setCrosshairPosition(dataPoint.value, dataPoint.time, series);
		else chart.clearCrosshairPosition();
	}

	mainChart.subscribeCrosshairMove((param) => {
		const firstIndicatorSeries = indicatorSeries.values().next().value;
		if (firstIndicatorSeries && candlestickSeries) {
			const dataPoint = getCrosshairDataPoint(candlestickSeries, param);
			syncCrosshair(indicatorChart, firstIndicatorSeries, dataPoint);
		}
	});

	indicatorChart.subscribeCrosshairMove((param) => {
		const firstIndicatorSeries = indicatorSeries.values().next().value;
		if (firstIndicatorSeries && candlestickSeries) {
			const dataPoint = getCrosshairDataPoint(firstIndicatorSeries, param);
			syncCrosshair(mainChart, candlestickSeries, dataPoint);
		}
	});

	// Handle window resize
	window.addEventListener('resize', resizeCharts);
}

// Function to resize charts (can be called externally)
function resizeCharts() {
	console.log('=== resizeCharts() called ===');
	if (mainChart) {
		const mainChartEl = document.getElementById('mainChart');
		if (mainChartEl && mainChartEl.parentElement) {
			const parent = mainChartEl.parentElement;
			console.log('Parent element:', parent.className);
			console.log('Parent clientWidth:', parent.clientWidth);
			console.log('Parent offsetWidth:', parent.offsetWidth);

			// Force reflow
			void parent.offsetWidth;

			const newWidth = parent.clientWidth - 40; // Subtract padding (20px * 2)
			console.log('Applying new width to mainChart:', newWidth);

			try {
				mainChart.applyOptions({ width: newWidth });
				console.log('✓ mainChart resized successfully');
			} catch (error) {
				console.error('✗ Error resizing mainChart:', error);
			}
		}
	} else {
		console.log('mainChart not initialized');
	}

	if (indicatorChart) {
		const indicatorChartEl = document.getElementById('indicatorChart');
		const indicatorWrapper = document.getElementById('indicatorChartWrapper');

		// Only resize if the wrapper is visible (has oscillators)
		if (indicatorChartEl && indicatorChartEl.parentElement && indicatorWrapper && indicatorWrapper.style.display !== 'none') {
			const parent = indicatorChartEl.parentElement;
			const newWidth = parent.clientWidth - 40;
			console.log('Applying new width to indicatorChart:', newWidth);

			try {
				indicatorChart.applyOptions({ width: newWidth });
				console.log('✓ indicatorChart resized successfully');
			} catch (error) {
				console.error('✗ Error resizing indicatorChart:', error);
			}
		} else {
			console.log('indicatorChart wrapper hidden, skipping resize');
		}
	}
	console.log('=== resizeCharts() complete ===');
}

// Authenticated fetch wrapper
async function authenticatedFetch(url, options = {}) {
	// Only use authClient if it exists AND user is authenticated
	if (authClient && authClient.isAuthenticated()) return authClient.authenticatedFetch(url, options);

	// Fallback for when auth is not enabled or user not authenticated
	return fetch(url, options);
}

// API calls
async function fetchConfig() {
	const response = await authenticatedFetch(`${API_BASE}/api/v1/utility/config`);
	if (!response.ok) throw new Error('Failed to fetch config');

	const result = await response.json();
	return result.data || result;
}

async function fetchCatalog() {
	const response = await authenticatedFetch(`${API_BASE}/api/v1/indicators/catalog`);
	if (!response.ok) throw new Error('Failed to fetch catalog');

	const result = await response.json();
	return result.data || result;
}

async function fetchOHLCV(symbol, timeframe, bars, analysisDate = null) {
	let url = `${API_BASE}/api/v1/market-data/ohlcv?symbol=${symbol}&timeframe=${timeframe}&count=${bars}`;
	if (analysisDate) url += `&analysisDate=${encodeURIComponent(analysisDate)}`;

	const response = await authenticatedFetch(url);
	if (!response.ok) {
		const error = await response.json();
		throw new Error(error.error || 'Failed to fetch OHLCV data');
	}
	const result = await response.json();
	// Handle wrapped response format {success: true, data: {...}}
	return result.data || result;
}

async function fetchIndicator(symbol, indicator, timeframe, bars, config = {}, analysisDate = null) {
	const configParam = encodeURIComponent(JSON.stringify(config));
	let url = `${API_BASE}/api/v1/indicators/${indicator}/series?symbol=${symbol}&timeframe=${timeframe}&bars=${bars}&config=${configParam}`;
	if (analysisDate) url += `&analysisDate=${encodeURIComponent(analysisDate)}`;

	const response = await authenticatedFetch(url);
	if (!response.ok) {
		const error = await response.json();
		throw new Error(error.error || `Failed to fetch ${indicator} indicator`);
	}
	const result = await response.json();
	// Handle wrapped response format {success: true, data: {...}}
	return result.data || result;
}

async function fetchRegime(symbol, timeframe, count, analysisDate = null) {
	let url = `${API_BASE}/api/v1/regime/detect?symbol=${symbol}&timeframe=${timeframe}&count=${count}`;
	if (analysisDate) url += `&analysisDate=${encodeURIComponent(analysisDate)}`;

	const response = await authenticatedFetch(url);
	if (!response.ok) {
		const error = await response.json();
		throw new Error(error.error?.message || error.error || 'Failed to fetch regime');
	}
	const result = await response.json();
	return result.data || result;
}

// Regime visualization state
let regimePriceLines = [];
let regimeMarkers = [];
let regimeHighlightSeries = null;

function clearRegimeVisualization() {
	// Remove price lines
	regimePriceLines.forEach(line => {
		try {
			candlestickSeries.removePriceLine(line);
		} catch (e) {
			console.debug('Could not remove price line:', e);
		}
	});
	regimePriceLines = [];

	// Clear markers
	if (candlestickSeries) candlestickSeries.setMarkers([]);
	regimeMarkers = [];

	// Remove highlight series
	if (regimeHighlightSeries && mainChart) {
		try {
			mainChart.removeSeries(regimeHighlightSeries);
		} catch (e) {
			console.debug('Could not remove highlight series:', e);
		}
		regimeHighlightSeries = null;
	}

	// Clear regime data in panel
	if (typeof clearRegimeInPanel === 'function') clearRegimeInPanel();
}

function displayRegimeOnChart(regimeData, barTime) {
	clearRegimeVisualization();

	if (!regimeData || !candlestickSeries) return;

	const { regime, regime_components, range_bounds } = regimeData;

	// Determine direction from regime name
	const isBullish = regime.includes('bull');
	const isBearish = regime.includes('bear');
	const isRange = regime.includes('range');

	// Get the candle data for the selected bar to create highlight
	const candleData = currentClickedData?.candleData;
	if (candleData && mainChart) {
		// Determine highlight color based on regime
		let highlightColor;
		if (isBullish) highlightColor = 'rgba(8, 153, 129, 0.3)'; // Green transparent
		else if (isBearish) highlightColor = 'rgba(242, 54, 69, 0.3)'; // Red transparent
		else if (isRange) highlightColor = 'rgba(255, 193, 7, 0.3)'; // Yellow/orange transparent
		else highlightColor = 'rgba(120, 123, 134, 0.3)'; // Gray transparent

		// Create a histogram series to highlight the bar
		regimeHighlightSeries = mainChart.addHistogramSeries({
			color: highlightColor,
			priceFormat: { type: 'price' },
			priceScaleId: '', // Overlay on main price scale
			lastValueVisible: false,
			priceLineVisible: false
		});

		// Set data point at the bar location
		regimeHighlightSeries.setData([{
			time: barTime,
			value: candleData.high,
			color: highlightColor
		}]);
	}

	// Add direction marker (arrow) on the selected bar
	if (isBullish || isBearish) {
		const marker = {
			time: barTime,
			position: isBullish ? 'belowBar' : 'aboveBar',
			color: isBullish ? '#089981' : '#F23645',
			shape: isBullish ? 'arrowUp' : 'arrowDown',
			text: regime.replace(/_/g, ' ').toUpperCase()
		};
		regimeMarkers.push(marker);
		candlestickSeries.setMarkers(regimeMarkers);
	} else if (isRange) {
		// For range regimes, add a square marker
		const marker = {
			time: barTime,
			position: 'aboveBar',
			color: '#FFC107',
			shape: 'square',
			text: regime.replace(/_/g, ' ').toUpperCase()
		};
		regimeMarkers.push(marker);
		candlestickSeries.setMarkers(regimeMarkers);
	}

	// Add horizontal lines for range bounds
	if (isRange && range_bounds && range_bounds.high && range_bounds.low) {
		const highLine = candlestickSeries.createPriceLine({
			price: range_bounds.high,
			color: '#F23645',
			lineWidth: 2,
			lineStyle: LightweightCharts.LineStyle.Dashed,
			axisLabelVisible: true,
			title: `R: ${range_bounds.high.toFixed(2)}`
		});
		regimePriceLines.push(highLine);

		const lowLine = candlestickSeries.createPriceLine({
			price: range_bounds.low,
			color: '#089981',
			lineWidth: 2,
			lineStyle: LightweightCharts.LineStyle.Dashed,
			axisLabelVisible: true,
			title: `S: ${range_bounds.low.toFixed(2)}`
		});
		regimePriceLines.push(lowLine);

		// Add midpoint line
		if (range_bounds.midpoint) {
			const midLine = candlestickSeries.createPriceLine({
				price: range_bounds.midpoint,
				color: '#787B86',
				lineWidth: 1,
				lineStyle: LightweightCharts.LineStyle.Dotted,
				axisLabelVisible: true,
				title: 'Mid'
			});
			regimePriceLines.push(midLine);
		}
	}

	// Show regime info in status
	let statusText = `Régime: ${regime.replace(/_/g, ' ').toUpperCase()}`;
	if (regime_components?.confidence) statusText += ` (${(regime_components.confidence * 100).toFixed(0)}%)`;
	if (isRange && range_bounds) statusText += ` | Range: ${range_bounds.low?.toFixed(2)} - ${range_bounds.high?.toFixed(2)}`;
	showStatus(statusText, 'success');
}

async function analyzeRegime() {
	// Check if we have a selected bar
	if (!currentClickedData || !currentClickedData.time) {
		showStatus('Sélectionnez d\'abord une bougie en cliquant dessus', 'error');
		return;
	}

	const symbol = document.getElementById('symbol').value;
	const timeframe = document.getElementById('timeframe').value;
	const bars = document.getElementById('bars').value;

	// Get original UTC timestamp from the map (populated during data transformation)
	const barTimestamp = originalTimestampMap.get(currentClickedData.time);
	if (!barTimestamp) {
		showStatus('Impossible de récupérer le timestamp original', 'error');
		return;
	}
	const analysisDate = new Date(barTimestamp).toISOString();

	showStatus('Analyse du régime en cours...', 'loading');

	try {
		const regimeData = await fetchRegime(symbol, timeframe, bars, analysisDate);
		displayRegimeOnChart(regimeData, currentClickedData.time);
		// Update data panel with regime info
		if (typeof updateRegimeInPanel === 'function') updateRegimeInPanel(regimeData);
		console.log('Regime data:', regimeData);
	} catch (error) {
		showStatus(`Erreur: ${error.message}`, 'error');
		console.error('Regime analysis error:', error);
	}
}

// Analyze regime for all visible bars and display direction arrows
async function analyzeAllRegimes() {
	clearRegimeVisualization();

	const symbol = document.getElementById('symbol').value;
	const timeframe = document.getElementById('timeframe').value;

	// Get confidence threshold from input (default 50%)
	const confidenceInput = document.getElementById('confidenceThreshold');
	const minConfidence = (confidenceInput ? parseFloat(confidenceInput.value) : 50) / 100;

	// Get all chart times from the timestamp map
	const chartTimes = Array.from(originalTimestampMap.keys()).sort((a, b) => a - b);

	if (chartTimes.length === 0) {
		showStatus('Aucune donnée à analyser', 'error');
		return;
	}

	showStatus(`Analyse des régimes (confiance ≥ ${Math.round(minConfidence * 100)}%)...`, 'loading');

	const markers = [];
	let processed = 0;
	let errors = 0;
	let filteredOut = 0;

	// Process bars in batches to avoid overwhelming the API
	const batchSize = 10;
	const delayBetweenBatches = 100; // ms

	for (let i = 0; i < chartTimes.length; i += batchSize) {
		const batch = chartTimes.slice(i, i + batchSize);

		const batchPromises = batch.map(async (chartTime) => {
			const originalTimestamp = originalTimestampMap.get(chartTime);
			if (!originalTimestamp) return { marker: null, filtered: false };

			try {
				const analysisDate = new Date(originalTimestamp).toISOString();
				// Use fewer bars for faster analysis (50 is enough for regime detection)
				const regimeData = await fetchRegime(symbol, timeframe, 50, analysisDate);

				if (regimeData && regimeData.direction) {
					const confidence = regimeData.confidence || 0;
					const isBullish = regimeData.direction === 'bullish';
					const isBearish = regimeData.direction === 'bearish';

					// Only show markers if confidence meets threshold
					if ((isBullish || isBearish) && confidence >= minConfidence) {
						return {
							marker: {
								time: chartTime,
								position: isBullish ? 'belowBar' : 'aboveBar',
								color: isBullish ? '#089981' : '#F23645',
								shape: isBullish ? 'arrowUp' : 'arrowDown',
								size: 1
							},
							filtered: false
						};
					} else if (isBullish || isBearish) {
						// Direction detected but confidence too low
						return { marker: null, filtered: true };
					}
				}
				return { marker: null, filtered: false };
			} catch (error) {
				console.warn(`Regime analysis failed for bar at ${chartTime}:`, error.message);
				return { marker: null, filtered: false, error: true };
			}
		});

		const results = await Promise.all(batchPromises);
		results.forEach(result => {
			if (result.marker) markers.push(result.marker);
			if (result.filtered) filteredOut++;
			if (result.error) errors++;
		});

		processed += batch.length;
		showStatus(`Analyse des régimes: ${processed}/${chartTimes.length} barres...`, 'loading');

		// Small delay between batches to prevent rate limiting
		if (i + batchSize < chartTimes.length) {
			await new Promise(resolve => setTimeout(resolve, delayBetweenBatches));
		}
	}

	// Sort markers by time and set them on the chart
	markers.sort((a, b) => a.time - b.time);
	regimeMarkers = markers;

	if (candlestickSeries) {
		candlestickSeries.setMarkers(markers);
	}

	const bullishCount = markers.filter(m => m.shape === 'arrowUp').length;
	const bearishCount = markers.filter(m => m.shape === 'arrowDown').length;
	const neutralCount = chartTimes.length - bullishCount - bearishCount - filteredOut;

	let statusMsg = `Régimes (≥${Math.round(minConfidence * 100)}%): ${bullishCount} ↑, ${bearishCount} ↓`;
	if (filteredOut > 0) statusMsg += `, ${filteredOut} filtrés`;
	if (neutralCount > 0) statusMsg += `, ${neutralCount} neutres`;
	if (errors > 0) statusMsg += ` (${errors} erreurs)`;

	showStatus(statusMsg, 'success');

	console.log('All regimes analyzed:', {
		total: chartTimes.length,
		bullish: bullishCount,
		bearish: bearishCount,
		neutral: neutralCount,
		filteredOut,
		errors,
		minConfidence
	});
}

// Data transformation
function transformOHLCVtoCandles(ohlcvData) {
	// LightweightCharts displays timestamps in browser local time
	// API sends UTC timestamps, we need to shift them to configured timezone

	// Get configured timezone offset from UTC
	const now = new Date();
	const utcDate = new Date(now.toLocaleString('en-US', { timeZone: 'UTC' }));
	const tzDate = new Date(now.toLocaleString('en-US', { timeZone: appTimezone }));
	const configuredOffset = tzDate - utcDate; // Offset in milliseconds

	console.log('Timezone adjustment for charts:', {
		appTimezone: appTimezone,
		configuredOffset: `${configuredOffset / 3600000}h (${configuredOffset}ms)`,
		browserOffset: `${now.getTimezoneOffset()}min`,
		example: `UTC timestamp will be shifted by ${configuredOffset}ms`,
	});

	// Support both old (bars) and new (data) format
	const dataSource = ohlcvData.data || ohlcvData.bars || [];

	// Clear and rebuild the timestamp map
	originalTimestampMap.clear();

	return dataSource.map((item) => {
		// New format: { timestamp, values: { open, high, low, close, volume } }
		// Old format: { timestamp, open, high, low, close, volume }
		const timestamp = item.timestamp;
		const values = item.values || item;
		const chartTime = (timestamp + configuredOffset) / 1000;

		// Store mapping from chart time to original UTC timestamp
		originalTimestampMap.set(chartTime, timestamp);

		return {
			time: chartTime,
			open: values.open,
			high: values.high,
			low: values.low,
			close: values.close,
		};
	});
}

function transformIndicatorToSeries(indicatorData, ohlcvData) {
	// Apply same timezone adjustment as candles
	const now = new Date();
	const utcDate = new Date(now.toLocaleString('en-US', { timeZone: 'UTC' }));
	const tzDate = new Date(now.toLocaleString('en-US', { timeZone: appTimezone }));
	const configuredOffset = tzDate - utcDate;

	// NEW FORMAT: { data: [{ timestamp, value/values }] }
	if (indicatorData.data && Array.isArray(indicatorData.data) && indicatorData.data.length > 0) {
		const firstPoint = indicatorData.data[0];

		// Check if composite indicator (has values object)
		if (firstPoint && firstPoint.values && typeof firstPoint.values === 'object') {
			const series = [];
			const componentKeys = Object.keys(firstPoint.values);

			// Extract each component as a separate series
			for (const key of componentKeys) {
				const data = indicatorData.data
					.map((point) => ({
						time: (point.timestamp + configuredOffset) / 1000,
						value: point.values[key],
					}))
					.filter((point) => point.value !== null && !isNaN(point.value));

				series.push({ name: key, data });
			}
			return series;
		}
		// Simple indicator (has single value)
		else if (firstPoint && 'value' in firstPoint) {
			const data = indicatorData.data
				.map((point) => ({
					time: (point.timestamp + configuredOffset) / 1000,
					value: point.value,
				}))
				.filter((point) => point.value !== null && !isNaN(point.value));

			return [{ name: indicatorData.indicator, data }];
		}
	}

	// OLD FORMAT FALLBACK: { values: [...] }
	const { values, components, bars } = indicatorData;
	const dataSource = ohlcvData.data || ohlcvData.bars || [];
	const allTimestamps = dataSource.map((item) => (item.timestamp + configuredOffset) / 1000);

	// Handle object-based indicators (like MACD)
	if (typeof values === 'object' && !Array.isArray(values)) {
		const series = [];

		// Extract each component as a separate series
		for (const [key, valueArray] of Object.entries(values)) {
			// Take the last N timestamps to match the indicator values
			const offset = allTimestamps.length - valueArray.length;
			const timestamps = allTimestamps.slice(offset);

			const data = valueArray
				.map((value, i) => ({
					time: timestamps[i],
					value: value,
				}))
				.filter((point) => point.value !== null && !isNaN(point.value));

			series.push({ name: key, data });
		}
		return series;
	}
	// Handle array-based indicators (like RSI, SMA, EMA)
	else if (Array.isArray(values)) {
		// Take the last N timestamps to match the indicator values
		const offset = allTimestamps.length - values.length;
		const timestamps = allTimestamps.slice(offset);

		const data = values
			.map((value, i) => ({
				time: timestamps[i],
				value: value,
			}))
			.filter((point) => point.value !== null && !isNaN(point.value));

		return [{ name: indicatorData.indicator, data }];
	}

	// Check if data array is empty (not enough valid points)
	if (indicatorData.data && Array.isArray(indicatorData.data) && indicatorData.data.length === 0)
		throw new Error(`No valid data points for ${indicatorData.indicator}. Try increasing the number of bars or check if the indicator has enough warmup period.`);

	console.error('Unknown indicator format. indicatorData:', {
		hasData: !!indicatorData.data,
		dataIsArray: Array.isArray(indicatorData.data),
		dataLength: indicatorData.data?.length,
		firstPoint: indicatorData.data?.[0],
		hasValues: !!indicatorData.values,
		valuesType: typeof indicatorData.values,
		indicator: indicatorData.indicator,
		components: indicatorData.components,
	});
	throw new Error(`Unknown indicator format for ${indicatorData.indicator}`);
}

// Chart updates
function updateMainChart(ohlcvData) {
	if (!candlestickSeries) throw new Error('Chart not initialized. Please refresh the page.');

	const candles = transformOHLCVtoCandles(ohlcvData);

	// Disable sync during data loading
	isSyncingCharts = true;
	try {
		candlestickSeries.setData(candles);
		// Force initial fit to ensure all data is visible
		mainChart.timeScale().fitContent();
	} finally {
		isSyncingCharts = false;
	}

	// Update chart info with timezone-aware formatting
	const chartInfo = document.getElementById('chartInfo');
	const firstDate = formatTimestamp(ohlcvData.firstTimestamp);
	const lastDate = formatTimestamp(ohlcvData.lastTimestamp);

	// Also show UTC time for comparison
	const lastDateUTC = new Date(ohlcvData.lastTimestamp).toISOString().replace('T', ' ').substring(0, 19);

	chartInfo.textContent = `${ohlcvData.count} barres | ${firstDate} - ${lastDate} (${appTimezone}) | UTC: ${lastDateUTC}`;
}

function clearAllIndicators() {
	// Clear overlay indicators from main chart
	indicatorSeries.forEach((series, key) => {
		if (key.includes('overlay')) mainChart.removeSeries(series);
	});

	// Clear oscillator chart
	indicatorSeries.forEach((series, key) => {
		if (key.includes('oscillator')) indicatorChart.removeSeries(series);
	});

	indicatorSeries.clear();
	seriesDisplayNames.clear();

	// Hide indicator chart wrapper if no oscillators
	const hasOscillators = Array.from(indicatorSeries.keys()).some((key) => key.includes('oscillator'));
	const wrapper = document.getElementById('indicatorChartWrapper');
	if (wrapper && !hasOscillators) wrapper.style.display = 'none';
}

// Add overlay indicator to main chart
function addOverlayIndicator(name, seriesDataArray) {
	const colors = ['#2962FF', '#F23645', '#089981', '#FF6D00', '#9C27B0'];

	seriesDataArray.forEach((seriesData, index) => {
		const seriesName = seriesData.name || name;
		// Get full description from catalog, or fallback to cleaned indicator name
		const catalogDescription = indicatorDescriptions.get(name);
		const displayName = catalogDescription
			? (seriesDataArray.length > 1 ? `${catalogDescription} - ${seriesName.toUpperCase()}` : catalogDescription)
			: name.replace(/_/g, ' ').toUpperCase();

		// Use only seriesName for the key if it's different from name, otherwise use name with index
		const key = seriesDataArray.length > 1
			? `${seriesName}_overlay_${index}`
			: `${seriesName}_overlay`;
		const color = colors[index % colors.length];

		const lineSeries = mainChart.addLineSeries({
			color: color,
			lineWidth: 2,
			title: displayName,
		});

		lineSeries.setData(seriesData.data);
		indicatorSeries.set(key, lineSeries);
		seriesDisplayNames.set(key, displayName); // Store display name for data panel
	});
}

// Add oscillator indicator to indicator chart
function addOscillatorIndicator(name, seriesDataArray) {
	const colors = ['#2962FF', '#F23645', '#089981', '#FF6D00', '#9C27B0'];

	// Show indicator chart wrapper if hidden
	const wrapper = document.getElementById('indicatorChartWrapper');
	if (wrapper) wrapper.style.display = 'block';

	// Disable sync during indicator loading
	const wasSyncing = isSyncingCharts;
	isSyncingCharts = true;

	try {
		seriesDataArray.forEach((seriesData, index) => {
			const seriesName = seriesData.name || name;
			// Get full description from catalog, or fallback to cleaned indicator name
			const catalogDescription = indicatorDescriptions.get(name);
			const displayName = catalogDescription
				? (seriesDataArray.length > 1 ? `${catalogDescription} - ${seriesName.toUpperCase()}` : catalogDescription)
				: name.replace(/_/g, ' ').toUpperCase();

			// Use only seriesName for the key if it's different from name, otherwise use name with index
			const key = seriesDataArray.length > 1
				? `${seriesName}_oscillator_${index}`
				: `${seriesName}_oscillator`;
			const color = colors[index % colors.length];

			const lineSeries = indicatorChart.addLineSeries({
				color: color,
				lineWidth: 2,
				title: displayName,
			});

			lineSeries.setData(seriesData.data);
			indicatorSeries.set(key, lineSeries);
			seriesDisplayNames.set(key, displayName); // Store display name for data panel
		});

		// Fit content after adding all series
		indicatorChart.timeScale().fitContent();

		// Trigger resize to ensure proper display
		resizeCharts();
	} finally {
		isSyncingCharts = wasSyncing;
	}
}

// Indicator configuration and metadata
const INDICATOR_CONFIGS = {
	// Moving Averages (Overlays)
	sma: { period: 20 },
	ema: { period: 20 },
	wma: { period: 20 },
	wsma: { period: 20 },
	dema: { period: 20 },
	rma: { period: 14 },
	dma: { period: 20 },
	sma15: { period: 15 },

	// Momentum (Oscillators)
	rsi: { period: 14 },
	macd: { fastPeriod: 12, slowPeriod: 26, signalPeriod: 9 },
	stochastic: { kPeriod: 14, dPeriod: 3, smooth: 3 },
	stochRsi: { period: 14, kPeriod: 3, dPeriod: 3 },
	williamsR: { period: 14 },
	cci: { period: 20 },
	roc: { period: 12 },
	mom: { period: 10 },

	// Volatility
	atr: { period: 14 },
	bb: { period: 20, stdDev: 2 },
	accelerationBands: { period: 20, factor: 2 },
	bbWidth: { period: 20, stdDev: 2 },
	iqr: { period: 14 },
	mad: { period: 14 },

	// Trend
	adx: { period: 14 },
	dx: { period: 14 },
	psar: { step: 0.02, max: 0.2 },
	tds: {},
	ichimoku: { conversionPeriod: 9, basePeriod: 26, spanPeriod: 52, displacement: 26 },

	// Volume
	obv: {},
	vwap: {},

	// Support/Resistance
	linearRegression: { period: 20 },
	zigzag: { deviation: 5 },

	// Advanced
	ao: { fastPeriod: 5, slowPeriod: 34 },
	ac: { fastPeriod: 5, slowPeriod: 34, signalPeriod: 5 },
	cg: { period: 10 },
	rei: { period: 14 },
	tr: {},
};

// Classify indicators as overlay or oscillator
const OVERLAY_INDICATORS = [
	// Moving averages - all overlay on price
	'sma',
	'ema',
	'wma',
	'wsma',
	'dema',
	'rma',
	'dma',
	'sma15',
	// Volatility bands
	'bb',
	'accelerationBands',
	// Trend overlays
	'psar',
	'ichimoku',
	// Support/Resistance
	'linearRegression',
	'zigzag',
	// Volume overlays
	'vwap',
];

const OSCILLATOR_INDICATORS = [
	// Momentum oscillators
	'rsi',
	'macd',
	'stochastic',
	'stochRsi',
	'williamsR',
	'cci',
	'roc',
	'mom',
	// Volatility oscillators
	'atr',
	'bbWidth',
	'iqr',
	'mad',
	// Trend oscillators
	'adx',
	'dx',
	// Volume oscillators
	'obv',
	// Advanced oscillators
	'ao',
	'ac',
	'cg',
	'rei',
	'tr',
	'tds',
];

async function addIndicator(name, symbol, timeframe, bars, analysisDate = null) {
	if (!currentData) throw new Error('OHLCV data not loaded');

	const config = INDICATOR_CONFIGS[name] || {};
	const isOverlay = OVERLAY_INDICATORS.includes(name);
	const isOscillator = OSCILLATOR_INDICATORS.includes(name);

	try {
		const data = await fetchIndicator(symbol, name, timeframe, bars, config, analysisDate);
		const series = transformIndicatorToSeries(data, currentData);

		if (isOverlay) addOverlayIndicator(name, series);

		if (isOscillator) addOscillatorIndicator(name, series);

		console.log(`Indicator ${name} added successfully`);

		// Resize charts to ensure proper display
		setTimeout(() => {
			if (typeof resizeCharts === 'function') resizeCharts();
		}, 100);
	} catch (error) {
		console.error(`Failed to add ${name} indicator:`, error);
		showStatus(`Erreur lors du chargement de l'indicateur ${name.toUpperCase()}: ${error.message}`, 'error');
		setTimeout(hideStatus, 3000);
	}
}
// Main load function
async function loadData() {
	const symbol = document.getElementById('symbol').value.trim().toUpperCase();
	const timeframe = document.getElementById('timeframe').value;
	const bars = parseInt(document.getElementById('bars').value);
	const analysisDateInput = document.getElementById('analysisDate').value;

	// Convert datetime-local to ISO string if provided
	let analysisDate = null;
	if (analysisDateInput) analysisDate = new Date(analysisDateInput).toISOString();

	if (!symbol) {
		showStatus('Veuillez entrer un symbole', 'error');
		setTimeout(hideStatus, 3000);
		return;
	}

	const loadBtn = document.getElementById('loadBtn');
	loadBtn.disabled = true;

	const statusMessage = analysisDate ? `Chargement des données OHLCV (backtesting au ${new Date(analysisDate).toLocaleString()})...` : 'Chargement des données OHLCV...';
	showStatus(statusMessage, 'loading');

	try {
		// Load OHLCV data
		const ohlcvData = await fetchOHLCV(symbol, timeframe, bars, analysisDate);
		currentData = ohlcvData;

		// Track loaded parameters
		lastLoadedParams = { symbol, timeframe, bars, analysisDate };

		// Update main chart
		updateMainChart(ohlcvData);

		// Update chart title with backtesting info
		let chartTitle = `${symbol} - ${timeframe}`;
		if (analysisDate) chartTitle += ` (Backtesting: ${new Date(analysisDate).toLocaleDateString()})`;

		document.getElementById('chartTitle').textContent = chartTitle;

		// Show/hide backtesting banner
		const backtestingInfo = document.getElementById('backtestingInfo');
		const backtestingDate = document.getElementById('backtestingDate');
		if (analysisDate) {
			backtestingDate.textContent = new Date(analysisDate).toLocaleString('fr-FR', {
				year: 'numeric',
				month: 'long',
				day: 'numeric',
				hour: '2-digit',
				minute: '2-digit',
			});
			backtestingInfo.style.display = 'block';
		} else {
			backtestingInfo.style.display = 'none';
		}

		showStatus('Données chargées avec succès', 'success');
		setTimeout(hideStatus, 2000);

		// Clear existing indicators
		clearAllIndicators();

		// Load selected indicators
		const selectedIndicators = Array.from(document.querySelectorAll('#indicatorList input:checked')).map((input) => input.value);

		if (selectedIndicators.length > 0) {
			showStatus(`Chargement de ${selectedIndicators.length} indicateur(s)...`, 'loading');

			for (const indicator of selectedIndicators) await addIndicator(indicator, symbol, timeframe, bars, analysisDate);

			// Force time scale synchronization after loading indicators
			const mainLogicalRange = mainChart.timeScale().getVisibleLogicalRange();
			if (mainLogicalRange) indicatorChart.timeScale().setVisibleLogicalRange(mainLogicalRange);

			showStatus('Tous les indicateurs ont été chargés', 'success');
			setTimeout(hideStatus, 2000);
		}
	} catch (error) {
		console.error('Error loading data:', error);
		showStatus(`Erreur: ${error.message}`, 'error');
	} finally {
		loadBtn.disabled = false;
	}
}

// Event listeners
document.getElementById('loadBtn').addEventListener('click', loadData);

// Clear date button handler
document.getElementById('clearDateBtn').addEventListener('click', () => {
	document.getElementById('analysisDate').value = '';
	document.getElementById('backtestingInfo').style.display = 'none';
	// Automatically reload data in real-time mode
	loadData();
});

// Handle indicator checkbox changes
document.querySelectorAll('#indicatorList input').forEach((checkbox) => {
	checkbox.addEventListener('change', async (e) => {
		if (!currentData) {
			showStatus("Veuillez d'abord charger les données OHLCV", 'error');
			e.target.checked = false;
			setTimeout(hideStatus, 3000);
			return;
		}

		const indicator = e.target.value;
		const symbol = document.getElementById('symbol').value.trim().toUpperCase();
		const timeframe = document.getElementById('timeframe').value;
		const bars = parseInt(document.getElementById('bars').value);

		if (e.target.checked) {
			await addIndicator(indicator, symbol, timeframe, bars);
		} else {
			// Remove indicator
			const keysToRemove = Array.from(indicatorSeries.keys()).filter((k) => k.startsWith(indicator));
			keysToRemove.forEach((key) => {
				const series = indicatorSeries.get(key);
				if (key.includes('overlay')) mainChart.removeSeries(series);
				else if (key.includes('oscillator')) indicatorChart.removeSeries(series);

				indicatorSeries.delete(key);
				seriesDisplayNames.delete(key);
			});

			// Hide oscillator chart if no oscillators remain
			const hasOscillators = Array.from(indicatorSeries.keys()).some((k) => k.includes('oscillator'));
			if (!hasOscillators) document.getElementById('indicatorChartWrapper').style.display = 'none';
		}
	});
});

// Enter key support
document.getElementById('symbol').addEventListener('keypress', (e) => {
	if (e.key === 'Enter') loadData();
});

// Track last loaded parameters to detect mismatches
let lastLoadedParams = null;

// Auto-reload when timeframe or bars change
document.getElementById('timeframe').addEventListener('change', async () => {
	if (currentData) {
		const newTimeframe = document.getElementById('timeframe').value;
		const newBars = parseInt(document.getElementById('bars').value);

		// Check if parameters have changed from last load
		if (lastLoadedParams && (lastLoadedParams.timeframe !== newTimeframe || lastLoadedParams.bars !== newBars)) {
			// Show loading status immediately
			showStatus('Changement de timeframe - Rechargement des données...', 'loading');
			await loadData();
		}
	}
});

document.getElementById('bars').addEventListener('change', async () => {
	if (currentData) {
		const newTimeframe = document.getElementById('timeframe').value;
		const newBars = parseInt(document.getElementById('bars').value);

		// Check if parameters have changed from last load
		if (lastLoadedParams && (lastLoadedParams.timeframe !== newTimeframe || lastLoadedParams.bars !== newBars)) {
			// Show loading status immediately
			showStatus('Changement du nombre de barres - Rechargement des données...', 'loading');
			await loadData();
		}
	}
});

// Initialize charts when everything is ready
async function tryInitCharts() {
	if (typeof LightweightCharts !== 'undefined' && window.lightweightChartsLoaded) {
		try {
			// Initialize auth client if available
			// Note: Authentication is now handled server-side via HTTP-only cookies
			// The server will redirect to /login.html if not authenticated
			if (window.authClient) {
				authClient = window.authClient;
				console.log('Auth client initialized');
			}

			// Load configuration first
			const config = await fetchConfig();
			if (config.timezone) {
				appTimezone = config.timezone;
				console.log('Timezone configured:', appTimezone);

				// Update timezone display with debug info
				const timezoneDisplay = document.getElementById('timezoneDisplay');
				if (timezoneDisplay) {
					const browserTZ = Intl.DateTimeFormat().resolvedOptions().timeZone;
					const tzOffset = new Date().getTimezoneOffset();
					timezoneDisplay.textContent = `Timezone: ${appTimezone} | Browser: ${browserTZ} (UTC${tzOffset > 0 ? '-' : '+'}${Math.abs(tzOffset / 60)})`;
				}

				// Debug: test timestamp formatting
				const testTimestamp = Date.now();
				console.log('Timezone test:');
				console.log('  Current timestamp:', testTimestamp);
				console.log('  UTC:', new Date(testTimestamp).toISOString());
				console.log('  Configured timezone (' + appTimezone + '):', formatTimestamp(testTimestamp));
				console.log('  Browser local:', new Date(testTimestamp).toLocaleString());
			}

			initCharts();
			console.log('Trading Indicators Visualizer initialized successfully');

			// Initialize data panel
			initDataPanel();

			// Setup chart click listeners for data panel
			setupChartClickListeners();

			// Build indicator UI from catalog
			buildIndicatorUI();

			// Setup regime button - analyzes all bars
			const regimeBtn = document.getElementById('regimeBtn');
			if (regimeBtn) regimeBtn.addEventListener('click', analyzeAllRegimes);
		} catch (error) {
			console.error('Failed to initialize charts:', error);
		}
	} else {
		console.log('Waiting for LightweightCharts to load...');
		setTimeout(tryInitCharts, 100);
	}
}

// Start initialization
if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', tryInitCharts);
else tryInitCharts();
