import { Language } from '@pi-kit/i18n';
import { inject, makeEnvironmentProviders } from '@angular/core';
import { OPEN_GENERATIVE_UI_WEBSANDBOX_LOADER } from '@copilotkit/angular';
import { GENUI_SANDBOX_PATH } from '@pi-kit/protocol';
import { BackendService } from '@pi-kit/api';

/** Use CopilotKit's renderer and JetBrains' RPC implementation, with an HTTP bootstrap instead of srcdoc.
 * srcdoc inherits the desktop renderer's strict CSP and cannot execute the sandbox runtime.
 */
export function provideOpenUiSandbox() {
  return makeEnvironmentProviders([
    {
      provide: OPEN_GENERATIVE_UI_WEBSANDBOX_LOADER,
      useFactory: () => {
        const backend = inject(BackendService);
        const language = inject(Language);
        return async () => {
          const { default: Websandbox } = await import('@jetbrains/websandbox');
          const backendUrl = await backend.url();
          const cleanups = new WeakMap<HTMLIFrameElement, () => void>();
          return class PiKitWebsandbox extends Websandbox {
            static override create(...args: Parameters<typeof Websandbox.create>) {
              return new PiKitWebsandbox(args[0], args[1] ?? {});
            }

            override createIframe(): HTMLIFrameElement {
              const container =
                typeof this.options.frameContainer === 'string'
                  ? document.querySelector(this.options.frameContainer)
                  : this.options.frameContainer;
              if (!(container instanceof HTMLElement))
                throw new Error(language.t('chat.openUiSandbox.containerUnavailable'));
              const url = new URL(GENUI_SANDBOX_PATH, backendUrl);
              // CopilotKit measures only once; charts, fonts and local interactions can change the height later.
              const resizeScript = `<script>
                document.addEventListener('DOMContentLoaded', () => {
                  let previous = 0;
                  new ResizeObserver(() => {
                    const body = document.body;
                    const style = getComputedStyle(body);
                    const height = Math.ceil(body.getBoundingClientRect().height + (parseFloat(style.marginTop) || 0) + (parseFloat(style.marginBottom) || 0));
                    if (height !== previous) { previous = height; parent.postMessage({ type: 'pi-kit:genui-height', height }, '*'); }
                  }).observe(document.body);
                });
              </script>`;
              const html = this._prepareFrameContent(this.options).replace('<head>', `<head>${resizeScript}`);
              const frame = document.createElement('iframe');
              frame.setAttribute('sandbox', 'allow-scripts');
              frame.setAttribute('referrerpolicy', 'no-referrer');
              frame.className = this.options.frameClassName ?? '';
              let sent = false;
              const ready = (event: MessageEvent) => {
                if (event.source !== frame.contentWindow || event.origin !== 'null') return;
                if (event.data?.type === 'pi-kit:genui-ready' && !sent) {
                  sent = true;
                  frame.contentWindow?.postMessage({ type: 'pi-kit:genui-document', html }, '*');
                } else if (
                  event.data?.type === 'pi-kit:genui-height' &&
                  typeof event.data.height === 'number' &&
                  Number.isFinite(event.data.height)
                ) {
                  const height = Math.max(100, Math.min(2000, Math.ceil(event.data.height)));
                  container.classList.add('pk-open-ui-sized');
                  container.style.setProperty('--pk-open-ui-height', `${height}px`);
                }
              };
              window.addEventListener('message', ready);
              cleanups.set(frame, () => {
                window.removeEventListener('message', ready);
                if (!container.querySelector('iframe')) {
                  container.classList.remove('pk-open-ui-sized');
                  container.style.removeProperty('--pk-open-ui-height');
                }
              });
              frame.src = url.href;
              container.appendChild(frame);
              return frame;
            }

            override destroy(): void {
              super.destroy();
              cleanups.get(this.iframe)?.();
            }
          };
        };
      },
    },
  ]);
}
