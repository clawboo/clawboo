// Styled select primitive (Phase 20e).
//
// Wraps the native `<select>` element so we keep its full keyboard / a11y
// behavior (arrow keys, type-ahead, mobile native picker, screen reader
// semantics) but layers on premium chrome: token-driven background, surface
// tier visuals, custom Lucide chevron overlay, focus ring.
//
// API mirrors the native element — pass `value` + `onChange` and either an
// `options` array OR raw `<option>` children. Use this anywhere a vanilla
// `<select>` would otherwise look browser-default.

import { ChevronDown } from 'lucide-react'
import type { ChangeEvent, CSSProperties, ReactNode, SelectHTMLAttributes } from 'react'

export type SelectSize = 'sm' | 'md'

export interface SelectOption {
  value: string
  label: string
  disabled?: boolean
}

export interface SelectProps extends Omit<
  SelectHTMLAttributes<HTMLSelectElement>,
  'onChange' | 'size'
> {
  /** Convenience prop — pass an array of options or use `children` directly. */
  options?: SelectOption[]
  value: string
  onChange: (value: string) => void
  /** Compact (sm = 26 px) vs default (md = 32 px) heights. */
  size?: SelectSize
  children?: ReactNode
  className?: string
  style?: CSSProperties
}

const SIZE_STYLES: Record<
  SelectSize,
  { height: number; fontSize: number; pl: number; pr: number }
> = {
  sm: { height: 26, fontSize: 11, pl: 8, pr: 24 },
  md: { height: 32, fontSize: 12, pl: 10, pr: 28 },
}

export function Select({
  options,
  value,
  onChange,
  size = 'md',
  children,
  className,
  style,
  disabled,
  ...rest
}: SelectProps) {
  const dims = SIZE_STYLES[size]

  function handleChange(event: ChangeEvent<HTMLSelectElement>) {
    onChange(event.target.value)
  }

  return (
    <span
      className={className}
      style={{
        position: 'relative',
        display: 'inline-block',
        ...style,
      }}
    >
      <select
        value={value}
        onChange={handleChange}
        disabled={disabled}
        style={{
          appearance: 'none',
          WebkitAppearance: 'none',
          MozAppearance: 'none',
          height: dims.height,
          paddingLeft: dims.pl,
          paddingRight: dims.pr,
          background: 'rgb(var(--foreground-rgb) / 0.05)',
          border: '1px solid rgb(var(--foreground-rgb) / 0.1)',
          borderRadius: 6,
          color: 'rgb(var(--foreground-rgb) / 0.85)',
          fontSize: dims.fontSize,
          fontFamily: 'var(--font-body)',
          fontWeight: 500,
          cursor: disabled ? 'not-allowed' : 'pointer',
          outline: 'none',
          transition: 'border-color var(--motion-fast), background var(--motion-fast)',
          opacity: disabled ? 0.5 : 1,
          minWidth: 0,
        }}
        {...rest}
      >
        {options
          ? options.map((opt) => (
              <option key={opt.value} value={opt.value} disabled={opt.disabled}>
                {opt.label}
              </option>
            ))
          : children}
      </select>
      <ChevronDown
        aria-hidden
        size={size === 'sm' ? 12 : 14}
        strokeWidth={2}
        style={{
          position: 'absolute',
          right: size === 'sm' ? 6 : 8,
          top: '50%',
          transform: 'translateY(-50%)',
          pointerEvents: 'none',
          color: 'rgb(var(--foreground-rgb) / 0.5)',
        }}
      />
    </span>
  )
}
