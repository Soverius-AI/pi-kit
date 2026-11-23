import { TestBed } from '@angular/core/testing';
import { RoomsStore } from '@pi-kit/rooms/api';
import type { Room } from '@pi-kit/protocol';
import { NewRoomDialog } from './new-room-dialog';

describe('new standalone room', () => {
  it('creates a personal room from its name and purpose with no thread or Git fields', async () => {
    const room: Room = {
      id: '43cf612f-b2b3-44b0-9298-d90cae8d8e9f',
      title: 'Personal',
      repository: '',
      baseCommit: '',
      hostInstanceId: '0b6c5bb4-3b1e-4a36-9ad2-7f6f8a1c2d01',
      createdAt: 1,
      waiting: 0,
    };
    const create = vi.fn().mockResolvedValue(room);
    const created = vi.fn();
    TestBed.configureTestingModule({
      providers: [{ provide: RoomsStore, useValue: { hosts: async () => [], create } }],
    });
    const fixture = TestBed.createComponent(NewRoomDialog);
    fixture.componentInstance.created.subscribe(created);
    await fixture.whenStable();
    const root = fixture.nativeElement as HTMLElement;
    const input = root.querySelector('[data-testid=new-room-name]') as HTMLInputElement;
    input.value = 'Personal';
    input.dispatchEvent(new Event('input'));
    const summary = root.querySelector('[data-testid=new-room-purpose]') as HTMLTextAreaElement;
    summary.value = 'Help me plan my day';
    summary.dispatchEvent(new Event('input'));
    await fixture.whenStable();
    (root.querySelector('[data-testid=new-room-create]') as HTMLButtonElement).click();
    await fixture.whenStable();
    expect(create).toHaveBeenCalledExactlyOnceWith({ title: 'Personal', summary: 'Help me plan my day' }, undefined);
    expect(created).toHaveBeenCalledWith(room);
  });
});
