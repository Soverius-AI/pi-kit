// Imported first by openapi.ts: the application module reads the environment when it is loaded, and generating the document needs no real values.
process.env['NODE_ENV'] = 'production';
process.env['PI_KIT_TOKEN'] ??= 'openapi-generation-token';
process.env['PI_KIT_PORT'] ??= '4399';
