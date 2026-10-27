import { TestBed } from '@angular/core/testing';
import { DialogStore } from '@pi-kit/data-access';
import type { ResourceItem } from '@pi-kit/protocol';
import { PackagesStore } from '@pi-kit/settings/api';
import { DeleteSkillDialog } from './delete-skill-dialog';

const skill: ResourceItem = {
  key: 'skills:user:test',
  name: 'test',
  type: 'skills',
  path: '/agent/skills/test/SKILL.md',
  enabled: true,
  scope: 'user',
  origin: 'top-level',
  source: 'local',
  label: 'User',
};

describe('DeleteSkillDialog', () => {
  const pkgs = {
    removeSkill: vi.fn(async (_path: string, _mtime: number): Promise<{ ok: true } | { ok: false; error: string }> => ({
      ok: true,
    })),
  };
  beforeEach(() => {
    vi.clearAllMocks();
    pkgs.removeSkill.mockResolvedValue({ ok: true });
    TestBed.configureTestingModule({ providers: [{ provide: PackagesStore, useValue: pkgs }] });
  });
  const open = () => {
    const dialogs = TestBed.inject(DialogStore);
    dialogs.show({ kind: 'component', component: DeleteSkillDialog, inputs: { skill, mtime: 41 } });
    const f = TestBed.createComponent(DeleteSkillDialog);
    f.componentRef.setInput('skill', skill);
    f.componentRef.setInput('mtime', 41);
    f.detectChanges();
    return { f, dialogs };
  };

  it('keeps keyboard focus inside, blocks dismissal while busy, and restores focus on destroy', () => {
    const trigger = document.createElement('button');
    document.body.append(trigger);
    trigger.focus();
    const { f, dialogs } = open();
    const win: HTMLElement = f.nativeElement.querySelector('[role=dialog]');
    expect(document.activeElement).toBe(win);
    const buttons = win.querySelectorAll('button');
    const first = buttons[0];
    const last = buttons[buttons.length - 1];
    last.focus();
    last.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true }));
    expect(document.activeElement).toBe(first);
    first.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', shiftKey: true, bubbles: true, cancelable: true }));
    expect(document.activeElement).toBe(last);
    const closed = vi.spyOn(dialogs, 'close');
    f.componentInstance.busy.set(true);
    f.detectChanges();
    win.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    expect(closed).not.toHaveBeenCalled();
    f.componentInstance.busy.set(false);
    f.detectChanges();
    win.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    expect(dialogs.current()).toBeUndefined();
    expect(pkgs.removeSkill).not.toHaveBeenCalled();
    f.destroy();
    expect(document.activeElement).toBe(trigger);
    trigger.remove();
  });

  it('uses the captured file version and closes the shared host after successful deletion', async () => {
    const { f, dialogs } = open();
    await f.componentInstance.remove();
    expect(pkgs.removeSkill).toHaveBeenCalledWith(skill.path, 41);
    expect(dialogs.current()).toBeUndefined();
  });

  it('retains the shared dialog, error, and captured mtime when deletion is refused', async () => {
    pkgs.removeSkill.mockResolvedValueOnce({ ok: false, error: 'File changed; reopen confirmation' });
    const { f, dialogs } = open();
    await f.componentInstance.remove();
    f.detectChanges();
    expect(dialogs.current()?.kind).toBe('component');
    expect(f.nativeElement.querySelector('[role=alert]').textContent).toContain('File changed');
    expect(pkgs.removeSkill).toHaveBeenCalledWith(skill.path, 41);
    expect(f.componentInstance.busy()).toBe(false);
  });

  it('does not submit twice while deletion is running', async () => {
    let finish!: (value: { ok: true }) => void;
    pkgs.removeSkill.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const { f } = open();
    const pending = f.componentInstance.remove();
    await f.componentInstance.remove();
    expect(pkgs.removeSkill).toHaveBeenCalledOnce();
    finish({ ok: true });
    await pending;
  });
});
