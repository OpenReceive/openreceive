// Decorative artwork, drawn inline so the starter ships no image files.

export function BoltMark() {
  return (
    <svg width="28" height="28" viewBox="0 0 32 32" aria-hidden="true" focusable="false">
      <rect width="32" height="32" rx="8" fill="#f7931a" />
      <path d="M18.5 5 9 18h6l-1.5 9L23 14h-6l1.5-9Z" fill="#1a1000" />
    </svg>
  );
}

export function StickerArt() {
  return (
    <svg viewBox="0 0 240 240" aria-hidden="true" focusable="false">
      <defs>
        <linearGradient id="sticker-face" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#ffb547" />
          <stop offset="1" stopColor="#f7931a" />
        </linearGradient>
      </defs>
      <g transform="rotate(-8 120 120)">
        <path
          d="M120 14 211 66.5v105L120 224l-91-52.5v-105Z"
          fill="#fff"
          stroke="rgb(0 0 0 / 0.08)"
          strokeWidth="2"
          strokeLinejoin="round"
        />
        <path d="M120 30 197 74.5v89L120 208l-77-44.5v-89Z" fill="url(#sticker-face)" />
        <path d="M131 58 83 128h33l-8 56 49-74h-33l7-52Z" fill="#1a1000" />
      </g>
    </svg>
  );
}
