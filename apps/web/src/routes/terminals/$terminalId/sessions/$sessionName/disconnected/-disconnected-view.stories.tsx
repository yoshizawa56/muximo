import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, fn, userEvent, within } from "storybook/test";
import { storySession, storyTerminal } from "../../../../-story-fixtures";
import { DisconnectedView } from "./-disconnected-view";
import type { DisconnectedViewModel } from "./-disconnected-viewmodel";

function buildViewModel(overrides: Partial<DisconnectedViewModel> = {}): DisconnectedViewModel {
  return {
    selectedTerminal: storyTerminal,
    selectedSession: storySession,
    onReconnect: fn(),
    onChooseTerminal: fn(),
    ...overrides,
  };
}

const meta = {
  title: "Pages/Disconnected",
  component: DisconnectedView,
  parameters: { layout: "fullscreen" },
} satisfies Meta<typeof DisconnectedView>;

export default meta;
type Story = StoryObj<typeof meta>;

export const SessionPreserved: Story = {
  args: { viewModel: buildViewModel() },
  play: async ({ canvasElement, args }) => {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByRole("button", { name: /reconnect to session/i }));
    await expect(args.viewModel.onReconnect).toHaveBeenCalledOnce();
    await userEvent.click(canvas.getByRole("button", { name: /choose another terminal/i }));
    await expect(args.viewModel.onChooseTerminal).toHaveBeenCalledOnce();
  },
};

export const MissingSelection: Story = {
  args: { viewModel: buildViewModel({ selectedTerminal: null, selectedSession: null }) },
};
