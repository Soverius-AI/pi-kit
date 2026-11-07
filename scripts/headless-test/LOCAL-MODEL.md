# Real model E2E: Gemma 4 E2B on the Mac, pi-kit in Docker

This closes the real-inference gap in the initial lifecycle/remote-access run. No cloud provider, paid API call, mocked completion, or desktop attachment is used.

## Tested model and runtime

- `ggml-org/gemma-4-E2B-it-GGUF`, revision `6938c58e698502037401a5f19f6905f2fb2f7dee`.
- `gemma-4-E2B-it-Q4_0.gguf`, 2,841,481,184 bytes.
- SHA-256: `8e30dff3ac4c8434c49a7036fa15564bdbb6044e42bf04550bf1a096ad7e6a52`.
- llama.cpp **0.8.0**, build 11960, commit `8642541b2`, native Apple Silicon / Metal.
- Single model/slot, 16,384-token context, thinking disabled, 1,024-token output limit per completion.
- Mac server bound to **127.0.0.1:18088**, with a disposable API key. Docker Desktop successfully reaches this loopback listener through `host.docker.internal`; no LAN-wide binding was needed.
- The server has no built-in tools or web UI enabled. Agent tools execute in the unprivileged Docker backend, not on the Mac.

## Observed result

A legitimately paired browser submitted the normal AG-UI request over Tailscale HTTPS to the packaged Docker backend. The backend called the Mac's actual OpenAI-compatible llama.cpp endpoint.

### First run

The input file contained numbers `[17, 24, 8]` and a random proof string that was **not** supplied in the prompt. The request required real `read`, `write`, and verification `read` calls, without shell commands or access outside the disposable project.

Observed:

```text
HTTP 200, 187 streamed AG-UI events
Tools: read -> write -> read
RUN_FINISHED outcome: success
Elapsed: 11,238 ms
Output sum: 49
Output proof: exactly matches the random input proof
Output model: gemma-4-e2b-local
```

The four model completions reported output counts **17, 72, 17, 62** tokens (168 total). The first prompt had 4,467 input tokens; later tool turns reused llama.cpp's prompt cache. The final assistant response correctly described the calculation and file verification. llama.cpp's own timing log independently recorded the actual inference requests.

A separate `docker exec` process parsed the files and asserted exact output equality. The model-created file was owned by UID 1001, the test user.

### Follow-up after full container restart

The entire Docker container was restarted, leaving llama.cpp running on the Mac. No login, desktop attachment, reconfiguration, or new pairing was required for the follow-up request. The same persisted thread resumed using the saved model configuration and transcript.

The model read its earlier output, wrote `model-restart-proof.json` with copied sum/proof and `resumed: true`, then read it back:

```text
HTTP 200, 137 streamed AG-UI events
Tools: read -> write -> read
RUN_FINISHED outcome: success
Elapsed: 3,512 ms
Independent file assertions: passed
Desktop attached: false
```

Its four additional completions reported **17, 64, 19, 19** output tokens (119 total). No fallback model/provider was used.

### Authentication

An unauthenticated request to the Mac's `/v1/chat/completions` returned **401**. The disposable model-server key exists only in a private temporary file on the Mac and the disposable Docker profile's private `models.json`, not in git or this report.

## Reproduce

Install a compatible native llama.cpp build (the run used Homebrew `llama.cpp` 0.8.0). Download the exact GGUF revision above, verify its size and SHA-256, and keep it in a model cache rather than the repository.

The run used:

```sh
CACHE="$HOME/.cache/pi-kit-headless-test"
RUN=/tmp/pi-kit-headless-test
mkdir -p "$CACHE" "$RUN"
curl -fL --retry 3 \
  https://huggingface.co/ggml-org/gemma-4-E2B-it-GGUF/resolve/6938c58e698502037401a5f19f6905f2fb2f7dee/gemma-4-E2B-it-Q4_0.gguf \
  -o "$CACHE/gemma-4-E2B-it-Q4_0.gguf"
shasum -a 256 "$CACHE/gemma-4-E2B-it-Q4_0.gguf"
# Compare the result with the pinned SHA-256 above before starting inference.

python3 - <<'PY'
import os, secrets
path = '/tmp/pi-kit-headless-test/llama-api-key'
if not os.path.exists(path):
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(fd, 'w') as f:
        f.write(secrets.token_urlsafe(32) + '\n')
PY

nohup llama-server \
  --model "$CACHE/gemma-4-E2B-it-Q4_0.gguf" \
  --alias gemma-4-e2b-local --host 127.0.0.1 --port 18088 \
  --api-key-file "$RUN/llama-api-key" \
  --ctx-size 16384 --parallel 1 --n-gpu-layers 99 --threads 4 \
  --batch-size 256 --ubatch-size 128 --jinja --reasoning off --no-webui \
  > "$RUN/llama-server.log" 2>&1 &
echo $! > "$RUN/llama-server.pid"

curl -f http://127.0.0.1:18088/health
docker exec --user tester pi-kit-headless-test-9ef77b2 \
  curl -f http://host.docker.internal:18088/health
```

Provision **only the disposable test user's** `/home/tester/.pi/agent/models.json` with this provider. Replace the placeholder with the contents of the private key file, without printing the key or putting it into command-line arguments. Preserve unrelated entries if reusing a profile:

```json
{
  "providers": {
    "local-gemma4": {
      "name": "Local Gemma 4 E2B test",
      "baseUrl": "http://host.docker.internal:18088/v1",
      "api": "openai-completions",
      "apiKey": "<disposable model-server key>",
      "models": [
        {
          "id": "gemma-4-e2b-local",
          "name": "Gemma 4 E2B Q4_0 (Mac llama.cpp)",
          "reasoning": false,
          "input": ["text"],
          "contextWindow": 16384,
          "maxTokens": 1024,
          "samplingParams": { "temperature": 0.2 },
          "cost": { "input": 0, "output": 0, "cacheRead": 0, "cacheWrite": 0 }
        }
      ]
    }
  }
}
```

The test user's `settings.json` selected `defaultProvider: "local-gemma4"`, `defaultModel: "gemma-4-e2b-local"`, and `defaultThinkingLevel: "off"`. Both configuration files were mode 0600 and owned by tester. The service was restarted after provisioning. This is an administrator-owned test fixture, **not evidence that remotely saving a provider through onboarding works**.

After the measured runs, the disposable profile was also tuned with `compaction: { "reserveTokens": 2048, "keepRecentTokens": 4096 }` and the service restarted. Pi's defaults reserve 16,384 tokens and retain 20,000 recent tokens, which are inappropriate for this 16K local context and cause premature compaction warnings. This changes test-profile configuration only; long-context compaction itself is not covered by these tests.

Create `model-input.json` in `/home/tester/headless-test-project` with the numbers and a fresh random proof; do not pre-create the output file. Pair the browser as described in README.md, create a thread with `POST /api/threads`, and check `GET /api/models?thread=<id>` lists/selects the Gemma model.

Evaluate [`model-e2e.browser.js`](./model-e2e.browser.js) inside that paired test-origin browser. Then call:

```js
headlessModelTest.start(
  '<thread-id>',
  'Work only in /home/tester/headless-test-project. Use the read tool to read model-input.json. ' +
    'Add all integers in its numbers array. Use the write tool to create model-output.json ' +
    'with exactly the keys sum (the computed integer), proof (the exact input proof string), ' +
    'and model (gemma-4-e2b-local). Read the output to verify it. ' +
    'Do not run shell commands or access files outside this project. Actually use the tools; ' +
    'do not just show code. Finish with a short confirmation.',
);
// Check until complete; the helper bounds the browser request to four minutes.
headlessModelTest.summary();
```

Require HTTP 200, successful RUN_FINISHED, nonzero model usage, and actual tool results. Independently parse the files **inside Docker**, compare the sum, random proof, and exact keys, and verify tester owns the output. Repeat in the same thread after `docker restart`, writing a different output filename with `resumed: true`.

The independent verifier used for both outputs is included:

```sh
docker cp scripts/headless-test/verify-model.mjs pi-kit-headless-test-9ef77b2:/opt/verify-model.mjs
docker exec --user tester pi-kit-headless-test-9ef77b2 node /opt/verify-model.mjs --restart
```

The helper is a browser-origin test client for the real remote API. It is not a simulated model, a direct llama.cpp client, or a substitute for the paired-device cookie/CSRF authentication.

## End state and cleanup

The model server and Docker service were initially left running for inspection, then stopped during final cleanup. The disposable Docker resources, private key, and temporary logs were removed. The verified GGUF was retained in `~/.cache/pi-kit-headless-test/` for future runs.

For future runs, stop inference by verifying the PID file still names the test `llama-server` invocation, then stopping only that process. The downloaded model can be retained for reruns. To remove the Docker service/data and Tailscale node, use README.md's scoped cleanup instructions. Never remove a shared model cache or unrelated Docker resources.

The small model passed this focused tool-use scenario; this does not establish general coding quality, long-context reliability, vision support, or production deployment hardening. The originally observed remote onboarding-completion gap was subsequently fixed and verified; see RESULTS.md. Provider/credential setup remains intentionally local-only.
