import { InjectionToken, type Type } from '@angular/core';

export const ROOM_LEAD_CONTROLS = new InjectionToken<() => Promise<Type<unknown>>>('ROOM_LEAD_CONTROLS');
export const ROOM_PROSE = new InjectionToken<() => Promise<Type<unknown>>>('ROOM_PROSE');
/** Draws an MCP App the lead opened; inputs `threadId`, `ownerId`, `app`, `id` and `send`. */
export const ROOM_MCP_APP = new InjectionToken<() => Promise<Type<unknown>>>('ROOM_MCP_APP');
/** Draws one question the way a thread does; input `request` (a pi dialog), outputs `answered` and `dismissed`. */
export const ROOM_DIALOG = new InjectionToken<() => Promise<Type<unknown>>>('ROOM_DIALOG');
