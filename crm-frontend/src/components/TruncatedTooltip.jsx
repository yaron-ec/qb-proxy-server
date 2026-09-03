/**
 * TruncatedTooltip — wraps any text element and shows a tooltip with the full
 * value only when the text is actually overflowing (desktop hover) or on
 * long-press (mobile).
 *
 * The tooltip automatically repositions to stay fully within the viewport.
 *
 * Usage:
 *   <TruncatedTooltip text="A very long name that gets cut off">
 *     <span className="truncate">{name}</span>
 *   </TruncatedTooltip>
 *
 * Or without children (renders a <span> automatically):
 *   <TruncatedTooltip text={name} className="truncate block text-sm font-semibold" />
 */
import { useRef, useState, useLayoutEffect } from "react";

const TOOLTIP_MAX_WIDTH = 280;
const TOOLTIP_EST_HEIGHT = 36;
const VIEWPORT_MARGIN = 8;

export default function TruncatedTooltip({ text, children, className = "", as: As = "span", delayMs = 300 }) {
  const Tag = As;
  const ref = useRef(null);
  const tipRef = useRef(null);
  const [visible, setVisible] = useState(false);
  const [pos, setPos] = useState({ left: 0, top: 0 });
  const timerRef = useRef(null);
  const longPressTimer = useRef(null);

  const isOverflowing = () => {
    const el = ref.current;
    if (!el) return false;
    return el.scrollWidth > el.clientWidth + 1;
  };

  // Reposition tooltip to stay within viewport whenever it becomes visible
  useLayoutEffect(() => {
    if (!visible) return;
    const el = ref.current;
    const tip = tipRef.current;
    if (!el || !tip) return;

    const rect = el.getBoundingClientRect();
    const tipRect = tip.getBoundingClientRect();
    const vw = window.innerWidth;
    const vh = window.innerHeight;

    // Default: tooltip below the element, left-aligned to element's left edge
    let left = rect.left;
    let top = rect.bottom + 4;

    // If tooltip would overflow right, shift left (or flip to right-aligned)
    if (left + tipRect.width > vw - VIEWPORT_MARGIN) {
      left = Math.max(VIEWPORT_MARGIN, rect.right - tipRect.width);
    }
    // If still overflowing after shift, clamp to viewport
    left = Math.min(left, vw - tipRect.width - VIEWPORT_MARGIN);
    left = Math.max(left, VIEWPORT_MARGIN);

    // If tooltip would overflow bottom, show above the element instead
    if (top + tipRect.height > vh - VIEWPORT_MARGIN) {
      top = rect.top - tipRect.height - 4;
    }
    // If above also overflows, clamp to viewport top
    top = Math.max(top, VIEWPORT_MARGIN);

    setPos({ left, top });
  }, [visible]);

  const handleMouseEnter = () => {
    timerRef.current = setTimeout(() => {
      if (isOverflowing()) setVisible(true);
    }, delayMs);
  };

  const handleMouseLeave = () => {
    clearTimeout(timerRef.current);
    setVisible(false);
  };

  // Mobile long-press support
  const handleTouchStart = () => {
    longPressTimer.current = setTimeout(() => {
      if (isOverflowing()) setVisible(true);
    }, 500);
  };

  const handleTouchEnd = () => {
    clearTimeout(longPressTimer.current);
    setVisible(false);
  };

  const sharedHandlers = {
    onMouseEnter: handleMouseEnter,
    onMouseLeave: handleMouseLeave,
    onTouchStart: handleTouchStart,
    onTouchEnd: handleTouchEnd,
    onTouchCancel: handleTouchEnd,
  };

  const el = children ? (
    <Tag ref={ref} className={className} {...sharedHandlers}>
      {children}
    </Tag>
  ) : (
    <Tag ref={ref} className={`truncate block ${className}`} {...sharedHandlers}>
      {text}
    </Tag>
  );

  return (
    <>
      {el}
      {visible && text && (
        <div
          ref={tipRef}
          className="fixed z-[9999] pointer-events-none"
          style={{ left: pos.left, top: pos.top, maxWidth: TOOLTIP_MAX_WIDTH }}
        >
          <div className="bg-slate-900 text-white text-xs px-3 py-1.5 rounded-lg shadow-xl break-words leading-snug border border-white/10">
            {text}
          </div>
        </div>
      )}
    </>
  );
}