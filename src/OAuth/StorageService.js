import Database from 'better-sqlite3';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/**
 * Storage service using SQLite for persistent client data management
 * Features:
 * - Automatic persistence with SQLite
 * - Auto-cleanup of expired tokens
 * - Transaction support for data integrity
 * - Optimized queries with indexes
 */
export class StorageService {
	static #instance = null;
	#db = null;
	#preparedStatements = null;
	#dbPath = null;

	/**
	 * Create a StorageService instance (Singleton)
	 * @param {Object} parameters - Configuration options
	 * @param {string} parameters.dbPath - Database file path (default: data/oauth-storage.db)
	 * @returns {StorageService} The singleton instance
	 */
	constructor(parameters = {}) {
		if (StorageService.#instance) return StorageService.#instance;

		this.logger = parameters.logger || null;
		if (!this.logger) throw new Error('StorageService requires a logger instance in options');

		this.codeRequestLifeTime = process.env.OAUTH_AUTHORIZATION_CODE_DURATION || null;
		if (!this.codeRequestLifeTime) {
			this.logger.warn('OAUTH_AUTHORIZATION_CODE_DURATION not set in environment, defaulting to 10 minutes');
			this.codeRequestLifeTime = 10; // Default to 10 minutes
		}

		this.#dbPath = parameters.dbPath || null;
		StorageService.#instance = this;
		this.#initialize();
	}

	/**
	 * Initialize the database and tables
	 * @private
	 */
	#initialize() {
		// Ensure data directory exists
		const dataDir = path.join(__dirname, '../../data');
		if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });

		// Open database
		if (!this.#dbPath) this.#dbPath = path.join(dataDir, 'oauth-storage.db');

		this.#db = new Database(this.#dbPath);

		// Enable WAL mode for better concurrency
		this.#db.pragma('journal_mode = WAL');

		// Create tables
		this.#createTables();

		// Initialize prepared statements
		this.#initializePreparedStatements();

		this.logger.info('StorageService initialized with database', { path: this.#dbPath });
	}

	/**
	 * Create database tables
	 * @private
	 */
	#createTables() {
		this.#db.exec(`
			CREATE TABLE IF NOT EXISTS clients (
				client_id TEXT PRIMARY KEY,
				client_secret TEXT NOT NULL,
				client_name TEXT NOT NULL,
				client_redirect_uris TEXT NOT NULL,
				code TEXT,
				code_challenge TEXT,
				code_creation_date INTEGER,
				client_expiration_date,
				scope TEXT
			);

			CREATE INDEX IF NOT EXISTS idx_code ON clients(code);
		`);
	}

	/**
	 * Initialize prepared statements for better performance
	 * @private
	 */
	#initializePreparedStatements() {
		this.#preparedStatements = {
			setClient: this.#db.prepare(`
				INSERT INTO clients (
					client_id,
					client_secret,
					client_name,
					client_redirect_uris,
					code,
					code_challenge,
					code_creation_date,
					client_expiration_date,
					scope
				)
				VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
				ON CONFLICT(client_id) DO UPDATE SET
					client_secret = excluded.client_secret,
					client_name = excluded.client_name,
					client_redirect_uris = excluded.client_redirect_uris,
					code = excluded.code,
					code_challenge = excluded.code_challenge,
					code_creation_date = excluded.code_creation_date,
					client_expiration_date = excluded.client_expiration_date,
					scope = excluded.scope
			`),
			getClientById: this.#db.prepare(`
				SELECT
					client_secret,
					client_name,
					client_redirect_uris,
					code,
					code_challenge,
					code_creation_date,
					client_expiration_date,
					scope
				FROM clients
				WHERE client_id = ? and client_expiration_date IS NOT NULL AND client_expiration_date > ?
			`),
			getClientByCode: this.#db.prepare(`
				SELECT
					client_id,
					client_secret,
					client_name,
					client_redirect_uris,
					code,
					code_challenge,
					code_creation_date,
					scope
				FROM clients
				WHERE code = ? and client_expiration_date IS NOT NULL AND client_expiration_date > ?
			`),
			deleteClient: this.#db.prepare(`
				DELETE FROM clients WHERE client_id = ?
			`),
			cleanExpired: this.#db.prepare(`
				DELETE FROM clients
				WHERE client_expiration_date IS NOT NULL AND client_expiration_date < ?
			`),
		};
	}

	/**
	 * Clean expired tokens from database
	 * @private
	 */
	#cleanExpired() {
		try {
			const now = Date.now();
			const result = this.#preparedStatements.cleanExpired.run(now);

			if (result.changes > 0) this.logger.info('Cleaned expired clients', { count: result.changes });
		} catch (error) {
			this.logger.error('Error during cleanup', { error: error.message });
		}
	}

	/**
	 * Parse database row into client object
	 * @private
	 * @param {Object} row - Database row
	 * @returns {Object|undefined} Parsed client data or undefined
	 */
	#parseClientRow(row) {
		if (!row) return undefined;

		return {
			...(row.client_id && { client_id: row.client_id }),
			client_secret: row.client_secret,
			client_name: row.client_name,
			client_redirect_uris: JSON.parse(row.client_redirect_uris),
			code: row.code,
			code_challenge: row.code_challenge,
			code_creation_date: row.code_creation_date,
			scope: row.scope,
		};
	}

	/**
	 * Validate client data
	 * @private
	 * @param {string} clientId - Client identifier
	 * @param {Object} data - Client data
	 * @throws {Error} If validation fails
	 */
	#validateClientData(clientId, data) {
		if (!clientId || typeof clientId !== 'string') throw new Error('Invalid client_id: must be a non-empty string');

		if (data.client_redirect_uris) {
			const uris = Array.isArray(data.client_redirect_uris) ? data.client_redirect_uris : JSON.parse(data.client_redirect_uris);

			if (!Array.isArray(uris) || uris.length === 0) throw new Error('Invalid redirect URIs: must be a non-empty array');

			for (const uri of uris) if (!uri.startsWith('http://') && !uri.startsWith('https://')) throw new Error(`Invalid redirect URI: ${uri} must start with http:// or https://`);
		}
	}

	/**
	 * Get the singleton instance of StorageService
	 * @returns {StorageService} The singleton instance
	 */
	static getInstance(options) {
		if (!StorageService.#instance) StorageService.#instance = new StorageService(options);
		return StorageService.#instance;
	}

	/**
	 * Store or update client data
	 * @param {string} clientId - Unique client identifier
	 * @param {Object} data - Client data to store
	 * @throws {Error} If validation fails
	 */
	setClient(clientId, data = {}) {
		try {
			// Validate input
			this.#validateClientData(clientId, data);

			const now = Date.now();
			const expiresAt = now + this.codeRequestLifeTime;

			// Serialize redirect URIs as JSON array
			const redirectUris = Array.isArray(data.client_redirect_uris) ? JSON.stringify(data.client_redirect_uris) : data.client_redirect_uris || '[]';

			this.#preparedStatements.setClient.run(
				clientId,
				data.client_secret || '',
				data.client_name || '',
				redirectUris,
				data.code || null,
				data.code_challenge || null,
				data.code_creation_date || null,
				expiresAt,
				data.scope || null
			);
		} catch (error) {
			this.logger.error('Error setting client', { clientId, error: error.message });
			throw error;
		}
	}

	/**
	 * Retrieve client data
	 * @param {string} clientId - Unique client identifier
	 * @returns {Object|undefined} Client data or undefined if not found/expired
	 */
	getClientById(clientId) {
		try {
			const now = Date.now();
			const row = this.#preparedStatements.getClientById.get(clientId, now);
			return this.#parseClientRow(row);
		} catch (error) {
			this.logger.error('Error getting client by ID', { clientId, error: error.message });
			throw error;
		}
	}

	/**
	 * Retrieve client data by authorization code
	 * @param {string} code - Authorization code
	 * @returns {Object|undefined} Client data (including client_id) or undefined if not found/expired
	 */
	getClientByCode(code) {
		try {
			const now = Date.now();
			const row = this.#preparedStatements.getClientByCode.get(code, now);
			return this.#parseClientRow(row);
		} catch (error) {
			this.logger.error('Error getting client by code', { error: error.message });
			throw error;
		}
	}

	deleteClient(clientId) {
		try {
			this.#preparedStatements.deleteClient.run(clientId);
		} catch (error) {
			this.logger.error('Error deleting client', { clientId, error: error.message });
			throw error;
		}
	}
}