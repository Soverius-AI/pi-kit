import { describe, expect, it } from 'vitest';
import { defaultEnvironmentLook, ENVIRONMENT_ICONS, EnvironmentLookSchema } from './environments';

describe('defaultEnvironmentLook', () => {
  it('gives every instance a valid look that stays the same for its id', () => {
    const id = '0b6c5bb4-3b1e-4a36-9ad2-7f6f8a1c2d01';
    expect(EnvironmentLookSchema.parse(defaultEnvironmentLook(id))).toEqual(defaultEnvironmentLook(id.toUpperCase()));
  });

  it('spreads instances over the icons and colours', () => {
    const looks = Array.from({ length: 200 }, (_, i) =>
      defaultEnvironmentLook(`00000000-0000-4000-8000-${String(i).padStart(12, '0')}`),
    );
    expect(new Set(looks.map((look) => look.icon)).size).toBe(ENVIRONMENT_ICONS.length);
    expect(new Set(looks.map((look) => look.color)).size).toBe(9);
  });
});
