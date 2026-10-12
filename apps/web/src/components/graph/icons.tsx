import type { SVGProps } from "react";
import type { SignalType, Side } from "./types";

type P = SVGProps<SVGSVGElement> & { size?: number };

const base = (size = 16): SVGProps<SVGSVGElement> => ({
  width: size,
  height: size,
  viewBox: "0 0 16 16",
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 1.5,
  strokeLinecap: "round",
  strokeLinejoin: "round",
  "aria-hidden": true,
});

/* ----- Signal glyphs ----- */
export const IconForecast = ({ size, ...p }: P) => (
  <svg {...base(size)} {...p}>
    <path d="M1.5 6.2c1.6-1.6 3.1-1.6 4.6 0s3.1 1.6 4.6 0 2.6-1.6 3.8-.6" />
    <path d="M1.5 10.2c1.6-1.6 3.1-1.6 4.6 0s3.1 1.6 4.6 0 2.6-1.6 3.8-.6" opacity=".55" />
  </svg>
);
export const IconOdds = ({ size, ...p }: P) => (
  <svg {...base(size)} {...p}>
    <circle cx="8" cy="8" r="6" />
    <path d="M8 2v6l4.3 4.1" />
  </svg>
);
export const IconPrice = ({ size, ...p }: P) => (
  <svg {...base(size)} {...p}>
    <path d="M4 2.5v11M12 2.5v11" opacity=".55" />
    <rect x="2.5" y="5" width="3" height="5" rx=".6" />
    <rect x="10.5" y="4" width="3" height="4.5" rx=".6" />
    <path d="M8 3.5v9" />
    <rect x="6.5" y="6.5" width="3" height="3.5" rx=".6" />
  </svg>
);
export const IconSocial = ({ size, ...p }: P) => (
  <svg {...base(size)} {...p}>
    <path d="M2.5 3.5h11v7H8l-3 2.5v-2.5H2.5z" />
    <path d="M5.5 7h5" opacity=".6" />
  </svg>
);
export const IconNews = ({ size, ...p }: P) => (
  <svg {...base(size)} {...p}>
    <rect x="2.5" y="2.5" width="11" height="11" rx="1.5" />
    <path d="M5 5.5h6M5 8h6M5 10.5h3.5" opacity=".7" />
  </svg>
);
export const IconFunding = ({ size, ...p }: P) => (
  <svg {...base(size)} {...p}>
    <path d="M3 13 13 3" />
    <circle cx="4.5" cy="4.5" r="1.8" />
    <circle cx="11.5" cy="11.5" r="1.8" />
  </svg>
);
export const IconCalendar = ({ size, ...p }: P) => (
  <svg {...base(size)} {...p}>
    <rect x="2.5" y="3.5" width="11" height="10" rx="1.5" />
    <path d="M2.5 6.5h11M5.5 2v3M10.5 2v3" />
    <circle cx="8" cy="10" r=".9" fill="currentColor" stroke="none" />
  </svg>
);
export const IconModel = ({ size, ...p }: P) => (
  <svg {...base(size)} {...p}>
    <path d="M8 1.8 9.4 6.6 14.2 8 9.4 9.4 8 14.2 6.6 9.4 1.8 8 6.6 6.6z" />
  </svg>
);
export const IconRates = ({ size, ...p }: P) => (
  <svg {...base(size)} {...p}>
    <path d="M2 6 8 2.5 14 6" />
    <path d="M3.5 7v5M6.5 7v5M9.5 7v5M12.5 7v5M2 13.5h12" />
  </svg>
);

export const signalIcon: Record<SignalType, (p: P) => React.JSX.Element> = {
  forecast: IconForecast,
  odds: IconOdds,
  price: IconPrice,
  social: IconSocial,
  news: IconNews,
  funding: IconFunding,
  calendar: IconCalendar,
  model: IconModel,
  rates: IconRates,
};

/* ----- Kind glyphs ----- */
export const IconTrigger = ({ size, ...p }: P) => (
  <svg {...base(size)} {...p}>
    <path d="M8 1.8 14.2 8 8 14.2 1.8 8z" />
    <path d="M5.6 8h4.8" />
  </svg>
);
export const IconLong = ({ size, ...p }: P) => (
  <svg {...base(size)} {...p}>
    <path d="M3 12.5 7 8.5l2.2 2.2L13 6.5" />
    <path d="M9.8 6.5H13v3.2" />
  </svg>
);
export const IconShort = ({ size, ...p }: P) => (
  <svg {...base(size)} {...p}>
    <path d="M3 3.5 7 7.5l2.2-2.2L13 9.5" />
    <path d="M9.8 9.5H13V6.3" />
  </svg>
);
export const IconExit = ({ size, ...p }: P) => (
  <svg {...base(size)} {...p}>
    <path d="M8 1.8v5.4" />
    <path d="M4.4 4a5.5 5.5 0 1 0 7.2 0" />
  </svg>
);
export const actionIcon = (side: Side) => (side === "long" || side === "buy" ? IconLong : IconShort);

/* ----- UI glyphs ----- */
export const IconCheck = ({ size, ...p }: P) => (
  <svg {...base(size)} {...p}>
    <path d="m3.5 8.4 2.9 2.9 6.1-6.6" />
  </svg>
);
export const IconX = ({ size, ...p }: P) => (
  <svg {...base(size)} {...p}>
    <path d="m4 4 8 8M12 4l-8 8" />
  </svg>
);
export const IconLock = ({ size, ...p }: P) => (
  <svg {...base(size)} {...p}>
    <rect x="3" y="7" width="10" height="7" rx="1.6" />
    <path d="M5.3 7V5a2.7 2.7 0 0 1 5.4 0v2" />
  </svg>
);
export const IconFork = ({ size, ...p }: P) => (
  <svg {...base(size)} {...p}>
    <circle cx="4" cy="3.5" r="1.6" />
    <circle cx="12" cy="3.5" r="1.6" />
    <circle cx="8" cy="12.5" r="1.6" />
    <path d="M4 5.1v.9c0 1.6 4 1.6 4 3.5v1.4M12 5.1v.9c0 1.6-4 1.6-4 3.5" />
  </svg>
);
export const IconReplay = ({ size, ...p }: P) => (
  <svg {...base(size)} {...p}>
    <path d="M2.8 8a5.2 5.2 0 1 0 1.6-3.8" />
    <path d="M2.5 2.2v3h3" />
  </svg>
);
export const IconArrowRight = ({ size, ...p }: P) => (
  <svg {...base(size)} {...p}>
    <path d="M3 8h10M9 4l4 4-4 4" />
  </svg>
);
export const IconCopy = ({ size, ...p }: P) => (
  <svg {...base(size)} {...p}>
    <rect x="5.5" y="5.5" width="8" height="8" rx="1.5" />
    <path d="M10.5 3.5v-.5A1.5 1.5 0 0 0 9 1.5H4A1.5 1.5 0 0 0 2.5 3v5A1.5 1.5 0 0 0 4 9.5h.5" />
  </svg>
);
export const IconShield = ({ size, ...p }: P) => (
  <svg {...base(size)} {...p}>
    <path d="M8 1.8 13.2 4v4.1c0 3-2.2 5.2-5.2 6.1-3-.9-5.2-3.1-5.2-6.1V4z" />
    <path d="m5.6 8 1.7 1.7 3.2-3.4" />
  </svg>
);
export const IconKey = ({ size, ...p }: P) => (
  <svg {...base(size)} {...p}>
    <circle cx="5" cy="8" r="3" />
    <path d="M8 8h6M12 8v2.4M14 8v1.6" />
  </svg>
);
export const IconSpark = ({ size, ...p }: P) => (
  <svg {...base(size)} {...p}>
    <path d="M8 2v3M8 11v3M2 8h3M11 8h3M3.8 3.8l2 2M10.2 10.2l2 2M12.2 3.8l-2 2M5.8 10.2l-2 2" />
  </svg>
);
export const IconEye = ({ size, ...p }: P) => (
  <svg {...base(size)} {...p}>
    <path d="M1.5 8S4 3.5 8 3.5 14.5 8 14.5 8 12 12.5 8 12.5 1.5 8 1.5 8z" />
    <circle cx="8" cy="8" r="2" />
  </svg>
);
export const IconPower = IconExit;
export const IconPlus = ({ size, ...p }: P) => (
  <svg {...base(size)} {...p}>
    <path d="M8 3v10M3 8h10" />
  </svg>
);
export const IconSun = ({ size, ...p }: P) => (
  <svg {...base(size)} {...p}>
    <circle cx="8" cy="8" r="3" />
    <path d="M8 1v1.6M8 13.4V15M1 8h1.6M13.4 8H15M3 3l1.1 1.1M11.9 11.9 13 13M3 13l1.1-1.1M11.9 4.1 13 3" />
  </svg>
);
export const IconMoon = ({ size, ...p }: P) => (
  <svg {...base(size)} {...p}>
    <path d="M13.5 9.6A6 6 0 0 1 6.4 2.5a6 6 0 1 0 7.1 7.1z" />
  </svg>
);
export const IconSend = ({ size, ...p }: P) => (
  <svg {...base(size)} {...p}>
    <path d="M8 13V3M3.5 7.5 8 3l4.5 4.5" />
  </svg>
);
