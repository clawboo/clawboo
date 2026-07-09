// Toggle switch — a clean track + thumb, brand-red when on. Accessible
// (role=switch, keyboard, aria-checked). Use for boolean settings.

export interface SwitchProps {
  checked: boolean
  onChange: (next: boolean) => void
  disabled?: boolean
  label?: string
  size?: 'sm' | 'md'
  className?: string
}

export function Switch({
  checked,
  onChange,
  disabled = false,
  label,
  size = 'md',
  className = '',
}: SwitchProps) {
  const w = size === 'sm' ? 32 : 38
  const h = size === 'sm' ? 18 : 22
  const knob = h - 6
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={[
        'relative inline-flex shrink-0 items-center rounded-full transition-colors duration-200',
        'focus-visible:outline-2 focus-visible:outline-offset-2 disabled:opacity-45',
        disabled ? 'cursor-not-allowed' : 'cursor-pointer',
        className,
      ].join(' ')}
      style={{
        width: w,
        height: h,
        background: checked ? 'var(--primary)' : 'rgb(var(--foreground-rgb) / 0.15)',
      }}
    >
      <span
        aria-hidden
        className="absolute rounded-full bg-white shadow-sm transition-transform duration-200"
        style={{
          width: knob,
          height: knob,
          top: 3,
          left: 3,
          transform: checked ? `translateX(${w - knob - 6}px)` : 'translateX(0)',
        }}
      />
    </button>
  )
}
