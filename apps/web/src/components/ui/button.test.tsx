import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import { Button, buttonVariants } from './button'

describe('buttonVariants', () => {
  it('applies default variant classes when no variant is given', () => {
    const cls = buttonVariants()
    expect(cls).toContain('bg-primary')
    expect(cls).toContain('text-primary-foreground')
  })

  it('applies destructive variant classes', () => {
    const cls = buttonVariants({ variant: 'destructive' })
    expect(cls).toContain('bg-destructive')
  })

  it('applies outline variant classes', () => {
    const cls = buttonVariants({ variant: 'outline' })
    expect(cls).toContain('border')
    expect(cls).toContain('bg-background')
  })

  it('applies ghost variant classes', () => {
    const cls = buttonVariants({ variant: 'ghost' })
    expect(cls).toContain('hover:bg-accent')
  })

  it('applies link variant classes', () => {
    const cls = buttonVariants({ variant: 'link' })
    expect(cls).toContain('underline-offset-4')
  })

  it('applies sm size classes', () => {
    const cls = buttonVariants({ size: 'sm' })
    expect(cls).toContain('h-8')
  })

  it('applies lg size classes', () => {
    const cls = buttonVariants({ size: 'lg' })
    expect(cls).toContain('h-10')
  })

  it('applies icon size classes', () => {
    const cls = buttonVariants({ size: 'icon' })
    expect(cls).toContain('size-9')
  })
})

describe('Button', () => {
  it('renders as a <button> element by default', () => {
    render(<Button>Click me</Button>)
    expect(screen.getByRole('button', { name: 'Click me' })).toBeTruthy()
  })

  it('merges additional className onto the element', () => {
    render(<Button className="my-custom-class">X</Button>)
    const btn = screen.getByRole('button', { name: 'X' })
    expect(btn.className).toContain('my-custom-class')
  })

  it('forwards extra props to the underlying element', () => {
    render(<Button disabled>Disabled</Button>)
    expect(screen.getByRole('button', { name: 'Disabled' })).toBeTruthy()
    expect(
      (screen.getByRole('button', { name: 'Disabled' }) as HTMLButtonElement)
        .disabled,
    ).toBe(true)
  })
})
