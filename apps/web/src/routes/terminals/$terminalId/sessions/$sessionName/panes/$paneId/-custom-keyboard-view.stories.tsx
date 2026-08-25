import type { Meta, StoryObj } from "@storybook/react-vite";
import { type ComponentProps, useCallback, useState } from "react";
import { expect, userEvent, within } from "storybook/test";
import {
  type CustomKeyboardButton,
  type CustomKeyboardFlickPreview,
  type CustomKeyboardNativeAction,
  type CustomKeyboardNativeFileAction,
  type CustomKeyboardSequence,
  type CustomKeyboardSettingsViewModel,
  type CustomKeyboardShortcutDraft,
  type CustomKeyboardViewModel,
  customKeyboardIconOptions,
  customKeyboardSpecialKeyOptions,
  customKeyboardSpecialModifierOptions,
  defaultCustomKeyboardButtons,
} from "./-custom-keyboard-viewmodel";
import type { ShellViewModel } from "./-shell-view";
import { ShellView } from "./-shell-view";

const alphabetButtonLibrary: readonly CustomKeyboardButton[] = [..."qwertyuiopasdfghjklzxcvbnm"].map((key) => ({
  id: `letter-${key}`,
  kind: "key",
  category: "abc",
  icon: "letter",
  label: key,
  accessibleLabel: `Letter ${key.toUpperCase()}`,
  sequence: [{ type: "key", key }],
}));

const numberButtonLibrary: readonly CustomKeyboardButton[] = [
  "1",
  "2",
  "3",
  "4",
  "5",
  "6",
  "7",
  "8",
  "9",
  "0",
  "#",
  "$",
  "&",
  "@",
  "=",
  "-",
  "/",
  "+",
  "*",
  "?",
  "!",
  ":",
  ";",
  "(",
  ")",
  ",",
  ".",
  "'",
  '"',
].map((key) => ({
  id: `number-${key}`,
  kind: "key",
  category: "123",
  icon: "number",
  label: key,
  accessibleLabel: `Key ${key}`,
  sequence: [{ type: "text", value: key }],
}));

const numberSymbolButtonLibrary: readonly CustomKeyboardButton[] = [
  ["left-bracket", "[", "Left bracket"],
  ["right-bracket", "]", "Right bracket"],
  ["left-brace", "{", "Left brace"],
  ["right-brace", "}", "Right brace"],
  ["percent", "%", "Percent"],
  ["caret", "^", "Caret"],
  ["underscore", "_", "Underscore"],
  ["backslash", "\\", "Backslash"],
  ["less-than", "<", "Less-than"],
  ["greater-than", ">", "Greater-than"],
  ["euro", "€", "Euro sign"],
  ["pound", "£", "Pound sign"],
  ["yen", "¥", "Yen sign"],
  ["bullet", "•", "Bullet"],
].map(([id, label, accessibleLabel]) => ({
  id: `number-${id}`,
  kind: "key",
  category: "123",
  icon: "number",
  label,
  accessibleLabel,
  sequence: [{ type: "text", value: label }],
}));

const specialKeyButtons: readonly CustomKeyboardButton[] = customKeyboardSpecialKeyOptions.map(
  (definition): CustomKeyboardButton => ({
    id: definition.id,
    kind: "key",
    category: "special",
    icon: definition.icon,
    label: definition.label,
    accessibleLabel: definition.accessibleLabel,
    sequence: [{ type: "key", key: definition.key }],
  }),
);

const specialModifierButtons: readonly CustomKeyboardButton[] = customKeyboardSpecialModifierOptions.map(
  (definition): CustomKeyboardButton => ({
    id: definition.id,
    kind: "modifier",
    category: "special",
    icon: definition.icon,
    label: definition.label,
    accessibleLabel: definition.accessibleLabel,
    sequence: [],
    modifier: definition.modifier,
  }),
);

const specialButtonLibrary: readonly CustomKeyboardButton[] = [
  ...specialKeyButtons,
  ...specialModifierButtons.filter((button) => button.modifier !== "shift"),
  {
    id: "camera",
    kind: "key",
    category: "special",
    icon: "camera",
    label: "CAM",
    accessibleLabel: "Open camera",
    sequence: [],
    nativeAction: "capture-photo",
  },
  {
    id: "photo-library",
    kind: "key",
    category: "special",
    icon: "photo",
    label: "PHOTO",
    accessibleLabel: "Open photo library",
    sequence: [],
    nativeAction: "pick-photo",
  },
];

const nativeMediaButtons = specialButtonLibrary.filter((button) => button.nativeAction);

const buttonLibrary: readonly CustomKeyboardButton[] = [
  ...specialModifierButtons
    .filter((button) => button.modifier === "shift")
    .map((button) => ({ ...button, category: "abc" as const })),
  ...alphabetButtonLibrary,
  ...numberButtonLibrary,
  ...numberSymbolButtonLibrary,
  ...specialButtonLibrary,
  {
    id: "hash",
    kind: "key",
    category: "123",
    icon: "hash",
    accessibleLabel: "Hash",
    sequence: [{ type: "text", value: "#" }],
  },
  {
    id: "dollar",
    kind: "key",
    category: "123",
    icon: "dollar",
    accessibleLabel: "Dollar sign",
    sequence: [{ type: "text", value: "$" }],
  },
  {
    id: "ampersand",
    kind: "key",
    category: "123",
    icon: "ampersand",
    accessibleLabel: "Ampersand",
    sequence: [{ type: "text", value: "&" }],
  },
  {
    id: "equals",
    kind: "key",
    category: "123",
    icon: "equals",
    accessibleLabel: "Equals",
    sequence: [{ type: "text", value: "=" }],
  },
  {
    id: "npm-test",
    kind: "shortcut",
    category: "shortcuts",
    icon: "bolt",
    accessibleLabel: "Run npm test shortcut",
    sequence: [
      { type: "text", value: "bun test" },
      { type: "key", key: "Enter" },
    ],
  },
  {
    id: "clear-screen",
    kind: "shortcut",
    category: "shortcuts",
    icon: "terminal",
    accessibleLabel: "Clear terminal shortcut",
    sequence: [
      { type: "text", value: "clear" },
      { type: "key", key: "Enter" },
    ],
  },
];

function InteractiveShellStory({
  initialFlickPreview = null,
  startInSettings = false,
  initialButtons = defaultCustomKeyboardButtons,
}: {
  initialFlickPreview?: CustomKeyboardFlickPreview | null;
  startInSettings?: boolean;
  initialButtons?: readonly CustomKeyboardButton[];
}) {
  const [buttons, setButtons] = useState<CustomKeyboardButton[]>(() => [...initialButtons]);
  const [libraryButtons, setLibraryButtons] = useState<CustomKeyboardButton[]>(() => [...buttonLibrary]);
  const [shortcutButtons, setShortcutButtons] = useState<CustomKeyboardButton[]>(() => [
    ...defaultCustomKeyboardButtons.filter((button) => button.kind === "shortcut"),
    ...buttonLibrary.filter((button) => button.kind === "shortcut"),
  ]);
  const [activeModifiers, setActiveModifiers] = useState<CustomKeyboardViewModel["activeModifiers"]>([]);
  const [nativeKeyboardVisible, setNativeKeyboardVisible] = useState(false);
  const [flickPreview, setFlickPreview] = useState<CustomKeyboardFlickPreview | null>(initialFlickPreview);
  const [repeatStartDelayMs, setRepeatStartDelayMs] = useState(initialFlickPreview?.startDelayMs ?? 420);
  const [repeatIntervalMs, setRepeatIntervalMs] = useState(initialFlickPreview?.intervalMs ?? 180);
  const [selectedButtonId, setSelectedButtonId] = useState<string | null>(
    buttons.find((button) => button.kind === "shortcut")?.id ?? buttons[0]?.id ?? null,
  );
  const [settingsOpen, setSettingsOpen] = useState(startInSettings);
  const [lastAction, setLastAction] = useState("Tap a custom key to preview its action.");

  const onButtonPress = useCallback(
    (button: CustomKeyboardButton) => {
      const modifier = button.modifier;
      if (modifier) {
        setActiveModifiers((current) =>
          current.includes(modifier)
            ? current.filter((currentModifier) => currentModifier !== modifier)
            : [...current, modifier],
        );
        setLastAction(`${button.accessibleLabel} latched for the next key`);
        return;
      }

      const modifierPrefix = activeModifiers.length ? `${activeModifiers.join(" + ")} + ` : "";
      setActiveModifiers([]);
      setFlickPreview(null);
      setLastAction(`${modifierPrefix}${button.accessibleLabel} · ${formatStorySequence(button.sequence)}`);
    },
    [activeModifiers],
  );

  const onNativeAction = useCallback((action: CustomKeyboardNativeAction) => {
    const messageByAction: Record<CustomKeyboardNativeAction, string> = {
      "pick-photo": "Photo picker opened",
      "capture-photo": "Camera capture opened",
      "scan-qr": "QR scanner requested",
      "toggle-standard-keyboard": "Standard keyboard action requested",
    };
    setActiveModifiers([]);
    setLastAction(messageByAction[action]);
  }, []);

  const onNativeFileSelected = useCallback((action: CustomKeyboardNativeFileAction, file: File) => {
    const actionLabel = action === "capture-photo" ? "Camera photo selected" : "Photo selected";
    setLastAction(`${actionLabel}: ${file.name} · ${formatFileSize(file.size)}`);
  }, []);

  const onToggleNativeKeyboard = useCallback(() => {
    const nextVisible = !nativeKeyboardVisible;
    setNativeKeyboardVisible(nextVisible);
    setLastAction(nextVisible ? "Standard keyboard shown" : "Standard keyboard hidden");
  }, [nativeKeyboardVisible]);

  const onOpenSettings = useCallback(() => {
    setSettingsOpen(true);
  }, []);

  const onSwapButton = useCallback((buttonId: string, targetButtonId: string) => {
    setButtons((current) => {
      const sourceIndex = current.findIndex((button) => button.id === buttonId);
      const targetIndex = current.findIndex((button) => button.id === targetButtonId);
      if (sourceIndex < 0 || targetIndex < 0 || sourceIndex === targetIndex) return current;
      const next = [...current];
      [next[sourceIndex], next[targetIndex]] = [next[targetIndex], next[sourceIndex]];
      return next;
    });
  }, []);

  const onMoveShortcut = useCallback((buttonId: string, targetIndex: number) => {
    setShortcutButtons((current) => {
      const next = [...current];
      const sourceIndex = next.findIndex((button) => button.id === buttonId);
      if (sourceIndex < 0) return current;
      const [sourceButton] = next.splice(sourceIndex, 1);
      if (!sourceButton) return current;
      const insertionIndex = Math.max(
        0,
        Math.min(next.length, targetIndex > sourceIndex ? targetIndex - 1 : targetIndex),
      );
      next.splice(insertionIndex, 0, sourceButton);
      return next;
    });
  }, []);

  const onAddButton = useCallback((button: CustomKeyboardButton) => {
    setButtons((current) => (current.some((candidate) => candidate.id === button.id) ? current : [...current, button]));
    setSelectedButtonId(button.id);
  }, []);

  const onRemoveButton = useCallback((buttonId: string) => {
    setButtons((current) => current.filter((button) => button.id !== buttonId));
    setSelectedButtonId((current) => (current === buttonId ? null : current));
  }, []);

  const onRegisterShortcut = useCallback(
    (draft: CustomKeyboardShortcutDraft) => {
      const draftId = `shortcut-draft-${libraryButtons.filter((button) => button.category === "shortcuts").length + 1}`;
      const iconLabel = customKeyboardIconOptions.find((option) => option.value === draft.icon)?.label ?? "Custom";
      const shortcut: CustomKeyboardButton = {
        id: draftId,
        kind: "shortcut",
        category: "shortcuts",
        accessibleLabel: `${iconLabel} shortcut`,
        ...draft,
      };
      setLibraryButtons((current) =>
        current.some((button) => button.id === draftId) ? current : [...current, shortcut],
      );
      setShortcutButtons((current) =>
        current.some((button) => button.id === draftId) ? current : [...current, shortcut],
      );
      setSelectedButtonId(draftId);
    },
    [libraryButtons],
  );

  const onUpdateShortcut = useCallback((buttonId: string, draft: CustomKeyboardShortcutDraft) => {
    const iconLabel = customKeyboardIconOptions.find((option) => option.value === draft.icon)?.label ?? "Custom";
    const update = (button: CustomKeyboardButton): CustomKeyboardButton =>
      button.id === buttonId
        ? { ...button, icon: draft.icon, sequence: draft.sequence, accessibleLabel: `${iconLabel} shortcut` }
        : button;
    setButtons((current) => current.map(update));
    setLibraryButtons((current) => current.map(update));
    setShortcutButtons((current) => current.map(update));
  }, []);

  const onDeleteShortcut = useCallback((buttonId: string) => {
    setButtons((current) => current.filter((button) => button.id !== buttonId));
    setLibraryButtons((current) => current.filter((button) => button.id !== buttonId));
    setShortcutButtons((current) => current.filter((button) => button.id !== buttonId));
    setSelectedButtonId((current) => (current === buttonId ? null : current));
  }, []);

  const availableButtons = libraryButtons.filter((candidate) => !buttons.some((button) => button.id === candidate.id));
  const keyboardViewModel: CustomKeyboardViewModel = {
    buttons,
    activeModifiers,
    nativeKeyboardVisible,
    flickPreview,
    onButtonPress,
    onNativeAction,
    onNativeFileSelected,
    onToggleNativeKeyboard,
    onOpenSettings,
  };

  const settingsViewModel: CustomKeyboardSettingsViewModel = {
    buttons,
    availableButtons,
    shortcutButtons,
    selectedButtonId,
    repeatStartDelayMs,
    repeatIntervalMs,
    onSelectButton: setSelectedButtonId,
    onSwapButton,
    onMoveShortcut,
    onAddButton,
    onRemoveButton,
    onRegisterShortcut,
    onUpdateShortcut,
    onDeleteShortcut,
    onRepeatStartDelayChange: (startDelayMs) => {
      setRepeatStartDelayMs(startDelayMs);
      setFlickPreview((current) => (current ? { ...current, startDelayMs } : current));
    },
    onRepeatIntervalChange: (intervalMs) => {
      setRepeatIntervalMs(intervalMs);
      setFlickPreview((current) => (current ? { ...current, intervalMs } : current));
    },
    onClose: () => setSettingsOpen(false),
    onSave: () => {
      setSettingsOpen(false);
      setLastAction("Settings saved in the Storybook mock");
    },
  };

  const shellViewModel: ShellViewModel = {
    keyboard: keyboardViewModel,
    keyboardSettings: settingsViewModel,
    settingsOpen,
  };

  return (
    <ShellView
      viewModel={shellViewModel}
      nativeKeyboard={<MockStandardKeyboard />}
      terminalSurface={
        <MockTerminalSurface
          lastAction={lastAction}
          nativeKeyboardVisible={nativeKeyboardVisible}
          flickPreview={flickPreview}
          onPreviewDismiss={() => setFlickPreview(null)}
        />
      }
    />
  );
}

const storyArgs = {
  viewModel: {
    keyboard: {
      buttons: defaultCustomKeyboardButtons,
      activeModifiers: [],
      nativeKeyboardVisible: false,
      flickPreview: null,
      onButtonPress: () => undefined,
      onNativeAction: () => undefined,
      onNativeFileSelected: () => undefined,
      onToggleNativeKeyboard: () => undefined,
      onOpenSettings: () => undefined,
    },
    keyboardSettings: {
      buttons: defaultCustomKeyboardButtons,
      availableButtons: buttonLibrary,
      shortcutButtons: [
        ...defaultCustomKeyboardButtons.filter((button) => button.kind === "shortcut"),
        ...buttonLibrary.filter((button) => button.kind === "shortcut"),
      ],
      selectedButtonId: "git-status",
      repeatStartDelayMs: 420,
      repeatIntervalMs: 180,
      onSelectButton: () => undefined,
      onSwapButton: () => undefined,
      onMoveShortcut: () => undefined,
      onAddButton: () => undefined,
      onRemoveButton: () => undefined,
      onRegisterShortcut: () => undefined,
      onUpdateShortcut: () => undefined,
      onDeleteShortcut: () => undefined,
      onRepeatStartDelayChange: () => undefined,
      onRepeatIntervalChange: () => undefined,
      onClose: () => undefined,
      onSave: () => undefined,
    },
    settingsOpen: false,
  },
  terminalSurface: null,
  nativeKeyboard: null,
} satisfies ComponentProps<typeof ShellView>;

function MockTerminalSurface({
  lastAction,
  nativeKeyboardVisible,
  flickPreview,
  onPreviewDismiss,
}: {
  lastAction: string;
  nativeKeyboardVisible: boolean;
  flickPreview: CustomKeyboardFlickPreview | null;
  onPreviewDismiss: () => void;
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
      {flickPreview ? (
        <button
          className="absolute bottom-4 left-4 rounded-full border border-[#315f3c] bg-[#0b2411] px-2 py-1 font-mono text-[0.5rem] uppercase tracking-[0.1em] text-[#8fc998]"
          type="button"
          onClick={onPreviewDismiss}
          aria-label="Release flick preview"
        >
          holding
        </button>
      ) : null}
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
  component: ShellView,
  args: storyArgs,
  parameters: { layout: "fullscreen" },
} satisfies Meta<typeof ShellView>;

export default meta;
type Story = StoryObj<typeof meta>;

export const ShellAndKeyboard: Story = {
  render: () => <InteractiveShellStory />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByRole("button", { name: "Slash" }));
    await expect(canvas.getByRole("status", { name: "Last input" })).toHaveTextContent("Slash");
    await userEvent.click(canvas.getByRole("button", { name: /show standard keyboard/i }));
    await expect(canvas.getByText("Standard keyboard active")).toBeVisible();
  },
};

export const FlickRepeatPreview: Story = {
  render: () => (
    <InteractiveShellStory
      initialFlickPreview={{
        direction: "up",
        xPercent: 58,
        yPercent: 43,
        repeating: true,
        startDelayMs: 420,
        intervalMs: 160,
      }}
    />
  ),
};

export const NativeMediaActions: Story = {
  render: () => <InteractiveShellStory initialButtons={[...defaultCustomKeyboardButtons, ...nativeMediaButtons]} />,
};

export const SettingsEditor: Story = {
  render: () => <InteractiveShellStory startInSettings />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByRole("tab", { name: "123" }));
    await expect(canvas.getByRole("button", { name: "Show more symbols" })).toBeVisible();
    await userEvent.click(canvas.getByRole("button", { name: "Show more symbols" }));
    await expect(canvas.getByRole("button", { name: "Show numbers and basic symbols" })).toBeVisible();
    await expect(canvas.getByRole("button", { name: "Add Left bracket" })).toBeVisible();
    await userEvent.click(canvas.getByRole("tab", { name: "Shortcuts" }));
    await userEvent.click(canvas.getByRole("button", { name: "Register shortcut" }));
    await userEvent.click(canvas.getByRole("tab", { name: "Device" }));
    await userEvent.click(canvas.getByRole("button", { name: "Use Camera icon" }));
    await userEvent.click(canvas.getByRole("button", { name: "Clear" }));
    await userEvent.type(canvas.getByRole("textbox", { name: "Text to append" }), "echo ready");
    await userEvent.click(canvas.getByRole("button", { name: "Add text" }));
    await userEvent.click(canvas.getByRole("button", { name: "Ctrl modifier" }));
    await userEvent.click(canvas.getByRole("textbox", { name: "Text to append" }));
    await userEvent.keyboard("{Control>}c{/Control}");
    await expect(canvas.getByRole("button", { name: /Remove Text: "echo ready" token/ })).toBeVisible();
    await expect(canvas.getByRole("button", { name: "Remove Ctrl+C token" })).toBeVisible();
    await userEvent.click(canvas.getByRole("button", { name: "Create shortcut" }));
    await expect(canvas.getByRole("heading", { name: "Registered shortcuts" })).toBeVisible();
    await userEvent.click(canvas.getByRole("button", { name: "Edit shortcuts" }));
    await expect(canvas.getByRole("button", { name: "Finish editing shortcuts" })).toBeVisible();
    await expect(canvas.getByRole("button", { name: "Edit Run npm test shortcut" })).toBeVisible();
    await expect(canvas.getByRole("region", { name: "Custom keyboard preview" })).toHaveAttribute(
      "aria-disabled",
      "true",
    );
    await userEvent.click(canvas.getByRole("button", { name: "Edit Camera shortcut" }));
    await expect(canvas.getByRole("heading", { name: "Edit shortcut" })).toBeVisible();
    await userEvent.click(canvas.getByRole("button", { name: "Cancel" }));
    await userEvent.click(canvas.getByRole("button", { name: "Finish editing shortcuts" }));
  },
};

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
