import { forwardRef, useState, useId } from 'react'
import styles from './Input.module.css'

interface InputProps extends Omit<React.InputHTMLAttributes<HTMLInputElement>, 'size' | 'prefix'> {
  label?: string
  error?: string
  hint?: string
  prefix?: React.ReactNode
  suffix?: React.ReactNode
  size?: 'sm' | 'md'
}

const Input = forwardRef<HTMLInputElement, InputProps>(({
  label,
  error,
  hint,
  prefix,
  suffix,
  size = 'md',
  className,
  onFocus,
  onBlur,
  ...props
}, ref) => {
  const id = useId()
  const [focused, setFocused] = useState(false)
  const hasValue = Boolean(props.value || props.defaultValue)
  const floatLabel = focused || hasValue || Boolean(props.placeholder)

  return (
    <div className={[styles.wrapper, className].filter(Boolean).join(' ')}>
      <div className={[
        styles.field,
        styles[size],
        focused ? styles.focused : '',
        error ? styles.hasError : '',
      ].filter(Boolean).join(' ')}>
        {prefix && <span className={styles.prefix}>{prefix}</span>}

        <div className={styles.inputWrap}>
          {label && (
            <label
              htmlFor={id}
              className={[styles.label, floatLabel ? styles.floated : ''].filter(Boolean).join(' ')}
            >
              {label}
            </label>
          )}
          <input
            ref={ref}
            id={id}
            className={styles.input}
            onFocus={e => { setFocused(true); onFocus?.(e) }}
            onBlur={e => { setFocused(false); onBlur?.(e) }}
            {...props}
          />
        </div>

        {suffix && <span className={styles.suffix}>{suffix}</span>}
      </div>

      {error && <p className={styles.error} role="alert">{error}</p>}
      {hint && !error && <p className={styles.hint}>{hint}</p>}
    </div>
  )
})

Input.displayName = 'Input'
export default Input
