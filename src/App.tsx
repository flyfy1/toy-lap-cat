import { useEffect, useRef, useState } from 'react'
import { applyMeta, t } from './i18n'
import { Hint } from './components/Hint'
import { startGame } from './game'

export default function App() {
  const ref = useRef<HTMLCanvasElement>(null)
  const [touched, setTouched] = useState(false)
  useEffect(() => {
    applyMeta('purr')
    const g = startGame(ref.current!, () => setTouched(true))
    return () => g.dispose()
  }, [])
  return (
    <>
      <canvas ref={ref} />
      <Hint text={t('hint_purr')} hidden={touched} light />
    </>
  )
}
