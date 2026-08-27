import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, fn, userEvent, within } from "storybook/test";
import { storyOfflineTerminal, storyTerminal, storyTerminals } from "./-story-fixtures";
import { TerminalsView } from "./-terminals-view";
import type { TerminalsViewModel } from "./-terminals-viewmodel";

function buildViewModel(overrides: Partial<TerminalsViewModel> = {}): TerminalsViewModel {
  return {
    connectionName: "feature-login",
    terminals: storyTerminals,
    status: "ready",
    errorMessage: null,
    onSelectTerminal: fn(),
    onOpenSettings: fn(),
    onOpenWorkspaces: fn(),
    ...overrides,
  };
}

const meta = {
  title: "Pages/Terminals",
  component: TerminalsView,
  parameters: { layout: "fullscreen" },
} satisfies Meta<typeof TerminalsView>;

export default meta;
type Story = StoryObj<typeof meta>;

export const OnlineAndOffline: Story = {
  args: { viewModel: buildViewModel() },
  play: async ({ canvasElement, args }) => {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByRole("button", { name: /MacBook Air/ }));
    await expect(args.viewModel.onSelectTerminal).toHaveBeenCalledWith(storyTerminal);
    await expect(canvas.getByRole("button", { name: /Studio mini/ })).toBeDisabled();
  },
};

export const Loading: Story = {
  args: { viewModel: buildViewModel({ terminals: [], status: "loading" }) },
};

export const RequestFailed: Story = {
  args: {
    viewModel: buildViewModel({
      terminals: [storyOfflineTerminal],
      status: "error",
      errorMessage: "muximod is unreachable",
    }),
  },
};
