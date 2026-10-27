/**
 * pi-kit is local-first: switch off CopilotKit's runtime telemetry (it honours these variables when
 * its modules load, so this file must be the first import of `main.ts`).
 */
process.env['COPILOTKIT_TELEMETRY_DISABLED'] = 'true';
process.env['DO_NOT_TRACK'] = '1';
