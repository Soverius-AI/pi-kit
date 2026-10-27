import { Controller, Get, Header } from '@nestjs/common';
import { ApiOkResponse, ApiOperation, ApiProduces, ApiTags } from '@nestjs/swagger';
import { Public } from '../app/auth.guard';

/** A credential-free bootstrap. Generated code only arrives through postMessage into an opaque-origin iframe. */
export const GENUI_SANDBOX_CSP = [
  "default-src 'none'",
  "script-src 'unsafe-inline' 'unsafe-eval' https://cdn.jsdelivr.net https://unpkg.com",
  "style-src 'unsafe-inline' https://cdn.jsdelivr.net https://unpkg.com",
  'img-src data: blob: https:',
  'font-src data: https://cdn.jsdelivr.net https://unpkg.com',
  "connect-src 'none'", "frame-src 'none'", "object-src 'none'", "base-uri 'none'", "form-action 'none'",
].join('; ');

export const GENUI_SANDBOX_HTML = `<!doctype html><html><head><meta charset="utf-8"><title>Generated UI sandbox</title></head><body><script>
if (window.parent !== window) {
  window.addEventListener('message', function load(event) {
    if (event.source !== window.parent || event.data?.type !== 'pi-kit:genui-document' || typeof event.data.html !== 'string') return;
    window.removeEventListener('message', load);
    document.open(); document.write(event.data.html); document.close();
  });
  window.parent.postMessage({ type: 'pi-kit:genui-ready' }, '*');
}
</script></body></html>`;

/**
 * `GET /api/genui-sandbox/frame.html`: the credential-free bootstrap page of the generated UI iframe, public and
 * never cached.
 */
@ApiTags('agui')
@Controller('genui-sandbox')
export class GenUiSandboxController {
  @Public()
  @Get('frame.html')
  @Header('Content-Type', 'text/html; charset=utf-8')
  @Header('Cache-Control', 'no-store')
  @Header('X-Content-Type-Options', 'nosniff')
  @Header('Content-Security-Policy', GENUI_SANDBOX_CSP)
  @ApiOperation({ summary: 'Get the generated UI sandbox bootstrap', description: 'Returns a credential-free bootstrap for an opaque-origin JetBrains WebSandbox iframe; generated UI arrives from its parent through postMessage.' })
  @ApiProduces('text/html')
  @ApiOkResponse({ description: 'The sandbox bootstrap document.', content: { 'text/html': { schema: { type: 'string' } } } })
  frame(): string { return GENUI_SANDBOX_HTML; }
}
