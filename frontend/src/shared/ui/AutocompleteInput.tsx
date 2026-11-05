import {
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type InputHTMLAttributes,
} from "react";
import { Check, ChevronDown } from "lucide-react";
import type { SelectMenuOption } from "./SelectMenu";

type Props = Omit<
  InputHTMLAttributes<HTMLInputElement>,
  "value" | "onChange" | "list" | "type" | "aria-label"
> & {
  value: string;
  onChange: (value: string) => void;
  options: SelectMenuOption[];
  ariaLabel: string;
  suggestionsLabel: string;
};

/** An editable field whose suggestions share the application's select menu styles. */
export function AutocompleteInput({
  value,
  onChange,
  options,
  ariaLabel,
  suggestionsLabel,
  disabled,
  ...inputProps
}: Props) {
  const id = useId(),
    root = useRef<HTMLDivElement>(null),
    input = useRef<HTMLInputElement>(null);
  const [open, setOpen] = useState(false),
    [all, setAll] = useState(true),
    [active, setActive] = useState<number | null>(null);
  const [placement, setPlacement] = useState({ above: false, height: 280 });
  const query = value.trim().toLocaleLowerCase();
  const filtered = all
    ? options
    : options.filter((option) =>
        `${option.label} ${option.value}`.toLocaleLowerCase().includes(query),
      );
  const expanded = open && !disabled && filtered.length > 0;
  const index = active != null && active < filtered.length ? active : null;
  const close = () => {
    setOpen(false);
    setActive(null);
  };
  const choose = (next: string) => {
    onChange(next);
    close();
    input.current?.focus();
  };

  useEffect(() => {
    const outside = (event: PointerEvent) => {
      if (!root.current?.contains(event.target as Node)) {
        setOpen(false);
        setActive(null);
      }
    };
    document.addEventListener("pointerdown", outside);
    return () => document.removeEventListener("pointerdown", outside);
  }, []);
  useEffect(() => {
    if (!expanded) return;
    const escape = (event: KeyboardEvent) => {
      if (
        event.key !== "Escape" ||
        !root.current?.contains(event.target as Node)
      )
        return;
      event.preventDefault();
      event.stopPropagation();
      input.current?.focus();
      setOpen(false);
      setActive(null);
    };
    window.addEventListener("keydown", escape, true);
    return () => window.removeEventListener("keydown", escape, true);
  }, [expanded]);
  useLayoutEffect(() => {
    if (!expanded || !root.current) return;
    const measure = () => {
      if (!root.current) return;
      const rect = root.current.getBoundingClientRect();
      let top = 8,
        bottom = window.innerHeight - 8;
      for (
        let ancestor = root.current.parentElement;
        ancestor && ancestor !== document.body;
        ancestor = ancestor.parentElement
      ) {
        if (
          /(auto|scroll|hidden|clip)/.test(getComputedStyle(ancestor).overflowY)
        ) {
          const bounds = ancestor.getBoundingClientRect();
          top = Math.max(top, bounds.top + ancestor.clientTop + 5);
          bottom = Math.min(
            bottom,
            bounds.top + ancestor.clientTop + ancestor.clientHeight - 5,
          );
        }
      }
      const below = bottom - rect.bottom - 6,
        above = rect.top - top - 6;
      const upward =
        below < Math.min(160, filtered.length * 42 + 12) && above > below;
      setPlacement({
        above: upward,
        height: Math.max(40, Math.min(280, upward ? above : below)),
      });
    };
    measure();
    window.addEventListener("resize", measure);
    return () => window.removeEventListener("resize", measure);
  }, [expanded, filtered.length]);
  useEffect(() => {
    if (expanded && index != null)
      root.current
        ?.querySelector(`[id="${id}-${index}"]`)
        ?.scrollIntoView?.({ block: "nearest" });
  }, [expanded, index, id]);

  return (
    <div
      ref={root}
      className={`select-menu autocomplete-input ${expanded ? "is-open" : ""}`}
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node)) close();
      }}
    >
      <div className="select-menu-trigger autocomplete-trigger">
        <input
          {...inputProps}
          ref={input}
          className="autocomplete-input-control"
          value={value}
          disabled={disabled}
          role="combobox"
          aria-label={ariaLabel}
          aria-expanded={expanded}
          aria-controls={expanded ? id : undefined}
          aria-autocomplete="list"
          aria-activedescendant={
            expanded && index != null ? `${id}-${index}` : undefined
          }
          autoComplete="off"
          onFocus={() => {
            setAll(true);
            setOpen(true);
          }}
          onChange={(event) => {
            onChange(event.target.value);
            setAll(false);
            setOpen(true);
            setActive(null);
          }}
          onKeyDown={(event) => {
            if (event.nativeEvent.isComposing) return;
            if (event.key === "Escape" && expanded) {
              event.preventDefault();
              event.stopPropagation();
              close();
              return;
            }
            if (event.key === "Tab") {
              close();
              return;
            }
            if (event.key === "Enter" && expanded && index != null) {
              event.preventDefault();
              choose(filtered[index].value);
              return;
            }
            if (
              ["ArrowDown", "ArrowUp"].includes(event.key) &&
              options.length
            ) {
              event.preventDefault();
              if (!expanded) {
                setAll(true);
                setOpen(true);
                setActive(event.key === "ArrowDown" ? 0 : options.length - 1);
              } else
                setActive(
                  index == null
                    ? event.key === "ArrowDown"
                      ? 0
                      : filtered.length - 1
                    : (index +
                        (event.key === "ArrowDown" ? 1 : -1) +
                        filtered.length) %
                        filtered.length,
                );
            } else if (
              expanded &&
              index != null &&
              ["Home", "End"].includes(event.key)
            ) {
              event.preventDefault();
              setActive(event.key === "Home" ? 0 : filtered.length - 1);
            }
          }}
        />
        <button
          className="autocomplete-toggle"
          type="button"
          aria-label={suggestionsLabel}
          aria-expanded={expanded}
          aria-controls={expanded ? id : undefined}
          disabled={disabled || !options.length}
          onMouseDown={(event) => event.preventDefault()}
          onClick={() => {
            input.current?.focus();
            setAll(true);
            setOpen(!expanded);
            setActive(null);
          }}
        >
          <ChevronDown size={15} aria-hidden="true" />
        </button>
      </div>
      {expanded && (
        <div
          id={id}
          role="listbox"
          aria-label={ariaLabel}
          className="select-menu-popover autocomplete-menu"
          style={{
            top: placement.above ? "auto" : "calc(100% + 6px)",
            bottom: placement.above ? "calc(100% + 6px)" : "auto",
            maxHeight: placement.height,
          }}
        >
          {filtered.map((option, i) => (
            <button
              key={option.value}
              id={`${id}-${i}`}
              type="button"
              role="option"
              tabIndex={-1}
              aria-selected={option.value === value}
              className={`select-menu-option ${option.value === value ? "is-selected" : ""} ${i === index ? "is-highlighted" : ""}`}
              onMouseDown={(event) => event.preventDefault()}
              onMouseEnter={() => setActive(i)}
              onClick={() => choose(option.value)}
            >
              <span>
                {option.label}
                {option.label !== option.value && <small>{option.value}</small>}
              </span>
              {option.value === value && <Check size={14} aria-hidden="true" />}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
