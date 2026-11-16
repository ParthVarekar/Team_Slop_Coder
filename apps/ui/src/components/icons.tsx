import type { SVGProps } from 'react';

type IconProps = SVGProps<SVGSVGElement> & { size?: number };

function base({ size = 16, ...props }: IconProps) {
  return {
    width: size,
    height: size,
    viewBox: '0 0 16 16',
    fill: 'none',
    stroke: 'currentColor',
    strokeWidth: 1.4,
    strokeLinecap: 'round' as const,
    strokeLinejoin: 'round' as const,
    ...props,
  };
}

export function ActivityIcon(p: IconProps) {
  return (
    <svg {...base(p)}>
      <path d="M1.5 8h2.5l1.5-4 3 8 1.5-4h4.5" />
    </svg>
  );
}

export function SessionsIcon(p: IconProps) {
  return (
    <svg {...base(p)}>
      <circle cx="5.5" cy="5" r="2.2" />
      <path d="M1.8 13.5c.4-2.2 1.9-3.3 3.7-3.3s3.3 1.1 3.7 3.3" />
      <path d="M10.5 3.2a2.2 2.2 0 0 1 0 4.3M11 10.4c1.5.3 2.7 1.4 3 3.1" />
    </svg>
  );
}

export function TasksIcon(p: IconProps) {
  return (
    <svg {...base(p)}>
      <rect x="2" y="2" width="12" height="12" rx="2" />
      <path d="M5 8.2l2 2 4-4.4" />
    </svg>
  );
}

export function ReposIcon(p: IconProps) {
  return (
    <svg {...base(p)}>
      <circle cx="4.5" cy="3.5" r="1.6" />
      <circle cx="4.5" cy="12.5" r="1.6" />
      <circle cx="11.5" cy="5" r="1.6" />
      <path d="M4.5 5.1v5.8M11.5 6.6c0 3-3.5 2.4-5.4 3.6" />
    </svg>
  );
}

export function SearchIcon(p: IconProps) {
  return (
    <svg {...base(p)}>
      <circle cx="7" cy="7" r="4.5" />
      <path d="M10.5 10.5L14 14" />
    </svg>
  );
}

export function CommandIcon(p: IconProps) {
  return (
    <svg {...base(p)}>
      <path d="M6 6h4v4H6z" />
      <path d="M6 6V4.5A1.5 1.5 0 1 0 4.5 6H6zm4 0h1.5A1.5 1.5 0 1 0 10 4.5V6zm0 4v1.5a1.5 1.5 0 1 0 1.5-1.5H10zm-4 0H4.5A1.5 1.5 0 1 0 6 11.5V10z" />
    </svg>
  );
}

export function PlusIcon(p: IconProps) {
  return (
    <svg {...base(p)}>
      <path d="M8 3v10M3 8h10" />
    </svg>
  );
}

export function RefreshIcon(p: IconProps) {
  return (
    <svg {...base(p)}>
      <path d="M13.5 8a5.5 5.5 0 1 1-1.6-3.9M13.5 2.5V5H11" />
    </svg>
  );
}

export function ArchiveIcon(p: IconProps) {
  return (
    <svg {...base(p)}>
      <rect x="2" y="3" width="12" height="3" rx="1" />
      <path d="M3.5 6v6.5a1 1 0 0 0 1 1h7a1 1 0 0 0 1-1V6M6.5 8.5h3" />
    </svg>
  );
}

export function CameraIcon(p: IconProps) {
  return (
    <svg {...base(p)}>
      <path d="M2 5.5A1.5 1.5 0 0 1 3.5 4h1L5.5 2.5h5L11.5 4h1A1.5 1.5 0 0 1 14 5.5v6A1.5 1.5 0 0 1 12.5 13h-9A1.5 1.5 0 0 1 2 11.5z" />
      <circle cx="8" cy="8.3" r="2.4" />
    </svg>
  );
}

export function ChevronIcon(p: IconProps) {
  return (
    <svg {...base(p)}>
      <path d="M6 4l4 4-4 4" />
    </svg>
  );
}

export function CloseIcon(p: IconProps) {
  return (
    <svg {...base(p)}>
      <path d="M4 4l8 8M12 4l-8 8" />
    </svg>
  );
}

export function InboxIcon(p: IconProps) {
  return (
    <svg {...base(p)}>
      <path d="M2 9.5L3.8 3.6A1 1 0 0 1 4.75 3h6.5a1 1 0 0 1 .95.6L14 9.5V12a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1z" />
      <path d="M2 9.5h3.2l.9 1.5h3.8l.9-1.5H14" />
    </svg>
  );
}

export function SettingsIcon(p: IconProps) {
  return (
    <svg {...base(p)}>
      <circle cx="8" cy="8" r="2.2" />
      <path d="M8 1.6v1.6M8 12.8v1.6M1.6 8h1.6M12.8 8h1.6M3.5 3.5l1.1 1.1M11.4 11.4l1.1 1.1M12.5 3.5l-1.1 1.1M4.6 11.4l-1.1 1.1" />
    </svg>
  );
}