declare module '@earendil-works/pi-coding-agent/dist/core/tools/grep.js' {
  export { createGrepToolDefinition } from '@earendil-works/pi-coding-agent';
}

declare module '@anthropic-ai/sandbox-runtime/vendor/*' {
  const path: string;
  export default path;
}
