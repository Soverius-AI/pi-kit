import { ArgumentsHost, BadGatewayException, BadRequestException, Catch, ExceptionFilter, GatewayTimeoutException, RequestTimeoutException, ServiceUnavailableException } from '@nestjs/common';
import { BrowserOperationError } from '@pi-kit/protocol';
import type { Response } from 'express';

/** HTTP mapping belongs at the controller boundary; pi tools retain the original typed error. */
@Catch(BrowserOperationError)
export class BrowserExceptionFilter implements ExceptionFilter<BrowserOperationError> {
  catch(error: BrowserOperationError, host: ArgumentsHost): void {
    const Exception = {
      invalid: BadRequestException,
      unavailable: ServiceUnavailableException,
      timeout: GatewayTimeoutException,
      cancelled: RequestTimeoutException,
      failed: BadGatewayException,
    }[error.code];
    const exception = new Exception(error.message, { cause: error });
    host.switchToHttp().getResponse<Response>().status(exception.getStatus()).json(exception.getResponse());
  }
}
