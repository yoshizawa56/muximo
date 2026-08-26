import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { RouterProvider } from "@tanstack/react-router";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "@xterm/xterm/css/xterm.css";
import { AppErrorBoundary } from "./app/app-error-boundary";
import "./styles.css";
import { router } from "./router";

const queryClient = new QueryClient();
const bootSplashStartedAt = performance.now();

function hideBootSplash(): void {
  const bootSplash = document.getElementById("boot-splash");
  if (!bootSplash) return;

  bootSplash.classList.add("is-hidden");
  window.setTimeout(() => bootSplash.remove(), 220);
}

const rootElement = document.getElementById("root");
if (!rootElement) {
  hideBootSplash();
  throw new Error('Unable to start Muximo: the root element "#root" was not found.');
}

createRoot(rootElement).render(
  <StrictMode>
    <AppErrorBoundary>
      <QueryClientProvider client={queryClient}>
        <RouterProvider router={router} />
      </QueryClientProvider>
    </AppErrorBoundary>
  </StrictMode>,
);

const minimumBootSplashDuration = 360;
const remainingBootSplashDuration = Math.max(0, minimumBootSplashDuration - (performance.now() - bootSplashStartedAt));
window.setTimeout(() => window.requestAnimationFrame(hideBootSplash), remainingBootSplashDuration);
window.setTimeout(hideBootSplash, 5000);
