import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';
import { sessionRuntimeOptions } from './load-pi';

describe('session runtime paths', () => {
  it('keeps SDK defaults when no agent directory is supplied', () => {
    expect(sessionRuntimeOptions()).toEqual({});
  });

  it.each([
    ['custom-agent', resolve('custom-agent')],
    ['~/custom-agent', join(homedir(), 'custom-agent')],
    ['~', homedir()],
    [pathToFileURL(resolve('custom-agent')).href, resolve('custom-agent')],
  ])('isolates credentials and models for %s', (input, directory) => {
    expect(sessionRuntimeOptions(input)).toEqual({
      authPath: join(directory, 'auth.json'),
      modelsPath: join(directory, 'models.json'),
    });
  });
});
