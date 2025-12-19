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
let appTimezone = 'Europe/Paris'; // Default, will be loaded from API

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
        },
        timeScale: {
            borderColor: '#2a2a2a',
            timeVisible: true,
            secondsVisible: false,
            // Enable scroll and zoom
            rightOffset: 10,
            barSpacing: 10,
            fixLeftEdge: false,
            lockVisibleTimeRangeOnResize: true,
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
        rightPriceScale: {
            borderColor: '#2a2a2a',
        },
        timeScale: {
            borderColor: '#2a2a2a',
            visible: true,
            timeVisible: true,
            secondsVisible: false,
            // Enable scroll and zoom
            rightOffset: 10,
            barSpacing: 10,
            fixLeftEdge: false,
            lockVisibleTimeRangeOnResize: true,
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

    // Synchronize time scales between main chart and indicator chart
    // Use flags to prevent infinite loops
    let syncingFromMain = false;
    let syncingFromIndicator = false;

    mainChart.timeScale().subscribeVisibleTimeRangeChange((timeRange) => {
        if (timeRange && !syncingFromIndicator) {
            syncingFromMain = true;
            try {
                indicatorChart.timeScale().setVisibleRange(timeRange);
            } catch (e) {
                // Ignore errors when indicator chart has no data yet
            }
            syncingFromMain = false;
        }
    });

    indicatorChart.timeScale().subscribeVisibleTimeRangeChange((timeRange) => {
        if (timeRange && !syncingFromMain) {
            syncingFromIndicator = true;
            try {
                mainChart.timeScale().setVisibleRange(timeRange);
            } catch (e) {
                // Ignore errors when main chart has no data yet
            }
            syncingFromIndicator = false;
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
        if (indicatorChartEl && indicatorChartEl.parentElement &&
            indicatorWrapper && indicatorWrapper.style.display !== 'none') {
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

// API calls
async function fetchConfig() {
    const response = await fetch(`${API_BASE}/api/v1/config`);
    if (!response.ok)
        throw new Error('Failed to fetch config');

    const result = await response.json();
    return result.data || result;
}

async function fetchCatalog() {
    const response = await fetch(`${API_BASE}/api/v1/catalog`);
    if (!response.ok)
        throw new Error('Failed to fetch catalog');

    const result = await response.json();
    return result.data || result;
}

async function fetchOHLCV(symbol, timeframe, bars) {
    const response = await fetch(`${API_BASE}/api/v1/ohlcv?symbol=${symbol}&timeframe=${timeframe}&count=${bars}`);
    if (!response.ok) {
        const error = await response.json();
        throw new Error(error.error || 'Failed to fetch OHLCV data');
    }
    const result = await response.json();
    // Handle wrapped response format {success: true, data: {...}}
    return result.data || result;
}

async function fetchIndicator(symbol, indicator, timeframe, bars, config = {}) {
    const configParam = encodeURIComponent(JSON.stringify(config));
    const response = await fetch(`${API_BASE}/api/v1/indicators/${indicator}?symbol=${symbol}&timeframe=${timeframe}&bars=${bars}&config=${configParam}`);
    if (!response.ok) {
        const error = await response.json();
        throw new Error(error.error || `Failed to fetch ${indicator} indicator`);
    }
    const result = await response.json();
    // Handle wrapped response format {success: true, data: {...}}
    return result.data || result;
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
        example: `UTC timestamp will be shifted by ${configuredOffset}ms`
    });

    // Support both old (bars) and new (data) format
    const dataSource = ohlcvData.data || ohlcvData.bars || [];

    return dataSource.map(item => {
        // New format: { timestamp, values: { open, high, low, close, volume } }
        // Old format: { timestamp, open, high, low, close, volume }
        const timestamp = item.timestamp;
        const values = item.values || item;

        return {
            time: (timestamp + configuredOffset) / 1000, // Add timezone offset and convert to seconds
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
                    .map(point => ({
                        time: (point.timestamp + configuredOffset) / 1000,
                        value: point.values[key],
                    }))
                    .filter(point => point.value !== null && !isNaN(point.value));

                series.push({ name: key, data });
            }
            return series;
        }
        // Simple indicator (has single value)
        else if (firstPoint && ('value' in firstPoint)) {
            const data = indicatorData.data
                .map(point => ({
                    time: (point.timestamp + configuredOffset) / 1000,
                    value: point.value,
                }))
                .filter(point => point.value !== null && !isNaN(point.value));

            return [{ name: indicatorData.indicator, data }];
        }
    }

    // OLD FORMAT FALLBACK: { values: [...] }
    const { values, components, bars } = indicatorData;
    const dataSource = ohlcvData.data || ohlcvData.bars || [];
    const allTimestamps = dataSource.map(item => (item.timestamp + configuredOffset) / 1000);

    // Handle object-based indicators (like MACD)
    if (typeof values === 'object' && !Array.isArray(values)) {
        const series = [];

        // Extract each component as a separate series
        for (const [key, valueArray] of Object.entries(values)) {
            // Take the last N timestamps to match the indicator values
            const offset = allTimestamps.length - valueArray.length;
            const timestamps = allTimestamps.slice(offset);

            const data = valueArray.map((value, i) => ({
                time: timestamps[i],
                value: value,
            })).filter(point => point.value !== null && !isNaN(point.value));

            series.push({ name: key, data });
        }
        return series;
    }
    // Handle array-based indicators (like RSI, SMA, EMA)
    else if (Array.isArray(values)) {
        // Take the last N timestamps to match the indicator values
        const offset = allTimestamps.length - values.length;
        const timestamps = allTimestamps.slice(offset);

        const data = values.map((value, i) => ({
            time: timestamps[i],
            value: value,
        })).filter(point => point.value !== null && !isNaN(point.value));

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
        components: indicatorData.components
    });
    throw new Error(`Unknown indicator format for ${indicatorData.indicator}`);
}

// Chart updates
function updateMainChart(ohlcvData) {
    if (!candlestickSeries) 
        throw new Error('Chart not initialized. Please refresh the page.');

    const candles = transformOHLCVtoCandles(ohlcvData);
    candlestickSeries.setData(candles);

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
        if (key.includes('overlay')) 
            mainChart.removeSeries(series);
        
    });

    // Clear oscillator chart
    indicatorSeries.forEach((series, key) => {
        if (key.includes('oscillator')) 
            indicatorChart.removeSeries(series);
        
    });

    indicatorSeries.clear();
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
    'sma', 'ema', 'wma', 'wsma', 'dema', 'rma', 'dma', 'sma15',
    // Volatility bands
    'bb', 'accelerationBands',
    // Trend overlays
    'psar', 'ichimoku',
    // Support/Resistance
    'linearRegression', 'zigzag',
    // Volume overlays
    'vwap',
];

const OSCILLATOR_INDICATORS = [
    // Momentum oscillators
    'rsi', 'macd', 'stochastic', 'stochRsi', 'williamsR', 'cci', 'roc', 'mom',
    // Volatility oscillators
    'atr', 'bbWidth', 'iqr', 'mad',
    // Trend oscillators
    'adx', 'dx',
    // Volume oscillators
    'obv',
    // Advanced oscillators
    'ao', 'ac', 'cg', 'rei', 'tr', 'tds',
];

async function addIndicator(name, symbol, timeframe, bars) {
    if (!currentData) 
        throw new Error('OHLCV data not loaded');

    const config = INDICATOR_CONFIGS[name] || {};
    const isOverlay = OVERLAY_INDICATORS.includes(name);
    const isOscillator = OSCILLATOR_INDICATORS.includes(name);

    try {
        const data = await fetchIndicator(symbol, name, timeframe, bars, config);
        const series = transformIndicatorToSeries(data, currentData);

        if (isOverlay) 
            addOverlayIndicator(name, series);

        if (isOscillator) 
            addOscillatorIndicator(name, series);

        console.log(`Indicator ${name} added successfully`);

        // Resize charts to ensure proper display
        setTimeout(() => {
            if (typeof resizeCharts === 'function') 
                resizeCharts();
            
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

    if (!symbol) {
        showStatus('Veuillez entrer un symbole', 'error');
        setTimeout(hideStatus, 3000);
        return;
    }

    const loadBtn = document.getElementById('loadBtn');
    loadBtn.disabled = true;
    showStatus('Chargement des données OHLCV...', 'loading');

    try {
        // Load OHLCV data
        const ohlcvData = await fetchOHLCV(symbol, timeframe, bars);
        currentData = ohlcvData;

        // Update main chart
        updateMainChart(ohlcvData);

        // Update chart title
        document.getElementById('chartTitle').textContent = `${symbol} - ${timeframe}`;

        showStatus('Données chargées avec succès', 'success');
        setTimeout(hideStatus, 2000);

        // Clear existing indicators
        clearAllIndicators();

        // Load selected indicators
        const selectedIndicators = Array.from(document.querySelectorAll('#indicatorList input:checked'))
            .map(input => input.value);

        if (selectedIndicators.length > 0) {
            showStatus(`Chargement de ${selectedIndicators.length} indicateur(s)...`, 'loading');

            for (const indicator of selectedIndicators) 
                await addIndicator(indicator, symbol, timeframe, bars);

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

// Handle indicator checkbox changes
document.querySelectorAll('#indicatorList input').forEach(checkbox => {
    checkbox.addEventListener('change', async (e) => {
        if (!currentData) {
            showStatus('Veuillez d\'abord charger les données OHLCV', 'error');
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
            const keysToRemove = Array.from(indicatorSeries.keys()).filter(k => k.startsWith(indicator));
            keysToRemove.forEach(key => {
                const series = indicatorSeries.get(key);
                if (key.includes('overlay')) 
                    mainChart.removeSeries(series);
                 else if (key.includes('oscillator')) 
                    indicatorChart.removeSeries(series);
                
                indicatorSeries.delete(key);
            });

            // Hide oscillator chart if no oscillators remain
            const hasOscillators = Array.from(indicatorSeries.keys()).some(k => k.includes('oscillator'));
            if (!hasOscillators) 
                document.getElementById('indicatorChartWrapper').style.display = 'none';
            
        }
    });
});

// Enter key support
document.getElementById('symbol').addEventListener('keypress', (e) => {
    if (e.key === 'Enter') loadData();
});

// Initialize charts when everything is ready
async function tryInitCharts() {
    if (typeof LightweightCharts !== 'undefined' && window.lightweightChartsLoaded) {
        try {
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
                    timezoneDisplay.textContent = `Timezone: ${appTimezone} | Browser: ${browserTZ} (UTC${tzOffset > 0 ? '-' : '+'}${Math.abs(tzOffset/60)})`;
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
        } catch (error) {
            console.error('Failed to initialize charts:', error);
        }
    } else {
        console.log('Waiting for LightweightCharts to load...');
        setTimeout(tryInitCharts, 100);
    }
}

// Start initialization
if (document.readyState === 'loading') 
    document.addEventListener('DOMContentLoaded', tryInitCharts);
 else 
    tryInitCharts();
