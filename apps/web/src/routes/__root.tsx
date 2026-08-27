import { createRootRoute, type ErrorComponentProps, Outlet, retainSearchParams } from "@tanstack/react-router";
import { z } from "zod";
import { AppErrorView } from "../app/app-error-view";
import { AppViewport } from "../app/components/app-layout";
import { useMobileViewportHeight } from "../app/mobile-viewport";

const rootSearchSchema = z.object({
  connection: z.preprocess((value) => {
    if (typeof value !== "string") return value;
    const trimmed = value.trim();
    return trimmed || undefined;
  }, z.string().min(1).optional()),
});

export const Route = createRootRoute({
  validateSearch: rootSearchSchema,
  search: {
    middlewares: [retainSearchParams(["connection"])],
  },
  component: RootRoute,
  errorComponent: RootError,
  notFoundComponent: RootNotFound,
});

function RootRoute() {
  useMobileViewportHeight();
  return (
    <AppViewport>
      <Outlet />
    </AppViewport>
  );
}

function RootError({ error, reset }: ErrorComponentProps) {
  return <AppErrorView error={error} onRetry={reset} />;
}

function RootNotFound() {
  return (
    <AppErrorView
      error={new Error("The requested route does not exist")}
      title="That route does not exist"
      description="The app is still running, but this URL is not one of its routes. Return to the terminal list to continue."
    />
  );
}
