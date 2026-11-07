// Run independently of the model/browser in the disposable Docker or macOS profile.
// node /opt/verify-model.mjs [--restart]; macOS sets PI_KIT_TEST_PROJECT to its test project.
import assert from 'node:assert/strict';
import { readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

const root = process.env.PI_KIT_TEST_PROJECT || '/home/tester/headless-test-project';
assert.ok(
  root === '/home/tester/headless-test-project' ||
    /^\/Users\/[^/]+\/Library\/Caches\/pi-kit-macos-service-test-[^/]+\/home\/project$/.test(root),
  'Only a disposable integration-test project is allowed',
);
const read = (name) => JSON.parse(readFileSync(join(root, name), 'utf8'));
const input = read('model-input.json');
assert.ok(Array.isArray(input.numbers) && input.numbers.every(Number.isSafeInteger));
assert.ok(typeof input.proof === 'string' && input.proof.length >= 16);
const sum = input.numbers.reduce((total, number) => total + number, 0);
const output = read('model-output.json');
assert.deepEqual(output, { sum, proof: input.proof, model: 'gemma-4-e2b-local' });
assert.equal(statSync(join(root, 'model-output.json')).uid, process.getuid());
console.log(`PASS model-created output: sum=${sum}, exact proof/keys, owned by UID ${process.getuid()}`);
if (process.argv.includes('--restart')) {
  assert.deepEqual(read('model-restart-proof.json'), { sum, proof: input.proof, resumed: true });
  assert.equal(statSync(join(root, 'model-restart-proof.json')).uid, process.getuid());
  console.log('PASS model-created restart output: exact sum/proof, resumed=true, correct owner');
}
