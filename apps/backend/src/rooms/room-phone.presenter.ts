import { randomBytes } from 'node:crypto';
import type { PhonePromptDraft, PhonePromptKind } from './room-phone.types';

export function presentPhonePrompt(
  kind: PhonePromptKind,
  text: string,
  token = randomBytes(8).toString('hex'),
  now = Date.now(),
  prefix = '/',
): PhonePromptDraft {
  if (text.length > 8000)
    return {
      token,
      expiresAt: now + 600000,
      consumed: true,
      text: `${text.slice(0, 3000)}\n\nThis request needs a complete preview. Open this room in pi-kit to review and answer it.`,
    };
  const command =
    kind === 'test'
      ? `Reply ${prefix}room-test ${token}`
      : kind === 'action'
        ? `Reply ${prefix}approve ${token} or ${prefix}reject ${token}`
        : `Reply ${prefix}answer ${token} YOUR_ANSWER`;
  return {
    token,
    expiresAt: now + 600000,
    consumed: false,
    text: `${text}\n\n${command}\nThis request expires in ten minutes.`,
  };
}
