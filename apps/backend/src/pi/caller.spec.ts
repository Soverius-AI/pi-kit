import { describe, expect, it } from 'vitest';
import { extensionNameFromStack } from './caller';

const stack = (...frames: string[]) => ['Error', ...frames.map((f) => `    at ${f}`)].join('\n');

describe('extensionNameFromStack', () => {
  it('names a single-file extension by its file', () => {
    const s = stack('UiBridge.confirm (/app/dist/main.js:10:5)', 'Object.handler (/proj/.pi/extensions/pk-test.ts:12:34)', 'async Runner.emit (/app/node_modules/@earendil-works/pi-coding-agent/dist/core/extensions/runner.js:4:1)');
    expect(extensionNameFromStack(s)).toBe('pk-test');
  });
  it('names a folder extension by its folder', () => {
    expect(extensionNameFromStack(stack('async handler (/home/u/.pi/agent/extensions/git-guard/index.ts:3:9)'))).toBe('git-guard');
    expect(extensionNameFromStack(stack('/home/u/.pi/agent/extensions/git-guard/src/guard.mjs:3:9'))).toBe('guard');
  });
  it('reads file URLs and frames without a function name', () => {
    expect(extensionNameFromStack(stack('file:///proj/.pi/extensions/ask.js:1:1'))).toBe('ask');
  });
  it('does not blame pi itself or pi-kit', () => {
    expect(extensionNameFromStack(stack('x (/app/node_modules/@earendil-works/pi-coding-agent/dist/extensions/mcp/index.js:1:1)', 'y (/app/dist/main.js:2:2)'))).toBeUndefined();
    expect(extensionNameFromStack(undefined)).toBeUndefined();
  });
});
