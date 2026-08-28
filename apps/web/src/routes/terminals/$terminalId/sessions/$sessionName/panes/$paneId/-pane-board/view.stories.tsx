import type { Meta, StoryObj } from "@storybook/react-vite";
import { useState } from "react";
import { expect, fn, userEvent, within } from "storybook/test";
import { storyPanes } from "../../../../../../-story-fixtures";
import { PaneBoardView } from "./view";
import type { PaneBoardViewModel, PaneSummary } from "./viewmodel";

function buildViewModel(overrides: Partial<PaneBoardViewModel> = {}): PaneBoardViewModel {
  return {
    selectedTarget: "%0",
    panes: storyPanes,
    status: "ready",
    errorMessage: null,
    select: fn(),
    refresh: fn(),
    ...overrides,
  };
}

function InteractivePaneBoardStory({
  initialOpen = false,
  showLayout = false,
  panes = storyPanes,
  status = "ready",
  errorMessage = null,
}: {
  initialOpen?: boolean;
  showLayout?: boolean;
  panes?: PaneSummary[];
  status?: PaneBoardViewModel["status"];
  errorMessage?: string | null;
}) {
  const [isOpen, setIsOpen] = useState(initialOpen);
  const viewModel = buildViewModel({ panes, status, errorMessage });

  return (
    <PaneBoardView
      viewModel={viewModel}
      isOpen={isOpen}
      onClose={() => setIsOpen(false)}
      layoutMode="deck"
      showLayout={showLayout && isOpen}
    />
  );
}

const meta = {
  title: "Components/Pane board",
  component: PaneBoardView,
  parameters: { layout: "fullscreen" },
} satisfies Meta<typeof PaneBoardView>;

export default meta;
type Story = StoryObj<typeof meta>;

export const ReadyPaneList: Story = {
  args: { viewModel: buildViewModel() },
  play: async ({ canvasElement, args }) => {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByRole("button", { name: /review the viewport lease/i }));
    await expect(args.viewModel.select).toHaveBeenCalledWith(storyPanes[0]);
  },
};

export const LoadingPaneList: Story = {
  args: { viewModel: buildViewModel({ panes: [], status: "loading" }) },
};

export const EmptyPaneList: Story = {
  args: { viewModel: buildViewModel({ panes: [] }) },
};

export const PaneListError: Story = {
  args: {
    viewModel: buildViewModel({ panes: [], status: "error", errorMessage: "Unable to load panes" }),
  },
};

export const WindowMapInteraction: Story = {
  args: { viewModel: buildViewModel() },
  render: () => <InteractivePaneBoardStory initialOpen showLayout />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByRole("tab", { name: /muximo 1/i }));
    await userEvent.click(canvas.getByRole("button", { name: "Close window map" }));
    await expect(canvas.getByLabelText("tmux panes")).toHaveAttribute("data-open", "false");
  },
};

export const MobilePaneSelectionClosesBoard: Story = {
  args: { viewModel: buildViewModel() },
  render: () => <InteractivePaneBoardStory initialOpen />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getByLabelText("tmux panes")).toHaveAttribute("data-open", "true");
    await userEvent.click(canvas.getByRole("button", { name: /review the viewport lease/i }));
    await expect(canvas.getByLabelText("tmux panes")).toHaveAttribute("data-open", "false");
  },
};

export const WindowMapError: Story = {
  args: {
    viewModel: buildViewModel({ panes: [], status: "error", errorMessage: "Unable to load panes" }),
    isOpen: true,
    layoutMode: "deck",
    showLayout: true,
  },
  play: async ({ canvasElement, args }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getByRole("alert")).toHaveTextContent("Unable to load panes");
    await userEvent.click(canvas.getByRole("button", { name: "Try again" }));
    await expect(args.viewModel.refresh).toHaveBeenCalledTimes(1);
  },
};

export const WindowMapLoading: Story = {
  args: {
    viewModel: buildViewModel({ panes: [], status: "loading", errorMessage: null }),
    isOpen: true,
    layoutMode: "deck",
    showLayout: true,
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getByRole("status")).toHaveTextContent("Reading tmux");
  },
};
