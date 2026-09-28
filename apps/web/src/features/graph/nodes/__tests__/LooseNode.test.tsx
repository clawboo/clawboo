// A loose node: a skill or connector on the canvas, attached to no agent yet.
//
// jsdom loads no CSS, so the hover reveal and the dashed ring are screenshot
// questions. What this can see is that the node says what it is, carries the
// port its drag starts from, and can take itself back off the canvas.

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { ReactFlowProvider } from '@xyflow/react'
import type { Node, NodeProps } from '@xyflow/react'
import { http, HttpResponse } from 'msw'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { server } from '@/__vitest__/mswServer'
import { BUILTIN_SKILLS } from '@/features/marketplace/catalog'

import {
  describeLoose,
  makeLooseNode,
  useLooseNodeStore,
  type LooseNodeData,
} from '../../looseNodes'
import { LooseNode } from '../LooseNode'

const skill = BUILTIN_SKILLS[0]!

function props(isConnectable = true): NodeProps<Node<LooseNodeData, 'loose'>> {
  const node = makeLooseNode('atlas', describeLoose('skill', skill.id)!, { x: 0, y: 0 })
  return {
    id: node.id,
    type: 'loose',
    data: node.data,
    selected: false,
    dragging: false,
    draggable: true,
    selectable: true,
    deletable: true,
    isConnectable,
    zIndex: 0,
    positionAbsoluteX: 0,
    positionAbsoluteY: 0,
  }
}

beforeEach(() => {
  useLooseNodeStore.setState({
    byCanvas: {
      atlas: [makeLooseNode('atlas', describeLoose('skill', skill.id)!, { x: 0, y: 0 })],
    },
  })
})
afterEach(() => cleanup())

describe('LooseNode', () => {
  it('names the thing and says it is not attached yet', () => {
    render(
      <ReactFlowProvider>
        <LooseNode {...props()} />
      </ReactFlowProvider>,
    )
    expect(screen.getByText(skill.name)).toBeInTheDocument()
    expect(screen.getByText('Not attached')).toBeInTheDocument()
  })

  it('carries a port whose hint says where the drag goes', () => {
    const { container } = render(
      <ReactFlowProvider>
        <LooseNode {...props()} />
      </ReactFlowProvider>,
    )
    expect(container.querySelector('.boo-port')).toHaveClass('source', 'connectable')
    expect(screen.getByText('Drag onto an agent')).toBeInTheDocument()
  })

  it('stands the port down on a locked canvas', () => {
    const { container } = render(
      <ReactFlowProvider>
        <LooseNode {...props(false)} />
      </ReactFlowProvider>,
    )
    expect(container.querySelector('.boo-port-anchor')).toHaveStyle({ visibility: 'hidden' })
  })

  it('takes itself off the canvas, and the canvas saves without it', async () => {
    let saved: unknown = null
    server.use(
      http.post('/api/graph-layout', async ({ request }) => {
        saved = await request.json()
        return HttpResponse.json({ ok: true })
      }),
    )
    render(
      <ReactFlowProvider>
        <LooseNode {...props()} />
      </ReactFlowProvider>,
    )
    fireEvent.click(screen.getByRole('button', { name: `Remove ${skill.name} from the canvas` }))
    expect(useLooseNodeStore.getState().byCanvas['atlas']).toHaveLength(0)
    await waitFor(() => expect(saved).toMatchObject({ name: 'loose-atlas', positions: {} }))
  })
})
