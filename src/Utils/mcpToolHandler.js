/**
 * Tool Handler Wrapper - Eliminates duplicate error handling in all tools
 * Wraps async handlers with standard try-catch and Mcp response formatting
 */

import { mcpSuccess, mcpError } from './mcpResponse.js';

export function createToolHandler(handler, logger, _toolName = 'Tool') {
	return async (params) => {
		try {
			const result = await handler(params);
			return mcpSuccess(result);
		} catch (error) {
			logger.error(`Error: ${error?.message || String(error)}`);
			return mcpError(error?.message || 'Internal error', { params }, -32603);
		}
	};
}

export default { createToolHandler };
