export type AppIconName =
  | "arrow-left"
  | "close"
  | "folder"
  | "layout"
  | "menu"
  | "new-pane"
  | "paperclip"
  | "refresh"
  | "settings"
  | "sliders"
  | "split-bottom"
  | "split-right"
  | "terminal"
  | "window";

export function AppIcon({ name, size = 16 }: { name: AppIconName; size?: number }) {
  const iconProps = {
    width: size,
    height: size,
    viewBox: "0 0 24 24",
    fill: "none",
    stroke: "currentColor",
    strokeWidth: 1.8,
    strokeLinecap: "round" as const,
    strokeLinejoin: "round" as const,
    "aria-hidden": true,
  };

  switch (name) {
    case "arrow-left":
      return (
        <svg {...iconProps}>
          <path d="M19 12H5M11 18l-6-6 6-6" />
        </svg>
      );
    case "close":
      return (
        <svg {...iconProps}>
          <path d="m6 6 12 12M18 6 6 18" />
        </svg>
      );
    case "folder":
      return (
        <svg {...iconProps}>
          <path d="M3.5 6.5h6l2 2h9v9.5a2 2 0 0 1-2 2h-15z" />
          <path d="M3.5 6.5v-1a2 2 0 0 1 2-2h4l2 2h7a2 2 0 0 1 2 2v1" />
        </svg>
      );
    case "layout":
      return (
        <svg {...iconProps}>
          <rect x="3.5" y="4.5" width="17" height="15" rx="2" />
          <path d="M12 4.5v15M12 12h8.5" />
        </svg>
      );
    case "menu":
      return (
        <svg {...iconProps}>
          <path d="M4 7h16M4 12h16M4 17h16" />
        </svg>
      );
    case "new-pane":
      return (
        <svg {...iconProps}>
          <rect x="3.5" y="4.5" width="17" height="15" rx="2" />
          <path d="M12 4.5v15M16 10v4M14 12h4" />
        </svg>
      );
    case "paperclip":
      return (
        <svg {...iconProps}>
          <path d="m21.44 11.05-9.19 9.19a6 6 0 0 1-8.49-8.49l8.57-8.57A4 4 0 1 1 18 8.84l-8.59 8.57a2 2 0 0 1-2.83-2.83l8.49-8.48" />
        </svg>
      );
    case "refresh":
      return (
        <svg {...iconProps}>
          <path d="M20 11a8 8 0 0 0-14.7-4L3 9" />
          <path d="M3 4v5h5M4 13a8 8 0 0 0 14.7 4L21 15" />
          <path d="M21 20v-5h-5" />
        </svg>
      );
    case "settings":
      return (
        <svg {...iconProps}>
          <path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.38a2 2 0 0 0-.73-2.73l-.15-.09a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2Z" />
          <circle cx="12" cy="12" r="3" />
        </svg>
      );
    case "sliders":
      return (
        <svg {...iconProps}>
          <path d="M4 6h16M4 12h16M4 18h16" />
          <circle cx="9" cy="6" r="1.7" fill="currentColor" stroke="none" />
          <circle cx="15" cy="12" r="1.7" fill="currentColor" stroke="none" />
          <circle cx="10" cy="18" r="1.7" fill="currentColor" stroke="none" />
        </svg>
      );
    case "split-bottom":
      return (
        <svg {...iconProps}>
          <rect x="3.5" y="4.5" width="17" height="15" rx="2" />
          <path d="M3.5 12h17" />
        </svg>
      );
    case "split-right":
      return (
        <svg {...iconProps}>
          <rect x="3.5" y="4.5" width="17" height="15" rx="2" />
          <path d="M12 4.5v15" />
        </svg>
      );
    case "terminal":
      return (
        <svg {...iconProps}>
          <rect x="3.5" y="4.5" width="17" height="15" rx="2" />
          <path d="m7.5 9 3 3-3 3M13.5 15h3" />
        </svg>
      );
    case "window":
      return (
        <svg {...iconProps}>
          <rect x="3.5" y="4.5" width="17" height="15" rx="2" />
          <path d="M3.5 9.5h17M9 6.5h1" />
        </svg>
      );
  }
}
