/**
 * Chromium normally permits only six HTTP/1.1 connections per host, shared by the
 * app's windows. Our local API keeps several responses open (thread/update/folder
 * events, terminals and agent transcripts). A chat stream can occupy the last
 * slot, leaving even health checks queued in the browser instead of reaching Nest.
 *
 * Exempt only the backend's IPv4 loopback host, not external websites. Chromium
 * still applies its overall socket limits. This must run before app.whenReady().
 */
export function configureLoopbackConnections(commandLine: { appendSwitch(name: string, value?: string): void }): void {
  commandLine.appendSwitch('ignore-connections-limit', '127.0.0.1');
}
