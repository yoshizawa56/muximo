import type { Meta, StoryObj } from "@storybook/react-vite";
import { type ReactNode, useCallback, useState } from "react";
import { expect, fireEvent, fn, userEvent, within } from "storybook/test";
import {
  applyCustomKeyboardDrop,
  assignedKeyIds,
  isCustomKeyboardShortcutDraftValid,
  keysFromIds,
  removeKeyFromLayout,
  resolveCustomKeyboardLayout,
} from "./policy";
import {
  type CustomKeyboardClipboardHistoryEntry,
  CustomKeyboardSettingsView,
  CustomKeyboardView,
  DirectionalFlickIcon,
} from "./view";
import {
  type CustomKeyboardDragSource,
  type CustomKeyboardDropTarget,
  type CustomKeyboardFlickDirection,
  type CustomKeyboardKey,
  type CustomKeyboardLayout,
  type CustomKeyboardNativeFileAction,
  type CustomKeyboardProfileSummary,
  type CustomKeyboardSequence,
  type CustomKeyboardSettingsViewModel,
  type CustomKeyboardShortcutDraft,
  type CustomKeyboardViewModel,
  customKeyboardFixedKeyIds,
  customKeyboardIconOptions,
  customKeyboardKeyLibrary,
  customKeyboardSurfaceDefinitions,
  defaultCustomKeyboardFixedLayout,
  defaultCustomKeyboardKeys,
  defaultCustomKeyboardLayout,
} from "./viewmodel";

type StoryKeyboardState = {
  libraryKeys: CustomKeyboardKey[];
  layout: CustomKeyboardLayout;
  shortcutKeyIds: string[];
  repeatStartDelayMs: number;
  repeatIntervalMs: number;
};

const defaultStoryProfile: CustomKeyboardProfileSummary = {
  id: "default",
  name: "Default",
  icon: "terminal",
  linked: true,
};

const defaultStoryProfiles: readonly CustomKeyboardProfileSummary[] = [defaultStoryProfile];

function cloneStoryLayout(layout: CustomKeyboardLayout): CustomKeyboardLayout {
  return {
    rows: layout.rows.map((row) => ({
      ...row,
      placements: row.placements.map((placement) => ({ ...placement })),
    })),
  };
}

function createStoryLayout(initialKeys: readonly CustomKeyboardKey[]): CustomKeyboardLayout {
  const layout = cloneStoryLayout(defaultCustomKeyboardLayout);
  const assigned = new Set(assignedKeyIds(layout));
  const mainRow = layout.rows.find((row) => row.id === "main");
  if (!mainRow) return layout;
  for (const key of initialKeys) {
    if (customKeyboardFixedKeyIds.includes(key.id)) continue;
    if (assigned.has(key.id)) continue;
    mainRow.placements.push({ keyId: key.id, density: "regular" });
    assigned.add(key.id);
  }
  return layout;
}

function InteractiveShellStory({
  startInSettings = false,
  initialKeys = defaultCustomKeyboardKeys,
  initialActiveModifiers = [],
  initialProfiles = defaultStoryProfiles,
  clipboardHistory,
}: {
  startInSettings?: boolean;
  initialKeys?: readonly CustomKeyboardKey[];
  initialActiveModifiers?: CustomKeyboardViewModel["activeModifiers"];
  initialProfiles?: readonly CustomKeyboardProfileSummary[];
  clipboardHistory?: readonly CustomKeyboardClipboardHistoryEntry[];
}) {
  const [keyboardState, setKeyboardState] = useState<StoryKeyboardState>(() => ({
    libraryKeys: uniqueStoryKeys([...customKeyboardKeyLibrary, ...initialKeys]),
    layout: createStoryLayout(initialKeys),
    shortcutKeyIds: customKeyboardKeyLibrary.filter((key) => key.category === "shortcuts").map((key) => key.id),
    repeatStartDelayMs: 420,
    repeatIntervalMs: 180,
  }));
  const [activeModifiers, setActiveModifiers] = useState<CustomKeyboardViewModel["activeModifiers"]>(() => [
    ...initialActiveModifiers,
  ]);
  const [nativeKeyboardVisible, setNativeKeyboardVisible] = useState(false);
  const [lastAction, setLastAction] = useState("Tap a custom key to preview its action.");
  const [profiles, setProfiles] = useState<readonly CustomKeyboardProfileSummary[]>(() =>
    initialProfiles.length > 0 ? [...initialProfiles] : defaultStoryProfiles,
  );
  const [activeProfileId, setActiveProfileId] = useState(() => initialProfiles[0]?.id ?? defaultStoryProfile.id);

  const activeProfile =
    profiles.find((profile) => profile.id === activeProfileId) ?? profiles[0] ?? defaultStoryProfile;

  const onSelectProfile = useCallback(
    (profileId: string) => {
      const profile = profiles.find((candidate) => candidate.id === profileId);
      if (!profile) return;
      setActiveProfileId(profileId);
      setProfiles((current) =>
        current.map((candidate) => (candidate.id === profileId ? { ...candidate, linked: true } : candidate)),
      );
      setLastAction(`Selected profile ${profile.name}`);
    },
    [profiles],
  );

  const onActivateKey = useCallback(
    (key: CustomKeyboardKey) => {
      const activation = key.activation;
      if (activation.type === "surface" || activation.type === "directional-flick") return;
      if (activation.type === "modifier") {
        setActiveModifiers((current) =>
          current.includes(activation.modifier)
            ? current.filter((modifier) => modifier !== activation.modifier)
            : [...current, activation.modifier],
        );
        setLastAction(`${key.accessibleLabel} latched for the next key`);
        return;
      }
      const modifierPrefix = activeModifiers.length ? `${activeModifiers.join(" + ")} + ` : "";
      setActiveModifiers([]);
      if (activation.type === "native" && activation.action === "toggle-standard-keyboard") {
        setNativeKeyboardVisible((current) => !current);
        setLastAction(nativeKeyboardVisible ? "Standard keyboard hidden" : "Standard keyboard shown");
        return;
      }
      const actionLabel =
        activation.type === "terminal"
          ? activation.action === "enter-copy-mode"
            ? "tmux copy mode requested"
            : activation.action === "paste-from-clipboard"
              ? "Clipboard paste requested"
              : "tmux buffer paste requested"
          : activation.type === "native"
            ? activation.action === "pick-photo"
              ? "Photo picker opened"
              : activation.action === "capture-photo"
                ? "Camera capture opened"
                : "Native action requested"
            : `${key.accessibleLabel} · ${formatStorySequence(activation.sequence)}`;
      setLastAction(`${modifierPrefix}${actionLabel}`);
    },
    [activeModifiers, nativeKeyboardVisible],
  );

  const onDirectionalFlick = useCallback((direction: CustomKeyboardFlickDirection) => {
    setActiveModifiers([]);
    setLastAction(`${direction} arrow input`);
  }, []);

  const onNativeFileSelected = useCallback((action: CustomKeyboardNativeFileAction, file: File) => {
    const actionLabel = action === "capture-photo" ? "Camera photo selected" : "Photo selected";
    setLastAction(`${actionLabel}: ${file.name} · ${formatFileSize(file.size)}`);
  }, []);

  const onClipboardHistorySelect = useCallback((entry: CustomKeyboardClipboardHistoryEntry) => {
    setLastAction(`Selected ${entry.source} history: ${entry.preview}`);
  }, []);

  const onDrop = useCallback((source: CustomKeyboardDragSource, target: CustomKeyboardDropTarget) => {
    setKeyboardState((current) => {
      const next = applyCustomKeyboardDrop(
        { layout: current.layout, shortcutKeyIds: current.shortcutKeyIds },
        source,
        target,
      );
      return { ...current, layout: next.layout, shortcutKeyIds: [...next.shortcutKeyIds] };
    });
  }, []);

  const onRemoveKey = useCallback((keyId: string) => {
    setKeyboardState((current) => ({ ...current, layout: removeKeyFromLayout(current.layout, keyId) }));
  }, []);

  const onRegisterShortcut = useCallback((draft: CustomKeyboardShortcutDraft) => {
    if (!isCustomKeyboardShortcutDraftValid(draft)) return;
    const iconLabel = customKeyboardIconOptions.find((option) => option.value === draft.icon)?.label ?? "Custom";
    setKeyboardState((current) => {
      const draftId = `shortcut-draft-${current.libraryKeys.filter((key) => key.category === "shortcuts").length + 1}`;
      const shortcut: CustomKeyboardKey = {
        id: draftId,
        category: "shortcuts",
        icon: draft.icon,
        accessibleLabel: `${iconLabel} shortcut`,
        activation: { type: "sequence", sequence: draft.sequence },
      };
      return {
        ...current,
        libraryKeys: current.libraryKeys.some((key) => key.id === draftId)
          ? current.libraryKeys
          : [...current.libraryKeys, shortcut],
        shortcutKeyIds: current.shortcutKeyIds.includes(draftId)
          ? current.shortcutKeyIds
          : [...current.shortcutKeyIds, draftId],
      };
    });
  }, []);

  const onUpdateShortcut = useCallback((keyId: string, draft: CustomKeyboardShortcutDraft) => {
    if (!isCustomKeyboardShortcutDraftValid(draft)) return;
    const iconLabel = customKeyboardIconOptions.find((option) => option.value === draft.icon)?.label ?? "Custom";
    setKeyboardState((current) => ({
      ...current,
      libraryKeys: current.libraryKeys.map((key) =>
        key.id === keyId
          ? {
              ...key,
              icon: draft.icon,
              accessibleLabel: `${iconLabel} shortcut`,
              activation: { type: "sequence", sequence: draft.sequence },
            }
          : key,
      ),
    }));
  }, []);

  const onDeleteShortcut = useCallback((keyId: string) => {
    setKeyboardState((current) => ({
      ...current,
      layout: removeKeyFromLayout(current.layout, keyId),
      libraryKeys: current.libraryKeys.filter((key) => key.id !== keyId),
      shortcutKeyIds: current.shortcutKeyIds.filter((id) => id !== keyId),
    }));
  }, []);

  const editableRows = resolveCustomKeyboardLayout(keyboardState.layout, keyboardState.libraryKeys);
  const fixedRows = resolveCustomKeyboardLayout(defaultCustomKeyboardFixedLayout, customKeyboardKeyLibrary);
  const rows = [...editableRows, ...fixedRows];
  const assignedIds = assignedKeyIds(keyboardState.layout);
  const assigned = new Set(assignedIds);
  const availableKeys = keyboardState.libraryKeys.filter(
    (key) => !assigned.has(key.id) && !customKeyboardFixedKeyIds.includes(key.id),
  );
  const shortcutKeys = keysFromIds(keyboardState.shortcutKeyIds, keyboardState.libraryKeys);
  const surfaces = customKeyboardSurfaceDefinitions.map((surface) => ({
    id: surface.id,
    keys: keysFromIds(surface.keyIds, keyboardState.libraryKeys),
  }));
  const keyboardViewModel: CustomKeyboardViewModel = {
    rows,
    surfaces,
    activeModifiers,
    nativeKeyboardVisible,
    activeProfile,
    profiles,
    workspaceId: "workspace-muximo",
    repeatStartDelayMs: keyboardState.repeatStartDelayMs,
    repeatIntervalMs: keyboardState.repeatIntervalMs,
    onSelectProfile,
    onActivateKey,
    onDirectionalFlick,
    onNativeFileSelected,
    onKeepNativeKeyboardOpen: fn(),
    onToggleNativeKeyboard: () => setNativeKeyboardVisible((current) => !current),
  };

  const settingsViewModel: CustomKeyboardSettingsViewModel = {
    rows: editableRows,
    availableKeys,
    shortcutKeys,
    activeProfile,
    profiles,
    linkedProfileIds: [],
    workspaceId: "workspace-muximo",
    assignedKeyIds: assignedIds,
    repeatStartDelayMs: keyboardState.repeatStartDelayMs,
    repeatIntervalMs: keyboardState.repeatIntervalMs,
    onSelectProfile,
    onCreateProfile: ({ name }) => setLastAction(`Created profile ${name}`),
    onDuplicateProfile: (profileId) => setLastAction(`Duplicated profile ${profileId}`),
    onRenameProfile: (profileId, name) => setLastAction(`Renamed profile ${profileId} to ${name}`),
    onDeleteProfile: (profileId) => setLastAction(`Deleted profile ${profileId}`),
    onSetProfileIcon: (profileId, icon) => setLastAction(`Changed profile ${profileId} icon to ${icon}`),
    onToggleProfileLink: (profileId) => setLastAction(`Toggled workspace profile link ${profileId}`),
    onDrop,
    onRemoveKey,
    onRegisterShortcut,
    onUpdateShortcut,
    onDeleteShortcut,
    onRepeatStartDelayChange: (startDelayMs) => {
      setKeyboardState((current) => ({ ...current, repeatStartDelayMs: startDelayMs }));
    },
    onRepeatIntervalChange: (intervalMs) => {
      setKeyboardState((current) => ({ ...current, repeatIntervalMs: intervalMs }));
    },
  };

  return (
    <StoryShell
      keyboardViewModel={keyboardViewModel}
      settingsViewModel={settingsViewModel}
      initialSettingsOpen={startInSettings}
      nativeKeyboard={<MockStandardKeyboard />}
      clipboardHistory={clipboardHistory}
      onClipboardHistorySelect={onClipboardHistorySelect}
      terminalSurface={<MockTerminalSurface lastAction={lastAction} nativeKeyboardVisible={nativeKeyboardVisible} />}
    />
  );
}

function StoryShell({
  keyboardViewModel,
  settingsViewModel,
  terminalSurface,
  nativeKeyboard,
  initialSettingsOpen = false,
  clipboardHistory,
  onClipboardHistorySelect,
}: {
  keyboardViewModel?: CustomKeyboardViewModel;
  settingsViewModel?: CustomKeyboardSettingsViewModel;
  terminalSurface?: ReactNode;
  nativeKeyboard?: ReactNode;
  initialSettingsOpen?: boolean;
  clipboardHistory?: readonly CustomKeyboardClipboardHistoryEntry[];
  onClipboardHistorySelect?: (entry: CustomKeyboardClipboardHistoryEntry) => void;
}) {
  const [settingsOpen, setSettingsOpen] = useState(initialSettingsOpen);

  if (!keyboardViewModel || !settingsViewModel) return null;
  if (settingsOpen) {
    return (
      <div className="h-[var(--app-viewport-height)] min-h-0 overflow-hidden bg-[#061008]">
        <CustomKeyboardSettingsView
          viewModel={settingsViewModel}
          onClose={() => setSettingsOpen(false)}
          onSave={() => setSettingsOpen(false)}
        />
      </div>
    );
  }

  return (
    <main className="h-[var(--app-viewport-height)] min-h-0 bg-[#020503] p-2 pb-1 text-[#d9f4dc] md:p-6">
      <div className="mx-auto flex h-full max-w-[1100px] flex-col overflow-hidden rounded-[17px] border border-[#1c4b28] bg-[#071108] shadow-[0_25px_80px_rgb(0_0_0_/_46%)]">
        <header className="flex min-h-[54px] shrink-0 items-center gap-2 border-b border-[#17391f] bg-[rgb(6_15_8_/_95%)] px-3">
          <span className="size-2 rounded-full bg-[#39d65b] shadow-[0_0_0_4px_rgb(57_214_91_/_11%)]" />
          <span className="font-mono text-[0.58rem] font-bold uppercase tracking-[0.15em] text-[#6ba875]">
            Shell / mobile terminal
          </span>
        </header>
        <CustomKeyboardView
          viewModel={keyboardViewModel}
          nativeKeyboard={nativeKeyboard}
          onOpenSettings={() => setSettingsOpen(true)}
          clipboardHistory={clipboardHistory}
          onClipboardHistorySelect={onClipboardHistorySelect}
        >
          {terminalSurface}
        </CustomKeyboardView>
      </div>
    </main>
  );
}

function MockTerminalSurface({
  lastAction,
  nativeKeyboardVisible,
}: {
  lastAction: string;
  nativeKeyboardVisible: boolean;
}) {
  return (
    <div className="relative flex min-h-0 flex-1 flex-col overflow-hidden bg-[#020503] bg-[linear-gradient(rgb(57_214_91_/_3%)_1px,transparent_1px)] bg-[size:100%_24px] p-4 font-mono text-[0.72rem] leading-[1.7] text-[#a3d5aa] md:p-6">
      <div className="min-h-0 flex-1 overflow-hidden">
        <p className="m-0 text-[#5f9a68]">muximo@host:~/work$ muximo shell</p>
        <p className="m-0 text-[#91c899]">attached to tmux pane %12</p>
        <p className="m-0 text-[#6e9f77]">mobile owns viewport · custom keys ready</p>
        <p className="m-0 mt-4 text-[#d0f7d4]">$ git status --short</p>
        <p className="m-0 text-[#6caa76]"> M apps/web/src/routes/terminals/...</p>
        <p className="m-0 text-[#5d8c65]">$ _</p>
      </div>
      <div className="mt-4 flex flex-wrap items-center justify-between gap-2 border-t border-[#15351d] pt-3 text-[0.58rem] text-[#5d8965]">
        <span role="status" aria-label="Last input">
          last input · {lastAction}
        </span>
        <span>{nativeKeyboardVisible ? "native keyboard focus" : "custom keyboard focus"}</span>
      </div>
    </div>
  );
}

function MockStandardKeyboard() {
  const rows = [
    ["Q", "W", "E", "R", "T", "Y", "U", "I", "O", "P"],
    ["A", "S", "D", "F", "G", "H", "J", "K", "L"],
    ["Z", "X", "C", "V", "B", "N", "M"],
  ];
  return (
    <fieldset
      className="m-0 shrink-0 border-0 border-t border-[#aeb3bc] bg-[#d1d4da] px-1.5 pb-[max(8px,var(--safe-area-bottom))] pt-1.5 text-center shadow-[0_-8px_18px_rgb(0_0_0_/_18%)]"
      aria-label="Standard keyboard mock"
    >
      <div className="mx-auto flex max-w-[640px] flex-col gap-1" aria-hidden="true">
        <div className="flex items-center justify-between px-2 font-sans text-[0.48rem] font-semibold text-[#626873]">
          <span>English (US)</span>
          <span>⌄</span>
        </div>
        {rows.map((row) => (
          <div className="mx-auto flex w-full max-w-[620px] justify-center gap-1.5" key={row.join("")}>
            {row.map((key) => (
              <span
                className="grid h-[34px] min-w-0 flex-1 place-items-center rounded-[5px] bg-[#f7f7f8] font-sans text-[0.72rem] text-[#1f2329] shadow-[0_1px_1px_rgb(0_0_0_/_22%)]"
                key={key}
              >
                {key}
              </span>
            ))}
          </div>
        ))}
        <div className="mx-auto flex w-full max-w-[620px] gap-1.5">
          <span className="grid h-[34px] w-[15%] place-items-center rounded-[5px] bg-[#b8bbc2] font-sans text-[0.56rem] font-semibold text-[#343840] shadow-[0_1px_1px_rgb(0_0_0_/_18%)]">
            123
          </span>
          <span className="grid h-[34px] w-[12%] place-items-center rounded-[5px] bg-[#b8bbc2] font-sans text-[0.8rem] text-[#343840] shadow-[0_1px_1px_rgb(0_0_0_/_18%)]">
            ◉
          </span>
          <span className="grid h-[34px] min-w-0 flex-1 place-items-center rounded-[5px] bg-[#f7f7f8] font-sans text-[0.56rem] text-[#656a73] shadow-[0_1px_1px_rgb(0_0_0_/_22%)]">
            space
          </span>
          <span className="grid h-[34px] w-[21%] place-items-center rounded-[5px] bg-[#b8bbc2] font-sans text-[0.56rem] font-semibold text-[#343840] shadow-[0_1px_1px_rgb(0_0_0_/_18%)]">
            return
          </span>
        </div>
      </div>
    </fieldset>
  );
}

const meta = {
  title: "Pages/Shell",
  component: StoryShell,
  parameters: { layout: "fullscreen" },
} satisfies Meta<typeof StoryShell>;

export default meta;
type Story = StoryObj<typeof meta>;

export const ShellAndKeyboard: Story = {
  render: () => <InteractiveShellStory />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByRole("button", { name: "Open copy and paste actions" }));
    const clipboardDialog = canvas.getByRole("dialog", { name: "Copy and paste actions" });
    await expect(clipboardDialog).toBeVisible();
    await userEvent.click(canvas.getByRole("button", { name: "Open copy and paste actions" }));
    await expect(clipboardDialog).not.toBeInTheDocument();
    await userEvent.click(canvas.getByRole("button", { name: "Open copy and paste actions" }));
    const reopenedClipboardDialog = canvas.getByRole("dialog", { name: "Copy and paste actions" });
    await expect(within(reopenedClipboardDialog).getByRole("button", { name: "Copy mode" })).toBeVisible();
    await expect(within(reopenedClipboardDialog).getByRole("button", { name: "Paste from clipboard" })).toBeVisible();
    await expect(within(reopenedClipboardDialog).getByRole("button", { name: "Paste from tmux buffer" })).toBeVisible();
    await userEvent.click(within(reopenedClipboardDialog).getByRole("button", { name: "Paste from clipboard" }));
    await expect(reopenedClipboardDialog).not.toBeInTheDocument();
    await userEvent.click(canvas.getByRole("button", { name: "Slash" }));
    await expect(canvas.getByRole("status", { name: "Last input" })).toHaveTextContent("Slash");
    await userEvent.click(canvas.getByRole("button", { name: /show standard keyboard/i }));
    await expect(canvas.getByRole("button", { name: /hide standard keyboard/i })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
  },
};

export const ClipboardHistoryExperiment: Story = {
  render: () => (
    <InteractiveShellStory
      clipboardHistory={[
        { id: "history-1", source: "PC clipboard", preview: "git status --short", age: "just now" },
        { id: "history-2", source: "tmux buffer", preview: "bun test packages/contract", age: "2 min ago" },
        { id: "history-3", source: "Device clipboard", preview: "Review this pane", age: "10 min ago" },
      ]}
    />
  ),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByRole("button", { name: "Open copy and paste actions" }));
    const clipboardDialog = canvas.getByRole("dialog", { name: "Copy and paste actions" });
    await expect(within(clipboardDialog).getByText("History experiment")).toBeVisible();
    await userEvent.click(
      within(clipboardDialog).getByRole("button", { name: "Use history entry git status --short" }),
    );
    await expect(canvas.getByRole("status", { name: "Last input" })).toHaveTextContent(
      "Selected PC clipboard history: git status --short",
    );
  },
};

export const ProfileSelection: Story = {
  render: () => (
    <InteractiveShellStory
      initialProfiles={[
        defaultStoryProfile,
        { id: "agent", name: "Agent", icon: "spark", linked: true },
        { id: "review", name: "Review", icon: "branch", linked: false },
      ]}
    />
  ),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const profileTrigger = canvas.getByRole("button", { name: "Open custom keyboard profiles and settings" });
    await userEvent.click(profileTrigger);
    const profileDialog = canvas.getByRole("dialog", { name: "Select custom keyboard profile" });
    await expect(profileDialog).toBeVisible();
    await userEvent.click(profileTrigger);
    await expect(profileDialog).not.toBeInTheDocument();
    await userEvent.click(profileTrigger);
    const reopenedProfileDialog = canvas.getByRole("dialog", { name: "Select custom keyboard profile" });
    await userEvent.click(within(reopenedProfileDialog).getByRole("option", { name: /Agent/ }));
    await expect(canvas.getByRole("status", { name: "Last input" })).toHaveTextContent("Selected profile Agent");
  },
};

export const ProfileIconPicker: Story = {
  render: () => (
    <InteractiveShellStory initialProfiles={[{ id: "agent", name: "Agent", icon: "terminal", linked: true }]} />
  ),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByRole("button", { name: "Open custom keyboard profiles and settings" }));
    const profileDialog = canvas.getByRole("dialog", { name: "Select custom keyboard profile" });
    await userEvent.click(within(profileDialog).getByRole("button", { name: "Keyboard settings" }));
    await expect(canvas.getByRole("heading", { name: "Keyboard settings" })).toBeVisible();
    await userEvent.click(canvas.getByRole("tab", { name: "Device" }));
    const camera = canvas.getByRole("button", { name: "Use Camera icon" });
    await userEvent.click(camera);
    await expect(camera).toHaveAttribute("aria-pressed", "true");
  },
};

export const ModifierLatched: Story = {
  render: () => <InteractiveShellStory initialActiveModifiers={["ctrl"]} />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const modifier = canvas.getByRole("button", { name: "Control modifier" });
    await expect(modifier).toHaveAttribute("aria-pressed", "true");
    await userEvent.click(modifier);
    await expect(modifier).toHaveAttribute("aria-pressed", "false");
  },
};

export const DirectionalFlickKey: Story = { render: () => <InteractiveShellStory /> };

export const DirectionalFlickIconComparison: Story = {
  render: () => {
    const variants = [
      { label: "With outer ring", showOuterRing: true },
      { label: "Without outer ring", showOuterRing: false },
    ] as const;
    return (
      <div className="flex min-h-screen items-center justify-center bg-[#061008] p-6 text-[#d9f4dc]">
        <div className="grid gap-4 sm:grid-cols-2">
          {variants.map(({ label, showOuterRing }) => (
            <div className="rounded-[10px] border border-[#285a33] bg-[#0b2111] p-4" key={label}>
              <div className="flex items-center gap-3">
                <DirectionalFlickIcon size={44} showOuterRing={showOuterRing} />
                <span className="font-mono text-[0.62rem] text-[#a9e8b1]">{label}</span>
              </div>
              <div className="mt-3 flex gap-2 text-[#8bff9a]">
                {(["up", "right", "down", "left"] as const).map((direction) => (
                  <DirectionalFlickIcon key={direction} size={28} direction={direction} showOuterRing={showOuterRing} />
                ))}
              </div>
            </div>
          ))}
        </div>
      </div>
    );
  },
};

export const NativeMediaActions: Story = {
  render: () => (
    <InteractiveShellStory
      initialKeys={[...defaultCustomKeyboardKeys, customKeyboardKeyLibrary.find((key) => key.id === "camera")!]}
    />
  ),
};

export const SettingsEditor: Story = {
  render: () => <InteractiveShellStory startInSettings />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByRole("tab", { name: "Special" }));
    await expect(
      canvas.queryByRole("button", { name: "Open custom keyboard profiles and settings" }),
    ).not.toBeInTheDocument();
    await expect(canvas.queryByRole("button", { name: "Show or hide the standard keyboard" })).not.toBeInTheDocument();
    await userEvent.click(canvas.getByRole("tab", { name: "ABC" }));
    await expect(canvas.queryByText("main", { exact: true })).not.toBeInTheDocument();
    await userEvent.click(canvas.getByRole("button", { name: "Flick repeat" }));
    await expect(canvas.getByRole("button", { name: "Flick repeat" })).toHaveAttribute("aria-expanded", "true");
    const shift = canvas.getByRole("button", { name: "Toggle Shift keyboard key" });
    await userEvent.click(shift);
    await expect(shift).toHaveAttribute("aria-pressed", "true");
    await userEvent.click(shift);
    await expect(shift).toHaveAttribute("aria-pressed", "false");
    await userEvent.click(canvas.getByRole("tab", { name: "Shortcuts" }));
    await userEvent.click(canvas.getByRole("button", { name: "Register shortcut" }));
    const shortcutDialog = canvas.getByRole("dialog", { name: "Register shortcut" });
    await userEvent.click(within(shortcutDialog).getByRole("button", { name: "Clear" }));
    await userEvent.type(canvas.getByRole("textbox", { name: "Text to append" }), "echo ready");
    await userEvent.click(canvas.getByRole("button", { name: "Add text" }));
    await userEvent.click(canvas.getByRole("button", { name: "Create shortcut" }));
    await expect(canvas.getByRole("heading", { name: "Registered shortcuts" })).toBeVisible();
    await userEvent.click(canvas.getByRole("button", { name: "Edit shortcuts" }));
    await expect(canvas.getByRole("button", { name: "Finish editing shortcuts" })).toBeVisible();
    await userEvent.click(canvas.getByRole("button", { name: "Finish editing shortcuts" }));
    await userEvent.click(canvas.getByRole("button", { name: "Save" }));
    await expect(canvas.queryByRole("heading", { name: "Keyboard settings" })).not.toBeInTheDocument();
  },
};

export const DragAndDrop: Story = {
  render: () => <InteractiveShellStory startInSettings />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByRole("tab", { name: "123" }));
    await userEvent.click(canvas.getByRole("button", { name: "Show more symbols" }));
    const source = canvas.getByRole("button", { name: "Add Left bracket" });
    const target = canvas.getByRole("toolbar", { name: "Custom keyboard preview drop zone" });
    const sourceRect = source.getBoundingClientRect();
    const targetRect = target.getBoundingClientRect();
    await fireEvent.mouseDown(source, {
      button: 0,
      clientX: sourceRect.left + sourceRect.width / 2,
      clientY: sourceRect.top + sourceRect.height / 2,
    });
    await fireEvent.mouseMove(document, {
      buttons: 1,
      clientX: targetRect.left + targetRect.width / 2,
      clientY: targetRect.top + targetRect.height / 2,
    });
    await fireEvent.mouseUp(document, {
      button: 0,
      clientX: targetRect.left + targetRect.width / 2,
      clientY: targetRect.top + targetRect.height / 2,
    });
    await expect(canvas.getByLabelText("Left bracket")).toBeVisible();
  },
};

function uniqueStoryKeys(keys: readonly CustomKeyboardKey[]): CustomKeyboardKey[] {
  return [...new Map(keys.map((key) => [key.id, key] as const)).values()];
}

function formatStorySequence(sequence: CustomKeyboardSequence): string {
  if (sequence.length === 0) return "modifier";
  return sequence
    .map((token) => {
      if (token.type === "text") return JSON.stringify(token.value);
      const modifiers = token.modifiers?.join("+") ?? "";
      return modifiers ? `${modifiers}+${token.key}` : token.key;
    })
    .join(" → ");
}

function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
