/** One-line ghost hint that fades after the first interaction. */
export function Hint({ text, hidden, light = false }: { text: string; hidden: boolean; light?: boolean }) {
  return (
    <div
      className={`pointer-events-none fixed inset-x-0 bottom-16 z-10 text-center text-sm tracking-widest transition-opacity duration-700 ${light ? 'text-[#4A3A2C]/70' : 'text-white/60'} ${hidden ? 'opacity-0' : 'animate-pulse opacity-100'}`}
    >
      {text}
    </div>
  )
}
