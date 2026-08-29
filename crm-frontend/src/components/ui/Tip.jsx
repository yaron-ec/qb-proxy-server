/**
 * Tip — lightweight one-liner tooltip wrapper using the existing Radix UI tooltip.
 *
 * Usage:
 *   <Tip label="Delete this item">
 *     <button ...><Trash2 /></button>
 *   </Tip>
 *
 * Props:
 *   label    — string shown in the tooltip
 *   side     — "top" | "right" | "bottom" | "left" (default "top")
 *   delay    — open delay in ms (default 400)
 *   children — trigger element
 */
import { Tooltip, TooltipTrigger, TooltipContent } from "@/components/ui/tooltip";

export default function Tip({ label, side = "right", delay = 350, children }) {
  if (!label) return children;
  return (
    <Tooltip delayDuration={delay}>
      <TooltipTrigger asChild>{children}</TooltipTrigger>
      <TooltipContent side={side}>
        {label}
      </TooltipContent>
    </Tooltip>
  );
}