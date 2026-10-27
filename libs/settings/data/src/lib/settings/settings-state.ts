import type { Translate } from '@pi-kit/i18n';
import type {
  Diagnostics,
  KeyValidation,
  ResourcesOverview,
  SettingsOverview,
  TrustList,
  TrustState,
} from '@pi-kit/protocol';
import { settingsSections, type SettingsSectionId } from '@pi-kit/ui';
export interface LoginPrompt {
  promptId: string;
  kind: 'text' | 'secret' | 'select' | 'manual_code';
  message: string;
  placeholder?: string;
  options?: { id: string; label: string; description?: string }[];
}

/** A provider sign-in in progress, as the dialog shows it (OAuth inline, an API key in the workflow dialog). */
export interface LoginFlow {
  provider: string;
  providerName: string;
  type: 'api_key' | 'oauth';
  id?: string;
  status: 'starting' | 'running' | 'done' | 'error';
  /** Progress lines and links the flow announced. */
  notes: { text: string; url?: string; label?: string }[];
  /** A device code to enter at `verificationUri`. */
  device?: { userCode: string; verificationUri: string };
  authUrl?: { url: string; instructions?: string };
  prompt?: LoginPrompt;
  error?: string;
}

/** The API-key workflow : 1 provider, 2 where to get a key, 3 paste it, 4 the result. */
export interface KeyWorkflow {
  step: 1 | 2 | 3 | 4;
  /** Shown inside the "Add a provider" wizard, not as a dialog of its own. */
  embedded?: boolean;
  provider?: string;
  /** Step 3 after “Validate and save”: pi is storing the key, then the provider is asked once. */
  phase: 'editing' | 'saving' | 'validating' | 'done' | 'failed';
  validation?: KeyValidation;
  error?: string;
}

export interface SettingsStoreState {
  section: SettingsSectionId;
  /** The sub-page of the open section: the folder of the project whose page is showing (Settings › Projects); `undefined` is the section's list. */
  project: string | undefined;
  search: string;
  overview: SettingsOverview | undefined;
  /** Saves in flight, and the “Saved” tick that follows a successful one. */
  saving: number;
  saved: boolean;
  /** Why the session should be reloaded for a change to take effect there. */
  reloadReasons: string[];
  reloading: boolean;
  flow: LoginFlow | undefined;
  keyWorkflow: KeyWorkflow | undefined;
  /** Counts finished sign-ins and sign-outs; the model list reloads when it moves. */
  credentialsChanged: number;
  resources: ResourcesOverview | undefined;
  resourcesBusy: string[];
  diagnostics: Diagnostics | undefined;
  trustList: TrustList | undefined;
  /** Trust state of each known folder (Settings › Projects). */
  folders: Record<string, TrustState>;
}

/** The old dialog’s tab names (`UiStore.openSettings`, `/models`, `/login`, `/hotkeys`) and the MCP panel map onto the new sections. */
export function sectionOfTab(translate: Translate, tab: string): SettingsSectionId {
  const legacy: Record<string, SettingsSectionId> = {
    keys: 'keybindings',
    connectors: 'mcp',
    'attendant-activity': 'attendant',
  };
  const wanted = legacy[tab] ?? tab;
  return settingsSections(translate).some((s) => s.id === wanted) ? (wanted as SettingsSectionId) : 'general';
}

/** The key file format of Export / Import. */
export interface KeybindingsFile {
  format: 'pi-kit-keybindings';
  version: 1;
  'pi-kit': Record<string, string>;
  pi: Record<string, string[]>;
}
