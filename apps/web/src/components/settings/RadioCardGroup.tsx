import { type KeyboardEvent, type ReactNode, useRef } from 'react'

interface RadioCardOption<T extends string> {
  value: T
  label: string
  icon: ReactNode
}

interface RadioCardGroupProps<T extends string> {
  label: string
  options: ReadonlyArray<RadioCardOption<T>>
  value: T
  onChange: (next: T) => void
  columns: 2 | 3
}

const STEP: Record<string, 1 | -1> = {
  ArrowRight: 1,
  ArrowDown: 1,
  ArrowLeft: -1,
  ArrowUp: -1,
}

/**
 * A button-as-radio group with a roving tabindex (WAI-ARIA radio group): one
 * tab stop on the checked radio, arrows move AND select, wrapping at the ends.
 * Space/Enter on a focused radio select it through the button's own click.
 */
export function RadioCardGroup<T extends string>({
  label,
  options,
  value,
  onChange,
  columns,
}: RadioCardGroupProps<T>) {
  const refs = useRef<Array<HTMLButtonElement | null>>([])
  const checkedIndex = options.findIndex((o) => o.value === value)
  // Nothing checked would leave the group with no tab stop at all.
  const tabStop = checkedIndex === -1 ? 0 : checkedIndex

  const onKeyDown = (event: KeyboardEvent<HTMLButtonElement>, index: number) => {
    const step = STEP[event.key]
    if (!step) return
    event.preventDefault()
    const next = (index + step + options.length) % options.length
    const target = options[next]
    if (!target) return
    onChange(target.value)
    refs.current[next]?.focus()
  }

  return (
    <div
      className={`grid gap-2 ${columns === 3 ? 'grid-cols-3' : 'grid-cols-2'}`}
      role="radiogroup"
      aria-label={label}
    >
      {options.map((option, index) => {
        const selected = option.value === value
        return (
          // biome-ignore lint/a11y/useSemanticElements: WAI-ARIA button-as-radio pattern (icon + label styling not achievable with a native radio input)
          <button
            key={option.value}
            ref={(el) => {
              refs.current[index] = el
            }}
            type="button"
            role="radio"
            aria-checked={selected}
            tabIndex={index === tabStop ? 0 : -1}
            onClick={() => onChange(option.value)}
            onKeyDown={(event) => onKeyDown(event, index)}
            className={`flex flex-col items-center gap-1.5 rounded-md border px-3 py-2.5 text-xs transition-colors ${
              selected
                ? 'border-primary bg-primary/5 text-primary'
                : 'border-border text-muted-foreground hover:border-primary/50 hover:text-foreground'
            }`}
          >
            {option.icon}
            {option.label}
          </button>
        )
      })}
    </div>
  )
}
