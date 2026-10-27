// Pi exposes these registration hooks for bundlers. Make the imports visible
// to esbuild instead of leaving Pi's variable-specifier imports unresolved.
import { registerBunOAuthFlows } from '@earendil-works/pi-ai/bun-oauth';
import { bedrockProviderModule } from '@earendil-works/pi-ai/bedrock-provider';
import { setBedrockProviderModule } from '@earendil-works/pi-ai/api/bedrock-converse-stream.lazy';
registerBunOAuthFlows();
setBedrockProviderModule(bedrockProviderModule);

import { fileURLToPath } from 'node:url';
import { setEmbeddedQuickJSWasmPath } from 'pi-internal/config.js';
setEmbeddedQuickJSWasmPath(fileURLToPath(new URL('../quickjs.wasm', import.meta.url)));
