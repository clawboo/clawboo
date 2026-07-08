import { act, createRef } from 'react'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'

import { MessageComposer, type MessageComposerHandle } from '../chatComponents'

describe('MessageComposer.prefill', () => {
  it('replaces the draft with the prefilled text', async () => {
    const ref = createRef<MessageComposerHandle>()
    render(<MessageComposer ref={ref} onSend={vi.fn()} disabled={false} />)
    const textarea = screen.getByRole('textbox')

    await userEvent.type(textarea, 'old draft')
    expect(textarea).toHaveValue('old draft')

    act(() => ref.current?.prefill('a suggested first task'))
    expect(textarea).toHaveValue('a suggested first task')
  })

  it('insertMention still prepends (existing behavior unaffected)', () => {
    const ref = createRef<MessageComposerHandle>()
    render(<MessageComposer ref={ref} onSend={vi.fn()} disabled={false} />)
    act(() => ref.current?.insertMention('Coder'))
    expect(screen.getByRole('textbox')).toHaveValue('@Coder ')
  })
})
