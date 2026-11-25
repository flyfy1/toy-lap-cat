/** One-line ghost hint that fades after the first interaction. The light theme gets a small hand that
 *  makes one stroking motion every 2.5 s, and sits 24 px above the 44 px bottom buttons. */
export function Hint({ text, hidden, light = false }: { text: string; hidden: boolean; light?: boolean }) {
  if (light)
    return (
      <div
        className={`pointer-events-none fixed inset-x-0 bottom-[80px] z-10 flex items-center justify-center gap-2 font-[ui-rounded,system-ui,sans-serif] text-[15px] text-[#4A3A2C]/75 transition-opacity duration-700 ${hidden ? 'opacity-0' : 'opacity-100'}`}
      >
        <svg className="hint-hand" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
          <path d="M8 13V5.5a1.5 1.5 0 0 1 3 0V11m0-1.5a1.5 1.5 0 0 1 3 0V11m0-.5a1.5 1.5 0 0 1 3 0v1m0-.5a1.5 1.5 0 0 1 3 0v4.5a6 6 0 0 1-6 6h-1.2a6 6 0 0 1-4.6-2.2L5 16.5a1.6 1.6 0 0 1 2.4-2.1L8 15" />
        </svg>
        <span>{text}</span>
      </div>
    )
  return (
    <div
      className={`pointer-events-none fixed inset-x-0 bottom-16 z-10 text-center text-sm tracking-widest transition-opacity duration-700 ${light ? 'text-[#4A3A2C]/70' : 'text-white/60'} ${hidden ? 'opacity-0' : 'animate-pulse opacity-100'}`}
    >
      {text}
    </div>
  )
}
