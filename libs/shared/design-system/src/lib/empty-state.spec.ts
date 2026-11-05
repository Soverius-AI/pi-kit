import { Component } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { PkEmptyState } from './empty-state';

@Component({
  imports: [PkEmptyState],
  template: `
    <pk-empty-state heading="No thread open" text="Start a new thread." icon="files">
      <button actions type="button">New thread</button>
      <ul class="list"></ul>
    </pk-empty-state>
  `,
})
class Host {}

describe('PkEmptyState', () => {
  it('shows the heading, the text, the actions and the projected content', () => {
    const fixture = TestBed.createComponent(Host);
    fixture.detectChanges();
    const root = fixture.nativeElement as HTMLElement;
    expect(root.querySelector('h2')?.textContent).toBe('No thread open');
    expect(root.querySelector('p')?.textContent).toBe('Start a new thread.');
    expect(root.querySelector('.actions button')?.textContent).toBe('New thread');
    expect(root.querySelector('.actions + .list')).not.toBeNull();
    expect(root.querySelector('.mark pk-icon')).not.toBeNull();
  });

  it('shows the pi-kit mark and no text line by default', () => {
    const fixture = TestBed.createComponent(PkEmptyState);
    fixture.componentRef.setInput('heading', 'Nothing here');
    fixture.detectChanges();
    const root = fixture.nativeElement as HTMLElement;
    expect(root.querySelector('pk-logo.brand')).not.toBeNull();
    expect(root.querySelector('p')).toBeNull();
  });
});
