/**
 * What the settings dialog offers: the sections of the left nav and every setting with its name, description and where it is
 * stored. The dialog renders its rows from this table (a row looks its text and storage chip up by `id`) and the search box filters the same table, so
 * what the search finds is exactly what the page shows.
 */

import type { Translate } from '@pi-kit/i18n';
export type SettingsSectionId =
  | 'general'
  | 'appearance'
  | 'keybindings'
  | 'models'
  | 'local-models'
  | 'providers'
  | 'mcp'
  | 'extensions'
  | 'skills'
  | 'projects'
  | 'attendant'
  | 'advanced'
  | 'voice'
  | 'computer-use';
export type SettingsNavGroup = 'App' | 'pi' | 'Workspace';

export interface SettingsSection {
  id: SettingsSectionId;
  label: string;
  group: SettingsNavGroup;
  /** The line under the section title. */
  intro: string;
}

export const settingsSections = (translate: Translate): readonly SettingsSection[] => [
  {
    id: 'general',
    label: translate('shared.catalog.general'),
    group: 'App',
    intro: translate('shared.catalog.howPiCompactsRetriesAndQueuesAnd'),
  },
  {
    id: 'appearance',
    label: translate('shared.catalog.appearance'),
    group: 'App',
    intro: translate('shared.catalog.themeTextSizeTheThreadListAnd'),
  },
  {
    id: 'keybindings',
    label: translate('shared.catalog.keybindings'),
    group: 'App',
    intro: translate('shared.catalog.piKitSShortcutsAndPiS'),
  },
  {
    id: 'models',
    label: translate('settings.modelManagement.chatModels'),
    group: 'pi',
    intro: translate('settings.modelManagement.defaultsForNewChatsPinnedModelShortcutsAnd'),
  },
  {
    id: 'local-models',
    label: translate('settings.modelManagement.localModels'),
    group: 'pi',
    intro: translate('settings.modelManagement.yourDownloadedModelsDiskSpaceAndLlamaSwap'),
  },
  {
    id: 'providers',
    label: translate('shared.catalog.providers'),
    group: 'pi',
    intro: translate('shared.catalog.wherePiGetsItsModelsSubscriptionsAPI'),
  },
  {
    id: 'mcp',
    label: translate('shared.catalog.mCPServers'),
    group: 'pi',
    intro: translate('shared.catalog.toolsPiCanCallServicesYouConnect'),
  },
  {
    id: 'computer-use',
    label: translate('shared.catalog.computerUse'),
    group: 'pi',
    intro: translate('shared.catalog.computerUseIntro'),
  },
  {
    id: 'extensions',
    label: translate('settings.addPackageWizard.extensions'),
    group: 'pi',
    intro: translate('settings.modelManagement.installedPackagesExtensionsAndPromptTemplatesAndWhich'),
  },
  {
    id: 'skills',
    label: translate('shared.catalog.skills'),
    group: 'pi',
    intro: translate('settings.modelManagement.createEditAndEnableYourSkillsManageLearned'),
  },
  {
    id: 'projects',
    label: translate('shared.catalog.projects'),
    group: 'Workspace',
    intro: translate('shared.catalog.theFoldersInTheSidebarWhatThey'),
  },
  {
    id: 'attendant',
    label: translate('shared.catalog.attendant'),
    group: 'Workspace',
    intro: translate('shared.catalog.anOptionalSecondAgentThatKeepsAn'),
  },
  {
    id: 'advanced',
    label: translate('shared.catalog.advanced'),
    group: 'Workspace',
    intro: translate('shared.catalog.diagnosticsThePiReleaseInUseSaved'),
  },
  {
    id: 'voice',
    label: translate('shared.catalog.voice'),
    group: 'App',
    intro: translate('shared.catalog.dictateIntoTheComposerWhistleRunsOn'),
  },
];

export const SETTINGS_NAV_GROUPS: readonly SettingsNavGroup[] = ['App', 'pi', 'Workspace'];

/** Where a setting lives: one of pi’s own files, pi-kit’s SQLite database, the folder’s `.pi/`, or macOS itself (a privacy permission it grants the app). */
export type SettingsStorage = 'pi' | 'pi-kit' | 'project' | 'macos';

export interface SettingEntry {
  id: string;
  section: SettingsSectionId;
  /** The group (card) on the page it belongs to. */
  group: string;
  name: string;
  description: string;
  storage: SettingsStorage;
  /** The file for `pi` and `project` settings (`settings.json`, `auth.json`, `keybindings.json`, `trust.json`, `mcp.json`). */
  file?: string;
  /** Extra words the search matches that the text does not contain. */
  keywords?: string;
  /** Changing it needs the session reloaded to take effect there (the dialog offers the reload). */
  reload?: boolean;
}

export const settingsCatalog = (translate: Translate): readonly SettingEntry[] => [
  {
    id: 'language',
    section: 'general',
    group: translate('settings.language.heading'),
    name: translate('settings.language.name'),
    description: translate('settings.language.description'),
    storage: 'pi-kit',
    keywords: 'language locale english german deutsch sprache',
  },
  // ---- General
  {
    id: 'auto-compaction',
    section: 'general',
    group: translate('shared.catalog.context'),
    name: translate('shared.catalog.compactTheContextAutomatically'),
    description: translate('shared.catalog.whenAConversationNearsTheModelS'),
    storage: 'pi',
    file: 'settings.json',
    keywords: 'compaction summarise context window',
  },
  {
    id: 'retry',
    section: 'general',
    group: translate('shared.catalog.runs'),
    name: translate('shared.catalog.retryOnProviderErrors'),
    description: translate('shared.catalog.whenAProviderFailsForAMoment'),
    storage: 'pi',
    file: 'settings.json',
    keywords: 'retries backoff errors network',
  },
  {
    id: 'steering-mode',
    section: 'general',
    group: translate('shared.catalog.runs'),
    name: translate('shared.catalog.steeringMessages'),
    description: translate('shared.catalog.messagesYouSendToSteerPiWhile'),
    storage: 'pi',
    file: 'settings.json',
    keywords: 'steer queue',
  },
  {
    id: 'follow-up-mode',
    section: 'general',
    group: translate('shared.catalog.runs'),
    name: translate('shared.catalog.followUpMessages'),
    description: translate('shared.catalog.messagesYouQueueForAfterTheRun'),
    storage: 'pi',
    file: 'settings.json',
    keywords: 'follow up queue',
  },
  {
    id: 'versions',
    section: 'general',
    group: translate('shared.catalog.versions'),
    name: translate('shared.catalog.versionsAndUpdates'),
    description: translate('shared.catalog.piKitPiTheInstalledPackagesAnd'),
    storage: 'pi-kit',
    file: 'pi-release.json',
    keywords: 'update upgrade release restart version',
  },

  // ---- Appearance (all in pi-kit's database)
  {
    id: 'theme',
    section: 'appearance',
    group: translate('shared.catalog.look'),
    name: translate('shared.catalog.theme'),
    description: translate('shared.catalog.systemFollowsYourOperatingSystemSLight'),
    storage: 'pi-kit',
    keywords: 'dark light colour color',
  },
  {
    id: 'prose-size',
    section: 'appearance',
    group: translate('shared.catalog.text'),
    name: translate('shared.catalog.textSize'),
    description: translate('shared.catalog.theSizeOfProseInTheTranscript'),
    storage: 'pi-kit',
    keywords: 'font prose reading',
  },
  {
    id: 'code-size',
    section: 'appearance',
    group: translate('shared.catalog.text'),
    name: translate('shared.catalog.codeSize'),
    description: translate('shared.catalog.theSizeOfCodeBlocksAndTool'),
    storage: 'pi-kit',
    keywords: 'font monospace mono',
  },
  {
    id: 'density',
    section: 'appearance',
    group: translate('shared.catalog.look'),
    name: translate('shared.catalog.threadList'),
    description: translate('shared.catalog.detailedGivesEachThreadInTheSidebar'),
    storage: 'pi-kit',
    keywords: 'density compact comfortable detailed spacing sidebar',
  },
  {
    id: 'show-usage',
    section: 'appearance',
    group: translate('shared.catalog.transcript'),
    name: translate('shared.catalog.showUsageUnderEveryTurn'),
    description: translate('shared.catalog.theTokensCostAndTimeOfA'),
    storage: 'pi-kit',
    keywords: 'tokens cost usage line',
  },
  {
    id: 'thinking-expanded',
    section: 'appearance',
    group: translate('shared.catalog.transcript'),
    name: translate('shared.catalog.showThinkingExpanded'),
    description: translate('shared.catalog.openPiSThinkingTracesInsteadOf'),
    storage: 'pi-kit',
    keywords: 'reasoning trace',
  },
  {
    id: 'collapse-tool-output',
    section: 'appearance',
    group: translate('shared.catalog.transcript'),
    name: translate('shared.catalog.collapseToolOutput'),
    description: translate('shared.catalog.capTheOutputOfToolCallsTo'),
    storage: 'pi-kit',
    keywords: 'bash edit read output',
  },

  // ---- Keybindings
  {
    id: 'keys-pi-kit',
    section: 'keybindings',
    group: translate('settings.versionsBlock.piKit'),
    name: translate('shared.catalog.piKitShortcuts'),
    description: translate('shared.catalog.newThreadCommandPaletteSwitchingModelAnd'),
    storage: 'pi-kit',
    keywords: 'keyboard hotkey shortcut keybinding conflict',
  },
  {
    id: 'keys-pi',
    section: 'keybindings',
    group: 'pi',
    name: translate('shared.catalog.piSTerminalShortcuts'),
    description: translate('shared.catalog.theKeysOfPiSOwnInterface'),
    storage: 'pi',
    file: 'keybindings.json',
    keywords: 'keyboard hotkey shortcut keybinding conflict terminal',
    reload: true,
  },
  {
    id: 'keys-io',
    section: 'keybindings',
    group: translate('shared.catalog.exportAndImport'),
    name: translate('shared.catalog.exportAndImport'),
    description: translate('shared.catalog.saveEveryCustomShortcutAsAJSON'),
    storage: 'pi-kit',
    keywords: 'json backup share',
  },

  // ---- Chat models
  {
    id: 'default-model',
    section: 'models',
    group: translate('shared.catalog.newThreads'),
    name: translate('shared.catalog.defaultModel'),
    description: translate('shared.catalog.theModelANewThreadStartsWith'),
    storage: 'pi',
    file: 'settings.json',
    keywords: 'model default startup',
  },
  {
    id: 'default-effort',
    section: 'models',
    group: translate('shared.catalog.newThreads'),
    name: translate('settings.modelManagement.reasoningEffort'),
    description: translate('settings.modelManagement.thinkingEffortForNewChatsHigherLevelsCan'),
    storage: 'pi',
    file: 'settings.json',
    keywords: 'thinking level reasoning',
  },
  {
    id: 'pinned-models',
    section: 'models',
    group: translate('shared.catalog.pinnedModels'),
    name: translate('shared.catalog.pinnedModels'),
    description: translate('shared.catalog.theModelsMCyclesThroughInThis'),
    storage: 'pi',
    file: 'settings.json',
    keywords: 'enabledModels scoped pin cycle switch order drag',
  },
  {
    id: 'price-table',
    section: 'models',
    group: translate('shared.catalog.prices'),
    name: translate('shared.catalog.modelsAndPrices'),
    description: translate('shared.catalog.contextWindowAndPricePerMillionTokens'),
    storage: 'pi',
    file: 'models.json',
    keywords: 'cost price context window catalog table',
  },
  {
    id: 'pi-update',
    section: 'models',
    group: translate('shared.catalog.catalogs'),
    name: translate('shared.catalog.piAndModelCatalogs'),
    description: translate('shared.catalog.whichPiRunsAndWhetherANewer'),
    storage: 'pi-kit',
    keywords: 'update catalog version',
  },

  // ---- Providers
  {
    id: 'providers',
    section: 'providers',
    group: translate('shared.catalog.providers'),
    name: translate('shared.catalog.providerSignIn'),
    description: translate('shared.catalog.subscriptionsAPIKeysAndLocalServersA'),
    storage: 'pi',
    file: 'auth.json',
    keywords: 'api key login oauth credentials sign in openrouter anthropic openai secret',
  },

  {
    id: 'key-storage',
    section: 'providers',
    group: translate('shared.catalog.whereKeysAreKept'),
    name: translate('shared.catalog.whereAPIKeysAreKept'),
    description: translate('shared.catalog.keysGoIntoTheOperatingSystemS'),
    storage: 'pi',
    file: 'auth.json',
    keywords:
      'keychain keyring credential manager secret-tool plain text plaintext move migrate encrypt secure storage',
  },

  // ---- MCP servers (connectors, merged into this section)
  {
    id: 'mcp-servers',
    section: 'mcp',
    group: translate('shared.catalog.servers'),
    name: translate('shared.catalog.mCPServers'),
    description: translate('shared.catalog.everyServerPiConnectsToTheCatalog'),
    storage: 'pi',
    file: 'mcp.json',
    keywords:
      'model context protocol tools connector connectors reconnect oauth sign in servers integration plugin edit headers environment arguments secret rename',
  },
  {
    id: 'mcp-add',
    section: 'mcp',
    group: translate('shared.catalog.servers'),
    name: translate('shared.catalog.addAServer'),
    description: translate('shared.catalog.addAServiceFromTheCatalogOr'),
    storage: 'pi',
    file: 'mcp.json',
    keywords:
      'add connect connector custom mcp server url command stdio npx uvx http catalog linear github slack notion sentry atlassian jira confluence figma',
  },
  {
    id: 'connector-project-only',
    section: 'mcp',
    group: translate('shared.catalog.servers'),
    name: translate('shared.catalog.thisProjectOnly'),
    description: translate('shared.catalog.addAServerToThisFolderS'),
    storage: 'project',
    file: 'mcp.json',
    keywords: 'connector server project folder local trust scope workspace user',
  },
  {
    id: 'connector-exposure',
    section: 'mcp',
    group: translate('shared.catalog.servers'),
    name: translate('shared.catalog.howToolsReachTheModel'),
    description: translate('shared.catalog.directDeclaresEveryToolToTheModel'),
    storage: 'pi',
    file: 'mcp.json',
    keywords: 'connector server exposure direct codemode deferred tools context tokens',
    reload: true,
  },
  {
    id: 'mcp-files',
    section: 'mcp',
    group: translate('shared.catalog.theFiles'),
    name: translate('shared.catalog.theMcpJsonFiles'),
    description: translate('shared.catalog.everythingOnThisPageIsTwoFiles'),
    storage: 'pi',
    file: 'mcp.json',
    keywords: 'mcp.json file editor edit here validate syntax open reveal finder config json',
  },

  // ---- Local models
  {
    id: 'local-models',
    section: 'local-models',
    group: translate('settings.modelManagement.libraryGroup'),
    name: translate('settings.modelManagement.libraryName'),
    description: translate('settings.modelManagement.libraryDescription'),
    storage: 'pi-kit',
    keywords:
      'hf hugging face gguf llama.cpp llama-swap install engine local download retry cancel delete disk space cleanup',
  },

  // ---- Extensions
  {
    id: 'packages',
    section: 'extensions',
    group: translate('shared.catalog.packages'),
    name: translate('shared.catalog.packages'),
    description: translate('shared.catalog.installedWithPiInstallEachBringsExtensions'),
    storage: 'pi',
    file: 'settings.json',
    keywords: 'package packages install npm git pi-package update outdated browse add remove version marketplace',
    reload: true,
  },
  {
    id: 'resources',
    section: 'extensions',
    group: translate('shared.catalog.inventory'),
    name: translate('settings.modelManagement.yourExtensionsAndPromptTemplates'),
    description: translate('settings.modelManagement.theExtensionAndPromptFilesPiFoundTurn'),
    storage: 'pi',
    file: 'settings.json',
    keywords: 'extension prompt template enable disable reload',
    reload: true,
  },
  // ---- Skills
  {
    id: 'skills',
    section: 'skills',
    group: translate('shared.catalog.inventory'),
    name: translate('settings.extensionsSection.yourSkills'),
    description: translate('settings.modelManagement.theSkillsInYourUserAndProjectFolders'),
    storage: 'pi',
    file: 'settings.json',
    keywords: 'skill new create edit enable disable reload learned retired',
    reload: true,
  },
  {
    id: 'skill-commands',
    section: 'skills',
    group: translate('shared.catalog.skills'),
    name: translate('shared.catalog.skillsAsSlashCommands'),
    description: translate('shared.catalog.registerEverySkillAsSkillNameIn'),
    storage: 'pi',
    file: 'settings.json',
    keywords: 'slash command skill',
    reload: true,
  },

  // ---- Projects: the list and the defaults are the page; the rows from `project-trust` on are on a project's own page (search finds them and the page says where)
  {
    id: 'projects-list',
    section: 'projects',
    group: translate('shared.catalog.projects'),
    name: translate('shared.catalog.projects'),
    description: translate('shared.catalog.theFoldersInTheSidebarDragTo'),
    storage: 'pi-kit',
    keywords: 'project sidebar hide show order reorder folder group add forget workspace',
  },
  {
    id: 'default-trust',
    section: 'projects',
    group: translate('shared.catalog.defaultsForEveryProject'),
    name: translate('shared.catalog.projectTrustForNewFolders'),
    description: translate('shared.catalog.whatPiDoesForAFolderIt'),
    storage: 'pi',
    file: 'settings.json',
    keywords: 'trust ask always never security',
  },
  {
    id: 'default-worktree-root',
    section: 'projects',
    group: translate('shared.catalog.defaultsForEveryProject'),
    name: translate('shared.catalog.worktreeFolder'),
    description: translate('shared.catalog.whereNewWorktreesAreMadeOneSubfolder'),
    storage: 'pi-kit',
    keywords: 'worktree folder root path directory',
  },
  {
    id: 'default-start',
    section: 'projects',
    group: translate('shared.catalog.defaultsForEveryProject'),
    name: translate('shared.catalog.newThreadsStart'),
    description: translate('shared.catalog.whatTheWhereRowOfANew'),
    storage: 'pi-kit',
    keywords: 'new thread start local worktree ask where',
  },
  {
    id: 'project-trust',
    section: 'projects',
    group: translate('shared.catalog.trust'),
    name: translate('shared.catalog.runProjectResources'),
    description: translate('shared.catalog.whetherAFolderSOwnExtensionsSkills'),
    storage: 'pi',
    file: 'trust.json',
    keywords: 'trust project resources review known folders security revoke',
  },
  {
    id: 'project-start',
    section: 'projects',
    group: translate('shared.catalog.newThreads'),
    name: translate('shared.catalog.start'),
    description: translate('shared.catalog.whereANewThreadOfThisProject'),
    storage: 'pi-kit',
    keywords: 'new thread start local worktree ask where project',
  },
  {
    id: 'project-switch',
    section: 'projects',
    group: translate('shared.catalog.newThreads'),
    name: translate('shared.catalog.localSwitchingBranches'),
    description: translate('shared.catalog.letANewLocalThreadCheckOut'),
    storage: 'pi-kit',
    keywords: 'branch switch checkout local clean tree',
  },
  {
    id: 'project-worktree-folder',
    section: 'projects',
    group: translate('shared.catalog.worktrees'),
    name: translate('shared.catalog.worktreeFolderOfThisProject'),
    description: translate('shared.catalog.whereThisProjectSWorktreesGoOne'),
    storage: 'pi-kit',
    keywords: 'worktree folder root path directory project',
  },
  {
    id: 'project-base',
    section: 'projects',
    group: translate('shared.catalog.worktrees'),
    name: translate('shared.catalog.cutFrom'),
    description: translate('shared.catalog.theBaseANewWorktreeStartsFrom'),
    storage: 'pi-kit',
    keywords: 'worktree base branch origin fetch cut from',
  },
  {
    id: 'project-carry',
    section: 'projects',
    group: translate('shared.catalog.worktrees'),
    name: translate('shared.catalog.carryUncommittedChanges'),
    description: translate('shared.catalog.applyTheFolderSStagedAndUnstaged'),
    storage: 'pi-kit',
    keywords: 'carry uncommitted changes diff patch dirty ask always never worktree',
  },
  {
    id: 'project-branch',
    section: 'projects',
    group: translate('shared.catalog.worktrees'),
    name: translate('shared.catalog.branch'),
    description: translate('shared.catalog.aWorktreeSBranchIsNamedFrom'),
    storage: 'pi-kit',
    keywords: 'branch name prefix detached worktree',
  },
  {
    id: 'project-remove',
    section: 'projects',
    group: translate('shared.catalog.worktrees'),
    name: translate('shared.catalog.removeTheFolder'),
    description: translate('shared.catalog.whatHappensToAWorktreeSFolder'),
    storage: 'pi-kit',
    keywords: 'remove delete folder worktree clean up after merge hand off archive days',
  },
  {
    id: 'project-scripts',
    section: 'projects',
    group: translate('shared.catalog.setupScripts'),
    name: translate('shared.catalog.setupScripts'),
    description: translate('shared.catalog.commandsTypedIntoANewWorktreeS'),
    storage: 'pi-kit',
    keywords: 'setup script command install copy env files worktree lockfile pnpm npm yarn bun',
  },
  {
    id: 'project-open-worktrees',
    section: 'projects',
    group: translate('shared.catalog.openWorktrees'),
    name: translate('shared.catalog.openWorktrees'),
    description: translate('shared.catalog.theFoldersAProjectHasRightNow'),
    storage: 'pi-kit',
    keywords: 'open worktrees hand off merge back remove folder thread branch ahead',
  },
  {
    id: 'project-sidebar',
    section: 'projects',
    group: translate('shared.catalog.sidebar'),
    name: translate('shared.catalog.showInTheSidebar'),
    description: translate('shared.catalog.aHiddenProjectStaysKnownTheSidebar'),
    storage: 'pi-kit',
    keywords: 'sidebar hide show project',
  },
  {
    id: 'project-forget',
    section: 'projects',
    group: translate('shared.catalog.sidebar'),
    name: translate('shared.catalog.forgetThisProject'),
    description: translate('shared.catalog.removesTheProjectFromTheSidebarAnd'),
    storage: 'pi-kit',
    keywords: 'forget remove project folder workspace',
  },
  {
    id: 'score-histogram',
    section: 'projects',
    group: translate('shared.catalog.steeredOrVibed'),
    name: translate('shared.catalog.meatProxyAndVibeScores'),
    description: translate('shared.catalog.howMuchOfEachFinishedThreadS'),
    storage: 'pi-kit',
    keywords: 'meat proxy vibe score steered histogram outcome thread hunk',
  },

  // ---- Attendant
  {
    id: 'attendant',
    section: 'attendant',
    group: translate('shared.catalog.attendant'),
    name: translate('shared.catalog.attendantAgent'),
    description: translate('shared.catalog.aSecondAgentOfPiKitS'),
    storage: 'pi-kit',
    keywords: 'background agent titles summary assistant suggestions',
  },
  {
    id: 'attendant-model',
    section: 'attendant',
    group: translate('shared.catalog.attendant'),
    name: translate('shared.catalog.model'),
    description: translate('shared.catalog.whichModelTheAttendantUsesAutomaticPicks'),
    storage: 'pi-kit',
    keywords: 'attendant model cheapest local',
  },
  {
    id: 'attendant-on-end',
    section: 'attendant',
    group: translate('shared.catalog.attendant'),
    name: translate('shared.catalog.afterARunEnds'),
    description: translate('shared.catalog.lookAtAThreadWhenARun'),
    storage: 'pi-kit',
    keywords: 'attendant schedule run end finish when',
  },
  {
    id: 'attendant-follow-ups',
    section: 'attendant',
    group: translate('shared.catalog.attendant'),
    name: translate('shared.catalog.followUpPrompts'),
    description: translate('shared.catalog.followUpPromptsDescription'),
    storage: 'pi-kit',
    keywords: 'attendant prompt suggestion ghost follow up subagent',
  },
  {
    id: 'attendant-on-question',
    section: 'attendant',
    group: translate('shared.catalog.attendant'),
    name: translate('shared.catalog.whenAThreadAsksAQuestion'),
    description: translate('shared.catalog.lookAtAThreadWhenPiStops'),
    storage: 'pi-kit',
    keywords: 'attendant schedule question interrupt dialog confirm when',
  },
  {
    id: 'attendant-every',
    section: 'attendant',
    group: translate('shared.catalog.attendant'),
    name: translate('shared.catalog.everySoManyMinutes'),
    description: translate('shared.catalog.alsoLookAtTheThreadsThatChanged'),
    storage: 'pi-kit',
    keywords: 'attendant schedule interval sweep minutes when',
  },
  {
    id: 'attendant-cap',
    section: 'attendant',
    group: translate('shared.catalog.attendant'),
    name: translate('shared.catalog.dailyCostCap'),
    description: translate('shared.catalog.theMostTheAttendantMaySpendIn'),
    storage: 'pi-kit',
    keywords: 'attendant cost budget dollars limit spend',
  },
  {
    id: 'attendant-no-cap',
    section: 'attendant',
    group: translate('shared.catalog.attendant'),
    name: translate('shared.catalog.noDailyLimit'),
    description: translate('shared.catalog.letTheAttendantSpendWithoutACap'),
    storage: 'pi-kit',
    keywords: 'attendant cost budget unlimited limit spend',
  },
  {
    id: 'attendant-projects',
    section: 'attendant',
    group: translate('shared.catalog.projects'),
    name: translate('shared.catalog.projectsTheAttendantWorksIn'),
    description: translate('shared.catalog.turnItOffForAProjectAnd'),
    storage: 'pi-kit',
    keywords: 'attendant opt out project folder',
  },
  {
    id: 'attendant-activity',
    section: 'attendant',
    group: translate('shared.catalog.activity'),
    name: translate('shared.catalog.attendantActivity'),
    description: translate('shared.catalog.everythingTheAttendantDidOrProposedNewest'),
    storage: 'pi-kit',
    keywords: 'attendant log history cost tokens actions',
  },

  // ---- Advanced
  {
    id: 'diagnostics',
    section: 'advanced',
    group: translate('shared.catalog.diagnostics'),
    name: translate('shared.catalog.diagnostics'),
    description: translate('shared.catalog.backendPortDataFolderLogFilesAnd'),
    storage: 'pi-kit',
    keywords: 'port log data directory bootId debug copy',
  },
  {
    id: 'pi-release',
    section: 'advanced',
    group: translate('shared.catalog.piRelease'),
    name: translate('shared.catalog.piReleaseInUse'),
    description: translate('shared.catalog.whichPiPiKitRunsItsThreads'),
    storage: 'pi-kit',
    file: 'pi-release.json',
    keywords: 'rollback pin previous managed bundled',
  },
  {
    id: 'copilot-inspector',
    section: 'advanced',
    group: translate('shared.catalog.developerTools'),
    name: translate('shared.catalog.copilotKitInspector'),
    description: translate('shared.catalog.copilotKitSWebInspectorOverTheWindow'),
    storage: 'pi-kit',
    keywords: 'copilotkit inspector ag-ui agui events debug devtools developer runtime',
  },
  {
    id: 'trust-list',
    section: 'advanced',
    group: translate('shared.catalog.savedTrustDecisions'),
    name: translate('shared.catalog.savedTrustDecisions'),
    description: translate('shared.catalog.everyFolderPiRemembersAnAnswerFor'),
    storage: 'pi',
    file: 'trust.json',
    keywords: 'revoke forget trust folders',
  },

  {
    id: 'secret-store',
    section: 'advanced',
    group: translate('shared.catalog.secretsAndDataAtRest'),
    name: translate('shared.catalog.credentialStoreAndPiKitSecret'),
    description: translate('shared.catalog.wherePiKitKeepsAPIKeysAnd'),
    storage: 'pi-kit',
    keywords:
      'keychain keyring secret-tool credential manager pi-kit-secret path install optional disable direct api keys plaintext storage security',
  },
  {
    id: 'database-encryption',
    section: 'advanced',
    group: translate('shared.catalog.secretsAndDataAtRest'),
    name: translate('shared.catalog.databaseEncryption'),
    description: translate('shared.catalog.piKitSDatabaseHoldsTranscriptsTool'),
    storage: 'pi-kit',
    keywords: 'sqlcipher encrypted encryption recovery key sqlite database at rest',
  },
  {
    id: 'disk-encryption',
    section: 'advanced',
    group: translate('shared.catalog.secretsAndDataAtRest'),
    name: translate('shared.catalog.diskEncryption'),
    description: translate('shared.catalog.whetherFileVaultBitLockerOrLUKSProtectsThe'),
    storage: 'pi-kit',
    keywords: 'filevault bitlocker luks full disk encryption tokens oauth',
  },
  {
    id: 'redaction',
    section: 'advanced',
    group: translate('shared.catalog.secretsAndDataAtRest'),
    name: translate('shared.catalog.redaction'),
    description: translate('shared.catalog.keyShapesOpenAIAnthropicOpenRouterGitHubAWS'),
    storage: 'pi-kit',
    keywords: 'redact mask secret token key pattern regex export share bug report privacy',
  },

  // ---- Voice
  {
    id: 'voice-engine',
    section: 'voice',
    group: translate('shared.catalog.speechModel'),
    name: translate('shared.catalog.whistleSpeechModel'),
    description: translate('shared.catalog.cactusComputeSWhistle17MBApache'),
    storage: 'pi-kit',
    keywords: 'voice dictation speech microphone transcribe whistle needle download model engine wasm python',
  },
  {
    id: 'voice-language',
    section: 'voice',
    group: translate('shared.catalog.dictation'),
    name: translate('shared.catalog.language'),
    description: translate('shared.catalog.detectTheLanguageAsYouSpeakOr'),
    storage: 'pi-kit',
    keywords: 'voice speech language english german french spanish italian dutch polish auto detect',
  },
  {
    id: 'voice-ptt',
    section: 'voice',
    group: translate('shared.catalog.dictation'),
    name: translate('shared.catalog.pushToTalkKey'),
    description: translate('shared.catalog.theKeyYouHoldWhileYouSpeak'),
    storage: 'pi-kit',
    keywords: 'voice hotkey shortcut keybinding hold talk microphone',
  },
  {
    id: 'voice-ptt-mode',
    section: 'voice',
    group: translate('shared.catalog.dictation'),
    name: translate('shared.catalog.theKeyHoldsOrToggles'),
    description: translate('shared.catalog.holdSpeakWhileTheKeyIsDown'),
    storage: 'pi-kit',
    keywords: 'voice push to talk hold toggle press',
  },
  {
    id: 'voice-live',
    section: 'voice',
    group: translate('shared.catalog.dictation'),
    name: translate('shared.catalog.showWordsWhileISpeak'),
    description: translate('shared.catalog.sendTheAudioToWhistleASecond'),
    storage: 'pi-kit',
    keywords: 'voice live partial streaming words realtime',
  },
  {
    id: 'voice-send',
    section: 'voice',
    group: translate('shared.catalog.dictation'),
    name: translate('shared.catalog.sendWhenDone'),
    description: translate('shared.catalog.sendTheMessageAsSoonAsThe'),
    storage: 'pi-kit',
    keywords: 'voice send submit automatically enter',
  },
  {
    id: 'voice-privacy',
    section: 'voice',
    group: translate('shared.catalog.privacy'),
    name: translate('shared.catalog.whereTheAudioGoes'),
    description: translate('shared.catalog.theMicrophoneIsReadByThisWindow'),
    storage: 'pi-kit',
    keywords: 'voice privacy network offline local microphone',
  },

  // ---- Computer use (@pi-kit/computer-use, packages/pi-computer-use)
  {
    id: 'computer-use',
    section: 'computer-use',
    group: translate('shared.catalog.computerUse'),
    name: translate('shared.catalog.computerUseSwitch'),
    description: translate('shared.catalog.computerUseSwitchHint'),
    storage: 'pi',
    file: 'computer-use.json',
    keywords: 'computer use cua driver screen click type apps desktop automation control mouse keyboard',
  },
  {
    id: 'computer-use-accessibility',
    section: 'computer-use',
    group: translate('shared.catalog.computerUsePermissions'),
    name: translate('shared.catalog.computerUseAccessibility'),
    description: translate('shared.catalog.computerUseAccessibilityHint'),
    storage: 'macos',
    keywords: 'macos permission privacy security accessibility click type',
  },
  {
    id: 'computer-use-screen',
    section: 'computer-use',
    group: translate('shared.catalog.computerUsePermissions'),
    name: translate('shared.catalog.computerUseScreen'),
    description: translate('shared.catalog.computerUseScreenHint'),
    storage: 'macos',
    keywords: 'macos permission privacy security screen recording capture screenshot relaunch',
  },
  {
    id: 'computer-use-app',
    section: 'computer-use',
    group: translate('shared.catalog.computerUsePermissions'),
    name: translate('shared.catalog.computerUseApp'),
    description: translate('shared.catalog.computerUseAppHint'),
    storage: 'macos',
    keywords: 'macos permission electron development signed ad-hoc terminal',
  },
];

const settingsById = (translate: Translate) => new Map(settingsCatalog(translate).map((s) => [s.id, s] as const));

export function settingById(translate: Translate, id: string): SettingEntry | undefined {
  return settingsById(translate).get(id);
}

export function sectionById(translate: Translate, id: SettingsSectionId): SettingsSection {
  return settingsSections(translate).find((s) => s.id === id) as SettingsSection;
}

/** The chip text: `pi settings.json`, `pi-kit database`, `project .pi/settings.json`. */
export function storageLabel(translate: Translate, entry: Pick<SettingEntry, 'storage' | 'file'>): string {
  if (entry.storage === 'pi-kit') return translate('shared.catalog.piKitDatabase');
  if (entry.storage === 'macos') return 'macOS';
  if (entry.storage === 'project')
    return translate('shared.catalog.projectPi', { value1: entry.file ?? 'settings.json' });
  return `pi ${entry.file ?? 'settings.json'}`;
}

/** The tooltip of the chip: the place in words. */
export function storageTitle(translate: Translate, entry: Pick<SettingEntry, 'storage' | 'file'>): string {
  if (entry.storage === 'pi-kit') return translate('shared.catalog.storedInPiKitSOwnSQLite');
  if (entry.storage === 'macos') return translate('shared.catalog.grantedByMacOS');
  if (entry.storage === 'project')
    return translate('shared.catalog.storedInTheFolderSPi', { value1: entry.file ?? 'settings.json' });
  return translate('shared.catalog.storedInPiSInItsAgent', { value1: entry.file ?? 'settings.json' });
}

/**
 * The ids of the settings that match a search: every word of the query must occur in the setting’s name, description, group, keywords or section
 * title (case-insensitive). An empty query matches every setting.
 */
export function searchSettings(
  translate: Translate,
  query: string,
  entries: readonly SettingEntry[] = settingsCatalog(translate),
): Set<string> {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (words.length === 0) return new Set(entries.map((e) => e.id));
  const found = new Set<string>();
  for (const entry of entries) {
    const hay =
      `${entry.name} ${entry.description} ${entry.group} ${entry.keywords ?? ''} ${sectionById(translate, entry.section).label}`.toLowerCase();
    if (words.every((w) => hay.includes(w))) found.add(entry.id);
  }
  return found;
}

/** How many settings of each section match, for the nav while a search is active. */
export function matchCounts(translate: Translate, matches: ReadonlySet<string>): Map<SettingsSectionId, number> {
  const counts = new Map<SettingsSectionId, number>();
  for (const entry of settingsCatalog(translate))
    if (matches.has(entry.id)) counts.set(entry.section, (counts.get(entry.section) ?? 0) + 1);
  return counts;
}
