/** Lap Cat's own line icons (the shared ones are in Icons.tsx): 20 px, 1.75 px stroke, currentColor. No emoji. */
const S = { width: 20, height: 20, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 1.75, strokeLinecap: 'round' as const, strokeLinejoin: 'round' as const, 'aria-hidden': true }

export const IconPaw = () => (
  <svg {...S}>
    <path d="M12 13.2c-2.6 0-5 2.5-5 4.6 0 1.5 1.2 2.2 2.6 2.2 1 0 1.6-.5 2.4-.5s1.4.5 2.4.5c1.4 0 2.6-.7 2.6-2.2 0-2.1-2.4-4.6-5-4.6Z" />
    <ellipse cx="6" cy="10.2" rx="1.7" ry="2.1" />
    <ellipse cx="9.4" cy="6.4" rx="1.7" ry="2.2" />
    <ellipse cx="14.6" cy="6.4" rx="1.7" ry="2.2" />
    <ellipse cx="18" cy="10.2" rx="1.7" ry="2.1" />
  </svg>
)
export const IconSpeaker = ({ off }: { off: boolean }) => (
  <svg {...S}>
    <path d="M4 9.5h3.2L12 5.5v13l-4.8-4H4z" />
    {off ? (
      <path d="m16 9.5 5 5m0-5-5 5" />
    ) : (
      <>
        <path d="M15.5 9.2a4 4 0 0 1 0 5.6" />
        <path d="M18 6.8a7.4 7.4 0 0 1 0 10.4" />
      </>
    )}
  </svg>
)
export const IconReceipt = () => (
  <svg {...S}>
    <path d="M6 3.5h12v17l-2-1.4-2 1.4-2-1.4-2 1.4-2-1.4-2 1.4z" />
    <path d="M9 8h6M9 11.5h6M9 15h3.5" />
  </svg>
)
export const IconSave = () => (
  <svg {...S}>
    <path d="M12 4v11m0 0-4-4m4 4 4-4M5 19.5h14" />
  </svg>
)
