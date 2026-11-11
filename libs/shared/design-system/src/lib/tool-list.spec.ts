import { TestBed } from '@angular/core/testing';
import { type PkToolListItem, PkToolList } from './tool-list';

class ToolListPage {
  static async render(items: PkToolListItem[], nested = false) {
    const fixture = TestBed.createComponent(PkToolList);
    fixture.componentRef.setInput('items', items);
    fixture.componentRef.setInput('nested', nested);
    await fixture.whenStable();
    return { fixture, root: fixture.nativeElement as HTMLElement };
  }

  static row(root: HTMLElement, id: string): HTMLElement {
    return root.querySelector<HTMLElement>(`[data-call="${id}"] .pk-row`)!;
  }
}

describe('PkToolList', () => {
  it('shows top-level output at once and nested calls under their parent, opening their output on demand', async () => {
    const { fixture, root } = await ToolListPage.render([
      {
        id: 'c1',
        name: 'agent',
        state: 'running',
        sub: 'Running, 12s',
        output: 'spawned',
        children: [
          { id: 'n1', name: 'bash', target: 'npm test', state: 'done', stat: '3s', output: 'PASS' },
          { id: 'n2', name: 'read', state: 'error', sub: 'ENOENT' },
        ],
      },
    ]);
    expect(ToolListPage.row(root, 'c1').querySelector('.sub')?.textContent).toBe('Running, 12s');
    expect(root.querySelector('[data-testid="tool-output"]')?.textContent).toContain('spawned');
    const nested = root.querySelector<HTMLElement>('[data-nested]')!;
    expect(nested.style.marginInlineStart).toBe('18px');
    expect(ToolListPage.row(nested, 'n1').querySelector('.stat')?.textContent).toBe('3s');
    expect(ToolListPage.row(nested, 'n2').getAttribute('data-state')).toBe('error');
    expect(ToolListPage.row(nested, 'n2').querySelector('.sub')?.textContent).toBe('ENOENT');
    expect(nested.querySelector('[data-testid="tool-output"]')).toBeNull();
    ToolListPage.row(nested, 'n1').click();
    await fixture.whenStable();
    expect(nested.querySelector('[data-testid="tool-output"]')?.textContent).toContain('PASS');
    ToolListPage.row(nested, 'n1').click();
    await fixture.whenStable();
    expect(nested.querySelector('[data-testid="tool-output"]')).toBeNull();
  });
});
