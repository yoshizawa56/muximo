import type { Meta, StoryObj } from "@storybook/react-vite";
import { useMemo, useState } from "react";
import { expect, fn, userEvent, within } from "storybook/test";
import { storyWorkspaces } from "../../terminals/-story-fixtures";
import type { WorkspaceDetailViewModel } from "../-workspaces-viewmodel";
import { WorkspaceDetailView } from "./-workspace-detail-view";

function buildViewModel(overrides: Partial<WorkspaceDetailViewModel> = {}): WorkspaceDetailViewModel {
  const workspace = storyWorkspaces[0];
  return {
    workspace,
    workspaces: storyWorkspaces,
    status: "ready",
    name: workspace.name,
    setupScriptPath: workspace.setupScriptPath ?? "",
    cleanupScriptPath: workspace.cleanupScriptPath ?? "",
    isSaving: false,
    isDeleting: false,
    errorMessage: null,
    saveError: null,
    canSave: true,
    onNameChange: fn(),
    onSetupScriptPathChange: fn(),
    onCleanupScriptPathChange: fn(),
    onSave: fn(),
    onDelete: fn(),
    onBack: fn(),
    ...overrides,
  };
}

function InteractiveWorkspaceDetail() {
  const [name, setName] = useState("muximo");
  const [saved, setSaved] = useState(false);
  const onSave = useMemo(() => fn(), []);
  const viewModel = buildViewModel({
    name,
    onNameChange: setName,
    onSave: () => {
      onSave();
      setSaved(true);
    },
  });
  return (
    <>
      <WorkspaceDetailView viewModel={viewModel} />
      {saved ? (
        <p role="status" className="fixed bottom-5 left-5 rounded bg-lime px-3 py-2 text-xs text-black">
          Workspace saved
        </p>
      ) : null}
    </>
  );
}

const meta = {
  title: "Pages/Workspace detail",
  component: WorkspaceDetailView,
  parameters: { layout: "fullscreen" },
} satisfies Meta<typeof WorkspaceDetailView>;

export default meta;
type Story = StoryObj<typeof meta>;

export const GitWorkspace: Story = {
  args: { viewModel: buildViewModel() },
  render: () => <InteractiveWorkspaceDetail />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.clear(canvas.getByLabelText(/workspace name/i));
    await userEvent.type(canvas.getByLabelText(/workspace name/i), "muximo-app");
    await userEvent.click(canvas.getByRole("button", { name: /save workspace/i }));
    await expect(canvas.getByRole("status", { name: /workspace saved/i })).toBeVisible();
  },
};

export const Loading: Story = {
  args: { viewModel: buildViewModel({ workspace: null, status: "loading" }) },
};

export const NotFound: Story = {
  args: { viewModel: buildViewModel({ workspace: null, status: "error", errorMessage: "Workspace not found" }) },
};

export const Saving: Story = {
  args: { viewModel: buildViewModel({ isSaving: true }) },
};

export const SaveFailed: Story = {
  args: {
    viewModel: buildViewModel({ saveError: "Workspace name cannot be empty or exceed 120 characters", canSave: false }),
  },
};
