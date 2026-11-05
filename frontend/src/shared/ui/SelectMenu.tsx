import { useEffect, useId, useRef, useState } from "react";
import { Check, ChevronDown } from "lucide-react";

export type SelectMenuOption = { value: string; label: string };

type SelectMenuProps = {
  value?: string;
  defaultValue?: string;
  options: SelectMenuOption[];
  onChange?: (value: string) => void;
  ariaLabel?: string;
  className?: string;
  disabled?: boolean;
};

export function SelectMenu({
  value,
  defaultValue,
  options,
  onChange,
  ariaLabel,
  className = "",
  disabled = false,
}: SelectMenuProps) {
  const id = useId();
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  const [internalValue, setInternalValue] = useState(
    defaultValue ?? options[0]?.value ?? "",
  );
  const selectedValue = value ?? internalValue;
  const selected =
    options.find((option) => option.value === selectedValue) ?? options[0];

  useEffect(() => {
    const close = (event: PointerEvent) => {
      if (rootRef.current && !rootRef.current.contains(event.target as Node))
        setOpen(false);
    };
    document.addEventListener("pointerdown", close);
    return () => document.removeEventListener("pointerdown", close);
  }, []);

  useEffect(() => {
    if (open) {
      const selectedOption = rootRef.current?.querySelector<HTMLButtonElement>(
        '[role="option"][aria-selected="true"]',
      );
      (
        selectedOption ??
        rootRef.current?.querySelector<HTMLButtonElement>('[role="option"]')
      )?.focus();
    }
  }, [open]);

  useEffect(() => {
    if (!open) return;
    // Dialog handles Escape during document capture; close this menu first.
    const escape = (event: KeyboardEvent) => {
      if (
        event.key !== "Escape" ||
        !rootRef.current?.contains(event.target as Node)
      )
        return;
      event.preventDefault();
      event.stopPropagation();
      setOpen(false);
      triggerRef.current?.focus();
    };
    window.addEventListener("keydown", escape, true);
    return () => window.removeEventListener("keydown", escape, true);
  }, [open]);

  const choose = (nextValue: string) => {
    if (value === undefined) setInternalValue(nextValue);
    onChange?.(nextValue);
    setOpen(false);
    triggerRef.current?.focus();
  };

  return (
    <div
      ref={rootRef}
      className={`select-menu ${open ? "is-open" : ""} ${className}`}
      onKeyDown={(event) => {
        if (event.key === "Escape" && open) {
          event.preventDefault();
          event.stopPropagation();
          setOpen(false);
          triggerRef.current?.focus();
          return;
        }
        if (event.key === "Tab") {
          setOpen(false);
          return;
        }
        if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key))
          return;
        event.preventDefault();
        if (!open) {
          setOpen(true);
          return;
        }
        const buttons = [
          ...(rootRef.current?.querySelectorAll<HTMLButtonElement>(
            '[role="option"]',
          ) ?? []),
        ];
        const index = buttons.findIndex(
          (button) => button === document.activeElement,
        );
        const next =
          event.key === "Home"
            ? 0
            : event.key === "End"
              ? buttons.length - 1
              : (index +
                  (event.key === "ArrowDown" ? 1 : -1) +
                  buttons.length) %
                buttons.length;
        buttons[next]?.focus();
      }}
    >
      <button
        ref={triggerRef}
        className="select-menu-trigger"
        type="button"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={id}
        aria-label={ariaLabel}
        disabled={disabled}
        onClick={() => setOpen((current) => !current)}
      >
        <span>{selected?.label ?? "—"}</span>
        <ChevronDown size={15} aria-hidden="true" />
      </button>
      {open && (
        <div
          id={id}
          className="select-menu-popover"
          role="listbox"
          aria-label={ariaLabel}
        >
          {options.map((option) => (
            <button
              className={`select-menu-option ${option.value === selectedValue ? "is-selected" : ""}`}
              type="button"
              role="option"
              aria-selected={option.value === selectedValue}
              key={option.value}
              onClick={() => choose(option.value)}
            >
              <span>{option.label}</span>
              {option.value === selectedValue && (
                <Check size={14} aria-hidden="true" />
              )}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
