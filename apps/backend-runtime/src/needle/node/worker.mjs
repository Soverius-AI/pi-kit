// The package marks all files side-effect-free, including this worker entry.
// This Nx target ignores those annotations so worker startup is retained.
import 'needle-internal/node/worker.js';
