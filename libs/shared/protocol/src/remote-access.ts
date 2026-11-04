import type { StoredDeviceGrant } from './environments';

/** Desktop-managed private access through Tailscale Serve. Never includes backend credentials. */
export type RemoteAccessSetupAction = 'tailscale' | 'https' | 'authorize';
export type RemoteAccessIssue =
  | 'cli-unavailable'
  | 'connection-required'
  | 'https-required'
  | 'approval-required'
  | 'permission-denied'
  | 'port-in-use'
  | 'assets-missing'
  | 'status-failed'
  | 'start-failed'
  | 'storage-unavailable';
export type RemoteAccessDevice = Pick<StoredDeviceGrant, 'id' | 'name' | 'createdAt' | 'lastSeenAt'>;
export interface RemoteAccessPairing {
  code: string;
  url: string;
  expiresAt: number;
}

export interface RemoteAccessRequest {
  id: string;
  name: string;
  confirmationCode: string;
  expiresAt: number;
}

export interface RemoteAccessStatus {
  state: 'unavailable' | 'disconnected' | 'available' | 'starting' | 'serving' | 'error';
  version?: string;
  dnsName?: string;
  /** Public HTTPS port exposed through Tailscale Serve, not the private backend port. */
  port?: number;
  /** The control plane authorizes certificate provisioning for this node. */
  httpsReady?: boolean;
  url?: string;
  message?: string;
  /** Actionable local setup state; never includes raw command output or peer lists. */
  issue?: RemoteAccessIssue;
  setupAction?: RemoteAccessSetupAction;
  diagnostic?: string;
  pairing?: RemoteAccessPairing;
  requests?: RemoteAccessRequest[];
  devices?: RemoteAccessDevice[];
}
