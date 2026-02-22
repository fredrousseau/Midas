/* exported fetchCatalog, authenticatedFetch, mainChart, candlestickSeries, indicatorChart, indicatorSeries, seriesDisplayNames, appTimezone, isSyncingCharts, getTimezoneOffsetMs, formatTimestamp, resizeCharts */
// Configuration
const API_BASE = window.location.origin;

// State
let mainChart = null;
let candlestickSeries = null;
let indicatorChart = null;
let currentData = null;
let indicatorSeries = new Map();
let indicatorDescriptions = new Map();
let seriesDisplayNames = new Map();
let appTimezone = 'Europe/Paris';
let isSyncingCharts = false;

// Import auth client (will be loaded via script tag)
let authClient = null;

// ─── Utility functions ──────────────────────────────────────────────────────

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

/**
 * Compute the offset in milliseconds between UTC and the configured app timezone.
 * Cached per call — cheap enough for repeated use within a single data transform.
 */
function getTimezoneOffsetMs() {
	const now = new Date();
	const utcDate = new Date(now.toLocaleString('en-US', { timeZone: 'UTC' }));
	const tzDate = new Date(now.toLocaleString('en-US', { timeZone: appTimezone }));
	return tzDate - utcDate;
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

// ─── Charts initialization ──────────────────────────────────────────────────

function initCharts() {
	const mainChartEl = document.getElementById('mainChart');

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
			minimumWidth: 80,
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
			minimumWidth: 80,
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

	// Synchronize time scales using logical range
	mainChart.timeScale().subscribeVisibleLogicalRangeChange((logicalRange) => {
		if (isSyncingCharts || !logicalRange) return;
		const wrapper = document.getElementById('indicatorChartWrapper');
		if (!wrapper || wrapper.classList.contains('hidden')) return;

		isSyncingCharts = true;
		try {
			indicatorChart.timeScale().setVisibleLogicalRange(logicalRange);
		} catch (_e) {
			// Chart not ready
		} finally {
			isSyncingCharts = false;
		}
	});

	indicatorChart.timeScale().subscribeVisibleLogicalRangeChange((logicalRange) => {
		if (isSyncingCharts || !logicalRange) return;

		isSyncingCharts = true;
		try {
			mainChart.timeScale().setVisibleLogicalRange(logicalRange);
		} catch (_e) {
			// Chart not ready
		} finally {
			isSyncingCharts = false;
		}
	});

	// Synchronize crosshair
	function getCrosshairDataPoint(series, param) {
		if (!param || !param.time || !param.seriesData) return null;
		return param.seriesData.get(series) || null;
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

	window.addEventListener('resize', resizeCharts);
}

// ─── Chart resize ───────────────────────────────────────────────────────────

function resizeCharts() {
	if (mainChart) {
		const mainChartEl = document.getElementById('mainChart');
		if (mainChartEl?.parentElement) {
			const newWidth = mainChartEl.parentElement.clientWidth - 40;
			mainChart.applyOptions({ width: newWidth });
		}
	}

	if (indicatorChart) {
		const indicatorChartEl = document.getElementById('indicatorChart');
		const indicatorWrapper = document.getElementById('indicatorChartWrapper');

		if (indicatorChartEl?.parentElement && indicatorWrapper && !indicatorWrapper.classList.contains('hidden')) {
			const newWidth = indicatorChartEl.parentElement.clientWidth - 40;
			indicatorChart.applyOptions({ width: newWidth });
		}
	}
}

// ─── Authenticated fetch ────────────────────────────────────────────────────

async function authenticatedFetch(url, options = {}) {
	if (authClient && authClient.isAuthenticated()) return authClient.authenticatedFetch(url, options);
	return fetch(url, options);
}

// ─── API calls ──────────────────────────────────────────────────────────────

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

async function fetchOHLCV(symbol, timeframe, bars) {
	const url = `${API_BASE}/api/v1/market-data/ohlcv?symbol=${symbol}&timeframe=${timeframe}&count=${bars}`;

	const response = await authenticatedFetch(url);
	if (!response.ok) {
		const error = await response.json();
		throw new Error(error.error || 'Failed to fetch OHLCV data');
	}
	const result = await response.json();
	return result.data || result;
}

async function fetchIndicator(symbol, indicator, timeframe, bars, config = {}) {
	const configParam = encodeURIComponent(JSON.stringify(config));
	const url = `${API_BASE}/api/v1/indicators/${indicator}/series?symbol=${symbol}&timeframe=${timeframe}&bars=${bars}&config=${configParam}`;

	const response = await authenticatedFetch(url);
	if (!response.ok) {
		const error = await response.json();
		throw new Error(error.error || `Failed to fetch ${indicator} indicator`);
	}
	const result = await response.json();
	return result.data || result;
}

// ─── Data transformation ────────────────────────────────────────────────────

function transformOHLCVtoCandles(ohlcvData) {
	const configuredOffset = getTimezoneOffsetMs();
	const dataSource = ohlcvData.data || ohlcvData.bars || [];

	return dataSource.map((item) => {
		const timestamp = item.timestamp;
		const values = item.values || item;
		const chartTime = (timestamp + configuredOffset) / 1000;

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
	const configuredOffset = getTimezoneOffsetMs();

	// NEW FORMAT: { data: [{ timestamp, value/values }] }
	if (indicatorData.data && Array.isArray(indicatorData.data) && indicatorData.data.length > 0) {
		const firstPoint = indicatorData.data[0];

		// Composite indicator (has values object)
		if (firstPoint?.values && typeof firstPoint.values === 'object') {
			const series = [];
			for (const key of Object.keys(firstPoint.values)) {
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
		if (firstPoint && 'value' in firstPoint) {
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
	const { values } = indicatorData;
	const dataSource = ohlcvData.data || ohlcvData.bars || [];
	const allTimestamps = dataSource.map((item) => (item.timestamp + configuredOffset) / 1000);

	if (typeof values === 'object' && !Array.isArray(values)) {
		const series = [];
		for (const [key, valueArray] of Object.entries(values)) {
			const offset = allTimestamps.length - valueArray.length;
			const timestamps = allTimestamps.slice(offset);
			const data = valueArray
				.map((value, i) => ({ time: timestamps[i], value }))
				.filter((point) => point.value !== null && !isNaN(point.value));
			series.push({ name: key, data });
		}
		return series;
	} else if (Array.isArray(values)) {
		const offset = allTimestamps.length - values.length;
		const timestamps = allTimestamps.slice(offset);
		const data = values
			.map((value, i) => ({ time: timestamps[i], value }))
			.filter((point) => point.value !== null && !isNaN(point.value));
		return [{ name: indicatorData.indicator, data }];
	}

	if (indicatorData.data && Array.isArray(indicatorData.data) && indicatorData.data.length === 0)
		throw new Error(`No valid data points for ${indicatorData.indicator}. Try increasing the number of bars.`);

	throw new Error(`Unknown indicator format for ${indicatorData.indicator}`);
}

// ─── Chart updates ──────────────────────────────────────────────────────────

function updateMainChart(ohlcvData) {
	if (!candlestickSeries) throw new Error('Chart not initialized. Please refresh the page.');

	const candles = transformOHLCVtoCandles(ohlcvData);

	isSyncingCharts = true;
	try {
		candlestickSeries.setData(candles);
		mainChart.timeScale().fitContent();
	} finally {
		isSyncingCharts = false;
	}

	const chartInfo = document.getElementById('chartInfo');
	const firstDate = formatTimestamp(ohlcvData.firstTimestamp);
	const lastDate = formatTimestamp(ohlcvData.lastTimestamp);
	const lastDateUTC = new Date(ohlcvData.lastTimestamp).toISOString().replace('T', ' ').substring(0, 19);
	chartInfo.textContent = `${ohlcvData.count} barres | ${firstDate} - ${lastDate} (${appTimezone}) | UTC: ${lastDateUTC}`;
}

function clearAllIndicators() {
	indicatorSeries.forEach((series, key) => {
		if (key.includes('overlay')) mainChart.removeSeries(series);
	});
	indicatorSeries.forEach((series, key) => {
		if (key.includes('oscillator')) indicatorChart.removeSeries(series);
	});

	indicatorSeries.clear();
	seriesDisplayNames.clear();

	const hasOscillators = Array.from(indicatorSeries.keys()).some((key) => key.includes('oscillator'));
	const wrapper = document.getElementById('indicatorChartWrapper');
	if (wrapper && !hasOscillators) wrapper.classList.add('hidden');
}

// ─── Add indicators to charts ───────────────────────────────────────────────

function addOverlayIndicator(name, seriesDataArray) {
	const colors = ['#2962FF', '#F23645', '#089981', '#FF6D00', '#9C27B0'];

	seriesDataArray.forEach((seriesData, index) => {
		const seriesName = seriesData.name || name;
		const catalogDescription = indicatorDescriptions.get(name);
		const displayName = catalogDescription
			? (seriesDataArray.length > 1 ? `${catalogDescription} - ${seriesName.toUpperCase()}` : catalogDescription)
			: name.replace(/_/g, ' ').toUpperCase();

		const key = seriesDataArray.length > 1
			? `${seriesName}_overlay_${index}`
			: `${seriesName}_overlay`;
		const color = colors[index % colors.length];

		const lineSeries = mainChart.addLineSeries({
			color: color,
			lineWidth: 2,
			title: '',
		});

		lineSeries.setData(seriesData.data);
		indicatorSeries.set(key, lineSeries);
		seriesDisplayNames.set(key, displayName);
	});
}

function addOscillatorIndicator(name, seriesDataArray) {
	const colors = ['#2962FF', '#F23645', '#089981', '#FF6D00', '#9C27B0'];

	const wrapper = document.getElementById('indicatorChartWrapper');
	if (wrapper) wrapper.classList.remove('hidden');

	const wasSyncing = isSyncingCharts;
	isSyncingCharts = true;

	try {
		seriesDataArray.forEach((seriesData, index) => {
			const seriesName = seriesData.name || name;
			const catalogDescription = indicatorDescriptions.get(name);
			const displayName = catalogDescription
				? (seriesDataArray.length > 1 ? `${catalogDescription} - ${seriesName.toUpperCase()}` : catalogDescription)
				: name.replace(/_/g, ' ').toUpperCase();

			const key = seriesDataArray.length > 1
				? `${seriesName}_oscillator_${index}`
				: `${seriesName}_oscillator`;
			const color = colors[index % colors.length];

			const lineSeries = indicatorChart.addLineSeries({
				color: color,
				lineWidth: 2,
				title: '',
			});

			lineSeries.setData(seriesData.data);
			indicatorSeries.set(key, lineSeries);
			seriesDisplayNames.set(key, displayName);
		});

		indicatorChart.timeScale().fitContent();
		resizeCharts();
	} finally {
		isSyncingCharts = wasSyncing;
	}
}

// ─── Indicator configuration ────────────────────────────────────────────────

const INDICATOR_CONFIGS = {
	sma: { period: 20 }, ema: { period: 20 }, wma: { period: 20 }, wsma: { period: 20 },
	dema: { period: 20 }, rma: { period: 14 }, dma: { period: 20 }, sma15: { period: 15 },
	rsi: { period: 14 }, macd: { fastPeriod: 12, slowPeriod: 26, signalPeriod: 9 },
	stochastic: { kPeriod: 14, dPeriod: 3, smooth: 3 }, stochRsi: { period: 14, kPeriod: 3, dPeriod: 3 },
	williamsR: { period: 14 }, cci: { period: 20 }, roc: { period: 12 }, mom: { period: 10 },
	atr: { period: 14 }, bb: { period: 20, stdDev: 2 }, accelerationBands: { period: 20, factor: 2 },
	bbWidth: { period: 20, stdDev: 2 }, iqr: { period: 14 }, mad: { period: 14 },
	adx: { period: 14 }, dx: { period: 14 }, psar: { step: 0.02, max: 0.2 }, tds: {},
	ichimoku: { conversionPeriod: 9, basePeriod: 26, spanPeriod: 52, displacement: 26 },
	obv: {}, vwap: {},
	linearRegression: { period: 20 }, zigzag: { deviation: 5 },
	ao: { fastPeriod: 5, slowPeriod: 34 }, ac: { fastPeriod: 5, slowPeriod: 34, signalPeriod: 5 },
	cg: { period: 10 }, rei: { period: 14 }, tr: {},
};

const OVERLAY_INDICATORS = [
	'sma', 'ema', 'wma', 'wsma', 'dema', 'rma', 'dma', 'sma15',
	'bb', 'accelerationBands', 'psar', 'ichimoku', 'linearRegression', 'zigzag', 'vwap',
];

const OSCILLATOR_INDICATORS = [
	'rsi', 'macd', 'stochastic', 'stochRsi', 'williamsR', 'cci', 'roc', 'mom',
	'atr', 'bbWidth', 'iqr', 'mad', 'adx', 'dx', 'obv', 'ao', 'ac', 'cg', 'rei', 'tr', 'tds',
];

async function addIndicator(name, symbol, timeframe, bars) {
	if (!currentData) throw new Error('OHLCV data not loaded');

	const config = INDICATOR_CONFIGS[name] || {};
	const isOverlay = OVERLAY_INDICATORS.includes(name);
	const isOscillator = OSCILLATOR_INDICATORS.includes(name);

	try {
		const data = await fetchIndicator(symbol, name, timeframe, bars, config);
		const series = transformIndicatorToSeries(data, currentData);

		if (isOverlay) addOverlayIndicator(name, series);
		if (isOscillator) addOscillatorIndicator(name, series);

		setTimeout(() => resizeCharts(), 100);
	} catch (error) {
		console.error(`Failed to add ${name} indicator:`, error);
		showStatus(`Erreur lors du chargement de l'indicateur ${name.toUpperCase()}: ${error.message}`, 'error');
		setTimeout(hideStatus, 3000);
	}
}

// ─── Main load function ─────────────────────────────────────────────────────

async function loadData() {
	const symbol = document.getElementById('symbol').value.trim().toUpperCase();
	const timeframe = document.getElementById('timeframe').value;
	const bars = parseInt(document.getElementById('bars').value);

	if (!symbol) {
		showStatus('Veuillez entrer un symbole', 'error');
		setTimeout(hideStatus, 3000);
		return;
	}

	const loadBtn = document.getElementById('loadBtn');
	loadBtn.disabled = true;

	showStatus('Chargement des données OHLCV...', 'loading');

	try {
		const ohlcvData = await fetchOHLCV(symbol, timeframe, bars);
		currentData = ohlcvData;
		lastLoadedParams = { symbol, timeframe, bars };

		updateMainChart(ohlcvData);
		document.getElementById('chartTitle').textContent = `${symbol} - ${timeframe}`;

		showStatus('Données chargées avec succès', 'success');
		setTimeout(hideStatus, 2000);

		clearAllIndicators();

		const selectedIndicators = Array.from(document.querySelectorAll('#indicatorList input:checked')).map((input) => input.value);

		if (selectedIndicators.length > 0) {
			showStatus(`Chargement de ${selectedIndicators.length} indicateur(s)...`, 'loading');

			for (const indicator of selectedIndicators) await addIndicator(indicator, symbol, timeframe, bars);

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

// ─── Event listeners ────────────────────────────────────────────────────────

document.getElementById('loadBtn').addEventListener('click', loadData);

// Enter key on symbol input
document.getElementById('symbol').addEventListener('keypress', (e) => {
	if (e.key === 'Enter') {
		hideSymbolSuggestions();
		loadData();
	}
});

// ─── Symbol autocomplete (reusable) ─────────────────────────────────────────

function attachSymbolAutocomplete(inputEl, dropdownEl, onSelect) {
	let debounceId  = null;
	let activeIndex = -1;

	function hide() {
		dropdownEl.classList.add('hidden');
		dropdownEl.innerHTML = '';
		activeIndex = -1;
	}

	function show(results) {
		if (!results || results.length === 0) { hide(); return; }

		dropdownEl.innerHTML = results.map((r, i) => {
			const name     = r.name     ? `<span class="suggestion-name">${r.name}</span>` : '';
			const exchange = r.exchange ? `<span class="suggestion-exchange">${r.exchange}</span>` : '';
			const badge    = `<span class="suggestion-badge ${r._adapter || ''}">${r._adapter || ''}</span>`;
			return `<div class="symbol-suggestion-item" data-index="${i}" data-symbol="${r.symbol}">
				<span class="suggestion-symbol">${r.symbol}</span>${name}${exchange}${badge}
			</div>`;
		}).join('');

		dropdownEl.querySelectorAll('.symbol-suggestion-item').forEach(item => {
			item.addEventListener('mousedown', (e) => {
				e.preventDefault();
				inputEl.value = item.dataset.symbol;
				hide();
				onSelect(item.dataset.symbol);
			});
		});

		dropdownEl.classList.remove('hidden');
		activeIndex = -1;
	}

	function navigate(direction) {
		const items = dropdownEl.querySelectorAll('.symbol-suggestion-item');
		if (!items.length) return;
		items[activeIndex]?.classList.remove('active');
		activeIndex = (activeIndex + direction + items.length) % items.length;
		const active = items[activeIndex];
		active.classList.add('active');
		active.scrollIntoView({ block: 'nearest' });
	}

	inputEl.addEventListener('keydown', (e) => {
		if (e.key === 'ArrowDown') { e.preventDefault(); navigate(1); }
		if (e.key === 'ArrowUp')   { e.preventDefault(); navigate(-1); }
		if (e.key === 'Enter' && activeIndex >= 0) {
			const active = dropdownEl.querySelectorAll('.symbol-suggestion-item')[activeIndex];
			if (active) { inputEl.value = active.dataset.symbol; hide(); onSelect(active.dataset.symbol); }
		}
		if (e.key === 'Escape') hide();
	});

	inputEl.addEventListener('input', () => {
		clearTimeout(debounceId);
		const q = inputEl.value.trim();
		if (q.length < 2) { hide(); return; }
		debounceId = setTimeout(async () => {
			try {
				const res  = await authenticatedFetch(`${API_BASE}/api/v1/market-data/search?q=${encodeURIComponent(q)}`);
				const json = await res.json();
				if (json.success && json.data?.results) show(json.data.results);
			} catch (_err) { /* silently ignore search errors */ }
		}, 300);
	});

	document.addEventListener('click', (e) => {
		if (!inputEl.contains(e.target) && !dropdownEl.contains(e.target)) hide();
	});

	return { hide };
}

const _mainSymbolAc = attachSymbolAutocomplete(
	document.getElementById('symbol'),
	document.getElementById('symbol-suggestions'),
	() => loadData()
);

function resolveBenchmark(symbol) {
	// European equities
	if (symbol.endsWith('.PA')) return '^FCHI';
	if (symbol.endsWith('.L'))  return '^FTSE';
	if (symbol.endsWith('.DE')) return '^GDAXI';
	if (symbol.endsWith('.AS')) return '^AEX';
	if (symbol.endsWith('.MI')) return '^FTSEMIB';
	if (symbol.endsWith('.MC')) return '^IBEX';
	if (symbol.endsWith('.SW')) return '^SSMI';
	// Crypto (Binance-style pairs with quote currency suffix)
	if (/^[A-Z0-9]+(USDT|USDC|BUSD|FDUSD|BTC|ETH|BNB)$/.test(symbol)) return 'BTCUSDT';
	// US equities / NASDAQ-listed
	if (/^[A-Z]{1,5}$/.test(symbol)) return '^GSPC';
	return '^GSPC';
}

const _webhookSymbolAc = attachSymbolAutocomplete(
	document.getElementById('webhookSymbol'),
	document.getElementById('webhookSymbol-suggestions'),
	(symbol) => {
		document.getElementById('webhookSymbol').value = symbol;
		document.getElementById('webhookMarket').value = resolveBenchmark(symbol);
	}
);

// Update benchmark when webhook symbol is changed manually
document.getElementById('webhookSymbol').addEventListener('blur', () => {
	const sym = document.getElementById('webhookSymbol').value.trim().toUpperCase();
	if (sym) document.getElementById('webhookMarket').value = resolveBenchmark(sym);
});

function hideSymbolSuggestions() { _mainSymbolAc.hide(); }

// ─── Auto-reload on parameter change ────────────────────────────────────────

let lastLoadedParams = null;

function autoReloadIfChanged() {
	if (!currentData || !lastLoadedParams) return;
	const newTimeframe = document.getElementById('timeframe').value;
	const newBars = parseInt(document.getElementById('bars').value);
	if (lastLoadedParams.timeframe !== newTimeframe || lastLoadedParams.bars !== newBars)
		loadData();
}

document.getElementById('timeframe').addEventListener('change', autoReloadIfChanged);
document.getElementById('bars').addEventListener('change', autoReloadIfChanged);

// ─── Initialization ─────────────────────────────────────────────────────────

async function tryInitCharts() {
	if (typeof LightweightCharts !== 'undefined' && window.lightweightChartsLoaded) 
		try {
			if (window.authClient)
				authClient = window.authClient;

			const config = await fetchConfig();
			if (config.timezone)
				appTimezone = config.timezone;

			initCharts();
			initDataPanel();
			setupChartClickListeners();
			buildIndicatorUI();
		} catch (error) {
			console.error('Failed to initialize charts:', error);
		}
	 else 
		setTimeout(tryInitCharts, 100);
	
}

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', tryInitCharts);
else tryInitCharts();

// ─── Webhook Tab Logic ──────────────────────────────────────────────────────

(function initWebhookTab() {
	const webhookUrlInput = document.getElementById('webhookUrl');
	const webhookCallBtn = document.getElementById('webhookCallBtn');
	const webhookResult = document.getElementById('webhookResult');
	const webhookResultUrl = document.getElementById('webhookResultUrl');
	const webhookStatus = document.getElementById('webhookStatus');

	if (!webhookUrlInput || !webhookCallBtn) return;

	// Set default analysis date to now
	const webhookDateInput = document.getElementById('webhookReferenceDate');
	if (webhookDateInput && !webhookDateInput.value) {
		const now = new Date();
		now.setMinutes(now.getMinutes() - now.getTimezoneOffset());
		webhookDateInput.value = now.toISOString().slice(0, 16);
	}

	// Restore saved webhook URL from localStorage
	const savedUrl = localStorage.getItem('webhookUrl');
	if (savedUrl) webhookUrlInput.value = savedUrl;

	webhookUrlInput.addEventListener('input', () => {
		localStorage.setItem('webhookUrl', webhookUrlInput.value.trim());
	});

	let _webhookTimerInterval = null;

	function showWebhookStatus(message, type = 'loading') {
		if (type === 'loading')
			webhookStatus.innerHTML = `<span class="status-spinner"></span><span class="status-text">${message}</span>`;
		else
			webhookStatus.textContent = message;

		webhookStatus.className = `status ${type}`;
		webhookStatus.style.display = type === 'loading' ? 'flex' : 'block';
	}

	function startWebhookTimer() {
		const start = Date.now();
		_webhookTimerInterval = setInterval(() => {
			const elapsed = ((Date.now() - start) / 1000).toFixed(1);
			const textEl = webhookStatus.querySelector('.status-text');
			if (textEl) textEl.textContent = `Appel en cours... ${elapsed}s`;
		}, 100);
	}

	function stopWebhookTimer() {
		clearInterval(_webhookTimerInterval);
		_webhookTimerInterval = null;
	}

	function hideWebhookStatus() {
		stopWebhookTimer();
		webhookStatus.style.display = 'none';
	}

	webhookCallBtn.addEventListener('click', async () => {
		const baseUrl = webhookUrlInput.value.trim();
		if (!baseUrl) {
			showWebhookStatus('Veuillez saisir une URL de webhook', 'error');
			setTimeout(hideWebhookStatus, 3000);
			return;
		}

		const symbol = document.getElementById('webhookSymbol').value.trim().toUpperCase();
		const market = document.getElementById('webhookMarket').value.trim();
		const referenceDate = document.getElementById('webhookReferenceDate').value;
		const long = document.getElementById('webhookLong').value;
		const medium = document.getElementById('webhookMedium').value;
		const short = document.getElementById('webhookShort').value;

		const params = new URLSearchParams();
		if (symbol) params.set('symbol', symbol);
		if (market) params.set('benchmark', market);
		if (referenceDate) params.set('referenceDate', new Date(referenceDate).toISOString());
		params.set('longTimeframe', long);
		params.set('mediumTimeframe', medium);
		params.set('shortTimeframe', short);

		const separator = baseUrl.includes('?') ? '&' : '?';
		const fullUrl = `${baseUrl}${separator}${params.toString()}`;

		webhookResultUrl.textContent = fullUrl;
		showWebhookStatus('Appel en cours... 0.0s', 'loading');
		startWebhookTimer();
		webhookCallBtn.disabled = true;

		try {
			const response = await fetch(fullUrl);
			const text = await response.text();

			if (text) {
				const renderMarkdown = (md) => {
					if (window.marked)
						webhookResult.innerHTML = window.marked.parse(md);
					else
						webhookResult.textContent = md;
				};

				try {
					const json = JSON.parse(text);
					renderMarkdown(JSON.stringify(json, null, 2));
				} catch {
					renderMarkdown(text);
				}
			} else {
				webhookResult.textContent = '(Reponse vide)';
			}

			if (response.ok)
				showWebhookStatus(`Succes (${response.status})`, 'success');
			else
				showWebhookStatus(`Erreur HTTP ${response.status}`, 'error');

		} catch (err) {
			webhookResult.textContent = err.message;
			showWebhookStatus(`Echec de l'appel: ${err.message}`, 'error');
		} finally {
			stopWebhookTimer();
			webhookCallBtn.disabled = false;
			setTimeout(hideWebhookStatus, 5000);
		}
	});
})();
