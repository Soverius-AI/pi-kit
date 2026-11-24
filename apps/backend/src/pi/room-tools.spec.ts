import type { ExtensionAPI } from '@earendil-works/pi-coding-agent' with { 'resolution-mode': 'import' };
import { describe, expect, it, vi } from 'vitest';
import { RoomAssistantCommandSchema } from '@pi-kit/protocol';
import { RoomTools, type RoomToolsHook } from './room-tools';

describe('room assistant tool contract', () => {
  it('publishes provider-compatible object parameters while validating action-specific required fields', async () => {
    const registered: {
      name: string;
      parameters: Record<string, unknown>;
      description: string;
      execute: (id: string, input: unknown) => Promise<unknown>;
    }[] = [];
    const assistant = vi.fn(async () => 'Saved');
    await RoomTools.factory(
      'lead',
      () => ({ assistant }) as unknown as RoomToolsHook,
    )({
      registerTool: (tool: unknown) => registered.push(tool as (typeof registered)[number]),
      on: vi.fn(),
    } as unknown as ExtensionAPI);
    const tool = registered.find((tool) => tool.name === RoomTools.ASSISTANT)!;
    expect(tool.parameters).toMatchObject({ type: 'object', required: ['action'], additionalProperties: false });
    expect(tool.description).toContain('Automatically maintain useful memory during ordinary room conversations');
    expect(tool.description).toContain('without requiring a remember command, form, or separate request');
    expect(tool.description).toContain('Do not use playbook scope for automatic personal memory');
    expect(
      RoomAssistantCommandSchema.safeParse({
        action: 'remember',
        key: 'reply-style',
        text: 'Concise',
        roomId: 'another-room',
        scope: 'playbook',
      }).success,
    ).toBe(false);
    expect(tool.parameters).not.toHaveProperty('anyOf');
    expect(tool.parameters).not.toHaveProperty('oneOf');
    await expect(tool.execute('bad', { action: 'snooze' })).rejects.toThrow();
    await expect(tool.execute('bad', { action: 'forget', key: 'fact', text: 'wrong field' })).rejects.toThrow();
    await expect(tool.execute('good', { action: 'remember', key: 'drink', text: 'Tea' })).resolves.toMatchObject({
      content: [{ text: 'Saved' }],
    });
    expect(assistant).toHaveBeenCalledExactlyOnceWith('lead', { action: 'remember', key: 'drink', text: 'Tea' });
    expect(RoomAssistantCommandSchema.safeParse({ action: 'commitment', title: 'Meeting' }).success).toBe(false);
  });
});
