import type { ArgumentsHost } from '@nestjs/common';
import { BrowserOperationError, type BrowserFailureCode } from '@pi-kit/protocol';
import { describe, expect, it, vi } from 'vitest';
import { BrowserExceptionFilter } from './browser-exception.filter';

describe('browser HTTP failures', () => {
  it.each<[BrowserFailureCode, number]>([['invalid', 400], ['unavailable', 503], ['timeout', 504], ['cancelled', 408], ['failed', 502]])('maps %s to HTTP %i with its original explanation', (code, status) => {
    const response = { status: vi.fn().mockReturnThis(), json: vi.fn() };
    const host = { switchToHttp: () => ({ getResponse: () => response }) } as unknown as ArgumentsHost;
    new BrowserExceptionFilter().catch(new BrowserOperationError(code, 'Original explanation'), host);
    expect(response.status).toHaveBeenCalledExactlyOnceWith(status);
    expect(response.json).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ statusCode: status, message: 'Original explanation' }));
  });
});
