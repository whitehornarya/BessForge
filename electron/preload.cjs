// Expose endpoint configuration only. No credential, filesystem, process, or
// IPC primitive crosses this context-isolated bridge.
const { contextBridge } = require('electron');

const prefix = '--bessforge-api-base-url=';
const argument = process.argv.find(value => value.startsWith(prefix));
let apiBaseUrl = 'http://127.0.0.1:53117';
if (argument) {
  try {
    apiBaseUrl = decodeURIComponent(argument.slice(prefix.length));
  } catch {
    // The main process supplied a validated value; retain the safe default.
  }
}
const config = Object.freeze({
  apiBase: apiBaseUrl,
  API_BASE_URL: apiBaseUrl,
  apiBaseUrl,
  eciApiBaseUrl: apiBaseUrl,
});
contextBridge.exposeInMainWorld('__BESSFORGE_CONFIG__', config);
contextBridge.exposeInMainWorld('__ECI_CONFIG__', config);
contextBridge.exposeInMainWorld('bessforgeConfig', config);
