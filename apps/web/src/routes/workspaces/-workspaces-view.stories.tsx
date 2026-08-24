import type { Meta, StoryObj } from "@storybook/react-vite";
import { useMemo, useState } from "react";
import { expect, fn, userEvent, within } from "storybook/test";
import { storyWorkspaces } from "../terminals/-story-fixtures";
import { WorkspacesListView } from "./-workspaces-view";
import type { WorkspacesListViewModel } from "./-workspaces-viewmodel";

function buildViewModel(overrides: Partial<WorkspacesListViewModel> = {}): WorkspacesListViewModel {
  return {
    workspaces: storyWorkspaces,
    status: "ready",
    query: "",
    errorMessage: null,
    isRegistering: false,
    onQueryChange: fn(),
    onSelectWorkspace: fn(),
    onRegister: fn(),
    onOpenCreate: fn(),
    onBack: fn(),
    ...overrides,
  };
}

function InteractiveWorkspaces() {
  const [query, setQuery] = useState("");
  const [selectedWorkspace, setSelectedWorkspace] = useState<string | null>(null);
  const onSelectWorkspace = useMemo(() => fn(), []);
  const viewModel = buildViewModel({
    query,
    onQueryChange: setQuery,
    onSelectWorkspace: (workspaceId) => {
      onSelectWorkspace(workspaceId);
      setSelectedWorkspace(workspaceId);
    },
  });
  return (
    <>
      <WorkspacesListView viewModel={viewModel} />
      {selectedWorkspace ? (
        <p role="status" className="fixed bottom-5 left-5 rounded bg-lime px-3 py-2 text-xs text-black">
          Selected {selectedWorkspace}
        </p>
      ) : null}
    </>
  );
}

const meta = {
  title: "Pages/Workspaces",
  component: WorkspacesListView,
  parameters: { layout: "fullscreen" },
} satisfies Meta<typeof WorkspacesListView>;

export default meta;
type Story = StoryObj<typeof meta>;

export const RegisteredWorkspaces: Story = {
  args: { viewModel: buildViewModel() },
  render: () => <InteractiveWorkspaces />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.type(canvas.getByPlaceholderText(/filter by name/i), "muximo");
    await userEvent.click(canvas.getByRole("button", { name: /muximo.*git/i }));
    await expect(canvas.getByRole("status", { name: /selected workspace-muximo/i })).toBeVisible();
  },
};

export const Empty: Story = {
  args: { viewModel: buildViewModel({ workspaces: [] }) },
};

export const Loading: Story = {
  args: { viewModel: buildViewModel({ workspaces: [], status: "loading" }) },
};

export const RequestFailed: Story = {
  args: { viewModel: buildViewModel({ workspaces: [], status: "error", errorMessage: "Could not load workspaces" }) },
};

export const NoFilterMatches: Story = {
  args: { viewModel: buildViewModel({ query: "does-not-exist" }) },
};
