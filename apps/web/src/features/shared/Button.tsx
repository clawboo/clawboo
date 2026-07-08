// The app-wide button primitive. One place for every button treatment so the
// whole product stays consistent and premium.
//
//   variant: primary  — brand-red filled pill (the forward action of a screen)
//            solid     — near-black (light) / white (dark) filled (strong neutral)
//            secondary — surface + hairline border (default neutral action)
//            outline   — transparent + border
//            ghost     — transparent, hover wash
//            danger    — destructive red
//   size:    sm | md | lg
//
// Icons: pass lucide icons as children alongside the label; use `loading` for
// an inline spinner. `IconButton` is the square icon-only variant.

import type { ButtonHTMLAttributes, ReactNode } from 'react'

import { Spinner } from './Spinner'

export type ButtonVariant = 'primary' | 'solid' | 'secondary' | 'outline' | 'ghost' | 'danger'
export type ButtonSize = 'sm' | 'md' | 'lg'

const SIZE: Record<ButtonSize, string> = {
  sm: 'h-8 gap-1.5 rounded-lg px-3 text-[13px]',
  md: 'h-9 gap-2 rounded-lg px-3.5 text-[13.5px]',
  lg: 'h-11 gap-2 rounded-xl px-5 text-[15px]',
}

const BASE =
  'inline-flex shrink-0 select-none items-center justify-center font-medium ' +
  'transition-[background-color,box-shadow,filter,transform,border-color] duration-150 ' +
  'active:scale-[0.98] disabled:pointer-events-none disabled:opacity-45 ' +
  'focus-visible:outline-2 focus-visible:outline-offset-2 whitespace-nowrap'

function variantClasses(variant: ButtonVariant): string {
  switch (variant) {
    case 'primary':
      return 'bg-primary text-primary-foreground font-semibold shadow-[0_1px_2px_rgb(var(--primary-rgb)/0.3),0_6px_16px_rgb(var(--primary-rgb)/0.2)] hover:brightness-[1.06]'
    case 'solid':
      return 'bg-foreground text-background font-semibold shadow-[var(--shadow-raised)] hover:brightness-110 dark:hover:brightness-95'
    case 'secondary':
      return 'bg-surface text-foreground border border-border shadow-[var(--shadow-raised)] hover:border-border-strong hover:bg-foreground/[0.02]'
    case 'outline':
      return 'text-foreground border border-border hover:border-border-strong hover:bg-foreground/[0.03]'
    case 'ghost':
      return 'text-foreground/70 hover:text-foreground hover:bg-foreground/[0.06]'
    case 'danger':
      return 'bg-destructive text-destructive-foreground font-semibold shadow-[var(--shadow-raised)] hover:brightness-105'
  }
}

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant
  size?: ButtonSize
  loading?: boolean
  fullWidth?: boolean
}

export function Button({
  variant = 'secondary',
  size = 'md',
  loading = false,
  fullWidth = false,
  disabled,
  className = '',
  children,
  type = 'button',
  ...rest
}: ButtonProps) {
  return (
    <button
      type={type}
      disabled={disabled || loading}
      className={[
        BASE,
        SIZE[size],
        variantClasses(variant),
        fullWidth ? 'w-full' : '',
        'cursor-pointer',
        className,
      ].join(' ')}
      {...rest}
    >
      {loading ? <Spinner size={size === 'lg' ? 16 : 14} /> : null}
      {children}
    </button>
  )
}

export interface IconButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant
  size?: ButtonSize
  label: string
  children: ReactNode
}

const ICON_SIZE: Record<ButtonSize, string> = {
  sm: 'h-7 w-7 rounded-lg',
  md: 'h-9 w-9 rounded-lg',
  lg: 'h-11 w-11 rounded-xl',
}

export function IconButton({
  variant = 'ghost',
  size = 'md',
  label,
  className = '',
  children,
  type = 'button',
  ...rest
}: IconButtonProps) {
  return (
    <button
      type={type}
      aria-label={label}
      title={label}
      className={[
        BASE,
        ICON_SIZE[size],
        variantClasses(variant),
        'cursor-pointer p-0',
        className,
      ].join(' ')}
      {...rest}
    >
      {children}
    </button>
  )
}
