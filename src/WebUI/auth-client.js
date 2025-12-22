/**
 * WebUI Authentication Client
 * Handles JWT token storage, retrieval, and automatic refresh
 */

const AUTH_STORAGE_KEY = 'midas_auth_tokens';
const API_BASE = window.location.origin;

/**
 * Authentication Client Class
 */
class AuthClient {
	constructor() {
		this.tokens = this.loadTokens();
		this.refreshTimer = null;
		this.setupAutoRefresh();
	}

	/**
	 * Load tokens from localStorage
	 * @returns {Object|null} Tokens object or null
	 */
	loadTokens() {
		try {
			const stored = localStorage.getItem(AUTH_STORAGE_KEY);
			if (!stored) return null;

			const tokens = JSON.parse(stored);

			// Check if access token is expired
			if (this.isTokenExpired(tokens.access_token)) 
				console.log('Access token expired, will need refresh');

			return tokens;
		} catch (error) {
			console.error('Error loading tokens:', error);
			return null;
		}
	}

	/**
	 * Save tokens to localStorage
	 * @param {Object} tokens - Tokens object
	 */
	saveTokens(tokens) {
		try {
			localStorage.setItem(AUTH_STORAGE_KEY, JSON.stringify(tokens));
			this.tokens = tokens;
			this.setupAutoRefresh();
		} catch (error) {
			console.error('Error saving tokens:', error);
		}
	}

	/**
	 * Clear tokens from localStorage
	 */
	clearTokens() {
		localStorage.removeItem(AUTH_STORAGE_KEY);
		this.tokens = null;
		if (this.refreshTimer) {
			clearTimeout(this.refreshTimer);
			this.refreshTimer = null;
		}
	}

	/**
	 * Decode JWT token (without verification - this is done server-side)
	 * @param {string} token - JWT token
	 * @returns {Object|null} Decoded payload or null
	 */
	decodeToken(token) {
		try {
			const parts = token.split('.');
			if (parts.length !== 3) return null;

			const payload = JSON.parse(atob(parts[1]));
			return payload;
		} catch (error) {
			console.error('Error decoding token:', error);
			return null;
		}
	}

	/**
	 * Check if token is expired
	 * @param {string} token - JWT token
	 * @returns {boolean} True if expired
	 */
	isTokenExpired(token) {
		const payload = this.decodeToken(token);
		if (!payload || !payload.exp) return true;

		// Add 60 second buffer
		const expirationTime = payload.exp * 1000;
		const now = Date.now();

		return now >= (expirationTime - 60000);
	}

	/**
	 * Get valid access token (refreshes if needed)
	 * @returns {Promise<string|null>} Access token or null
	 */
	async getAccessToken() {
		if (!this.tokens) return null;

		// If access token is still valid, return it
		if (!this.isTokenExpired(this.tokens.access_token)) 
			return this.tokens.access_token;

		// Try to refresh
		console.log('Access token expired, attempting refresh...');
		const refreshed = await this.refreshToken();

		if (refreshed) 
			return this.tokens.access_token;

		// Refresh failed, clear tokens and redirect to login
		this.clearTokens();
		return null;
	}

	/**
	 * Login with username and password
	 * @param {string} username - Username
	 * @param {string} password - Password
	 * @returns {Promise<Object>} Result object { success: boolean, error?: string }
	 */
	async login(username, password) {
		try {
			const response = await fetch(`${API_BASE}/webui/login`, {
				method: 'POST',
				headers: {
					'Content-Type': 'application/json',
				},
				body: JSON.stringify({ username, password }),
			});

			if (!response.ok) {
				const error = await response.json();
				return {
					success: false,
					error: error.error_description || 'Login failed',
				};
			}

			const tokens = await response.json();
			this.saveTokens(tokens);

			return { success: true };
		} catch (error) {
			console.error('Login error:', error);
			return {
				success: false,
				error: 'Network error or server unavailable',
			};
		}
	}

	/**
	 * Refresh access token using refresh token
	 * @returns {Promise<boolean>} True if refresh successful
	 */
	async refreshToken() {
		if (!this.tokens || !this.tokens.refresh_token) 
			return false;

		try {
			const response = await fetch(`${API_BASE}/webui/refresh`, {
				method: 'POST',
				headers: {
					'Content-Type': 'application/json',
				},
				body: JSON.stringify({
					refresh_token: this.tokens.refresh_token,
				}),
			});

			if (!response.ok) {
				console.error('Token refresh failed');
				return false;
			}

			const tokens = await response.json();
			this.saveTokens(tokens);

			console.log('Token refreshed successfully');
			return true;
		} catch (error) {
			console.error('Token refresh error:', error);
			return false;
		}
	}

	/**
	 * Logout
	 * @returns {Promise<void>}
	 */
	async logout() {
		try {
			// Call logout endpoint (for server-side cleanup if needed)
			const token = await this.getAccessToken();
			if (token) 
				await fetch(`${API_BASE}/webui/logout`, {
					method: 'POST',
					headers: {
						'Authorization': `Bearer ${token}`,
						'Content-Type': 'application/json',
					},
				});
			
		} catch (error) {
			console.error('Logout error:', error);
		} finally {
			// Always clear tokens client-side
			this.clearTokens();
		}
	}

	/**
	 * Check if user is authenticated
	 * @returns {boolean} True if authenticated
	 */
	isAuthenticated() {
		return this.tokens !== null;
	}

	/**
	 * Setup automatic token refresh
	 */
	setupAutoRefresh() {
		// Clear existing timer
		if (this.refreshTimer) {
			clearTimeout(this.refreshTimer);
			this.refreshTimer = null;
		}

		if (!this.tokens || !this.tokens.access_token) 
			return;

		const payload = this.decodeToken(this.tokens.access_token);
		if (!payload || !payload.exp) 
			return;

		// Calculate time until token expires (refresh 5 minutes before expiration)
		const expirationTime = payload.exp * 1000;
		const refreshTime = expirationTime - Date.now() - (5 * 60 * 1000);

		if (refreshTime > 0) {
			console.log(`Auto-refresh scheduled in ${Math.round(refreshTime / 1000 / 60)} minutes`);
			this.refreshTimer = setTimeout(async () => {
				console.log('Auto-refreshing token...');
				await this.refreshToken();
			}, refreshTime);
		}
	}

	/**
	 * Make authenticated API request
	 * @param {string} url - URL to fetch
	 * @param {Object} options - Fetch options
	 * @returns {Promise<Response>} Fetch response
	 */
	async authenticatedFetch(url, options = {}) {
		const token = await this.getAccessToken();

		if (!token) 
			throw new Error('Not authenticated');

		// Add authorization header
		const headers = options.headers || {};
		headers['Authorization'] = `Bearer ${token}`;

		return fetch(url, { ...options, headers });
	}
}

// Export singleton instance
const authClient = new AuthClient();
window.authClient = authClient;

// Export for ES6 modules
export default authClient;
