/**
 * Node-fetch shim that uses native fetch in Node.js 18+
 * This avoids AbortSignal compatibility issues between node-fetch v2 and Node.js 20
 */

const nativeFetch = globalThis.fetch;

// Add the properties that node-fetch normally exports
nativeFetch.default = nativeFetch;

// Export named classes from native globals
module.exports = nativeFetch;
module.exports.default = nativeFetch;
module.exports.Headers = globalThis.Headers;
module.exports.Request = globalThis.Request;
module.exports.Response = globalThis.Response;
module.exports.FetchError = class FetchError extends Error {
  constructor(message, type, systemError) {
    super(message);
    this.name = 'FetchError';
    this.type = type;
    if (systemError) {
      this.code = systemError.code;
      this.errno = systemError.errno;
    }
  }
};
module.exports.AbortError = class AbortError extends Error {
  constructor(message) {
    super(message);
    this.name = 'AbortError';
    this.type = 'aborted';
  }
};
