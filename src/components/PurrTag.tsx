// Lap Cat's landing tag (loaded on demand, recipients only, so the first load stays as it was).
import type { ReactElement } from 'react'
import { locale, type Locale } from '../i18n'
import { Tag } from './Tag'

const TAG: Record<Locale, [string, string]> = {
  en: ['This is {name}. Their human has left you in charge.', 'This cat’s human has left you in charge.'],
  'zh-CN': ['这是{name}。它的铲屎官让你代班。', '这只猫的铲屎官让你代班。'],
  es: ['Este es {name}. Su humano te deja al cargo.', 'El humano de este gato te deja al cargo.'],
  fr: ['Voici {name}. Son humain vous confie la garde.', 'L’humain de ce chat vous confie la garde.'],
  ja: ['こちら{name}。飼い主から代理を頼まれました。', 'この猫の飼い主から代理を頼まれました。'],
}

export default function PurrTag({ name }: { name: string }): ReactElement | null {
  const [named, plain] = TAG[locale]
  return <Tag text={name ? named.replace('{name}', name) : plain} className="top-[4.2rem]" paper="bg-[#FFFCF5] text-[#3B2E24]" />
}
