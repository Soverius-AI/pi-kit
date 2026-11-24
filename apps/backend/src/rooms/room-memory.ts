import { BadRequestException, ConflictException, Injectable } from '@nestjs/common';
import { redact, RoomFactInputSchema, type RoomFactInput, type RoomMemoryEntry } from '@pi-kit/protocol';
import { RoomPlaybooksRepository } from '../db/room-playbooks.repository';
import { RoomBus } from './room-bus';

@Injectable()
export class RoomMemory {
  constructor(
    private readonly notes: RoomPlaybooksRepository,
    private readonly bus: RoomBus,
  ) {}

  async change(roomId: string, input: RoomFactInput, by: string, scope = `room:${roomId}`): Promise<void> {
    input = RoomFactInputSchema.parse({ key: input.key, text: input.text });
    if (
      (scope.startsWith('room:') && scope !== `room:${roomId}`) ||
      (scope.startsWith('room-playbook:') && !scope.startsWith(`room-playbook:${roomId}/`))
    )
      throw new BadRequestException('Memory belongs to the current room only.');
    const secretKey = redact(input.key) !== input.key || /(?:bot)?\d{5,20}:[A-Za-z0-9_-]{20,200}/.test(input.key);
    if (secretKey && input.text.trim())
      throw new BadRequestException('Room memory does not store secret values as memory keys.');
    const now = Date.now();
    if (input.text.trim()) {
      const sensitiveKey =
        /\b(?:password|passwd|passphrase|credential|secret|api key|access token|auth token|bot token|private key|recovery key|recovery code)\b/i.test(
          input.key.replace(/[_.-]/g, ' '),
        );
      const sensitiveText =
        redact(input.text) !== input.text ||
        /(?:bot)?\d{5,20}:[A-Za-z0-9_-]{20,200}/.test(input.text) ||
        /\b(?:password|passphrase|api[_ -]?key|bot[_ -]?token|recovery[_ -]?(?:key|code))\s*(?:is|:|=)/i.test(
          input.text,
        );
      if (sensitiveKey || sensitiveText)
        throw new BadRequestException(
          'Room memory does not store passwords, access tokens, private keys or recovery secrets.',
        );
      if (!(await this.notes.remember(scope, input.key, input.text, by, now)))
        throw new ConflictException(
          'This memory key was forgotten. Do not recreate it from conversation history or under another key.',
        );
    } else if (secretKey) await this.notes.purge(scope, input.key);
    else await this.notes.forget(scope, input.key, by, now);
    const entry: RoomMemoryEntry = {
      scope: scope.startsWith('room:') ? 'room' : 'playbook',
      key: input.key,
      text: redact(input.text) as string,
      updatedBy: by,
      updatedAt: now,
    };
    this.bus.emit(roomId, { type: 'memory', entry });
  }
}
