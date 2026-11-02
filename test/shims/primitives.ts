/**
 * A minimal stand-in for the shell-seeded component library, so the shipped
 * client bundle can be loaded outside the app. Only the props this plugin
 * passes are implemented; the real library supplies the styling in the app.
 * @module cyberself/test/shims/primitives
 */
import { createElement, type ChangeEvent, type KeyboardEvent, type ReactNode } from 'react'

/** Props this plugin hands to `Button`. */
interface ButtonProps {
  variant?: string
  size?: string
  disabled?: boolean
  type?: 'button' | 'submit'
  title?: string
  onClick?: () => void
  children?: ReactNode
}

/** Props this plugin hands to `Input`. */
interface InputProps {
  value?: string
  placeholder?: string
  list?: string
  onChange?: (event: ChangeEvent<HTMLInputElement>) => void
  onKeyDown?: (event: KeyboardEvent<HTMLInputElement>) => void
}

export function Button(props: ButtonProps): ReactNode {
  return createElement(
    'button',
    {
      'data-variant': props.variant ?? 'ghost',
      'data-size': props.size ?? 'sm',
      'type': props.type ?? 'button',
      'title': props.title,
      'disabled': props.disabled,
      'onClick': props.onClick,
    },
    props.children,
  )
}

export function Input(props: InputProps): ReactNode {
  return createElement('input', {
    'value': props.value,
    'placeholder': props.placeholder,
    'list': props.list,
    'onChange': props.onChange,
    'onKeyDown': props.onKeyDown,
  })
}

/** Props this plugin hands to `SegmentedControl`. */
interface SegmentedControlProps<Value extends string> {
  id?: string
  value: Value
  options: readonly { value: Value; label: string }[]
  onChange?: (value: Value) => void
}

export function SegmentedControl<Value extends string>(props: SegmentedControlProps<Value>): ReactNode {
  return createElement(
    'div',
    { 'data-segmented': props.id ?? '' },
    props.options.map((option) => createElement(
      'button',
      {
        'key': option.value,
        'type': 'button',
        'data-value': option.value,
        'aria-pressed': option.value === props.value,
        'onClick': () => { props.onChange?.(option.value) },
      },
      option.label,
    )),
  )
}

export function MarkdownText(props: { text: string; streaming?: boolean; variant?: string }): ReactNode {
  return createElement('div', { 'data-markdown': props.variant ?? 'body' }, props.text)
}
