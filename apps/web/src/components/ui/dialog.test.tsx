import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import { Dialog, DialogContent, DialogTitle, DialogDescription } from './dialog'

describe('DialogContent', () => {
  it('renders a close button by default (showCloseButton=true)', () => {
    render(
      <Dialog open>
        <DialogContent>
          <DialogTitle>Test title</DialogTitle>
          <DialogDescription>Test description</DialogDescription>
        </DialogContent>
      </Dialog>,
    )
    expect(screen.getByRole('button', { name: /close/i })).toBeTruthy()
  })

  it('omits the close button when showCloseButton=false', () => {
    render(
      <Dialog open>
        <DialogContent showCloseButton={false}>
          <DialogTitle>Test title</DialogTitle>
          <DialogDescription>Test description</DialogDescription>
        </DialogContent>
      </Dialog>,
    )
    expect(screen.queryByRole('button', { name: /close/i })).toBeNull()
  })

  it('renders children inside the content', () => {
    render(
      <Dialog open>
        <DialogContent>
          <DialogTitle>Hello</DialogTitle>
          <DialogDescription>World</DialogDescription>
          <p>Custom child</p>
        </DialogContent>
      </Dialog>,
    )
    expect(screen.getByText('Custom child')).toBeTruthy()
  })
})
