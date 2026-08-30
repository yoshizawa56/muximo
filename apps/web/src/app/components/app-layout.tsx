import type { PointerEventHandler, ReactNode } from "react";

export function AppViewport({ children }: { children: ReactNode }) {
  return <div className="app-viewport">{children}</div>;
}

export function AppSafeAreaOverlay({
  children,
  className = "",
  onPointerDown,
}: {
  children: ReactNode;
  className?: string;
  onPointerDown?: PointerEventHandler<HTMLDivElement>;
}) {
  return (
    <div className={`app-safe-area-overlay ${className}`} onPointerDown={onPointerDown}>
      {children}
    </div>
  );
}
