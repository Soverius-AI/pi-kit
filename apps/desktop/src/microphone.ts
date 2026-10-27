/**
 * Microphone permission for voice input. On macOS the operating system, not Chromium, decides: the first request shows the
 * system's own prompt (`systemPreferences.askForMediaAccess`, which needs `NSMicrophoneUsageDescription` in the app's Info.plist and, for the
 * hardened runtime, the `com.apple.security.device.audio-input` entitlement), and a refusal can only be undone in System Settings, so a refusal is
 * explained in a dialog that opens the right pane. Other systems have no per-app prompt that the app can trigger: Chromium asks (Windows/Linux
 * desktops mostly do not), and the renderer's own `getUserMedia` error covers the rest.
 */

export interface MicrophoneAccess {
  granted: boolean;
  status: string;
  message?: string;
}

export interface MediaAccess {
  getMediaAccessStatus(kind: 'microphone'): string;
  askForMediaAccess(kind: 'microphone'): Promise<boolean>;
}

export const MICROPHONE_SETTINGS_URL = 'x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone';

export async function requestMicrophone(platform: NodeJS.Platform, access: MediaAccess, explainRefusal: (status: string) => Promise<void>): Promise<MicrophoneAccess> {
  if (platform !== 'darwin') return { granted: true, status: 'granted' };
  let status = access.getMediaAccessStatus('microphone');
  if (status === 'granted') return { granted: true, status };
  if (status === 'not-determined') {
    // The system's prompt: the user answers it, we get the answer.
    if (await access.askForMediaAccess('microphone')) return { granted: true, status: 'granted' };
    status = access.getMediaAccessStatus('microphone');
  }
  await explainRefusal(status);
  return {
    granted: false,
    status,
    message:
      status === 'restricted'
        ? 'The microphone is restricted on this Mac (a profile or Screen Time), so pi-kit cannot use it.'
        : 'Microphone access is off for pi-kit. Turn it on under System Settings › Privacy & Security › Microphone, then try again.',
  };
}
