import { writeSync } from 'node:fs';

// Node can print a huge minified source line before the error, and truncate its piped stderr on exit.
// Record the useful stack first, synchronously. A monitor observes the fatal error without handling it:
// Node still exits and Electron's watchdog still restarts the backend.
process.on('uncaughtExceptionMonitor', (error, origin) => {
  try {
    writeSync(2, `${new Date().toISOString()} FATAL ${origin}: ${error.stack ?? String(error)}\n`);
  } catch {
    // Diagnostics must not change the original failure or prevent Node from exiting.
  }
});
