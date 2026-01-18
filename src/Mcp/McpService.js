import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { readdir } from 'fs/promises';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { zodToJsonSchema } from '#utils/zodToJsonSchema.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

/**
 * Mcp (Model Context Protocol) service for managing tools and handling requests
 */
export class McpService {
	/**
	 * Create an McpService instance
	 * @param {Object} parameters - Configuration parameters
	 * @param {Object} parameters.logger - Logger instance
	 * @param {string} [parameters.name='Mcp Service'] - Service name
	 * @param {string} [parameters.version='1.0.0'] - Service version
	 * @throws {Error} If logger is not provided
	 */
	constructor(parameters) {
		this.logger = parameters.logger || null;

		if (!this.logger) throw new Error('McpService requires a logger instance in parameters');

		this.name = parameters.name || 'Mcp Service';
		this.version = parameters.version || '1.0.0';

		this.mcpServer = new McpServer({
			name: this.name,
			version: this.version,
		});

		// Store tools locally to maintain schema integrity
		this.registeredTools = [];

		// Store tool callbacks for direct execution
		this.toolCallbacks = new Map();
	}

	/**
	 * Handle incoming Mcp requests
	 * @param {Object} req - Express request object
	 * @param {Object} res - Express response object
	 * @returns {Promise<void>}
	 */
	async handleRequest(req, res) {
		const transport = new StreamableHTTPServerTransport({
			sessionIdGenerator: undefined,
			enableJsonResponse: true,
		});

		res.on('close', () => {
			transport.close();
		});

		// Log after response is fully sent (skip noisy methods)
		res.on('finish', () => {
			const mcpMethod = req.body?.method;

			this.logger.verbose(`Request: ${req.method} ${req.path} | ${mcpMethod} - Status: ${res.statusCode}`);
			this.logger.verbose(`Incoming Body: ${JSON.stringify(req.body?.params)}`);
		});

		await this.mcpServer.connect(transport);
		await transport.handleRequest(req, res, req.body);
	}

	/**
	 * Register a new tool with the Mcp server
	 * @param {string} name - Tool name
	 * @param {Object} config - Tool configuration
	 * @param {string} config.description - Tool description
	 * @param {Object} config.inputSchema - Input schema (Zod or JSON Schema)
	 * @param {Function} callback - Tool execution callback
	 */
	registerTool(name, config, callback) {
		// Convert Zod schema to JSON Schema for our local HTTP REST API
		let jsonSchema = config.inputSchema;
		if (config.inputSchema && typeof config.inputSchema === 'object') {
			// Check if it contains Zod types (they have _def property)
			const hasZodTypes = Object.values(config.inputSchema).some((v) => v?._def);
			if (hasZodTypes) jsonSchema = zodToJsonSchema(config.inputSchema);
		}

		// Store the tool for later retrieval with proper schema
		this.registeredTools.push({
			name,
			description: config.description,
			inputSchema: jsonSchema,
		});

		// Store the callback for direct execution via REST API
		this.toolCallbacks.set(name, callback);

		// Pass the ORIGINAL config to Mcp SDK - it expects Zod schemas, not JSON Schema
		// The SDK will handle the conversion to JSON Schema internally
		this.mcpServer.registerTool(name, config, callback);
	}

	/**
	 * Get all registered tools
	 * @returns {Array<Object>} Array of registered tools with their schemas
	 */
	getTools() {
		return this.registeredTools;
	}

	/**
	 * Discover and register all Mcp tool modules from mcp-modules directory
	 * Each module must export a register(mcpService, log, ...dependencies) function
	 *
	 * @param {...any} dependencies - Additional dependencies to pass to module registration
	 * @returns {Promise<Object>} Registration results with statistics
	 * @example
	 * const results = await mcpService.registerAllModules();
	 * console.log(`Registered ${results.totalTools} tools from ${results.modules.length} modules`);
	 */
	async registerAllModules(parameters) {
		const results = {
			modules: [],
			totalTools: 0,
		};

		this.logger = parameters.logger || null;
		if (!this.logger) throw new Error('registerAllModules requires a logger instance in parameters');

		this.mcpService = parameters.mcpService || null;
		if (!this.mcpService) throw new Error('registerAllModules requires mcpService instance in parameters');

		try {
			this.logger.info(`Auto-discovering Mcp tool modules...`);

			// Discover all modules
			const moduleNames = await this._discoverModules();
			this.logger.info(`Found ${moduleNames.length} potential module(s): ${moduleNames.join(', ')}`);

			// Load valid modules
			const modules = await Promise.all(moduleNames.map((name) => this._loadModule(name)));

			const validModules = modules.filter((m) => m !== null);
			this.logger.info(`Loaded ${validModules.length} valid module(s) with register.js`);

			// Register each module with dependencies
			for (const module of validModules)
				try {
					const result = await module.register(parameters);

					if (result.success) {
						results.totalTools += result.tools?.length || 0;
						this.logger.info(`Module : ${module.name} - Registration completed - ${result.tools?.length || 0} tool(s) registered`);
					} else {
						this.logger.error(`Module : ${module.name}: Registration failed - ${result.error}`);
					}

					results.modules.push({
						name: module.name,
						...result,
					});
				} catch (error) {
					this.logger.error(`${module.name}: Unexpected error - ${error.message}`);
					results.modules.push({
						name: module.name,
						success: false,
						error: error.message,
					});
				}

			return results;
		} catch (error) {
			this.logger.error(`Fatal error during tool registration: ${error.message}`);
			throw error;
		}
	}

	/**
	 * Discover all tool modules in the mcp-modules directory
	 * @private
	 * @returns {Promise<string[]>} Array of module directory names
	 */
	async _discoverModules() {
		try {
			const modulesDir = join(__dirname, './tools');
			const entries = await readdir(modulesDir, { withFileTypes: true });
			return entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name);
		} catch (error) {
			throw new Error(`Failed to discover Mcp tool modules: ${error.message}`);
		}
	}

	/**
	 * Load and validate a single tool module
	 * @private
	 * @param {string} moduleName - Name of the module directory
	 * @returns {Promise<Object|null>} Module object with register function, or null if invalid
	 */
	async _loadModule(moduleName) {
		try {
			const modulesDir = join(__dirname, './tools');
			const modulePath = join(modulesDir, moduleName, 'register.js');

			let module;

			try {
				 module = await import(modulePath);
			} catch (e) {
				this.logger.error(`Failed to import module ${moduleName} at ${modulePath}: ${e.message}`);
				return null;
			}

			// Validate module exports register function
			if (typeof module.register !== 'function') return null;

			return {
				name: moduleName,
				register: module.register,
				path: modulePath,
			};
		} catch {
			// Module doesn't have register.js or failed to load - skip silently
			return null;
		}
	}
}

export default McpService;
