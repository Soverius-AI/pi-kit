# Examples

Two small things that exercise pi-kit's generative UI without any remote service.

## `a2ui-failing-specs/`: an A2UI surface from a pi extension

A pi extension with one tool, `show_failing_specs`, that returns a fixed A2UI v0.9 payload: a card with a table
of failing specs (a button per row) and a "Rerun all" button. The model only decides to call the tool; the UI is the extension's.

Run it:

1. Make a scratch folder pi-kit may load project extensions from and put the extension in it:

   ```sh
   mkdir -p /tmp/specs-demo/.pi/extensions
   cp -r examples/a2ui-failing-specs /tmp/specs-demo/.pi/extensions/
   ```

2. Start pi-kit (`pnpm run dev:web`) with that folder trusted (`PI_KIT_TRUSTED_CWDS` skips the trust step, outside production builds):

   ```sh
   PI_KIT_TRUSTED_CWDS=/tmp/specs-demo PI_KIT_CWD=/tmp/specs-demo pnpm run dev:web
   ```

   Or skip the trust step and copy the folder to `~/.pi/agent/extensions/` instead.

3. Open http://localhost:4200, start a thread and ask "Which e2e specs fail right now?" (or "Show the failing specs").
   The model calls `show_failing_specs`, and the table appears in the transcript under a bar that says "Rendered from A2UI". "Run" on a row sends pi
   `User performed action "rerun_spec" ... Context: {"spec":"export.spec.ts:41",...}`.

How a tool returns a surface: either `details.a2ui_operations` (what this example does; the model sees only the
tool's text) or a result text that is JSON with an `a2ui_operations` array (the AG-UI convention, e.g. from an MCP
server). Components come from pi-kit's catalog: CopilotKit's A2UI basic catalog, themed with the design tokens, plus
`Table`, `Badge` and the `inset` option of `Row` and `Column`, with the root `Card` as the frame
(`libs/chat/feature-genui/src/lib/a2ui-catalog.ts`). A surface's data is an object: this example writes
`{ path: '/', value: { specs } }` and its table reads `/specs` (a bare array written at `/specs` still renders, because
pi-kit rewrites it, but a surface that arrives as a result text is not rewritten).

## `mcp-app-server/`: an MCP server that ships an MCP App

A zero-dependency stdio MCP server (`server.mjs`) with two tools. `open_issue_form` links a `ui://` resource, an
HTML form (title, team, priority) that talks to the host with the MCP Apps `postMessage` protocol; `create_issue`
is the tool the form calls. It stores issues in memory, so nothing is created anywhere.

Run it: add it to pi's MCP configuration, user level (`~/.pi/agent/mcp.json`) or project level
(`<project>/.pi/mcp.json`, trusted projects only):

```json
{
  "mcpServers": {
    "issues": {
      "command": "node",
      "args": ["/absolute/path/to/pi-kit/examples/mcp-app-server/server.mjs"],
      "exposure": "direct",
      "description": "A toy issue tracker with a create-issue form"
    }
  }
}
```

`exposure: "direct"` declares the tools to the model, so a small local model can call `mcp__issues__open_issue_form`
without writing a codemode script. Then ask pi to "open the issue form for the flaky export.spec.ts:58 test". The
form renders inline under a bar that says "MCP app, sandboxed"; "Create issue" calls `create_issue` through the
agent and shows the new issue's id; "Tell pi" sends a follow-up message into the conversation.

`PI_CODING_AGENT_DIR=<dir>` points pi (and pi-kit) at another agent folder, handy for trying this without touching
`~/.pi/agent`.
