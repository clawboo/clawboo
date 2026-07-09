// Shared premium chrome for the native-first onboarding wizard.
//
// OnboardingScreen gives every step the same spacious, full-page layout: a big
// Cabinet-Grotesk headline, an airy content column, a footer row, and the
// minimal brand StepDots pinned to the bottom. OnboardingPrimary / OnboardingGhost
// are the two button treatments used across the flow. Keeping this in one place
// is what lets the design system stay consistent as it rolls out to more screens.

import type { ReactNode } from 'react'

import { StepDots, type IndicatorId, type IndicatorStep } from './StepIndicator'

const muted = (o: number) => `rgb(var(--foreground-rgb) / ${o})`

export interface OnboardingScreenProps {
  /** When set, renders the bottom StepDots progress for this step. */
  step?: IndicatorId
  steps?: IndicatorStep[]
  /** Small uppercase brand label above the headline. */
  eyebrow?: ReactNode
  title: ReactNode
  subtitle?: ReactNode
  children?: ReactNode
  /** Footer row (Back / Skip + primary CTA). */
  footer?: ReactNode
  /** `md` = form/column steps; `lg` = card-grid steps (runtimes). */
  size?: 'md' | 'lg'
  align?: 'left' | 'center'
  testId?: string
}

export function OnboardingScreen({
  step,
  steps,
  eyebrow,
  title,
  subtitle,
  children,
  footer,
  size = 'md',
  align = 'left',
  testId,
}: OnboardingScreenProps) {
  const maxW = size === 'lg' ? 'max-w-3xl' : 'max-w-[480px]'
  const alignCls = align === 'center' ? 'items-center text-center' : 'items-start text-left'

  return (
    <div
      data-testid={testId}
      className="relative flex min-h-screen w-full flex-col items-center px-6"
    >
      <div className={['flex w-full flex-1 flex-col pt-[11vh] pb-12', maxW].join(' ')}>
        <header className={['flex flex-col', alignCls].join(' ')}>
          {eyebrow ? (
            <div
              className="mb-3.5 font-mono text-[11px] font-semibold uppercase tracking-[0.16em]"
              style={{ color: 'var(--primary)' }}
            >
              {eyebrow}
            </div>
          ) : null}
          <h1
            className="font-display text-[31px] leading-[1.05] sm:text-[41px]"
            style={{ color: 'var(--foreground)', fontWeight: 800, letterSpacing: '-0.022em' }}
          >
            {title}
          </h1>
          {subtitle ? (
            <p
              className="mt-3 max-w-[42ch] text-[15px] leading-relaxed"
              style={{ color: muted(0.55) }}
            >
              {subtitle}
            </p>
          ) : null}
        </header>

        {children ? <div className="mt-9">{children}</div> : null}

        {footer ? <div className="mt-9">{footer}</div> : null}
      </div>

      {step ? <StepDots current={step} steps={steps} className="mt-auto pb-10" /> : null}
    </div>
  )
}

// ── Buttons ────────────────────────────────────────────────────────────────

export interface OnboardingButtonProps {
  children: ReactNode
  onClick?: () => void
  disabled?: boolean
  type?: 'button' | 'submit'
  testId?: string
  className?: string
  'aria-label'?: string
}

/** Brand-red pill primary CTA — the confident forward action of each step. */
export function OnboardingPrimary({
  children,
  onClick,
  disabled,
  type = 'button',
  testId,
  className = '',
  'aria-label': ariaLabel,
}: OnboardingButtonProps) {
  return (
    <button
      type={type}
      data-testid={testId}
      aria-label={ariaLabel}
      onClick={onClick}
      disabled={disabled}
      className={[
        'inline-flex items-center justify-center gap-2 rounded-xl px-5 py-3 text-[15px] font-semibold',
        'bg-primary text-primary-foreground transition-[filter,transform] duration-150',
        'hover:brightness-[1.06] active:scale-[0.985]',
        'disabled:pointer-events-none disabled:opacity-45',
        className,
      ].join(' ')}
      style={{
        cursor: disabled ? 'not-allowed' : 'pointer',
        boxShadow:
          '0 1px 2px rgb(var(--primary-rgb) / 0.32), 0 8px 20px rgb(var(--primary-rgb) / 0.24)',
      }}
    >
      {children}
    </button>
  )
}

/** Quiet text button — Back / Skip. */
export function OnboardingGhost({
  children,
  onClick,
  disabled,
  type = 'button',
  testId,
  className = '',
  'aria-label': ariaLabel,
}: OnboardingButtonProps) {
  return (
    <button
      type={type}
      data-testid={testId}
      aria-label={ariaLabel}
      onClick={onClick}
      disabled={disabled}
      className={[
        'inline-flex items-center gap-1.5 rounded-lg px-2 py-1.5 text-[14px] font-medium',
        'text-foreground/50 transition-colors hover:text-foreground/90',
        'disabled:pointer-events-none disabled:opacity-40',
        className,
      ].join(' ')}
      style={{ cursor: disabled ? 'not-allowed' : 'pointer' }}
    >
      {children}
    </button>
  )
}
