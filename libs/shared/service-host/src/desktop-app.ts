import { execFile, execFileSync, spawn } from 'node:child_process';
import {
  accessSync,
  chmodSync,
  constants,
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readlinkSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import type { DesktopApp } from './desktop-cli';

/** A window can open here: not over SSH, and on Linux only with a display. */
const canShow = (env: NodeJS.ProcessEnv): boolean =>
  !env['SSH_CONNECTION'] &&
  !env['SSH_TTY'] &&
  (process.platform !== 'linux' || !!env['DISPLAY'] || !!env['WAYLAND_DISPLAY']);

/** Starts a program that outlives this command. */
const detached = (file: string, args: string[]): void =>
  void spawn(file, args, { detached: true, stdio: 'ignore' })
    .on('error', () => undefined)
    .unref();

/**
 * Where the pi-kit app lives on this computer and how it is installed for one user without an administrator: macOS
 * `/Applications` (or `~/Applications` where that is not writable) from the release's zip, Windows the per-user install
 * of its installer, Linux `~/Applications/pi-kit.AppImage` with a menu entry.
 */
export function desktopApp(env: NodeJS.ProcessEnv = process.env, home = homedir()): DesktopApp | undefined {
  if (process.platform === 'darwin') {
    const places = ['/Applications', join(home, 'Applications')];
    return {
      installed: () => places.map((dir) => join(dir, 'pi-kit.app')).find((app) => existsSync(app)),
      install: async (zip) => {
        const writable = places.find((dir) => {
          try {
            accessSync(dir, constants.W_OK);
            return true;
          } catch {
            return false;
          }
        });
        const dir = writable ?? places[1];
        mkdirSync(dir, { recursive: true });
        // ditto keeps the app's signature, symlinks and extended attributes as the zip holds them.
        execFileSync('ditto', ['-x', '-k', zip, dir]);
        return join(dir, 'pi-kit.app');
      },
      start: (app) => canShow(env) && (detached('open', [app]), true),
    };
  }
  if (process.platform === 'win32') {
    const perUser = join(env['LOCALAPPDATA'] ?? join(home, 'AppData', 'Local'), 'Programs', 'pi-kit', 'pi-kit.exe');
    const forEveryone = [env['ProgramFiles'], env['ProgramFiles(x86)']].flatMap((dir) =>
      dir ? [join(dir, 'pi-kit', 'pi-kit.exe')] : [],
    );
    return {
      installed: () => [perUser, ...forEveryone].find((exe) => existsSync(exe)),
      install: async (installer) => {
        // For this user only, also from an elevated prompt, where the installer would otherwise install for everyone.
        await promisify(execFile)(installer, ['/S', '/currentuser']);
        if (!existsSync(perUser)) throw new Error(`the installer finished, but ${perUser} is not there`);
        return perUser;
      },
      start: (exe) => canShow(env) && (detached(exe, []), true),
    };
  }
  if (process.platform === 'linux') {
    const image = join(home, 'Applications', 'pi-kit.AppImage');
    return {
      installed: () => (existsSync(image) ? image : undefined),
      install: async (file) => {
        mkdirSync(join(home, 'Applications'), { recursive: true });
        copyFileSync(file, image);
        chmodSync(image, 0o755);
        const icon = appImageIcon(image, join(home, '.local', 'share', 'icons'));
        const entry = join(home, '.local', 'share', 'applications', 'pi-kit.desktop');
        mkdirSync(join(entry, '..'), { recursive: true });
        writeFileSync(
          entry,
          `[Desktop Entry]\nType=Application\nName=pi-kit\nExec="${image}" %U\nTerminal=false\nCategories=Development;\n${icon ? `Icon=${icon}\n` : ''}`,
        );
        return image;
      },
      start: (app) => canShow(env) && (detached(app, []), true),
    };
  }
  return undefined;
}

/**
 * The AppImage's own icon, copied out of the image for the menu entry; undefined when it has none to give. `.DirIcon` is
 * the icon, or a link to it inside the image (electron-builder's points into usr/share/icons).
 */
function appImageIcon(image: string, icons: string): string | undefined {
  const scratch = mkdtempSync(join(tmpdir(), 'pi-kit-icon-'));
  const extract = (path: string) =>
    execFileSync(image, ['--appimage-extract', path], { cwd: scratch, stdio: 'ignore' });
  try {
    extract('.DirIcon');
    const dirIcon = join(scratch, 'squashfs-root', '.DirIcon');
    const target = lstatSync(dirIcon).isSymbolicLink() ? readlinkSync(dirIcon) : '.DirIcon';
    if (target !== '.DirIcon') extract(target);
    mkdirSync(icons, { recursive: true });
    copyFileSync(join(scratch, 'squashfs-root', target), join(icons, 'pi-kit.png'));
    return join(icons, 'pi-kit.png');
  } catch {
    return undefined;
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}
