# pi-kit

The pi-kit server and its `pi-kit` command, for machines without the desktop app: Linux, macOS and Windows, on x64 and
arm64.

```sh
npm install -g @soverius-ai/pi-kit
pi-kit service install   # start the backend at sign-in, and now
pi-kit login             # sign in to a model provider
pi-kit open              # the full UI in this computer's browser
```

npm installs only the package for your machine, `@soverius-ai/pi-kit-<os>-<arch>`. It carries its own Node.js runtime,
so the background service keeps working whichever Node.js you switch to later. `pi-kit --help` lists every command.

**Updating:** `pi-kit service stop`, `npm install -g @soverius-ai/pi-kit@latest`, `pi-kit service start`.
**Removing:** `pi-kit service uninstall` first, then `npm uninstall -g @soverius-ai/pi-kit`.

The desktop app and the server archives are on the [releases page](https://github.com/Soverius-AI/pi-kit/releases).
