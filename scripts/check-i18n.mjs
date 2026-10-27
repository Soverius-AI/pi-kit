// The interface catalogs are an independently checked asset contract: both locales must cover
// the same messages and parameters, and app-owned template copy must go through Transloco.
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import ts from 'typescript';
import { parseTemplate } from '@angular/compiler';
import { isAngularSource } from './frontend-scope.mjs';

const root = 'libs/shared/i18n/src/lib/translations';
const errors = [];
// Catalogs are authored as nested JSON; dotted paths are only the lookup format in code.
function flattenCatalog(value, language, prefix = '', messages = {}) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    errors.push(`${language}: ${prefix || 'catalog'} must be an object`);
    return messages;
  }
  for (const [key, message] of Object.entries(value)) {
    const path = prefix ? `${prefix}.${key}` : key;
    if (!key || key.includes('.')) errors.push(`${language}: ${path} must use nested objects instead of dotted property names`);
    if (typeof message === 'string') messages[path] = message;
    else flattenCatalog(message, language, path, messages);
  }
  return messages;
}
const catalogs = Object.fromEntries(['en', 'de'].map((lang) => [lang, flattenCatalog(JSON.parse(readFileSync(`${root}/${lang}.json`, 'utf8')), lang)]));
const keys = new Set(Object.keys(catalogs.en));
const placeholders = (value) => [...value.matchAll(/\{\{\s*(\w+)\s*\}\}/g)].map((m) => m[1]).sort().join(',');
for (const [lang, catalog] of Object.entries(catalogs)) {
  for (const key of keys) {
    const value = catalog[key];
    if (typeof value !== 'string' || !value.trim()) errors.push(`${lang}: missing or empty message ${key}`);
    else if (placeholders(value) !== placeholders(catalogs.en[key])) errors.push(`${lang}: interpolation mismatch in ${key}`);
  }
  for (const key of Object.keys(catalog)) if (!keys.has(key)) errors.push(`${lang}: unknown message ${key}`);
}

// The sources git knows or would add (ignored files left out), without needing ripgrep on the machine.
const files = execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', 'apps/renderer/src', 'libs'], { encoding: 'utf8' }).trim().split('\n')
  .filter((file) => isAngularSource(file) && file.endsWith('.ts') && !/\.spec\.|generated|test-setup|shared\/i18n\//.test(file));
const attributes = new Set(['title', 'aria-label', 'placeholder', 'alt', 'pkTip', 'label', 'empty']);
const seenKeys = new Set();
const requireKey = (key, file, params) => {
  seenKeys.add(key);
  if (!keys.has(key)) errors.push(`${file}: unknown translation key ${key}`);
  else if (params !== undefined) {
    const expected = [...new Set([...catalogs.en[key].matchAll(/\{\{\s*(\w+)\s*\}\}/g)].map((match) => match[1]))].sort();
    const supplied = [...new Set(params)].sort();
    if (expected.join(',') !== supplied.join(',')) errors.push(`${file}: ${key} expects [${expected}], supplied [${supplied}]`);
  }
};
function template(text, file) {
  const parsed = parseTemplate(text, file, { preserveWhitespaces: true });
  for (const error of parsed.errors ?? []) errors.push(`${file}: ${error}`);
  const seen = new Set();
  function walk(node, technical = false) {
    if (!node || typeof node !== 'object' || seen.has(node)) return;
    seen.add(node);
    const kind = node.constructor.name;
    if (kind === 'Element') technical ||= ['code', 'kbd', 'pre', 'script', 'style'].includes(node.name);
    if (kind === 'Text' && !technical && /[A-Za-z]/.test(node.value)) errors.push(`${file}: untranslated text ${JSON.stringify(node.value.trim())}`);
    if (kind === 'TextAttribute' && attributes.has(node.name) && /[A-Za-z]/.test(node.value)) errors.push(`${file}: untranslated ${node.name}: ${node.value}`);
    if (kind === 'Call' && node.receiver?.name === 'plural' && typeof node.args?.at(-1)?.value === 'string') {
      for (const form of ['one', 'other']) requireKey(`common.counts.${node.args.at(-1).value}.${form}`, file, ['count']);
    }
    if (kind === 'BindingPipe' && node.name === 'transloco' && typeof node.exp?.value === 'string') requireKey(node.exp.value, file, !node.args.length ? [] : node.args[0]?.constructor.name === 'LiteralMap' ? node.args[0].keys.map((key) => key.key) : undefined);
    for (const [name, value] of Object.entries(node)) {
      if (name.endsWith('Span') || ['i18n', 'file'].includes(name)) continue;
      if (Array.isArray(value)) value.forEach((child) => walk(child, technical));
      else if (value && typeof value === 'object') walk(value, technical);
    }
  }
  parsed.nodes.forEach((node) => walk(node));
}
for (const file of files) {
  const source = readFileSync(file, 'utf8');
  const sf = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
  function walk(node) {
    if (ts.isPropertyAssignment(node) && node.name.getText(sf) === 'template' && ts.isStringLiteralLike(node.initializer)) {
      template(node.initializer.text, file);
      return;
    }
    if (ts.isPropertyAssignment(node) && node.name.getText(sf) === 'templateUrl' && ts.isStringLiteralLike(node.initializer)) {
      const templateFile = `${file.slice(0, file.lastIndexOf('/'))}/${node.initializer.text}`;
      template(readFileSync(templateFile, 'utf8'), templateFile);
    }
    if (ts.isCallExpression(node) && node.expression.getText(sf) === 'plural' && ts.isStringLiteralLike(node.arguments.at(-1) ?? sf)) {
      for (const form of ['one', 'other']) requireKey(`common.counts.${node.arguments.at(-1).text}.${form}`, file, ['count']);
    }
    if (ts.isCallExpression(node) && /(?:\.t|\btranslate)$/.test(node.expression.getText(sf))) {
      if (ts.isStringLiteralLike(node.arguments[0] ?? sf)) requireKey(node.arguments[0].text, file, node.arguments.length < 2 ? [] : ts.isObjectLiteralExpression(node.arguments[1]) && node.arguments[1].properties.every((property) => !ts.isSpreadAssignment(property)) ? node.arguments[1].properties.map((property) => property.name?.getText(sf).replaceAll("'", '').replaceAll('"', '')) : undefined);
    }
    ts.forEachChild(node, walk);
  }
  walk(sf);
}
if (errors.length) {
  console.error(errors.join('\n'));
  process.exitCode = 1;
} else {
  console.log(`i18n: ${keys.size} messages in English and German; keys, interpolations and template copy checked (${seenKeys.size} literal keys).`);
}
