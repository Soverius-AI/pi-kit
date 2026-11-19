import { Component, computed, input } from '@angular/core';
import { PkIcon } from './icon';

export type PkAvatarHue = 'primary' | 'info' | 'success' | 'secondary' | 'neutral';

@Component({
  selector: 'pk-avatar',
  imports: [PkIcon],
  host: {
    class: 'pk-avatar',
    role: 'img',
    '[attr.data-hue]': 'hue()',
    '[attr.data-kind]': 'kind()',
    '[attr.aria-label]': 'label() ?? name()',
    '[attr.title]': 'label() ?? name()',
  },
  template: `
    <span class="letter" aria-hidden="true">{{ letter() }}</span>
    @if (kind() === 'agent') {
      <span class="pk-avatar-badge" aria-hidden="true"><pk-icon name="agents" size="9" /></span>
    }
  `,
})
export class PkAvatar {
  private static readonly HUES: readonly PkAvatarHue[] = ['primary', 'info', 'success', 'secondary', 'neutral'];

  readonly name = input.required<string>();
  readonly kind = input<'person' | 'agent'>('agent');
  readonly label = input<string>();
  protected readonly letter = computed(() => PkAvatar.letterOf(this.name()));
  protected readonly hue = computed(() => PkAvatar.hueOf(this.name()));

  static hueOf(name: string): PkAvatarHue {
    let h = 0x811c9dc5;
    const text = name.trim().toLowerCase();
    for (let i = 0; i < text.length; i++) {
      h ^= text.charCodeAt(i);
      h = Math.imul(h, 0x01000193) >>> 0;
    }
    h ^= h >>> 16;
    h = Math.imul(h, 0x85ebca6b) >>> 0;
    h ^= h >>> 13;
    h = Math.imul(h, 0xc2b2ae35) >>> 0;
    h ^= h >>> 16;
    return PkAvatar.HUES[(h >>> 0) % PkAvatar.HUES.length];
  }

  static letterOf(name: string): string {
    const match = /[\p{L}\p{N}]/u.exec(name.replace(/^pi-kit\s+/i, ''));
    return match ? match[0].toUpperCase() : '•';
  }
}
