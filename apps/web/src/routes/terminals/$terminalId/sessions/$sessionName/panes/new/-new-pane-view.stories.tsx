import { useMemo, useState } from "react";
import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, fn, userEvent, within } from "storybook/test";
import type { PanePlacement, PaneSummary } from "@muximo/contract";
import { NewPaneView } from "./-new-pane-view";
import type { NewPaneAgent, NewPaneKind, NewPaneViewModel } from "./-new-pane-viewmodel";
import type { WorkspacePickerViewModel, WorkspaceSelectionMode } from "../../../-workspace-picker-viewmodel";
import { storyPanes, storySession, storyTerminal, storyWorkspaces } from "../../../../../-story-fixtures";

function buildWorkspacePicker(mode: WorkspaceSelectionMode, onModeChange: (value: WorkspaceSelectionMode) => void): WorkspacePickerViewModel {
  return {
    workspaces: storyWorkspaces,
    workspaceCandidates: storyWorkspaces,
    workspaceId: storyWorkspaces[0].id,
    mode,
    workspaceStatus: "ready",
    browserStatus: "ready",
    browserPath: null,
    registrationOpen: false,
    registrationDirectory: "",
    setupScriptPath: "",
    cleanupScriptPath: "",
    worktreeCopyPatterns: "",
    isRegisteringWorkspace: false,
    registrationError: null,
    errorMessage: null,
    onWorkspaceChange: fn(),
    onModeChange,
    onOpenRegistration: fn(),
    onCloseRegistration: fn(),
    onBrowseWorkspace: fn(),
    onSelectWorkspaceDirectory: fn(),
    onRegistrationDirectoryChange: fn(),
    onSetupScriptPathChange: fn(),
    onCleanupScriptPathChange: fn(),
    onWorktreeCopyPatternsChange: fn(),
    onRegisterWorkspace: fn(),
  };
}

function buildViewModel(overrides: Partial<NewPaneViewModel> = {}): NewPaneViewModel {
  return {
    terminal: storyTerminal,
    session: storySession,
    name: "review",
    workspacePicker: buildWorkspacePicker("worktree", fn()),
    kind: "agent",
    agentId: "codex",
    existingPanes: storyPanes,
    placement: "window",
    targetPaneId: storyPanes[0].tmuxPaneId,
    isCreating: false,
    errorMessage: null,
    onNameChange: fn(),
    onKindChange: fn(),
    onAgentChange: fn(),
    onPlacementChange: fn(),
    onTargetPaneChange: fn(),
    onCreate: fn(),
    onBack: fn(),
    ...overrides,
  };
}

function NewPaneStory({ initialKind = "agent", initialPlacement = "window", initialPanes = storyPanes }: { initialKind?: NewPaneKind; initialPlacement?: PanePlacement; initialPanes?: PaneSummary[] }) {
  const [name, setName] = useState("review");
  const [kind, setKind] = useState(initialKind);
  const [agentId, setAgentId] = useState<NewPaneAgent>("codex");
  const [placement, setPlacement] = useState(initialPlacement);
  const [targetPaneId, setTargetPaneId] = useState<string | null>(initialPanes[0]?.tmuxPaneId ?? null);
  const [mode, setMode] = useState<WorkspaceSelectionMode>(initialKind === "shell" ? "workspace" : "worktree");
  const [created, setCreated] = useState(false);
  const onCreate = useMemo(() => () => setCreated(true), []);
  const viewModel = useMemo<NewPaneViewModel>(() => ({
    terminal: storyTerminal,
    session: storySession,
    name,
    workspacePicker: buildWorkspacePicker(mode, setMode),
    kind,
    agentId,
    existingPanes: initialPanes,
    placement,
    targetPaneId,
    isCreating: false,
    errorMessage: null,
    onNameChange: setName,
    onKindChange: (nextKind) => {
      setKind(nextKind);
      if (nextKind === "shell") setMode("workspace");
    },
    onAgentChange: setAgentId,
    onPlacementChange: setPlacement,
    onTargetPaneChange: setTargetPaneId,
    onCreate,
    onBack: fn(),
  }), [agentId, initialPanes, kind, mode, name, onCreate, placement, targetPaneId]);
  return (
    <>
      <NewPaneView viewModel={viewModel} />
      {created ? <p role="status" className="fixed bottom-5 left-5 rounded bg-lime px-3 py-2 text-xs text-black">Pane request submitted</p> : null}
    </>
  );
}

const meta = {
  title: "Pages/New pane",
  component: NewPaneView,
  parameters: { layout: "fullscreen" },
} satisfies Meta<typeof NewPaneView>;

export default meta;
type Story = StoryObj<typeof meta>;

export const AgentPane: Story = {
  args: { viewModel: buildViewModel() },
  render: () => <NewPaneStory />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.clear(canvas.getByLabelText(/pane name/i));
    await userEvent.type(canvas.getByLabelText(/pane name/i), "review changes");
    await userEvent.click(canvas.getByRole("radio", { name: /shell/i }));
    await userEvent.click(canvas.getByRole("button", { name: /open pane/i }));
    await expect(canvas.getByRole("status", { name: /pane request submitted/i })).toBeVisible();
  },
};

export const EmptySession: Story = {
  args: { viewModel: buildViewModel({ existingPanes: [] }) },
  render: () => <NewPaneStory initialPanes={[]} />,
};

export const ShellPane: Story = {
  args: { viewModel: buildViewModel({ kind: "shell", placement: "right" }) },
  render: () => <NewPaneStory initialKind="shell" initialPlacement="right" />,
};

export const Creating: Story = {
  args: {
    viewModel: buildViewModel({ isCreating: true }),
  },
};

export const RequestFailed: Story = {
  args: {
    viewModel: buildViewModel({
      workspacePicker: buildWorkspacePicker("workspace", fn()),
      kind: "shell",
      errorMessage: "Could not open pane",
    }),
  },
};
