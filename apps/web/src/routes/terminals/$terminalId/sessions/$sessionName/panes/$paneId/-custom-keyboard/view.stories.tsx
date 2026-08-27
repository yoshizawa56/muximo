import type { Meta, StoryObj } from "@storybook/react-vite";
import { type ComponentProps, useCallback, useState } from "react";
import { expect, userEvent, within } from "storybook/test";
import type { ShellViewModel } from "../-shell/view";
import { ShellView } from "../-shell/view";
import { applyCustomKeyboardDrop, selectedButtonsFromIds } from "./policy";
import { DirectionalFlickIcon } from "./view";
import {
  type CustomKeyboardButton,
  type CustomKeyboardDragSource,
  type CustomKeyboardDropTarget,
  type CustomKeyboardFlickDirection,
  type CustomKeyboardNativeAction,
  type CustomKeyboardNativeFileAction,
  type CustomKeyboardSequence,
  type CustomKeyboardSettingsViewModel,
  type CustomKeyboardShortcutDraft,
  type CustomKeyboardTerminalAction,
  type CustomKeyboardViewModel,
  customKeyboardIconOptions,
  customKeyboardSpecialKeyOptions,
  customKeyboardSpecialModifierOptions,
  defaultCustomKeyboardButtons,
} from "./viewmodel";

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

const terminalActionButtons = defaultCustomKeyboardButtons.filter((button) => button.terminalAction);

const specialButtonLibrary: readonly CustomKeyboardButton[] = [
  ...specialKeyButtons,
  ...specialModifierButtons.filter((button) => button.modifier !== "shift"),
  ...terminalActionButtons,
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
    accessibleLabel: "Run Bun test shortcut",
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
  startInSettings = false,
  initialButtons = defaultCustomKeyboardButtons,
  initialActiveModifiers = [],
}: {
  startInSettings?: boolean;
  initialButtons?: readonly CustomKeyboardButton[];
  initialActiveModifiers?: CustomKeyboardViewModel["activeModifiers"];
}) {
  const [libraryButtons, setLibraryButtons] = useState<CustomKeyboardButton[]>(() =>
    uniqueStoryButtons([...buttonLibrary, ...initialButtons]),
  );
  const [selectedButtonIds, setSelectedButtonIds] = useState<string[]>(() => initialButtons.map((button) => button.id));
  const [shortcutButtonIds, setShortcutButtonIds] = useState<string[]>(() =>
    [
      ...defaultCustomKeyboardButtons.filter((button) => button.kind === "shortcut"),
      ...buttonLibrary.filter((button) => button.kind === "shortcut"),
    ].map((button) => button.id),
  );
  const [activeModifiers, setActiveModifiers] = useState<CustomKeyboardViewModel["activeModifiers"]>(() => [
    ...initialActiveModifiers,
  ]);
  const [nativeKeyboardVisible, setNativeKeyboardVisible] = useState(false);
  const [repeatStartDelayMs, setRepeatStartDelayMs] = useState(420);
  const [repeatIntervalMs, setRepeatIntervalMs] = useState(180);
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
      setLastAction(`${modifierPrefix}${button.accessibleLabel} · ${formatStorySequence(button.sequence)}`);
    },
    [activeModifiers],
  );

  const onDirectionalFlick = useCallback((direction: CustomKeyboardFlickDirection) => {
    setActiveModifiers([]);
    setLastAction(`${direction} arrow input`);
  }, []);

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

  const onTerminalAction = useCallback((action: CustomKeyboardTerminalAction) => {
    const messageByAction: Record<CustomKeyboardTerminalAction, string> = {
      "enter-copy-mode": "tmux copy mode requested",
      "paste-from-clipboard": "Clipboard paste requested",
      "paste-from-tmux-buffer": "tmux buffer paste requested",
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

  const onDrop = useCallback(
    (source: CustomKeyboardDragSource, target: CustomKeyboardDropTarget) => {
      if (target.type === "keyboard") {
        setSelectedButtonIds(
          (current) =>
            applyCustomKeyboardDrop({ selectedButtonIds: current, shortcutButtonIds }, source, target)
              .selectedButtonIds as string[],
        );
        return;
      }

      setShortcutButtonIds(
        (current) =>
          applyCustomKeyboardDrop({ selectedButtonIds, shortcutButtonIds: current }, source, target)
            .shortcutButtonIds as string[],
      );
    },
    [selectedButtonIds, shortcutButtonIds],
  );

  const onRemoveButton = useCallback((buttonId: string) => {
    setSelectedButtonIds((current) => current.filter((id) => id !== buttonId));
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
      setShortcutButtonIds((current) => (current.includes(draftId) ? current : [...current, draftId]));
    },
    [libraryButtons],
  );

  const onUpdateShortcut = useCallback((buttonId: string, draft: CustomKeyboardShortcutDraft) => {
    const iconLabel = customKeyboardIconOptions.find((option) => option.value === draft.icon)?.label ?? "Custom";
    const update = (button: CustomKeyboardButton): CustomKeyboardButton =>
      button.id === buttonId
        ? { ...button, icon: draft.icon, sequence: draft.sequence, accessibleLabel: `${iconLabel} shortcut` }
        : button;
    setLibraryButtons((current) => current.map(update));
  }, []);

  const onDeleteShortcut = useCallback((buttonId: string) => {
    setSelectedButtonIds((current) => current.filter((id) => id !== buttonId));
    setLibraryButtons((current) => current.filter((button) => button.id !== buttonId));
    setShortcutButtonIds((current) => current.filter((id) => id !== buttonId));
  }, []);

  const buttons = selectedButtonsFromIds(selectedButtonIds, libraryButtons);
  const shortcutButtons = selectedButtonsFromIds(shortcutButtonIds, libraryButtons);
  const availableButtons = libraryButtons.filter((candidate) => !selectedButtonIds.includes(candidate.id));
  const keyboardViewModel: CustomKeyboardViewModel = {
    buttons,
    activeModifiers,
    nativeKeyboardVisible,
    repeatStartDelayMs,
    repeatIntervalMs,
    onButtonPress,
    onDirectionalFlick,
    onNativeAction,
    onTerminalAction,
    onNativeFileSelected,
    onKeepNativeKeyboardOpen: () => undefined,
    onToggleNativeKeyboard,
  };

  const settingsViewModel: CustomKeyboardSettingsViewModel = {
    buttons,
    availableButtons,
    shortcutButtons,
    selectedButtonIds,
    repeatStartDelayMs,
    repeatIntervalMs,
    onDrop,
    onRemoveButton,
    onRegisterShortcut,
    onUpdateShortcut,
    onDeleteShortcut,
    onRepeatStartDelayChange: (startDelayMs) => {
      setRepeatStartDelayMs(startDelayMs);
    },
    onRepeatIntervalChange: (intervalMs) => {
      setRepeatIntervalMs(intervalMs);
    },
  };

  const shellViewModel: ShellViewModel = {
    keyboard: keyboardViewModel,
    keyboardSettings: settingsViewModel,
  };

  return (
    <ShellView
      viewModel={shellViewModel}
      initialSettingsOpen={startInSettings}
      nativeKeyboard={<MockStandardKeyboard />}
      terminalSurface={<MockTerminalSurface lastAction={lastAction} nativeKeyboardVisible={nativeKeyboardVisible} />}
    />
  );
}

const storyArgs = {
  viewModel: {
    keyboard: {
      buttons: defaultCustomKeyboardButtons,
      activeModifiers: [],
      nativeKeyboardVisible: false,
      repeatStartDelayMs: 420,
      repeatIntervalMs: 180,
      onButtonPress: () => undefined,
      onDirectionalFlick: () => undefined,
      onNativeAction: () => undefined,
      onTerminalAction: () => undefined,
      onNativeFileSelected: () => undefined,
      onKeepNativeKeyboardOpen: () => undefined,
      onToggleNativeKeyboard: () => undefined,
    },
    keyboardSettings: {
      buttons: defaultCustomKeyboardButtons,
      availableButtons: buttonLibrary,
      shortcutButtons: [
        ...defaultCustomKeyboardButtons.filter((button) => button.kind === "shortcut"),
        ...buttonLibrary.filter((button) => button.kind === "shortcut"),
      ],
      selectedButtonIds: defaultCustomKeyboardButtons.map((button) => button.id),
      repeatStartDelayMs: 420,
      repeatIntervalMs: 180,
      onDrop: () => undefined,
      onRemoveButton: () => undefined,
      onRegisterShortcut: () => undefined,
      onUpdateShortcut: () => undefined,
      onDeleteShortcut: () => undefined,
      onRepeatStartDelayChange: () => undefined,
      onRepeatIntervalChange: () => undefined,
    },
  },
  terminalSurface: null,
  nativeKeyboard: null,
} satisfies ComponentProps<typeof ShellView>;

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
    await expect(canvas.getByRole("button", { name: /hide standard keyboard/i })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    await userEvent.click(canvas.getByRole("button", { name: "Slash" }));
    await expect(canvas.getByRole("button", { name: /hide standard keyboard/i })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
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

export const DirectionalFlickKey: Story = {
  render: () => <InteractiveShellStory />,
};

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
  render: () => <InteractiveShellStory initialButtons={[...defaultCustomKeyboardButtons, ...nativeMediaButtons]} />,
};

export const SettingsEditor: Story = {
  render: () => <InteractiveShellStory startInSettings />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByRole("button", { name: "Flick repeat" }));
    await expect(canvas.getByRole("button", { name: "Flick repeat" })).toHaveAttribute("aria-expanded", "true");
    const shift = canvas.getByRole("button", { name: "Toggle Shift keyboard key" });
    await userEvent.click(shift);
    await expect(shift).toHaveAttribute("aria-pressed", "true");
    await userEvent.click(shift);
    await expect(shift).toHaveAttribute("aria-pressed", "false");
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
    await expect(canvas.getByRole("button", { name: "Edit Run Bun test shortcut" })).toBeVisible();
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

function uniqueStoryButtons(buttons: readonly CustomKeyboardButton[]): CustomKeyboardButton[] {
  return [...new Map(buttons.map((button) => [button.id, button] as const)).values()];
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
