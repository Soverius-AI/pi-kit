import type { RoomAssistantPolicy } from '@pi-kit/protocol';

/** New rooms require explicit consent before background model work. */
export function defaultRoomAssistantPolicy(): RoomAssistantPolicy {
  return {
    enabled: false,
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    quietStart: '22:00',
    quietEnd: '08:00',
    dailyLimit: 10,
    dailyRunLimit: 20,
  };
}
