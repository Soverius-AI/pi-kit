import { randomUUID } from 'node:crypto';

/** Differs for every backend process: a client that sees it change knows the backend was restarted. Also shown in Settings › Advanced. */
export const BOOT_ID = randomUUID();
export const STARTED_AT = Date.now();
