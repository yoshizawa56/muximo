import type { ReactNode } from "react";

export function AppViewport({ children }: { children: ReactNode }) {
  return <div className="app-viewport">{children}</div>;
}

export function AppSafeAreaOverlay({ children, className = "" }: { children: ReactNode; className?: string }) {
  return <div className={`app-safe-area-overlay ${className}`}>{children}</div>;
}
