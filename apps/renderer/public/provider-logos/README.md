# Bundled provider marks

- `llama-cpp.svg` — ggml-org/llama.cpp `tools/ui/src/lib/assets/logo.svg` (MIT repository), retrieved 2026-10-23.
- `anthropic.svg`, `openrouter.svg`, `ollama.svg` — [Simple Icons v16.1.0](https://github.com/simple-icons/simple-icons) (`icons/<name>.svg`, CC0), retrieved 2026-10-23.
- `deepseek.svg`, `zai.svg`, `openai.svg`, `mistral.svg`, `groq.svg`, `githubcopilot.svg`, `google.svg`, `cohere.svg`, `perplexity.svg`, `xai.svg`, `qwen.svg`, `kimi.svg`, `cerebras.svg`, `minimax.svg` — [Lobe Icons](https://github.com/lobehub/lobe-icons) `packages/static-svg/icons/<name>.svg`, commit `7d7d0379f18b114a4009dc5cb85a7c375284f31b` (MIT), retrieved 2026-10-23. Lobe Icons maintains the icon paths; brand names and marks remain their owners' trademarks.

These are local assets; the Providers UI never downloads logos at runtime. Add only an explicitly mapped, trusted provider identity. Model-specific llama.cpp connections can use a recognized model-family mark (for example, DeepSeek or GLM → Z.ai). Unknown/user-named endpoints use their initials instead.
