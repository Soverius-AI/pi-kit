# @pi-kit/meat-proxy

A pi package that tells, for a finished thread, how much of its outcome you steered: the **Meat Proxy Score** (the line-weighted share of the outcome's hunks you specified, corrected or changed by hand) and its complement, the **Vibe Score**. pi-kit installs it into the bundled pi the first time it starts; remove it with `pi remove` and the badge shows the outcome alone, the Outcome view shows plain hunks and Settings shows no histogram. Nothing else changes.

```
extensions/meat-proxy.ts   /score [thread]
lib/hunks.mjs              the outcome diff split into hunks, with their ids
lib/ledger.mjs             what you put into the thread, counted without a model: specificity, corrections, review comments, answers, chips, hand edits, tool calls per message, unattended turns, time between turns
lib/attribution.mjs        the prompt that asks the attendant's model to label every hunk, and the reading of its answer
lib/score.mjs              the arithmetic: the score, its inputs, the sentence ("62 % steered: 14 of 23 hunks, 9 by the first prompt, 3 by review comments, 2 by hand")
lib/pipeline.mjs           the whole scoring of one thread against a host (the extension's host asks pi-kit over the event bus; pi-kit's backend answers directly)
prompts/attribute.md       the attribution prompt
```

It talks to pi-kit only through the plugin events of `doc/docs/plugins.md`: `pi-kit:thread:outcome`, `pi-kit:thread:transcript`, `pi-kit:thread:baselines`, `pi-kit:attendant:run` and `pi-kit:thread:annotate`. It never reads pi-kit's database. Everything is retrospective: the score never changes how a thread runs.

```
pi install ./packages/pi-kit-meat-proxy     # or let pi-kit do it
pi list
pi remove ./packages/pi-kit-meat-proxy
```
