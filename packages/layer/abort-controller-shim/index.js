/**
 * AbortController shim that uses native AbortController in Node.js 18+
 * This avoids compatibility issues between abort-controller package and Node.js 20
 */

module.exports = globalThis.AbortController;
module.exports.AbortController = globalThis.AbortController;
module.exports.AbortSignal = globalThis.AbortSignal;
module.exports.default = globalThis.AbortController;
