import winston from 'winston';
import DailyRotateFile from 'winston-daily-rotate-file';

/**
 * Option to enable/disable masking (can be toggled via env or at runtime)
 */
let maskEnabled = String(process.env.LOG_MASK_SENSITIVE || 'true').toLowerCase() !== 'false';

/**
 * Utility to mask sensitive keys in objects before logging
 * @param {Object} obj - Object to mask
 * @returns {Object} Masked object with sensitive fields replaced by '****'
 */
function maskSensitive(obj) {
	if (!maskEnabled) return obj;
	try {
		return JSON.parse(
			JSON.stringify(obj, (k, v) => {
				if (!k) return v;
				const key = k.toString().toLowerCase();
				const sensitive = ['authorization', 'token', 'access_token', 'refresh_token', 'client_secret', 'clientsecret', 'password'];
				if (sensitive.includes(key)) return '****';
				return v;
			})
		);
	} catch {
		return obj;
	}
}

/**
 * Winston logger instance configured with timestamp, JSON format, and sensitive data masking
 * @type {winston.Logger}
 */
const logger = winston.createLogger({
	level: process.env.LOG_LEVEL || 'info',
	format: winston.format.combine(
		winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
		winston.format.errors({ stack: true }),
		winston.format.json()
	),
	defaultMeta: {
		service: 'midas',
		environment: process.env.NODE_ENV || 'development',
	},
	transports: [
		new winston.transports.Console({
			forceConsole: true,
			format: winston.format.combine(
				winston.format.colorize(),
				winston.format.printf(({ timestamp, level, message }) => {
					let formattedMessage = '';
					try {
						if (typeof message === 'object') formattedMessage = JSON.stringify(maskSensitive(message), null, 2);
						else if (typeof message === 'string') try {
							const parsed = JSON.parse(message);
							formattedMessage = JSON.stringify(maskSensitive(parsed), null, 2);
						} catch {
							formattedMessage = message;
						} else formattedMessage = String(message);
					} catch {
						formattedMessage = String(message);
					}

					return `${timestamp} [${level}]: ${formattedMessage}`;
				})
			),
		}),

		// Error logs with daily rotation
		new DailyRotateFile({
			filename: 'logs/error-%DATE%.log',
			datePattern: 'YYYY-MM-DD',
			level: 'error',
			maxSize: '20m',
			maxFiles: '30d',
			zippedArchive: true,
		}),

		// Combined logs with daily rotation
		new DailyRotateFile({
			filename: 'logs/combined-%DATE%.log',
			datePattern: 'YYYY-MM-DD',
			maxSize: '20m',
			maxFiles: '14d',
			zippedArchive: true,
		}),
	],
});

export { logger };
