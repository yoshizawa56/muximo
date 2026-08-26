import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, fn, userEvent, within } from "storybook/test";
import { storySession, storyTerminal } from "../../../../-story-fixtures";
import { ConnectingView } from "./-connecting-view";
import type { ConnectingViewModel } from "./-connecting-viewmodel";

function buildViewModel(overrides: Partial<ConnectingViewModel> = {}): ConnectingViewModel {
  return {
    selectedTerminal: storyTerminal,
    selectedSession: storySession,
    connectionStep: 2,
    isManaging: false,
    errorMessage: null,
    onOpenSessionOverview: fn(),
    onBack: fn(),
    ...overrides,
  };
}

const meta = {
  title: "Pages/Connecting",
  component: ConnectingView,
  parameters: { layout: "fullscreen" },
} satisfies Meta<typeof ConnectingView>;

export default meta;
type Story = StoryObj<typeof meta>;

export const SessionConnection: Story = {
  args: { viewModel: buildViewModel() },
  play: async ({ canvasElement, args }) => {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByRole("button", { name: /open session overview/i }));
    await expect(args.viewModel.onOpenSessionOverview).toHaveBeenCalledOnce();
    await userEvent.click(canvas.getByRole("button", { name: /cancel/i }));
    await expect(args.viewModel.onBack).toHaveBeenCalledOnce();
  },
};

export const WaitingForAuthentication: Story = {
  args: { viewModel: buildViewModel({ connectionStep: 1 }) },
};
