import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { RoomAssistantStore } from '@pi-kit/rooms/data';
import type { RoomAssistantStatus } from '@pi-kit/protocol';
import { RoomAssistant } from './room-assistant';

describe('personal room memory editor', () => {
  it('corrects the original key and clears an unfinished edit when changing rooms', async () => {
    const roomId = signal('personal-a');
    const memory = vi.fn().mockResolvedValue(true);
    const status: RoomAssistantStatus = {
      policy: { enabled: false, timezone: 'Europe/Vienna', quietStart: null, quietEnd: null, dailyLimit: 10 },
      memory: [{ key: 'working-hours', text: 'Prefer meetings after 10am.', updatedBy: 'owner', updatedAt: 1 }],
      commitments: [],
      folders: [],
      workspace: '/room/workspace',
      work: [],
      files: [],
    };
    const store = {
      roomId,
      visible: signal(false),
      status: signal(status),
      error: signal(undefined),
      busy: signal(false),
      memory,
    };
    TestBed.overrideComponent(RoomAssistant, {
      set: { providers: [{ provide: RoomAssistantStore, useValue: store }] },
    });
    const fixture = TestBed.createComponent(RoomAssistant);
    await fixture.whenStable();
    const root = fixture.nativeElement as HTMLElement;
    const edit = Array.from(root.querySelectorAll('button')).find((button) => button.textContent?.trim() === 'Edit');
    edit?.click();
    await fixture.whenStable();
    const key = root.querySelector('[data-testid=room-memory-key]') as HTMLInputElement;
    expect(key.value).toBe('working-hours');
    expect(key.readOnly).toBe(true);
    const text = root.querySelector('[data-testid=room-memory-text]') as HTMLTextAreaElement;
    text.value = 'Prefer meetings after 11am.';
    text.dispatchEvent(new Event('input'));
    await fixture.whenStable();
    (root.querySelector('[data-testid=room-memory-save]') as HTMLButtonElement).click();
    await fixture.whenStable();
    expect(memory).toHaveBeenCalledExactlyOnceWith({ key: 'working-hours', text: 'Prefer meetings after 11am.' });
    edit?.click();
    await fixture.whenStable();
    roomId.set('personal-b');
    await fixture.whenStable();
    expect(key.value).toBe('');
    expect(key.readOnly).toBe(false);
    expect(text.value).toBe('');
  });
});
