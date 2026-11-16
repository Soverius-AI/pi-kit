import { writeSync } from 'node:fs';

// Node can print a huge minified source line before the error, and truncate its piped stderr on exit.
// Record the useful stack first, synchronously. A monitor observes the fatal error without handling it:
// Node still exits and Electron's watchdog still restarts the backend.
process.on('uncaughtExceptionMonitor', (error, origin) => {
  try {
    const at = new Date().toISOString();
    writeSync(2, `${at} FATAL ${origin}: ${error.stack ?? String(error)}\n`);
    const system = error as NodeJS.ErrnoException;
    writeSync(
      2,
      `${at} FATAL_CONTEXT ${JSON.stringify({
        pid: process.pid,
        platform: process.platform,
        arch: process.arch,
        origin,
        ...(typeof system.code === 'string' ? { code: system.code } : {}),
        ...(typeof system.errno === 'number' ? { errno: system.errno } : {}),
        ...(typeof system.syscall === 'string' ? { syscall: system.syscall } : {}),
      })}\n`,
    );
  } catch {
    // Diagnostics must not change the original failure or prevent Node from exiting.
  }
});
