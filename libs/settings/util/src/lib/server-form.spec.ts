import { english } from '@pi-kit/i18n/testing';
import { describe, expect, it } from 'vitest';
import type { McpServerDetail } from '@pi-kit/protocol';
import {
  blankForm,
  blankRow,
  bodyOfForm,
  checkToken,
  createOfForm,
  formOfDetail,
  previewText,
  secretHint,
  validateForm,
  withKey,
  withMark,
  withValue,
} from './server-form';

const row = (key: string, value = '') => ({ ...blankRow(), key, value });

const detail = (over: Partial<McpServerDetail> = {}): McpServerDetail => ({
  name: 'playwright',
  scope: 'project',
  path: '/p/.pi/mcp.json',
  kind: 'command',
  url: '',
  command: 'npx',
  args: ['@playwright/mcp@latest', '--headless', 'a b'],
  headers: [],
  env: [
    { key: 'PLAYWRIGHT_BROWSERS_PATH', value: '~/.cache/ms-playwright' },
    { key: 'API_KEY', stored: true },
  ],
  exposure: 'direct',
  description: '',
  enabled: true,
  kept: [],
  oauth: false,
  ...over,
});

describe('the form of a server in a file', () => {
  it('fills every field, the arguments on one line, a stored secret as a row without text', () => {
    const form = formOfDetail(detail());
    expect(form).toMatchObject({
      name: 'playwright',
      kind: 'command',
      command: 'npx',
      args: '@playwright/mcp@latest --headless "a b"',
      exposure: 'direct',
      scope: 'project',
      enabled: true,
    });
    expect(form.env.map((r) => [r.key, r.value, r.secret, r.stored])).toEqual([
      ['PLAYWRIGHT_BROWSERS_PATH', '~/.cache/ms-playwright', false, false],
      ['API_KEY', '', true, true],
    ]);
  });

  it('sends it back as it was: a stored row without a value (the file keeps it), arguments split again', () => {
    const body = bodyOfForm(formOfDetail(detail()));
    expect(body).toEqual({
      name: 'playwright',
      kind: 'command',
      command: 'npx',
      args: ['@playwright/mcp@latest', '--headless', 'a b'],
      env: [{ key: 'PLAYWRIGHT_BROWSERS_PATH', value: '~/.cache/ms-playwright' }, { key: 'API_KEY' }],
      exposure: 'direct',
      description: '',
      enabled: true,
    });
  });

  it('a URL server sends its URL and headers and none of the command fields', () => {
    const body = bodyOfForm({
      ...blankForm(),
      name: 'docs',
      url: ' https://docs.example/mcp ',
      headers: [row('X-Team', 'core'), row('')],
      description: ' Docs ',
    });
    expect(body).toEqual({
      name: 'docs',
      kind: 'url',
      url: 'https://docs.example/mcp',
      headers: [{ key: 'X-Team', value: 'core' }],
      exposure: 'codemode',
      description: 'Docs',
      enabled: true,
    });
  });

  it('the scope goes with a new server only', () => {
    expect(createOfForm({ ...blankForm('project'), name: 'a', url: 'https://a.example/mcp' })).toMatchObject({
      scope: 'project',
      name: 'a',
    });
    expect(bodyOfForm({ ...blankForm('project'), name: 'a', url: 'https://a.example/mcp' })).not.toHaveProperty(
      'scope',
    );
  });
});

describe('secret rows', () => {
  it('a value that looks like a secret is not kept in the state', () => {
    const typed = withValue(row('Authorization'), 'Bearer abcdefghijklmnop1234');
    expect(typed.row).toMatchObject({ value: '', secret: true, filled: true });
    expect(typed.secretText).toBe('Bearer abcdefghijklmnop1234');
    const plain = withValue(row('COLOR'), 'blue');
    expect(plain.row).toMatchObject({ value: 'blue', secret: false });
    expect(plain.secretText).toBeUndefined();
  });

  it('typing a secret name over a value that is already there moves it out of the state', () => {
    const moved = withKey({ ...row('X', 'plain-looking') }, 'API_KEY');
    expect(moved.row).toMatchObject({ key: 'API_KEY', value: '', secret: true, filled: true });
    expect(moved.moved).toBe('plain-looking');
    expect(withKey(row('X', 'v'), 'Y').moved).toBeUndefined();
  });

  it('the lock marks any value, and unmarking gives a plain value back', () => {
    const locked = withMark(row('COLOR', 'blue'), true, undefined);
    expect(locked.row).toMatchObject({ marked: true, secret: true, value: '', filled: true });
    expect(locked.moved).toBe('blue');
    const body = bodyOfForm(
      { ...blankForm(), name: 'a', kind: 'command', command: 'x', env: [locked.row] },
      new Map([[locked.row.uid, 'blue']]),
    );
    expect(body.env).toEqual([{ key: 'COLOR', value: 'blue', secret: true }]);
    const unlocked = withMark(locked.row, false, 'blue');
    expect(unlocked.row).toMatchObject({ marked: false, secret: false, value: 'blue' });
    expect(unlocked.restored).toBe('blue');
    // a value that looks like a secret stays one
    expect(withMark(withValue(row('GITHUB_TOKEN'), 'abc').row, false, 'abc').row.secret).toBe(true);
  });

  it('a stored row sends nothing until something is typed over it, and a typed secret travels once, with the mark', () => {
    const stored = formOfDetail(detail()).env[1];
    expect(bodyOfForm({ ...blankForm(), name: 'a', kind: 'command', command: 'x', env: [stored] }).env).toEqual([
      { key: 'API_KEY' },
    ]);
    const replaced = withValue(stored, 'new-value');
    expect(replaced.row).toMatchObject({ secret: true, filled: true, stored: true });
    expect(
      bodyOfForm(
        { ...blankForm(), name: 'a', kind: 'command', command: 'x', env: [replaced.row] },
        new Map([[stored.uid, 'new-value']]),
      ).env,
    ).toEqual([{ key: 'API_KEY', value: 'new-value', secret: true }]);
  });

  it('a locked row with nothing typed sends nothing', () => {
    const locked = withMark(row('COLOR'), true, undefined).row;
    expect(bodyOfForm({ ...blankForm(), name: 'a', kind: 'command', command: 'x', env: [locked] }).env).toEqual([]);
  });
});

describe('validateForm', () => {
  const ok = { ...blankForm(), name: 'docs', url: 'https://docs.example/mcp' };
  it('asks for a name, an address or a command', () => {
    expect(validateForm(english, ok)).toBeUndefined();
    expect(validateForm(english, { ...ok, name: 'bad name' })?.field).toBe('name');
    expect(validateForm(english, { ...ok, url: 'http://example.com/mcp' })?.field).toBe('url');
    expect(validateForm(english, { ...ok, url: 'http://localhost:8080/mcp' })).toBeUndefined();
    expect(validateForm(english, { ...ok, kind: 'command', command: '  ' })?.field).toBe('command');
    expect(validateForm(english, { ...ok, kind: 'command', command: 'npx' })).toBeUndefined();
  });
  it('a header or variable twice, and a variable name that is not one', () => {
    expect(validateForm(english, { ...ok, headers: [row('X-A', '1'), row('x-a', '2')] })).toMatchObject({
      field: 'headers',
      message: '“x-a” is there twice.',
    });
    expect(
      validateForm(english, { ...ok, kind: 'command', command: 'x', env: [row('A', '1'), row('a', '2')] }),
    ).toBeUndefined();
    expect(validateForm(english, { ...ok, kind: 'command', command: 'x', env: [row('A B', '1')] })?.field).toBe('env');
  });
});

describe('checkToken', () => {
  it('is the Authorization header without Bearer, from the typed secret or the plain text; never a command or a reference, and a bare token is a token', () => {
    const typed = withValue(row('Authorization'), 'Bearer abcdefghijklmnop1234');
    const form = { ...blankForm(), headers: [typed.row] };
    expect(checkToken(form, new Map([[typed.row.uid, 'Bearer abcdefghijklmnop1234']]))).toBe('abcdefghijklmnop1234');
    expect(checkToken({ ...blankForm(), headers: [row('authorization', 'Bearer ${T}')] }, new Map())).toBeUndefined();
    expect(checkToken({ ...blankForm(), headers: [row('X-A', 'v')] }, new Map())).toBeUndefined();
    expect(checkToken({ ...blankForm(), headers: [row('Authorization', 'plain-token')] }, new Map())).toBe(
      'plain-token',
    );
  });
});

describe('previewText ("As it will be written")', () => {
  it('is the entry as the file gets it, without the braces around it', () => {
    const form = formOfDetail(
      detail({
        env: [{ key: 'PLAYWRIGHT_BROWSERS_PATH', value: '~/.cache/ms-playwright' }],
        args: ['@playwright/mcp@latest', '--headless'],
      }),
    );
    expect(previewText(form)).toBe(
      [
        '"playwright": {',
        '  "command": "npx",',
        '  "args": [',
        '    "@playwright/mcp@latest",',
        '    "--headless"',
        '  ],',
        '  "env": {',
        '    "PLAYWRIGHT_BROWSERS_PATH": "~/.cache/ms-playwright"',
        '  },',
        '  "exposure": "direct"',
        '}',
      ].join('\n'),
    );
  });
  it('shows the command that prints a secret and never the secret', () => {
    const typed = withValue(row('Authorization'), 'Bearer abcdefghijklmnop1234');
    const text = previewText(
      { ...blankForm(), name: 'docs', url: 'https://docs.example/mcp', headers: [typed.row] },
      new Map([[typed.row.uid, 'Bearer abcdefghijklmnop1234']]),
    );
    expect(text).toContain('"Authorization": "!pi-kit-secret get mcp-docs-header-Authorization"');
    expect(text).not.toContain('abcdefghijklmnop1234');
  });
  it('a stored secret that was not touched shows that the file keeps it', () => {
    const text = previewText(formOfDetail(detail()));
    expect(text).toContain('"API_KEY": "!(the command that prints the value you stored)"');
  });
  it('works with an empty form', () => {
    expect(previewText(blankForm())).toContain('"name": {');
  });
});

describe('secretHint', () => {
  it('says where a secret goes, or that there is no place', () => {
    expect(secretHint(english, { available: true, label: 'macOS Keychain' })).toContain('kept in your macOS Keychain');
    expect(secretHint(english, { available: false, label: '' })).toContain('plain text');
    expect(secretHint(english, undefined)).toContain('plain text');
  });
});
