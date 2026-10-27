# @pi-kit/learn

A pi package that drafts a skill from a finished thread. pi-kit installs it into the bundled pi the first time it starts; remove it with `pi remove` and pi-kit stops drafting, nothing else changes.

```
extensions/learn.ts     /learn [thread] and /learn verify [thread]
lib/analysis.mjs        the prompt over the reduced transcript, and the reading of the model's answer (no dependencies; pi-kit's backend loads it too)
lib/verification.mjs    a verification report as a sentence and a level for ctx.ui.notify (no dependencies)
prompts/analyze.md      the analysis prompt
templates/SKILL.md      the shape of the skill the model is asked to write
```

It talks to pi-kit only through the plugin events of `doc/docs/plugins.md`: `pi-kit:thread:transcript`, `pi-kit:attendant:run`, `pi-kit:learn:draft` and `pi-kit:learn:verified`. It never writes a skills folder: the draft waits in pi-kit until the person reads it and approves it. `/learn verify` asks pi-kit to replay the draft from the thread's base commit in a scratch worktree and says how close the result came to the thread's own.

```
pi install ./packages/pi-kit-learn     # or let pi-kit do it
pi list
pi remove ./packages/pi-kit-learn
```
