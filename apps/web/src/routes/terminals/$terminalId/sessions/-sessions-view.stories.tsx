import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, fn, userEvent, within } from "storybook/test";
import { storySession, storySessions, storyTerminal } from "../../-story-fixtures";
import { SessionsView } from "./-sessions-view";
import type { SessionsViewModel } from "./-sessions-viewmodel";

function buildViewModel(overrides: Partial<SessionsViewModel> = {}): SessionsViewModel {
  return {
    terminals: [storyTerminal],
    sessions: storySessions,
    selectedTerminal: storyTerminal,
    selectedSession: null,
    status: "ready",
    errorMessage: null,
    onSelectSession: fn(),
    onCreateSession: fn(),
    onBack: fn(),
    ...overrides,
  };
}

const meta = {
  title: "Pages/Sessions",
  component: SessionsView,
  parameters: { layout: "fullscreen" },
} satisfies Meta<typeof SessionsView>;

export default meta;
type Story = StoryObj<typeof meta>;

export const ReadyWithWaitingSession: Story = {
  args: { viewModel: buildViewModel() },
  play: async ({ canvasElement, args }) => {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByRole("button", { name: /muximo.*2 agents/i }));
    await expect(args.viewModel.onSelectSession).toHaveBeenCalledWith(storySession);
    await expect(canvas.getByText("MANAGED")).toBeInTheDocument();
    await expect(canvas.getByText("UNMANAGED")).toBeInTheDocument();
    await userEvent.click(canvas.getByRole("button", { name: /new session/i }));
    await expect(args.viewModel.onCreateSession).toHaveBeenCalledOnce();
  },
};

export const Empty: Story = {
  args: { viewModel: buildViewModel({ sessions: [] }) },
};

export const Loading: Story = {
  args: { viewModel: buildViewModel({ sessions: [], status: "loading" }) },
};

export const RequestFailed: Story = {
  args: { viewModel: buildViewModel({ sessions: [], status: "error", errorMessage: "Could not read tmux sessions" }) },
};
