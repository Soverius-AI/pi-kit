// One backend contract, one generated SDK. Keep generated output reproducible and
// authentication in the renderer's transport rather than in generated files.
export default {
  input: 'docs/api/openapi.yaml',
  output: 'libs/shared/api/src/generated',
  plugins: ['@hey-api/typescript', '@hey-api/client-fetch', '@hey-api/sdk'],
};
