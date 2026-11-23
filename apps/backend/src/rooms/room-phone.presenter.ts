import { randomBytes } from 'node:crypto';
import type { PhonePromptDraft, PhonePromptKind } from './room-phone.types';

export interface PhoneCommandFormat {
  prefix?: string;
  separator?: '_' | '-';
  suffix?: string;
  entryCommand?: string;
}

export function formatPhoneCommand(
  name: string,
  { prefix = '/', separator = '-', suffix = '' }: PhoneCommandFormat = {},
): string {
  return prefix + name.replaceAll('-', separator) + suffix;
}

export function presentPhoneHelp(format: PhoneCommandFormat = {}): string {
  const command = (name: string) => formatPhoneCommand(name, format);
  return [
    'Room commands:',
    format.entryCommand
      ? `${command(format.entryCommand)} QUESTION — ask this room.`
      : 'Send a message or reply to an assistant message to ask this room.',
    `${command('memory')} — show remembered facts.`,
    `${command('remember')} KEY: FACT — remember a fact.`,
    `${command('forget')} KEY — forget a fact.`,
    `${command('pending')} — show decisions and questions waiting for you.`,
    `${command('pause')} / ${command('resume')} — pause or resume this room.`,
    `${command('help')} — show these commands.`,
  ].join('\n');
}

export function presentPhonePrompt(
  kind: PhonePromptKind,
  text: string,
  token = randomBytes(8).toString('hex'),
  now = Date.now(),
  prefix = '/',
  separator: '_' | '-' = '-',
  suffix = '',
  maxMessageLength = 12000,
): PhonePromptDraft {
  const limit = Math.min(8000, Math.max(0, maxMessageLength - 256));
  if (text.length > limit)
    return {
      token,
      expiresAt: now + 600000,
      consumed: true,
      text: `${text.slice(0, Math.min(3000, limit))}\n\nThis request needs a complete preview. Open this room in pi-kit to review and answer it.`,
    };
  const commandName = (name: string) => formatPhoneCommand(name, { prefix, separator, suffix });
  const command =
    kind === 'test'
      ? `Reply ${commandName('room-test')} ${token}`
      : kind === 'action'
        ? `Reply ${commandName('approve')} ${token} or ${commandName('reject')} ${token}`
        : `Reply ${commandName('answer')} ${token} YOUR_ANSWER`;
  return {
    token,
    expiresAt: now + 600000,
    consumed: false,
    text: `${text}\n\n${command}\nThis request expires in ten minutes.`,
  };
}
