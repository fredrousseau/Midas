import { z } from 'zod';

/**
 * WebUI Authentication Service
 * Handles simple username/password authentication for WebUI access
 * Works in conjunction with OAuthService for token generation
 */
export class WebUIAuthService {
	/**
	 * Create a WebUIAuthService instance
	 * @param {Object} parameters - Configuration parameters
	 * @param {Object} parameters.logger - Logger instance
	 * @param {Object} parameters.oauthService - OAuthService instance for token generation
	 * @throws {Error} If required parameters are not provided
	 */
	constructor(parameters) {
		this.logger = parameters.logger || null;
		this.oauthService = parameters.oauthService || null;

		if (!this.logger) throw new Error('WebUIAuthService requires a logger instance');
		if (!this.oauthService) throw new Error('WebUIAuthService requires an oauthService instance');

		// Load credentials from environment
		this.username = process.env.WEBUI_USERNAME || 'admin';
		this.password = process.env.WEBUI_PASSWORD || null;

		if (!this.password) {
			this.logger.warn('WEBUI_PASSWORD not set in .env - WebUI authentication will be insecure!');
			this.password = 'admin'; // Default fallback (insecure)
		}

		// Validation schema for login
		this.loginSchema = z.object({
			username: z.string().min(1).max(255),
			password: z.string().min(1),
		});

		this.logger.info(`WebUI Authentication initialized - Username: ${this.username}`);
	}

	/**
	 * Validate username and password
	 * @param {string} username - Username to validate
	 * @param {string} password - Password to validate
	 * @returns {Object} Validation result { valid: boolean, error?: string }
	 */
	validateCredentials(username, password) {
		// Validate input
		const validation = this.loginSchema.safeParse({ username, password });
		if (!validation.success) 
			return { valid: false, error: 'Invalid credentials format' };

		// Check credentials (constant-time comparison to prevent timing attacks)
		const usernameMatch = this.constantTimeCompare(username, this.username);
		const passwordMatch = this.constantTimeCompare(password, this.password);

		if (!usernameMatch || !passwordMatch) {
			this.logger.warn(`Failed WebUI login attempt for username: ${username}`);
			return { valid: false, error: 'Invalid username or password' };
		}

		this.logger.info(`Successful WebUI login for username: ${username}`);
		return { valid: true };
	}

	/**
	 * Constant-time string comparison to prevent timing attacks
	 * @param {string} a - First string
	 * @param {string} b - Second string
	 * @returns {boolean} True if strings are equal
	 */
	constantTimeCompare(a, b) {
		if (typeof a !== 'string' || typeof b !== 'string') return false;

		const aLen = Buffer.byteLength(a);
		const bLen = Buffer.byteLength(b);

		// Always compare same length to prevent timing attacks
		const bufA = Buffer.alloc(Math.max(aLen, bLen), 0);
		const bufB = Buffer.alloc(Math.max(aLen, bLen), 0);

		bufA.write(a);
		bufB.write(b);

		let result = aLen === bLen ? 0 : 1;
		for (let i = 0; i < bufA.length; i++) 
			result |= bufA[i] ^ bufB[i];

		return result === 0;
	}

	/**
	 * Create a simple access token for WebUI (wrapper around OAuthService)
	 * @param {string} username - Username to include in token
	 * @returns {Object} Token object with access_token and expires_in
	 */
	createWebUIToken(username) {
		const accessTokenDuration = parseInt(process.env.OAUTH_ACCESS_TOKEN_DURATION, 10) * 60;
		const refreshTokenDuration = parseInt(process.env.OAUTH_REFRESH_TOKEN_DURATION, 10) * 60;

		// Create tokens using OAuthService with webui scope
		const accessToken = this.oauthService.createToken(username, accessTokenDuration, {
			scope: 'webui',
			type: 'webui_access'
		});

		const refreshToken = this.oauthService.createToken(username, refreshTokenDuration, {
			scope: 'webui',
			type: 'webui_refresh'
		});

		return {
			access_token: accessToken,
			refresh_token: refreshToken,
			token_type: 'Bearer',
			expires_in: accessTokenDuration,
		};
	}

	/**
	 * Validate a WebUI token
	 * @param {string} token - JWT token to validate
	 * @returns {Object} Validation result { valid: boolean, payload?: Object, error?: string }
	 */
	validateToken(token) {
		const validation = this.oauthService.validateToken(token);

		if (!validation.valid) 
			return validation;

		// Additional check: ensure token has webui scope
		if (validation.payload.scope !== 'webui') {
			this.logger.warn('Token validation failed: not a WebUI token');
			return { valid: false, error: 'invalid_scope' };
		}

		return validation;
	}

	/**
	 * Get route definitions for WebUI authentication
	 * @returns {Array<Object>} Array of route configurations
	 */
	getRoutes() {
		return [
			{
				method: 'post',
				path: '/webui/login',
				handler: this.loginPostHandler.bind(this),
			},
			{
				method: 'post',
				path: '/webui/refresh',
				handler: this.refreshPostHandler.bind(this),
			},
			{
				method: 'post',
				path: '/webui/logout',
				handler: this.logoutPostHandler.bind(this),
			},
		];
	}

	/**
	 * Handle POST /webui/login
	 * @param {Request} req - Express request
	 * @param {Response} res - Express response
	 */
	loginPostHandler(req, res) {
		const { username, password } = req.body;

		if (!username || !password) 
			return res.status(400).json({
				error: 'invalid_request',
				error_description: 'Missing username or password',
			});

		// Validate credentials
		const validation = this.validateCredentials(username, password);
		if (!validation.valid) 
			return res.status(401).json({
				error: 'invalid_credentials',
				error_description: validation.error,
			});

		// Create tokens
		const tokens = this.createWebUIToken(username);

		// Set secure HTTP-only cookie with access token for server-side authentication
		const isProduction = process.env.NODE_ENV === 'production';
		res.cookie('webui_auth_token', tokens.access_token, {
			httpOnly: true, // Prevent JavaScript access (XSS protection)
			secure: isProduction, // Only send over HTTPS in production
			sameSite: 'strict', // CSRF protection
			maxAge: tokens.expires_in * 1000, // Convert to milliseconds
			path: '/'
		});

		res.status(200).json(tokens);
	}

	/**
	 * Handle POST /webui/refresh
	 * @param {Request} req - Express request
	 * @param {Response} res - Express response
	 */
	refreshPostHandler(req, res) {
		const { refresh_token } = req.body;

		if (!refresh_token) 
			return res.status(400).json({
				error: 'invalid_request',
				error_description: 'Missing refresh_token',
			});

		// Validate refresh token
		const validation = this.validateToken(refresh_token);
		if (!validation.valid) 
			return res.status(401).json({
				error: 'invalid_token',
				error_description: validation.error,
			});

		// Check if it's a refresh token
		if (validation.payload.type !== 'webui_refresh') 
			return res.status(401).json({
				error: 'invalid_token',
				error_description: 'Not a refresh token',
			});

		// Create new tokens
		const tokens = this.createWebUIToken(validation.payload.sub);

		// Update the HTTP-only cookie with new access token
		const isProduction = process.env.NODE_ENV === 'production';
		res.cookie('webui_auth_token', tokens.access_token, {
			httpOnly: true,
			secure: isProduction,
			sameSite: 'strict',
			maxAge: tokens.expires_in * 1000,
			path: '/'
		});

		res.status(200).json(tokens);
	}

	/**
	 * Handle POST /webui/logout
	 * @param {Request} req - Express request
	 * @param {Response} res - Express response
	 */
	logoutPostHandler(req, res) {
		// In a stateless JWT system, logout is handled client-side by deleting the token
		// This endpoint exists for consistency and future extensions (e.g., token blacklisting)
		this.logger.info('WebUI logout requested');

		// Clear the HTTP-only cookie
		res.clearCookie('webui_auth_token', {
			httpOnly: true,
			secure: process.env.NODE_ENV === 'production',
			sameSite: 'strict',
			path: '/'
		});

		res.status(200).json({
			success: true,
			message: 'Logged out successfully',
		});
	}
}

export default WebUIAuthService;
