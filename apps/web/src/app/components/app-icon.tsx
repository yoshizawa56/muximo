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
          <path d="M12 8.5a3.5 3.5 0 1 0 0 7 3.5 3.5 0 0 0 0-7Z" />
          <path d="M19.4 15a1.8 1.8 0 0 0 .2 2l.1.1-1.7 1.7-.1-.1a1.8 1.8 0 0 0-2-.2 1.8 1.8 0 0 0-1 1.6v.1h-2.4v-.1a1.8 1.8 0 0 0-1-1.6 1.8 1.8 0 0 0-2 .2l-.1.1-1.7-1.7.1-.1a1.8 1.8 0 0 0 .2-2 1.8 1.8 0 0 0-1.6-1H6.3v-2.4h.1a1.8 1.8 0 0 0 1.6-1 1.8 1.8 0 0 0-.2-2l-.1-.1 1.7-1.7.1.1a1.8 1.8 0 0 0 2 .2 1.8 1.8 0 0 0 1-1.6v-.1h2.4v.1a1.8 1.8 0 0 0 1 1.6 1.8 1.8 0 0 0 2-.2l.1-.1 1.7 1.7-.1.1a1.8 1.8 0 0 0-.2 2 1.8 1.8 0 0 0 1.6 1h.1V13h-.1a1.8 1.8 0 0 0-1.6 2Z" />
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
