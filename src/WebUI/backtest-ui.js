/**
 * Backtest UI Logic - SIMPLE VERSION
 * Displays a table of all analysis results (not just entry signals)
 */

// Global state
let currentResults = null;

/**
 * Run backtest
 */
window.runBacktest = async function () {
	const symbol = document.getElementById('btSymbol').value.trim().toUpperCase();
	const interval = document.getElementById('btTimeframe').value;
	const startDate = document.getElementById('startDate').value;
	const endDate = document.getElementById('endDate').value;

	// Validation
	if (!symbol) {
		showStatus('error', 'Le symbole est requis');
		return;
	}

	if (!startDate || !endDate) {
		showStatus('error', 'Les dates de début et de fin sont requises');
		return;
	}

	if (new Date(startDate) >= new Date(endDate)) {
		showStatus('error', 'La date de début doit être avant la date de fin');
		return;
	}

	// Disable button
	const btn = document.getElementById('runBacktestBtn');
	btn.disabled = true;

	// Show loading status
	showStatus('loading', `Backtesting en cours pour ${symbol} sur ${interval}...`);

	// Hide results
	document.getElementById('resultsSection').classList.remove('visible');

	try {
		const response = await fetch('/api/v1/backtest', {
			method: 'POST',
			credentials: 'include',
			headers: {
				'Content-Type': 'application/json',
			},
			body: JSON.stringify({
				symbol,
				interval,
				startDate,
				endDate,
			}),
		});

		if (!response.ok) {
			let errorMessage = 'Erreur lors du backtest';
			try {
				const errorData = await response.json();
				console.error('Backend error response:', errorData);
				if (errorData.error && typeof errorData.error === 'object') {
					errorMessage = errorData.error.message || JSON.stringify(errorData.error);
				} else {
					errorMessage = errorData.error || errorData.message || JSON.stringify(errorData);
				}
			} catch (parseError) {
				const textError = await response.text();
				errorMessage = textError || `HTTP ${response.status}: ${response.statusText}`;
				console.error('Backend error (non-JSON):', errorMessage);
			}
			throw new Error(errorMessage);
		}

		const response_data = await response.json();
		const results = response_data.data;
		currentResults = results;

		showStatus('success', `Backtest terminé: ${results.total_intervals} intervalles analysés`);
		displayResults(results);
	} catch (error) {
		console.error('Backtest error:', error);
		showStatus('error', `Erreur: ${error.message}`);
	} finally {
		btn.disabled = false;
	}
};

/**
 * Display backtest results
 */
function displayResults(results) {
	const { period, total_intervals, results: data } = results;

	// Show results section
	document.getElementById('resultsSection').classList.add('visible');

	// Display summary
	displaySummary(results);

	// Display results table
	displayResultsTable(data);
}

/**
 * Display summary cards
 */
function displaySummary(results) {
	const summaryGrid = document.getElementById('summaryGrid');
	const { period, total_intervals, results: data } = results;

	// Count actions
	const actionCounts = {};
	data.forEach((row) => {
		const action = row.action || 'N/A';
		actionCounts[action] = (actionCounts[action] || 0) + 1;
	});

	// Build summary cards
	const cards = [
		{
			label: 'Intervalles',
			value: total_intervals.toLocaleString(),
			class: '',
		},
		{
			label: 'Période',
			value: `${period.days.toFixed(0)} jours`,
			class: '',
		},
	];

	// Add action count cards (top 4)
	const sortedActions = Object.entries(actionCounts)
		.sort((a, b) => b[1] - a[1])
		.slice(0, 4);

	sortedActions.forEach(([action, count]) => {
		let cardClass = '';
		if (action === 'LONG') cardClass = 'positive';
		else if (action === 'SHORT') cardClass = 'negative';

		cards.push({
			label: action,
			value: count.toLocaleString(),
			class: cardClass,
		});
	});

	summaryGrid.innerHTML = cards
		.map(
			(card) => `
        <div class="stat-card">
            <div class="stat-label">${card.label}</div>
            <div class="stat-value ${card.class}">${card.value}</div>
        </div>
    `
		)
		.join('');
}

/**
 * Display results table
 */
function displayResultsTable(data) {
	const section = document.getElementById('performanceSection');

	if (!data || data.length === 0) {
		section.innerHTML = '<h2>📊 Résultats</h2><p style="color: #aaa;">Aucun résultat</p>';
		return;
	}

	// Build table
	section.innerHTML = `
        <h2>📊 Résultats (${data.length} intervalles)</h2>
        <div style="overflow-x: auto; margin-top: 16px;">
            <table class="results-table">
                <thead>
                    <tr>
                        <th>Timestamp</th>
                        <th>Prix</th>
                        <th>Action</th>
                        <th>Confiance</th>
                        <th>Qualité</th>
                        <th>Phase</th>
                    </tr>
                </thead>
                <tbody>
                    ${data.map((row) => formatTableRow(row)).join('')}
                </tbody>
            </table>
        </div>
    `;
}

/**
 * Format a single table row
 */
function formatTableRow(row) {
	const timestamp = new Date(row.timestamp).toLocaleString('fr-FR');
	const price = row.price ? row.price.toFixed(2) : '-';
	const confidence = row.confidence ? `${(row.confidence * 100).toFixed(2)}%` : '-';
	const quality = row.quality ? `${(row.quality * 100).toFixed(2)}%` : '-';

	// Action styling
	let actionClass = '';
	if (row.action === 'LONG') actionClass = 'action-long';
	else if (row.action === 'SHORT') actionClass = 'action-short';
	else if (row.action === 'ERROR') actionClass = 'action-error';
	else if (row.action && row.action.includes('WAIT')) actionClass = 'action-wait';

	return `
        <tr>
            <td>${timestamp}</td>
            <td>${price}</td>
            <td class="${actionClass}">${row.action}</td>
            <td>${confidence}</td>
            <td>${quality}</td>
            <td>${row.phase || '-'}</td>
        </tr>
    `;
}

/**
 * Show status message
 */
function showStatus(type, message) {
	const statusDiv = document.getElementById('statusMessage');
	statusDiv.className = `status-message ${type}`;
	statusDiv.style.display = 'flex';

	if (type === 'loading') {
		statusDiv.innerHTML = `<div class="spinner"></div><span>${message}</span>`;
	} else {
		statusDiv.textContent = message;
	}

	if (type !== 'loading') {
		setTimeout(() => {
			statusDiv.classList.remove(type);
			statusDiv.style.display = 'none';
		}, 5000);
	}
}

/**
 * Export results as JSON
 */
window.exportJSON = function () {
	if (!currentResults) {
		showStatus('error', 'Aucun résultat à exporter');
		return;
	}

	const dataStr = JSON.stringify(currentResults, null, 2);
	const blob = new Blob([dataStr], { type: 'application/json' });
	const url = URL.createObjectURL(blob);
	const a = document.createElement('a');
	a.href = url;
	a.download = `backtest_${currentResults.symbol}_${new Date().toISOString()}.json`;
	a.click();
	URL.revokeObjectURL(url);

	showStatus('success', 'Résultats exportés en JSON');
};

/**
 * Export results as CSV
 */
window.exportCSV = function () {
	if (!currentResults || !currentResults.results) {
		showStatus('error', 'Aucun résultat à exporter');
		return;
	}

	const headers = ['Timestamp', 'Prix', 'Action', 'Confiance', 'Qualité', 'Phase'];
	const rows = currentResults.results.map((row) => [
		new Date(row.timestamp).toISOString(),
		row.price || '',
		row.action || '',
		row.confidence || '',
		row.quality || '',
		row.phase || '',
	]);

	const csv = [headers, ...rows].map((row) => row.join(',')).join('\n');
	const blob = new Blob([csv], { type: 'text/csv' });
	const url = URL.createObjectURL(blob);
	const a = document.createElement('a');
	a.href = url;
	a.download = `backtest_${currentResults.symbol}_${new Date().toISOString()}.csv`;
	a.click();
	URL.revokeObjectURL(url);

	showStatus('success', 'Résultats exportés en CSV');
};
