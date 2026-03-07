import { EditorView } from '@codemirror/view'
import { HighlightStyle, syntaxHighlighting } from '@codemirror/language'
import { tags } from '@lezer/highlight'

const editorChrome = EditorView.theme(
  {
    '&': {
      height: '100%',
      fontSize: '13px',
      background: '#0d1117',
    },
    '.cm-content': {
      fontFamily: 'var(--font-mono)',
      padding: '12px 0',
      caretColor: '#E94560',
    },
    '.cm-cursor, .cm-dropCursor': {
      borderLeftColor: '#E94560',
      borderLeftWidth: '2px',
    },
    '.cm-gutters': {
      background: '#111827',
      borderRight: '1px solid rgba(255,255,255,0.06)',
      color: 'rgba(107,114,128,0.5)',
    },
    '.cm-activeLineGutter': {
      background: 'rgba(255,255,255,0.04)',
      color: 'rgba(232,232,232,0.6)',
    },
    '.cm-activeLine': {
      background: 'rgba(255,255,255,0.03)',
    },
    '.cm-selectionBackground, &.cm-focused .cm-selectionBackground': {
      background: 'rgba(233,69,96,0.15) !important',
    },
    '.cm-matchingBracket': {
      background: 'rgba(52,211,153,0.25)',
      outline: 'none',
    },
    '.cm-searchMatch': {
      background: 'rgba(251,191,36,0.25)',
    },
    '.cm-searchMatch.cm-searchMatch-selected': {
      background: 'rgba(251,191,36,0.4)',
    },
    '.cm-selectionMatch': {
      background: 'rgba(233,69,96,0.1)',
    },
    '.cm-foldPlaceholder': {
      background: 'rgba(255,255,255,0.06)',
      border: 'none',
      color: 'rgba(232,232,232,0.4)',
    },
    '.cm-tooltip': {
      background: '#111827',
      border: '1px solid rgba(255,255,255,0.1)',
    },
    '.cm-panels': {
      background: '#111827',
      color: '#E8E8E8',
    },
    '.cm-panels.cm-panels-top': {
      borderBottom: '1px solid rgba(255,255,255,0.06)',
    },
    '.cm-panels.cm-panels-bottom': {
      borderTop: '1px solid rgba(255,255,255,0.06)',
    },
    '.cm-placeholder': {
      color: 'rgba(107,114,128,0.5)',
      fontStyle: 'italic',
    },
  },
  { dark: true },
)

const markdownHighlight = syntaxHighlighting(
  HighlightStyle.define([
    { tag: tags.heading1, color: '#E94560', fontWeight: '700', fontSize: '1.3em' },
    { tag: tags.heading2, color: '#E94560', fontWeight: '600', fontSize: '1.15em' },
    { tag: tags.heading3, color: '#E94560', fontWeight: '600' },
    { tag: [tags.heading4, tags.heading5, tags.heading6], color: '#E94560', fontWeight: '500' },
    { tag: tags.strong, color: '#E8E8E8', fontWeight: '700' },
    { tag: tags.emphasis, color: '#34D399', fontStyle: 'italic' },
    { tag: [tags.monospace, tags.processingInstruction], color: '#FBBF24' },
    { tag: tags.link, color: '#3B82F6', textDecoration: 'underline' },
    { tag: tags.url, color: '#3B82F6' },
    { tag: tags.quote, color: 'rgba(232,232,232,0.6)', fontStyle: 'italic' },
    { tag: tags.list, color: 'rgba(232,232,232,0.4)' },
    { tag: tags.meta, color: 'rgba(107,114,128,0.7)' },
    { tag: tags.comment, color: 'rgba(107,114,128,0.5)' },
    { tag: tags.content, color: '#E8E8E8' },
    { tag: tags.separator, color: 'rgba(255,255,255,0.15)' },
  ]),
)

export const clawbooEditorTheme = [editorChrome, markdownHighlight]
