import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, fn, userEvent, within } from "storybook/test";
import { storyPanes, storySession, storyTerminal } from "../../../-story-fixtures";
import { SessionView } from "./-session-view";
import type { SessionOverviewViewModel } from "./-session-viewmodel";

function buildViewModel(overrides: Partial<SessionOverviewViewModel> = {}): SessionOverviewViewModel {
  return {
    terminal: storyTerminal,
    session: storySession,
    panes: storyPanes,
    status: "ready",
    errorMessage: null,
    onSelectPane: fn(),
    onCreatePane: fn(),
    onBack: fn(),
    onDisconnect: fn(),
    ...overrides,
  };
}

const meta = {
  title: "Pages/Session overview",
  component: SessionView,
  parameters: { layout: "fullscreen" },
} satisfies Meta<typeof SessionView>;

export default meta;
type Story = StoryObj<typeof meta>;

export const PanesReady: Story = {
  args: { viewModel: buildViewModel() },
  play: async ({ canvasElement, args }) => {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByRole("button", { name: /select pane 0/i }));
    await expect(args.viewModel.onSelectPane).toHaveBeenCalledWith(storyPanes[0]);
    await userEvent.click(canvas.getByRole("button", { name: /\+ pane/i }));
    await expect(args.viewModel.onCreatePane).toHaveBeenCalledOnce();
  },
};

export const EmptySession: Story = {
  args: { viewModel: buildViewModel({ panes: [] }) },
};

export const ReadingLayout: Story = {
  args: { viewModel: buildViewModel({ panes: [], status: "loading" }) },
};

export const LayoutUnavailable: Story = {
  args: { viewModel: buildViewModel({ panes: [], status: "error", errorMessage: "Unable to load panes" }) },
};
