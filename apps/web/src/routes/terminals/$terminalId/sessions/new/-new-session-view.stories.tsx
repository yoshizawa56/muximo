import type { Meta, StoryObj } from "@storybook/react-vite";
import { useMemo, useState } from "react";
import { expect, fn, userEvent, within } from "storybook/test";
import { storyTerminal, storyWorkspaces } from "../../../-story-fixtures";
import type { WorkspacePickerViewModel } from "../-workspace-picker-viewmodel";
import { NewSessionView } from "./-new-session-view";
import type { NewSessionViewModel } from "./-new-session-viewmodel";

function buildWorkspacePicker(overrides: Partial<WorkspacePickerViewModel> = {}): WorkspacePickerViewModel {
  return {
    workspaces: storyWorkspaces,
    workspaceCandidates: storyWorkspaces,
    workspaceId: storyWorkspaces[0].id,
    mode: "workspace",
    workspaceStatus: "ready",
    browserStatus: "ready",
    browserPath: null,
    registrationOpen: false,
    registrationDirectory: "",
    setupScriptPath: "",
    cleanupScriptPath: "",
    isRegisteringWorkspace: false,
    registrationError: null,
    errorMessage: null,
    onWorkspaceChange: fn(),
    onModeChange: fn(),
    onOpenRegistration: fn(),
    onCloseRegistration: fn(),
    onBrowseWorkspace: fn(),
    onSelectWorkspaceDirectory: fn(),
    onRegistrationDirectoryChange: fn(),
    onSetupScriptPathChange: fn(),
    onCleanupScriptPathChange: fn(),
    onRegisterWorkspace: fn(),
    ...overrides,
  };
}

function buildViewModel(overrides: Partial<NewSessionViewModel> = {}): NewSessionViewModel {
  return {
    terminal: storyTerminal,
    name: "",
    workspacePicker: buildWorkspacePicker(),
    isCreating: false,
    errorMessage: null,
    onNameChange: fn(),
    onBack: fn(),
    onCreate: fn(),
    ...overrides,
  };
}

function NewSessionStory({ initialName = "" }: { initialName?: string }) {
  const [name, setName] = useState(initialName);
  const [created, setCreated] = useState(false);
  const onCreate = useMemo(() => fn(), []);
  const viewModel = useMemo<NewSessionViewModel>(
    () => ({
      terminal: storyTerminal,
      name,
      workspacePicker: buildWorkspacePicker(),
      isCreating: false,
      errorMessage: null,
      onNameChange: setName,
      onBack: fn(),
      onCreate: () => {
        onCreate();
        setCreated(true);
      },
    }),
    [name, onCreate],
  );
  return (
    <>
      <NewSessionView viewModel={viewModel} />
      {created ? (
        <p role="status" className="fixed bottom-5 left-5 rounded bg-lime px-3 py-2 text-xs text-black">
          Session request submitted
        </p>
      ) : null}
    </>
  );
}

const meta = {
  title: "Pages/New session",
  component: NewSessionView,
  parameters: { layout: "fullscreen" },
} satisfies Meta<typeof NewSessionView>;

export default meta;
type Story = StoryObj<typeof meta>;

export const ReadyToCreate: Story = {
  args: { viewModel: buildViewModel() },
  render: () => <NewSessionStory />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.type(canvas.getByLabelText(/session name/i), "review");
    await userEvent.click(canvas.getByRole("button", { name: /create session/i }));
    await expect(canvas.getByRole("status", { name: /session request submitted/i })).toBeVisible();
  },
};

export const InvalidName: Story = {
  args: { viewModel: buildViewModel() },
  render: () => <NewSessionStory />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getByRole("button", { name: /create session/i })).toBeDisabled();
  },
};

export const Creating: Story = {
  args: {
    viewModel: buildViewModel({ name: "release", isCreating: true }),
  },
};

export const RequestFailed: Story = {
  args: {
    viewModel: buildViewModel({ name: "release", errorMessage: "Could not create tmux session" }),
  },
};
