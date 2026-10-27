import { type INestApplication, Module } from '@nestjs/common';
import { APP_INTERCEPTOR, APP_PIPE } from '@nestjs/core';
import { SwaggerModule } from '@nestjs/swagger';
import { ContractDocument, createContractDocument, OpenApiController } from './document';
import { ContractValidationPipe } from './pipe';
import { ContractSerializerInterceptor } from './serializer';

/** The API contract: request validation, response validation and the OpenAPI document, for every route that names a zod DTO. */
@Module({
  controllers: [OpenApiController],
  providers: [
    ContractDocument,
    { provide: APP_PIPE, useClass: ContractValidationPipe },
    { provide: APP_INTERCEPTOR, useClass: ContractSerializerInterceptor },
  ],
  exports: [ContractDocument],
})
export class ContractModule {}

/**
 * Builds the document from the routes of the application (call it after `setGlobalPrefix`, so the paths carry `/api`) and hands it to
 * `GET /api/openapi.json`. With `ui` the Swagger UI is mounted at `/api/docs` as well: only `dev:web` asks for it, the packaged app never does,
 * and the UI does not offer the raw document at a second address (the one behind the token is the only one).
 */
export function mountContract(app: INestApplication, options: { ui: boolean }) {
  const document = createContractDocument(app);
  app.get(ContractDocument).set(document);
  if (options.ui) {
    SwaggerModule.setup('api/docs', app, document, {
      raw: false,
      customSiteTitle: 'pi-kit API',
      swaggerOptions: { persistAuthorization: true, tryItOutEnabled: true },
    });
  }
  return document;
}
