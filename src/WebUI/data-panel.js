// Data panel management - displays candle and indicator data on click

let dataPanelOpen = false;
let currentClickedData = null;
let currentRegimeData = null;

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

// Format timestamp to readable date
function formatDate(timestamp) {
    if (!timestamp) return '-';
    const date = new Date(timestamp * 1000); // Convert from seconds to milliseconds
    return date.toLocaleString('fr-FR', {
        timeZone: appTimezone,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit'
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
    html += `<div class="data-row"><span class="data-label">Date:</span><span class="data-value">${formatDate(time)}</span></div>`;
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

    // Add regime section if available
    if (currentRegimeData)
        html += buildRegimeSection(currentRegimeData);

    content.innerHTML = html;
}

// Copy regime data to clipboard as JSON
function copyRegimeToClipboard() {
    if (!currentRegimeData) return;

    // Build a clean object with displayed values
    const exportData = {
        regime: currentRegimeData.regime,
        direction: currentRegimeData.direction,
        confidence: currentRegimeData.confidence,
        components: currentRegimeData.components,
        thresholds: currentRegimeData.thresholds,
        trend_phase: currentRegimeData.trend_phase,
        volume_analysis: currentRegimeData.volume_analysis,
        compression: currentRegimeData.compression,
        breakout_quality: currentRegimeData.breakout_quality,
        range_bounds: currentRegimeData.range_bounds
    };

    // Add candle data if available
    if (currentClickedData) {
        exportData.candle = {
            time: currentClickedData.time,
            ...currentClickedData.candleData
        };
    }

    navigator.clipboard.writeText(JSON.stringify(exportData, null, 2))
        .then(() => {
            // Visual feedback - change icon temporarily
            const btn = document.getElementById('copyRegimeBtn');
            if (btn) {
                btn.textContent = '✓';
                btn.style.color = '#089981';
                setTimeout(() => {
                    btn.textContent = '📋';
                    btn.style.color = '';
                }, 1500);
            }
        })
        .catch(err => console.error('Failed to copy:', err));
}

// Build regime section HTML
function buildRegimeSection(regimeData) {
    if (!regimeData) return '';

    const { regime, direction, confidence, components, thresholds, trend_phase, volume_analysis, range_bounds, compression, breakout_quality } = regimeData;

    let html = '<div class="data-section">';
    html += '<div class="data-section-title" style="display: flex; justify-content: space-between; align-items: center;">';
    html += '<span>Régime</span>';
    html += '<span id="copyRegimeBtn" onclick="copyRegimeToClipboard()" style="cursor: pointer; font-size: 14px;" title="Copier en JSON">📋</span>';
    html += '</div>';

    // Regime type with color coding
    const regimeClass = direction === 'bullish' ? 'positive' : (direction === 'bearish' ? 'negative' : '');
    const regimeDisplay = regime.replace(/_/g, ' ').toUpperCase();
    html += `<div class="data-row"><span class="data-label">Type:</span><span class="data-value ${regimeClass}">${regimeDisplay}</span></div>`;

    // Direction
    const directionIcon = direction === 'bullish' ? '▲' : (direction === 'bearish' ? '▼' : '◆');
    html += `<div class="data-row"><span class="data-label">Direction:</span><span class="data-value ${regimeClass}">${directionIcon} ${direction}</span></div>`;

    // Confidence
    const confidencePercent = (confidence * 100).toFixed(0);
    html += `<div class="data-row"><span class="data-label">Confiance:</span><span class="data-value">${confidencePercent}%</span></div>`;

    // Components (ADX, ER, ATR ratio) with thresholds
    if (components) {
        const adxThreshold = thresholds?.adx?.trending || 25;
        const erThreshold = thresholds?.er?.trending || 0.5;
        const atrHighThreshold = thresholds?.atrRatio?.high || 1.3;

        const adxClass = components.adx >= adxThreshold ? 'positive' : '';
        const erClass = components.efficiency_ratio >= erThreshold ? 'positive' : '';
        const atrClass = components.atr_ratio > atrHighThreshold ? 'positive' : '';

        html += `<div class="data-row"><span class="data-label">ADX:</span><span class="data-value ${adxClass}">${formatNumber(components.adx, 1)} / ${formatNumber(adxThreshold, 1)}</span></div>`;
        html += `<div class="data-row"><span class="data-label">Efficiency Ratio:</span><span class="data-value ${erClass}">${formatNumber(components.efficiency_ratio, 2)} / ${formatNumber(erThreshold, 2)}</span></div>`;
        html += `<div class="data-row"><span class="data-label">ATR Ratio:</span><span class="data-value ${atrClass}">${formatNumber(components.atr_ratio, 2)} / ${formatNumber(atrHighThreshold, 2)}</span></div>`;
    }

    // Trend phase
    if (trend_phase && trend_phase.phase) {
        const phaseDisplay = trend_phase.phase.charAt(0).toUpperCase() + trend_phase.phase.slice(1);
        html += `<div class="data-row"><span class="data-label">Phase:</span><span class="data-value">${phaseDisplay}</span></div>`;
    }

    // Volume analysis
    if (volume_analysis) {
        const volClass = volume_analysis.is_spike ? 'positive' : '';
        html += `<div class="data-row"><span class="data-label">Volume Ratio:</span><span class="data-value ${volClass}">${formatNumber(volume_analysis.ratio, 2)}x${volume_analysis.is_spike ? ' (spike)' : ''}</span></div>`;
    }

    // Compression
    if (compression && compression.detected)
        html += `<div class="data-row"><span class="data-label">Compression:</span><span class="data-value">Oui (${(compression.ratio * 100).toFixed(0)}%)</span></div>`;

    // Breakout quality
    if (breakout_quality)
        html += `<div class="data-row"><span class="data-label">Qualité breakout:</span><span class="data-value">${breakout_quality.score}/100 (${breakout_quality.grade})</span></div>`;

    // Range bounds
    if (range_bounds) {
        html += '<div class="data-subsection">';
        html += '<div class="data-row"><span class="data-label">Résistance:</span><span class="data-value negative">${formatNumber(range_bounds.high, 2)} (${range_bounds.high_touches} touches)</span></div>'.replace('${formatNumber(range_bounds.high, 2)}', formatNumber(range_bounds.high, 2)).replace('${range_bounds.high_touches}', range_bounds.high_touches);
        html += '<div class="data-row"><span class="data-label">Support:</span><span class="data-value positive">${formatNumber(range_bounds.low, 2)} (${range_bounds.low_touches} touches)</span></div>'.replace('${formatNumber(range_bounds.low, 2)}', formatNumber(range_bounds.low, 2)).replace('${range_bounds.low_touches}', range_bounds.low_touches);
        html += `<div class="data-row"><span class="data-label">Largeur:</span><span class="data-value">${formatNumber(range_bounds.width_percent, 1)}% (${formatNumber(range_bounds.width_atr, 1)} ATR)</span></div>`;
        html += `<div class="data-row"><span class="data-label">Position:</span><span class="data-value">${(range_bounds.current_position * 100).toFixed(0)}% | ${range_bounds.proximity.replace(/_/g, ' ')}</span></div>`;
        html += `<div class="data-row"><span class="data-label">Force:</span><span class="data-value">${range_bounds.strength}</span></div>`;
        html += '</div>';
    }

    html += '</div>';
    return html;
}

// Update regime data and refresh panel
function updateRegimeInPanel(regimeData) {
    currentRegimeData = regimeData;
    // Refresh the panel if it's open and we have candle data
    if (dataPanelOpen && currentClickedData)
        updateDataPanel(currentClickedData.time, currentClickedData.candleData);
}

// Clear regime data
function clearRegimeInPanel() {
    currentRegimeData = null;
    if (dataPanelOpen && currentClickedData)
        updateDataPanel(currentClickedData.time, currentClickedData.candleData);
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

// Track last click event for modifier key detection
let lastClickEvent = null;

// Setup native click listener to capture modifier keys
function setupNativeClickListener() {
    const mainChartEl = document.getElementById('mainChart');
    if (mainChartEl) {
        mainChartEl.addEventListener('click', (e) => {
            lastClickEvent = e;
        }, true); // Capture phase to get event before LightweightCharts
    }
}

// Setup click listeners on charts
function setupChartClickListeners() {
    if (!mainChart || !candlestickSeries) return;

    // Setup native click listener to capture modifier keys
    setupNativeClickListener();

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

        if (candleData) {
            updateDataPanel(param.time, candleData);

            // If Shift is pressed, trigger regime analysis (Shift+click works on all platforms)
            const shiftPressed = lastClickEvent && lastClickEvent.shiftKey;
            lastClickEvent = null; // Reset after use

            if (shiftPressed && typeof analyzeRegime === 'function')
                analyzeRegime();
        }
    });
}
