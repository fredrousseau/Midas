/* exported initDataPanel, setupChartClickListeners, dataPanelOpen, currentClickedData */
/* global formatTimestamp, resizeCharts, indicatorSeries, seriesDisplayNames, mainChart, candlestickSeries */
// Data panel management - displays candle and indicator data on click

let dataPanelOpen = false;
let currentClickedData = null;

// Initialize data panel
function initDataPanel() {
    const closeBtn = document.getElementById('dataPanelClose');
    closeBtn.addEventListener('click', closeDataPanel);
}

// Open data panel
function openDataPanel() {
    const panel = document.getElementById('dataPanel');
    const mainContent = document.querySelector('.main-content');

    panel.classList.add('open');
    mainContent.classList.add('data-panel-open');
    dataPanelOpen = true;

    // Resize charts after animation completes
    setTimeout(() => {
        if (typeof resizeCharts === 'function') 
            resizeCharts();
        
    }, 350); // Wait for transition (300ms) + a bit more
}

// Close data panel
function closeDataPanel() {
    const panel = document.getElementById('dataPanel');
    const mainContent = document.querySelector('.main-content');

    panel.classList.remove('open');
    mainContent.classList.remove('data-panel-open');
    dataPanelOpen = false;
    currentClickedData = null;

    // Resize charts after animation completes
    setTimeout(() => {
        if (typeof resizeCharts === 'function') 
            resizeCharts();
        
    }, 350); // Wait for transition (300ms) + a bit more
}

// Format number with separators
function formatNumber(value, decimals = 2) {
    if (value === null || value === undefined || isNaN(value)) return '-';
    return Number(value).toLocaleString('fr-FR', {
        minimumFractionDigits: decimals,
        maximumFractionDigits: decimals
    });
}

// Update data panel with candle and indicator data
function updateDataPanel(time, candleData) {
    if (!time || !candleData) {
        closeDataPanel();
        return;
    }

    currentClickedData = { time, candleData };
    openDataPanel();

    const content = document.getElementById('dataPanelContent');
    let html = '';

    // Candle section
    html += '<div class="data-section">';
    html += '<div class="data-section-title">Bougie</div>';
    html += `<div class="data-row"><span class="data-label">Date:</span><span class="data-value">${time ? formatTimestamp(time * 1000) : '-'}</span></div>`;
    html += `<div class="data-row"><span class="data-label">Open:</span><span class="data-value">${formatNumber(candleData.open, 2)}</span></div>`;
    html += `<div class="data-row"><span class="data-label">High:</span><span class="data-value positive">${formatNumber(candleData.high, 2)}</span></div>`;
    html += `<div class="data-row"><span class="data-label">Low:</span><span class="data-value negative">${formatNumber(candleData.low, 2)}</span></div>`;
    html += `<div class="data-row"><span class="data-label">Close:</span><span class="data-value">${formatNumber(candleData.close, 2)}</span></div>`;

    // Calculate and display change
    const change = candleData.close - candleData.open;
    const changePercent = (change / candleData.open) * 100;
    const changeClass = change >= 0 ? 'positive' : 'negative';
    html += `<div class="data-row"><span class="data-label">Change:</span><span class="data-value ${changeClass}">${formatNumber(change, 2)} (${formatNumber(changePercent, 2)}%)</span></div>`;

    html += '</div>';

    // Get indicator values at this time
    const indicatorValues = getIndicatorValuesAtTime(time);

    if (Object.keys(indicatorValues).length > 0) {
        html += '<div class="data-section">';
        html += '<div class="data-section-title">Indicateurs</div>';

        for (const [name, value] of Object.entries(indicatorValues)) 
            html += `<div class="data-row"><span class="data-label">${name}:</span><span class="data-value">${formatNumber(value, 4)}</span></div>`;

        html += '</div>';
    }

    content.innerHTML = html;
}

// Get indicator values at specific time
function getIndicatorValuesAtTime(time) {
    const values = {};

    // Iterate through all indicator series
    indicatorSeries.forEach((series, key) => {
        // Skip reference lines and histograms
        if (key.includes('ref') || key.includes('histogram')) return;

        try {
            // Get the data for this series
            const seriesData = series.data ? series.data() : null;

            if (!seriesData) return;

            // Find the data point at this time
            const dataPoint = seriesData.find(point => point.time === time);

            if (dataPoint && dataPoint.value !== null && dataPoint.value !== undefined) {
                // Get display name from seriesDisplayNames Map, or fallback to cleaned key
                const displayName = seriesDisplayNames.get(key) || key
                    .replace('_overlay', '')
                    .replace('_oscillator', '')
                    .replace(/_/g, ' ')
                    .toUpperCase();

                values[displayName] = dataPoint.value;
            }
        } catch (e) {
            // Ignore errors for series that don't support data()
            console.debug('Could not get data for series:', key, e);
        }
    });

    return values;
}

// Setup click listeners on charts
function setupChartClickListeners() {
    if (!mainChart || !candlestickSeries) return;

    // Subscribe to crosshair move to get candle data
    mainChart.subscribeCrosshairMove((param) => {
        if (!param || !param.time || !param.point)
            // Don't close the panel on mouse move, only when explicitly closed
            return;

        // Get the candle data at this time
        const candleData = param.seriesData.get(candlestickSeries);

        if (candleData)
            // Store the data but don't auto-open, wait for click
            currentClickedData = { time: param.time, candleData };

    });

    // Subscribe to click events
    mainChart.subscribeClick((param) => {
        if (!param || !param.time)
            return;

        // Get the candle data at click time
        const candleData = param.seriesData.get(candlestickSeries);

        if (candleData) 
            updateDataPanel(param.time, candleData);
        
    });
}
