import type { FoundRoom } from '../db/rooms.repository';

/** Repository playbooks share notes; personal playbooks belong to their room. */
export function roomMemoryScopes({ room, playbook }: Pick<FoundRoom, 'room' | 'playbook'>): string[] {
  return [
    `room:${room.id}`,
    ...(playbook
      ? [room.repository ? `playbook:${room.repository}/${playbook}` : `room-playbook:${room.id}/${playbook}`]
      : []),
  ];
}
