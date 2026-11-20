import { InjectionToken, type Type } from '@angular/core';

export const ROOM_LEAD_CONTROLS = new InjectionToken<() => Promise<Type<unknown>>>('ROOM_LEAD_CONTROLS');
export const ROOM_PROSE = new InjectionToken<() => Promise<Type<unknown>>>('ROOM_PROSE');
