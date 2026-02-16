/* exported buildIndicatorUI */
// Build indicator UI dynamically from catalog

let _catalogData = null;

async function buildIndicatorUI() {
	try {
		const catalog = await fetchCatalog();
		_catalogData = catalog;

		const indicatorListEl = document.getElementById('indicatorList');
		indicatorListEl.innerHTML = '';

		const categoryNames = {
			movingAverages: 'Moyennes Mobiles',
			momentum: 'Momentum',
			volatility: 'Volatilité',
			trend: 'Tendance',
			volume: 'Volume',
			supportResistance: 'Support/Résistance',
			advanced: 'Avancé',
		};

		let totalIndicators = 0;
		for (const [_category, data] of Object.entries(catalog))
			if (data.indicators && Array.isArray(data.indicators))
				totalIndicators += data.indicators.length;

		document.getElementById('totalCount').textContent = totalIndicators;

		for (const [category, data] of Object.entries(catalog)) {
			if (!data.indicators || !Array.isArray(data.indicators)) continue;

			const categorySection = document.createElement('div');
			categorySection.className = 'indicator-category';

			const header = document.createElement('div');
			header.className = 'category-header';

			const categoryName = document.createElement('span');
			categoryName.className = 'category-name';
			categoryName.textContent = `${categoryNames[category] || category} (${data.indicators.length})`;

			const arrow = document.createElement('span');
			arrow.className = 'category-arrow';
			arrow.textContent = '▸';

			header.appendChild(categoryName);
			header.appendChild(arrow);
			categorySection.appendChild(header);

			const itemsContainer = document.createElement('div');
			itemsContainer.className = 'category-items';

			data.indicators.forEach(indicator => {
				const indicatorItem = document.createElement('div');
				indicatorItem.className = 'indicator-item';

				const indicatorKey = typeof indicator === 'string' ? indicator : indicator.key;
				const indicatorDesc = typeof indicator === 'string' ? indicator.toUpperCase() : indicator.description;
				const indicatorWarmup = typeof indicator === 'object' ? indicator.warmup : null;

				if (typeof indicator === 'object') {
					const displayText = indicatorWarmup
						? `${indicatorDesc} (${indicatorWarmup})`
						: indicatorDesc;
					indicatorDescriptions.set(indicatorKey, displayText);
				}

				const checkbox = document.createElement('input');
				checkbox.type = 'checkbox';
				checkbox.id = `ind-${indicatorKey}`;
				checkbox.value = indicatorKey;
				checkbox.dataset.category = category;

				const label = document.createElement('label');
				label.htmlFor = `ind-${indicatorKey}`;
				label.textContent = indicatorWarmup
					? `${indicatorDesc} (${indicatorWarmup})`
					: indicatorDesc;

				indicatorItem.appendChild(checkbox);
				indicatorItem.appendChild(label);
				itemsContainer.appendChild(indicatorItem);
			});

			categorySection.appendChild(itemsContainer);
			indicatorListEl.appendChild(categorySection);

			header.addEventListener('click', () => {
				const isOpen = header.classList.contains('open');
				if (isOpen) {
					header.classList.remove('open');
					itemsContainer.classList.remove('open');
				} else {
					header.classList.add('open');
					itemsContainer.classList.add('open');
				}
			});
		}

		attachIndicatorListeners();
		setupClearAllButton();
		setupSidebarToggle();
		setupIndicatorSearch();
	} catch (error) {
		console.error('Failed to build indicator UI:', error);
		showStatus(`Erreur lors du chargement du catalogue: ${error.message}`, 'error');
	}
}

function setupSidebarToggle() {
	const sidebar = document.getElementById('sidebar');
	const toggleBtn = document.getElementById('sidebarToggle');

	toggleBtn.addEventListener('click', () => {
		const isCollapsed = sidebar.classList.contains('collapsed');
		if (isCollapsed) {
			sidebar.classList.remove('collapsed');
			toggleBtn.classList.remove('sidebar-closed');
			toggleBtn.textContent = '‹';
		} else {
			sidebar.classList.add('collapsed');
			toggleBtn.classList.add('sidebar-closed');
			toggleBtn.textContent = '›';
		}

		setTimeout(() => resizeCharts(), 350);
	});
}

function attachIndicatorListeners() {
	document.querySelectorAll('#indicatorList input[type="checkbox"]').forEach(checkbox => {
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
				addToSelectedIndicators(indicator);
			} else {
				removeIndicator(indicator);
				removeFromSelectedIndicators(indicator);
			}

			updateIndicatorStats();
			updateSelectedIndicatorsVisibility();
		});
	});
}

function updateIndicatorStats() {
	const selectedCount = document.querySelectorAll('#indicatorList input[type="checkbox"]:checked').length;
	document.getElementById('selectedCount').textContent = selectedCount;

	const clearBtn = document.getElementById('clearAllBtn');
	if (selectedCount > 0)
		clearBtn.classList.remove('hidden');
	else
		clearBtn.classList.add('hidden');
}

function setupClearAllButton() {
	const clearBtn = document.getElementById('clearAllBtn');
	clearBtn.addEventListener('click', () => {
		document.querySelectorAll('#indicatorList input[type="checkbox"]:checked').forEach(checkbox => {
			checkbox.checked = false;
			removeIndicator(checkbox.value);
			removeFromSelectedIndicators(checkbox.value);
		});
		updateIndicatorStats();
		updateSelectedIndicatorsVisibility();
	});
}

function removeIndicator(name) {
	const keysToRemove = Array.from(indicatorSeries.keys()).filter(k => k.startsWith(name));
	keysToRemove.forEach(key => {
		const series = indicatorSeries.get(key);
		if (key.includes('overlay'))
			mainChart.removeSeries(series);
		else if (key.includes('oscillator'))
			indicatorChart.removeSeries(series);

		indicatorSeries.delete(key);
	});

	const hasOscillators = Array.from(indicatorSeries.keys()).some(k => k.includes('oscillator'));
	if (!hasOscillators)
		document.getElementById('indicatorChartWrapper').classList.add('hidden');

	const oscillatorNames = Array.from(indicatorSeries.keys())
		.filter(k => k.includes('oscillator'))
		.map(k => k.split('-')[0].toUpperCase())
		.filter((v, i, a) => a.indexOf(v) === i);

	document.getElementById('indicatorTitle').textContent = oscillatorNames.length > 0
		? `Indicateurs: ${oscillatorNames.join(', ')}`
		: 'Indicateurs';
}

function setupIndicatorSearch() {
	const searchInput = document.getElementById('indicatorSearch');

	searchInput.addEventListener('input', (e) => {
		const searchTerm = e.target.value.toLowerCase().trim();
		const categories = document.querySelectorAll('.indicator-category');

		categories.forEach(category => {
			const categoryHeader = category.querySelector('.category-header');
			const categoryItems = category.querySelector('.category-items');
			const items = category.querySelectorAll('.indicator-item');

			let hasVisibleItems = false;

			items.forEach(item => {
				const label = item.querySelector('label');
				const indicatorName = label.textContent.toLowerCase();

				if (searchTerm === '' || indicatorName.includes(searchTerm)) {
					item.style.display = 'flex';
					hasVisibleItems = true;
				} else {
					item.style.display = 'none';
				}
			});

			if (hasVisibleItems) {
				category.style.display = 'block';
				if (searchTerm !== '') {
					categoryHeader.classList.add('open');
					categoryItems.classList.add('open');
				} else {
					categoryHeader.classList.remove('open');
					categoryItems.classList.remove('open');
				}
			} else {
				category.style.display = 'none';
			}
		});
	});
}

// ─── Selected Indicators Section ────────────────────────────────────────────

const indicatorSettings = new Map();

function updateSelectedIndicatorsVisibility() {
	const section = document.getElementById('selectedIndicatorsSection');
	const selectedCount = document.querySelectorAll('#indicatorList input[type="checkbox"]:checked').length;

	if (selectedCount > 0)
		section.classList.remove('hidden');
	else
		section.classList.add('hidden');
}

function addToSelectedIndicators(indicatorName) {
	const list = document.getElementById('selectedIndicatorsList');

	let initialColor = '#2196F3';
	const firstSeriesKey = Array.from(indicatorSeries.keys()).find(key => key.startsWith(indicatorName));
	if (firstSeriesKey) {
		const series = indicatorSeries.get(firstSeriesKey);
		if (series?.options?.().color)
			initialColor = series.options().color;
	}

	indicatorSettings.set(indicatorName, { visible: true, color: initialColor });

	const item = document.createElement('div');
	item.className = 'selected-indicator-item';
	item.id = `selected-${indicatorName}`;

	const colorBox = document.createElement('div');
	colorBox.className = 'selected-indicator-color';
	colorBox.style.backgroundColor = initialColor;
	colorBox.title = 'Changer la couleur';
	colorBox.addEventListener('click', () => showSelectedColorPicker(indicatorName, colorBox));

	const name = document.createElement('div');
	name.className = 'selected-indicator-name';
	name.textContent = indicatorDescriptions.get(indicatorName) || indicatorName.toUpperCase();

	const controls = document.createElement('div');
	controls.className = 'selected-indicator-controls';

	const visibilityBtn = document.createElement('button');
	visibilityBtn.className = 'btn-ghost selected-indicator-btn';
	visibilityBtn.innerHTML = '👁';
	visibilityBtn.title = 'Masquer/Afficher';
	visibilityBtn.addEventListener('click', () => toggleSelectedIndicatorVisibility(indicatorName, visibilityBtn));

	const deleteBtn = document.createElement('button');
	deleteBtn.className = 'btn-ghost btn-ghost-danger selected-indicator-btn';
	deleteBtn.innerHTML = '✕';
	deleteBtn.title = 'Supprimer';
	deleteBtn.addEventListener('click', () => deleteSelectedIndicator(indicatorName));

	controls.appendChild(visibilityBtn);
	controls.appendChild(deleteBtn);

	item.appendChild(colorBox);
	item.appendChild(name);
	item.appendChild(controls);

	list.appendChild(item);
}

function removeFromSelectedIndicators(indicatorName) {
	const item = document.getElementById(`selected-${indicatorName}`);
	if (item) item.remove();
	indicatorSettings.delete(indicatorName);
}

function toggleSelectedIndicatorVisibility(indicatorName, btn) {
	const settings = indicatorSettings.get(indicatorName);
	if (!settings) return;

	const newVisibility = !settings.visible;
	settings.visible = newVisibility;

	Array.from(indicatorSeries.keys())
		.filter(key => key.startsWith(indicatorName))
		.forEach(key => {
			const series = indicatorSeries.get(key);
			if (series?.applyOptions)
				series.applyOptions({ visible: newVisibility });
		});

	btn.innerHTML = newVisibility ? '👁' : '👁‍🗨';
	btn.classList.toggle('hidden-indicator', !newVisibility);
}

function deleteSelectedIndicator(indicatorName) {
	const checkbox = document.getElementById(`ind-${indicatorName}`);
	if (checkbox) checkbox.checked = false;

	removeIndicator(indicatorName);
	removeFromSelectedIndicators(indicatorName);
	updateIndicatorStats();
	updateSelectedIndicatorsVisibility();
}

function showSelectedColorPicker(indicatorName, colorBox) {
	const colors = ['#2196F3', '#FF9800', '#9C27B0', '#4CAF50', '#F44336', '#00BCD4', '#FF5722', '#FFEB3B', '#E91E63'];

	const picker = document.createElement('div');
	picker.className = 'color-picker-popup';

	const rect = colorBox.getBoundingClientRect();
	picker.style.top = `${rect.bottom + 5}px`;
	picker.style.left = `${rect.left}px`;

	colors.forEach(color => {
		const option = document.createElement('div');
		option.className = 'color-picker-option';
		option.style.backgroundColor = color;

		option.addEventListener('click', () => {
			const settings = indicatorSettings.get(indicatorName);
			if (settings)
				settings.color = color;

			colorBox.style.backgroundColor = color;

			Array.from(indicatorSeries.keys())
				.filter(key => key.startsWith(indicatorName))
				.forEach(key => {
					const series = indicatorSeries.get(key);
					if (series?.applyOptions && !key.includes('ref') && !key.includes('histogram'))
						series.applyOptions({ color });
				});

			document.body.removeChild(picker);
		});

		picker.appendChild(option);
	});

	const closeHandler = (e) => {
		if (!picker.contains(e.target) && e.target !== colorBox) {
			if (document.body.contains(picker))
				document.body.removeChild(picker);
			document.removeEventListener('click', closeHandler);
		}
	};

	setTimeout(() => document.addEventListener('click', closeHandler), 0);
	document.body.appendChild(picker);
}
