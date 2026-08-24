// Jest `setupFiles` entry: runs in every worker before the test framework and
// before any application module — including `config.ts` and its
// `dotenv.config()` call — is loaded. See `./test-support/offline-guard` for
// why each measure is needed.
import {
  installOfflineGuard,
  scrubProviderCredentials,
} from "./test-support/offline-guard";

scrubProviderCredentials(process.env);
installOfflineGuard();

// Silence console output during tests to keep output clean. This runs as a
// setupFile (before the test framework), so we patch directly.
console.log = () => {};
console.warn = () => {};
console.error = () => {};
