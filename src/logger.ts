import type { Logger } from './types.js';

export const consoleLogger: Logger = {
  info(event, fields) {
    console.info(JSON.stringify({ level: 'info', event, ...fields }));
  },
  error(event, fields) {
    console.error(JSON.stringify({ level: 'error', event, ...fields }));
  }
};
