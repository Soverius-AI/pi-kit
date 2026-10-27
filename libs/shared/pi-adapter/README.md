# shared-pi-adapter

Pure translation between pi and AG-UI: `mapEvent` turns pi's session events into AG-UI events, `sessionToMessages` rebuilds a
transcript from a session file, `buildSessionTree` lays out the session graph, plus the replay-log helpers, usage totals, patch
hunks and A2UI normalisation. The pi shapes are typed structurally (`pi-events.ts`), so the library never imports the pi
package; `fixtures/` holds events recorded from the real SDK (`npm run record:fixtures`). Tags `scope:shared`, `type:util`;
alias `@pi-kit/pi-adapter`.
