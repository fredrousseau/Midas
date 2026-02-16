import { randomUUID, createHash, createHmac, timingSafeEqual } from 'crypto';
import jwt from 'jsonwebtoken';
import { z } from 'zod';
import { StorageService } from './StorageService.js';

/**
 * OAuth 2.0 service with PKCE support for secure authentication
 */
export class OAuthService {
	/**
	 * Create an OAuthService instance
	 * @param {Object} parameters - Configuration parameters
	 * @param {Object} parameters.logger - Logger instance
	 * @param {boolean} parameters.isSecuredServer - Whether server is in secured mode
	 * @throws {Error} If logger is not provided
	 */
	constructor(parameters) {
		this.logger = parameters.logger || null;
		if (!this.logger) throw new Error('OAuthService requires a logger instance in options');

		this.isSecuredServer = parameters.isSecuredServer !== undefined ? parameters.isSecuredServer : true;

		this.JWT_SECRET = process.env.JWT_SECRET || null;
		if (!this.JWT_SECRET) throw new Error('OAuthService requires JWT_SECRET to be set in environment variables');

		// AK/SK for Dynamic Client Registration (only required when secured)
		this.REGISTRATION_ACCESS_KEY = process.env.OAUTH_REGISTRATION_ACCESS_KEY || null;
		this.REGISTRATION_SECRET_KEY = process.env.OAUTH_REGISTRATION_SECRET_KEY || null;

		if (this.isSecuredServer && (!this.REGISTRATION_ACCESS_KEY || !this.REGISTRATION_SECRET_KEY))
			throw new Error('OAuthService requires OAUTH_REGISTRATION_ACCESS_KEY and OAUTH_REGISTRATION_SECRET_KEY when SECURED_SERVER=true');

		this.storage = StorageService.getInstance({ logger: this.logger });

		// Validation schemas
		this.registerSchema = z.object({
			client_name: z.string().min(1).max(255).optional(),
			redirect_uris: z.array(z.string().url()).min(1),
		});

		this.authorizeSchema = z.object({
			client_id: z.string().uuid(),
			redirect_uri: z.string().url(),
			code_challenge: z.string().min(43).max(128),
			code_challenge_method: z.enum(['S256']),
			state: z.string().optional(),
			scope: z.string().optional(),
		});

		this.tokenSchema = z.object({
			grant_type: z.enum(['authorization_code', 'refresh_token']),
			client_id: z.string().uuid().optional(),
			code: z.string().uuid().optional(),
			code_verifier: z.string().min(43).max(128).optional(),
			refresh_token: z.string().optional(),
			scope: z.string().optional(),
		});
	}

	/**
	 * Get OAuth route definitions
	 * @returns {Array<Object>} Array of route configurations
	 */
	getRoutes() {
		const routes = [
			{
				method: 'get',
				path: '/.well-known/oauth-authorization-server',
				handler: this.wellKnownGetHandler.bind(this),
			},
			{
				method: 'post',
				path: '/oauth/register',
				handler: this.registerPostHandler.bind(this),
			},
			{
				method: 'get',
				path: '/oauth/authorize',
				handler: this.authorizeGetHandler.bind(this),
			},
			{
				method: 'post',
				path: '/oauth/token',
				handler: this.tokenPostHandler.bind(this),
			},
		];
		return routes;
	}

	// oAuth Step #1 - Authorization Server Metadata
	wellKnownGetHandler(req, res) {
		const protocol = req.protocol;
		const host = req.get('host');
		const issuer = `${protocol}://${host}`;

		res.status(200).json({
			issuer: `${issuer}`,
			authorization_endpoint: `${issuer}/oauth/authorize`,
			token_endpoint: `${issuer}/oauth/token`,
			registration_endpoint: `${issuer}/oauth/register`,
			grant_types_supported: ['authorization_code', 'client_credentials'],
			code_challenge_methods_supported: ['S256'],
			response_types_supported: ['code'],
		});
	}

	// oAuth Step #2 - Dynamic Client Registration : retuns server capabilities and client_id/secret
	registerPostHandler(req, res) {
		// If server is secured, validate AK/SK credentials
		if (this.isSecuredServer) {
			const authValidation = this.validateRegistrationAuth(req);
			if (!authValidation.valid) {
				this.logger.warn(`Registration auth failed: ${authValidation.error}`);
				return res.status(401).json({
					error: 'unauthorized',
					error_description: authValidation.error,
				});
			}
		}

		// Validate input
		const validation = this.registerSchema.safeParse(req.body);
		if (!validation.success) {
			const errorMsg = 'Invalid registration request';
			this.logger.verbose(`${errorMsg}: ${validation.error.message}`);
			return res.status(400).json({
				error: 'invalid_request',
				error_description: errorMsg,
				details: validation.error.issues,
			});
		}

		const params = validation.data;
		const client_id = randomUUID();
		const client_secret = randomUUID();
		const client_name = params.client_name || 'Unnamed App';
		const client_redirect_uris = params.redirect_uris;

		this.storage.setClient(client_id, {
			client_secret: client_secret,
			client_name: client_name,
			client_redirect_uris: client_redirect_uris,
		});

		this.logger.info(`New client registered: ${client_name} (${client_id})`);

		res.status(201).json({
			client_id: client_id,
			client_secret: client_secret,
			client_name: client_name,
			grant_types: ['authorization_code', 'refresh_token'],
			response_types: ['code'],
			token_endpoint_auth_method: 'none',
			scope: 'all',
			redirect_uris: client_redirect_uris,
		});
	}

	// oAuth Step #3 - Client sends a auth request
	authorizeGetHandler(req, res) {
		// Validate input
		const validation = this.authorizeSchema.safeParse(req.query);
		if (!validation.success) {
			const errorMsg = 'Invalid authorization request';
			this.logger.verbose(`${errorMsg}: ${validation.error.message}`);
			return res.status(400).json({
				error: 'invalid_request',
				error_description: errorMsg,
				details: validation.error.issues,
			});
		}

		const params = validation.data;
		const { client_id, redirect_uri, code_challenge, code_challenge_method, state, scope } = params;

		// Check if client exists
		const client = this.storage.getClientById(client_id);
		if (!client) {
			const errorMsg = 'Client not found';
			this.logger.verbose(errorMsg);
			return res.status(400).json({
				error: 'invalid_client',
				error_description: errorMsg,
			});
		}

		// CRITICAL: Validate redirect_uri against registered URIs
		this.logger.verbose(`Validating redirect_uri: ${redirect_uri}`);
		this.logger.verbose(`Registered URIs: ${JSON.stringify(client.client_redirect_uris)}`);

		if (!client.client_redirect_uris || !Array.isArray(client.client_redirect_uris)) {
			const errorMsg = 'No redirect URIs registered for this client';
			this.logger.info(`${errorMsg} - Client: ${client_id}`);
			return res.status(400).json({
				error: 'invalid_request',
				error_description: errorMsg,
			});
		}

		if (!client.client_redirect_uris.includes(redirect_uri)) {
			const errorMsg = 'Invalid redirect_uri: not registered for this client';
			this.logger.info(`${errorMsg} - Client: ${client_id}, URI: ${redirect_uri}, Registered: ${JSON.stringify(client.client_redirect_uris)}`);
			return res.status(400).json({
				error: 'invalid_request',
				error_description: errorMsg,
			});
		}

		// Validate code_challenge_method
		if (code_challenge_method !== 'S256') {
			const errorMsg = 'Only S256 code_challenge_method is supported';
			this.logger.verbose(errorMsg);
			return res.status(400).json({
				error: 'invalid_request',
				error_description: errorMsg,
			});
		}

		// Store authorization code with PKCE challenge
		client.code_challenge = code_challenge;
		client.code = randomUUID();
		client.code_creation_date = Date.now();
		client.scope = scope || 'all';

		this.storage.setClient(client_id, client);

		const redirectUrl = new URL(redirect_uri);
		redirectUrl.searchParams.set('code', client.code);

		if (state) redirectUrl.searchParams.set('state', state);

		res.redirect(302, redirectUrl.toString());
	}

	// oAuth Step #4 - Client asks for token (or refresh) server assess and sends
	async tokenPostHandler(req, res) {
		// Validate input
		const validation = this.tokenSchema.safeParse(req.body);

		if (!validation.success) {
			const errorMsg = 'Invalid Token Request';
			this.logger.verbose(`${errorMsg}: ${validation.error.message}`);
			return res.status(400).json({
				error: 'invalid_request',
				error_description: errorMsg,
				details: validation.error.issues,
			});
		}

		const parameters = validation.data;
		let client_id = parameters.client_id || null;

		let clientData = client_id ? this.storage.getClientById(client_id) : this.storage.getClientByCode(parameters.code);

		if (!clientData) {
			const errorMsg = 'Client not found or expired';
			this.logger.info(errorMsg);
			return res.status(400).json({ error: 'invalid_client', error_description: errorMsg });
		}

		// Use scope from authorization request if available
		const scope = clientData.scope || parameters.scope || 'all';

		if (parameters.grant_type === 'authorization_code') {
			// Check we have the expected parameters for auth code grant
			if (!parameters.code || !parameters.code_verifier) {
				const errorMsg = 'Missing code or code_verifier for authorization_code grant';
				this.logger.error(errorMsg);
				return res.status(400).json({ error: 'invalid_request', error_description: errorMsg });
			}

			// Verify the authorization code matches
			if (clientData.code !== parameters.code) {
				const errorMsg = 'Invalid authorization code';
				this.logger.error(errorMsg);
				return res.status(400).json({ error: 'invalid_grant', error_description: errorMsg });
			}

			// Verify PKCE challenge
			const computedChallenge = this.computeChallenge(parameters.code_verifier);
			if (computedChallenge !== clientData.code_challenge) {
				const errorMsg = 'PKCE verification failed';
				this.logger.error(errorMsg);
				return res.status(400).json({ error: 'invalid_grant', error_description: errorMsg });
			}

			// Delete the authorization code (one-time use) but keep client if he need to authenticate again later

			const cleansedClientData = clientData;
			cleansedClientData.code = null;
			cleansedClientData.code_challenge = null;
			cleansedClientData.code_creation_date = null;
			cleansedClientData.client_expiration_date = null;
			cleansedClientData.scope = null;
			this.storage.setClient(clientData.client_id, cleansedClientData);
		} else if (parameters.grant_type === 'refresh_token') {
			// Check we have the expected parameters for token refresh
			if (!parameters.refresh_token) {
				const errorMsg = 'Missing refresh_token';
				this.logger.error(errorMsg);
				return res.status(400).json({ error: 'invalid_request', error_description: errorMsg });
			}

			const validation = this.validateToken(parameters.refresh_token);
			if (!validation.valid) {
				const errorMsg = 'Invalid or expired refresh_token';
				this.logger.error(`${errorMsg}: ${validation.error}`);
				return res.status(400).json({ error: 'invalid_grant', error_description: errorMsg });
			}
			client_id = validation.payload.sub;
		}

		const accessTokenDuration = parseInt(process.env.OAUTH_ACCESS_TOKEN_DURATION, 10) * 60;
		const refreshTokenDuration = parseInt(process.env.OAUTH_REFRESH_TOKEN_DURATION, 10) * 60;

		const accessToken = this.createToken(client_id, accessTokenDuration, { scope });
		const refreshToken = this.createToken(client_id, refreshTokenDuration, { scope });

		res.status(200).json({
			access_token: accessToken,
			token_type: 'Bearer',
			expires_in: accessTokenDuration,
			refresh_token: refreshToken,
			scope: scope,
		});
	}

	computeChallenge(verifier) {
		return createHash('sha256').update(verifier).digest('base64url');
	}

	createToken(userId, duration, additionalClaims = {}) {
		const token = jwt.sign(
			{
				sub: userId,
				iat: Math.floor(Date.now() / 1000),
				...additionalClaims,
			},
			this.JWT_SECRET,
			{
				expiresIn: duration,
			}
		);
		return token;
	}

	validateToken(token) {
		try {
			const payload = jwt.verify(token, this.JWT_SECRET);
			return { valid: true, payload };
		} catch (error) {
			let errorType = 'unknown';
			if (error.name === 'TokenExpiredError') errorType = 'expired';
			else if (error.name === 'JsonWebTokenError') errorType = 'invalid';
			else if (error.name === 'NotBeforeError') errorType = 'not_active';

			return { valid: false, error: errorType, details: error.message };
		}
	}

	/**
	 * Validate AK/SK authentication for Dynamic Client Registration
	 * Uses HMAC-SHA256 signature verification
	 * @param {Object} req - Express request object
	 * @returns {Object} Validation result with valid boolean and error message
	 */
	validateRegistrationAuth(req) {
		const accessKey = req.headers['x-access-key'];
		const timestamp = req.headers['x-timestamp'];
		const signature = req.headers['x-signature'];

		// Check required headers
		if (!accessKey || !timestamp || !signature)
			return {
				valid: false,
				error: 'Missing required headers: X-Access-Key, X-Timestamp, X-Signature',
			};

		// Verify access key matches
		if (accessKey !== this.REGISTRATION_ACCESS_KEY)
			return {
				valid: false,
				error: 'Invalid access key',
			};

		// Verify timestamp is recent (within 5 minutes to prevent replay attacks)
		const requestTime = parseInt(timestamp, 10);
		const currentTime = Date.now();
		const timeDifference = Math.abs(currentTime - requestTime);
		const maxTimeDifference = 5 * 60 * 1000; // 5 minutes

		if (timeDifference > maxTimeDifference)
			return {
				valid: false,
				error: 'Request timestamp expired (max 5 minutes)',
			};

		// Compute expected signature
		// Signature = HMAC-SHA256(secret_key, access_key + timestamp + body)
		const body = JSON.stringify(req.body);
		const message = `${accessKey}${timestamp}${body}`;
		const expectedSignature = createHmac('sha256', this.REGISTRATION_SECRET_KEY).update(message).digest('hex');

		// Use timing-safe comparison to prevent timing attacks
		try {
			const signatureBuffer = Buffer.from(signature, 'hex');
			const expectedBuffer = Buffer.from(expectedSignature, 'hex');

			// Ensure buffers are same length before comparison
			if (signatureBuffer.length !== expectedBuffer.length)
				return {
					valid: false,
					error: 'Invalid signature',
				};

			const isValid = timingSafeEqual(signatureBuffer, expectedBuffer);

			if (!isValid)
				return {
					valid: false,
					error: 'Invalid signature',
				};
		} catch {
			return {
				valid: false,
				error: 'Signature verification failed',
			};
		}

		return { valid: true };
	}
}

export default OAuthService;
