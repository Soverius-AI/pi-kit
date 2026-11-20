import { Component, computed, input } from '@angular/core';
import { PkEnvGlyph, type PkEnvLook } from './env-look';
import { PkIcon } from './icon';
import type { PkIconName } from './icon-names';

export type PkAvatarHue = 'primary' | 'info' | 'success' | 'secondary' | 'neutral';
export type PkAvatarRole = 'lead' | 'worker' | 'consultant';

@Component({
  selector: 'pk-avatar',
  imports: [PkEnvGlyph, PkIcon],
  host: {
    class: 'pk-avatar',
    role: 'img',
    '[attr.data-hue]': 'hue()',
    '[attr.data-kind]': 'kind()',
    '[attr.data-role]': 'participant() ?? null',
    '[attr.aria-label]': 'label() ?? name()',
    '[attr.title]': 'label() ?? name()',
  },
  template: `
    <span class="letter" aria-hidden="true">{{ letter() }}</span>
    @if (participant()) {
      <span class="pk-avatar-role" aria-hidden="true"><pk-icon [name]="roleIcon()" size="8" /></span>
    }
    @if (look(); as look) {
      <pk-env-glyph class="pk-avatar-badge look" [look]="look" />
    } @else if (kind() === 'agent') {
      <span class="pk-avatar-badge" aria-hidden="true"><pk-icon name="agents" size="9" /></span>
    }
  `,
})
export class PkAvatar {
  private static readonly HUES: readonly PkAvatarHue[] = ['primary', 'info', 'success', 'secondary', 'neutral'];
  private static readonly ROLE_ICONS: Record<PkAvatarRole, PkIconName> = {
    lead: 'star',
    worker: 'terminal',
    consultant: 'comment',
  };

  readonly name = input.required<string>();
  readonly kind = input<'person' | 'agent'>('agent');
  readonly label = input<string>();
  /** The machine's look, drawn as the corner badge in place of the agent mark. */
  readonly look = input<PkEnvLook>();
  /** Tells apart agents on the same machine, which share the letter and the look. */
  readonly participant = input<PkAvatarRole>();
  protected readonly letter = computed(() => PkAvatar.letterOf(this.name()));
  protected readonly hue = computed(() => PkAvatar.hueOf(this.name()));
  protected readonly roleIcon = computed(() => PkAvatar.ROLE_ICONS[this.participant() ?? 'lead']);

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
