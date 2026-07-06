import { Monitor, Moon, Sun } from 'lucide-react'

import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import type { ThemeMode } from '../hooks/useThemeMode.js'

// Cycle order matches the user mental model "follow OS → I want light → I want
// dark → back to OS": clicking always advances one step. Keeping it a cycle
// (not a dropdown) keeps the click target as small as the existing top-bar
// affordance while still surfacing the third state.
const NEXT: Record<ThemeMode, ThemeMode> = {
  system: 'light',
  light: 'dark',
  dark: 'system',
}

const LABEL: Record<ThemeMode, string> = {
  system: 'Theme: system (follows OS) — click for light',
  light: 'Theme: light — click for dark',
  dark: 'Theme: dark — click for system',
}

interface Props {
  theme: ThemeMode
  onChange: (next: ThemeMode) => void
}

export function ThemeToggleButton({ theme, onChange }: Props) {
  const Icon = theme === 'system' ? Monitor : theme === 'dark' ? Moon : Sun
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          variant="ghost"
          size="sm"
          className="size-8 p-0"
          onClick={() => onChange(NEXT[theme])}
          aria-label={LABEL[theme]}
        >
          <Icon className="size-3.5" />
        </Button>
      </TooltipTrigger>
      <TooltipContent>{LABEL[theme]}</TooltipContent>
    </Tooltip>
  )
}
