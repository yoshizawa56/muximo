import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, fn, userEvent, within } from "storybook/test";
import { AppErrorView } from "./app-error-view";

const meta = {
  title: "Pages/App error",
  component: AppErrorView,
  parameters: { layout: "fullscreen" },
} satisfies Meta<typeof AppErrorView>;

export default meta;
type Story = StoryObj<typeof meta>;

export const RecoverableError: Story = {
  args: {
    error: new Error("The muximod event stream closed unexpectedly"),
    onRetry: fn(),
  },
  play: async ({ canvasElement, args }) => {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByRole("button", { name: /retry/i }));
    await expect(args.onRetry).toHaveBeenCalledOnce();
    await userEvent.click(canvas.getByText(/technical details/i));
    await expect(canvas.getByText(/event stream closed/i)).toBeVisible();
  },
};

export const UnknownError: Story = {
  args: {
    error: null,
    title: "Something went wrong",
    description: "The app could not identify the failure.",
    onRetry: fn(),
  },
};
