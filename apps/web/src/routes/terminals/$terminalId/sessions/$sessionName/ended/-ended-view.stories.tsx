import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, fn, userEvent, within } from "storybook/test";
import { storySession, storyTerminal } from "../../../../-story-fixtures";
import { EndedView } from "./-ended-view";
import type { EndedViewModel } from "./-ended-viewmodel";

function buildViewModel(overrides: Partial<EndedViewModel> = {}): EndedViewModel {
  return {
    selectedTerminal: storyTerminal,
    selectedSession: storySession,
    onReconnect: fn(),
    onChooseTerminal: fn(),
    ...overrides,
  };
}

const meta = {
  title: "Pages/Ended",
  component: EndedView,
  parameters: { layout: "fullscreen" },
} satisfies Meta<typeof EndedView>;

export default meta;
type Story = StoryObj<typeof meta>;

export const ShellEnded: Story = {
  args: { viewModel: buildViewModel() },
  play: async ({ canvasElement, args }) => {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByRole("button", { name: /reconnect to session/i }));
    await expect(args.viewModel.onReconnect).toHaveBeenCalledOnce();
  },
};

export const UnknownSession: Story = {
  args: { viewModel: buildViewModel({ selectedTerminal: null, selectedSession: null }) },
};
