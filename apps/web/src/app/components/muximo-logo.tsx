import type { SVGProps } from "react";

export type MuximoLogoVariant = "muximo" | "local" | "stg";

type MuximoLogoProps = Omit<SVGProps<SVGSVGElement>, "height" | "viewBox" | "width"> & {
  size?: number;
  variant?: MuximoLogoVariant;
};

const logoPalette = {
  muximo: { frame: "#8bff9a", dots: "#39d65b", glyph: "#8bff9a", label: "Muximo" },
  local: { frame: "#72c8ff", dots: "#3d9ed5", glyph: "#72c8ff", label: "Local" },
  stg: { frame: "#f1c76d", dots: "#c99a3f", glyph: "#f1c76d", label: "Staging" },
} satisfies Record<MuximoLogoVariant, { frame: string; dots: string; glyph: string; label: string }>;

export function MuximoLogo({ size = 26, variant = "muximo", ...props }: MuximoLogoProps) {
  const palette = logoPalette[variant];

  return (
    <svg
      {...props}
      width={size}
      height={size}
      viewBox="0 0 100 100"
      fill="none"
      role="img"
      aria-label={`${palette.label} logo`}
      focusable="false"
    >
      <rect x="8" y="8" width="84" height="84" rx="24" fill="#071108" />
      <rect x="19" y="21" width="62" height="58" rx="12" stroke={palette.frame} strokeWidth="4" />
      <path d="M29 31h2M36 31h2M43 31h2" stroke={palette.dots} strokeWidth="3" strokeLinecap="round" />
      <g transform="translate(-4 0) translate(50 0) scale(0.92 1) translate(-50 0)">
        <path
          d="m31 44 10 9-10 9M47 62h8"
          stroke="#d9f4dc"
          strokeWidth="4"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
        {variant === "muximo" ? (
          <path
            d="M61 62V43l9 11 9-11v19"
            stroke={palette.glyph}
            strokeWidth="4"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        ) : null}
        {variant === "local" ? (
          <path d="M61 43v19h14" stroke={palette.glyph} strokeWidth="4" strokeLinecap="round" strokeLinejoin="round" />
        ) : null}
        {variant === "stg" ? (
          <path
            d="M76 46c-2-2-4-3-7-3h-1c-4 0-6 2-6 5s2 4 6 5l2 1c4 1 6 2 6 5s-2 4-6 4h-1c-3 0-5-1-7-3"
            stroke={palette.glyph}
            strokeWidth="4"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        ) : null}
      </g>
    </svg>
  );
}
