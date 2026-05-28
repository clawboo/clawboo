import { EditorView } from '@codemirror/view'
import { HighlightStyle, syntaxHighlighting } from '@codemirror/language'
import { tags } from '@lezer/highlight'

// Dark theme — original Clawboo editor chrome. Used when resolved theme is 'dark'.
const editorChromeDark = EditorView.theme(
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

const markdownHighlightDark = syntaxHighlighting(
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

// Light theme — paper-white chrome, deepened brand colors for AA contrast.
const editorChromeLight = EditorView.theme(
  {
    '&': {
      height: '100%',
      fontSize: '13px',
      background: '#ffffff',
    },
    '.cm-content': {
      fontFamily: 'var(--font-mono)',
      padding: '12px 0',
      caretColor: '#dc2a48',
    },
    '.cm-cursor, .cm-dropCursor': {
      borderLeftColor: '#dc2a48',
      borderLeftWidth: '2px',
    },
    '.cm-gutters': {
      background: '#f8fafc',
      borderRight: '1px solid rgba(15,23,42,0.08)',
      color: 'rgba(100,116,139,0.7)',
    },
    '.cm-activeLineGutter': {
      background: 'rgba(15,23,42,0.04)',
      color: 'rgba(15,23,42,0.65)',
    },
    '.cm-activeLine': {
      background: 'rgba(15,23,42,0.03)',
    },
    '.cm-selectionBackground, &.cm-focused .cm-selectionBackground': {
      background: 'rgba(220,42,72,0.18) !important',
    },
    '.cm-matchingBracket': {
      background: 'rgba(5,150,105,0.22)',
      outline: 'none',
    },
    '.cm-searchMatch': {
      background: 'rgba(217,119,6,0.25)',
    },
    '.cm-searchMatch.cm-searchMatch-selected': {
      background: 'rgba(217,119,6,0.4)',
    },
    '.cm-selectionMatch': {
      background: 'rgba(220,42,72,0.1)',
    },
    '.cm-foldPlaceholder': {
      background: 'rgba(15,23,42,0.08)',
      border: 'none',
      color: 'rgba(15,23,42,0.5)',
    },
    '.cm-tooltip': {
      background: '#ffffff',
      border: '1px solid rgba(15,23,42,0.12)',
      color: '#0f172a',
    },
    '.cm-panels': {
      background: '#ffffff',
      color: '#0f172a',
    },
    '.cm-panels.cm-panels-top': {
      borderBottom: '1px solid rgba(15,23,42,0.08)',
    },
    '.cm-panels.cm-panels-bottom': {
      borderTop: '1px solid rgba(15,23,42,0.08)',
    },
    '.cm-placeholder': {
      color: 'rgba(100,116,139,0.55)',
      fontStyle: 'italic',
    },
  },
  { dark: false },
)

const markdownHighlightLight = syntaxHighlighting(
  HighlightStyle.define([
    { tag: tags.heading1, color: '#dc2a48', fontWeight: '700', fontSize: '1.3em' },
    { tag: tags.heading2, color: '#dc2a48', fontWeight: '600', fontSize: '1.15em' },
    { tag: tags.heading3, color: '#dc2a48', fontWeight: '600' },
    { tag: [tags.heading4, tags.heading5, tags.heading6], color: '#dc2a48', fontWeight: '500' },
    { tag: tags.strong, color: '#0f172a', fontWeight: '700' },
    { tag: tags.emphasis, color: '#059669', fontStyle: 'italic' },
    { tag: [tags.monospace, tags.processingInstruction], color: '#d97706' },
    { tag: tags.link, color: '#1d4ed8', textDecoration: 'underline' },
    { tag: tags.url, color: '#1d4ed8' },
    { tag: tags.quote, color: 'rgba(15,23,42,0.65)', fontStyle: 'italic' },
    { tag: tags.list, color: 'rgba(15,23,42,0.5)' },
    { tag: tags.meta, color: 'rgba(100,116,139,0.75)' },
    { tag: tags.comment, color: 'rgba(100,116,139,0.6)' },
    { tag: tags.content, color: '#0f172a' },
    { tag: tags.separator, color: 'rgba(15,23,42,0.18)' },
  ]),
)

// Default export remains the dark theme for backward compatibility — callers
// that want light should import `clawbooEditorThemeLight` and pick based on
// `useTheme().resolvedTheme`.
export const clawbooEditorTheme = [editorChromeDark, markdownHighlightDark]
export const clawbooEditorThemeDark = clawbooEditorTheme
export const clawbooEditorThemeLight = [editorChromeLight, markdownHighlightLight]
