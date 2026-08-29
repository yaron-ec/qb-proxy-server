import { useToast } from "@/components/ui/use-toast";
import {
  Toast,
  ToastClose,
  ToastDescription,
  ToastProvider,
  ToastTitle,
  ToastViewport,
} from "@/components/ui/toast";
import { X } from "lucide-react";

export function Toaster() {
  const { toasts, dismiss, clearAll } = useToast();

  return (
    <ToastProvider>
      {toasts.map(function ({ id, title, description, action, open, ...props }) {
        return (
          <Toast key={id} data-state={open ? "open" : "closed"} {...props}>
            <div className="grid gap-1 flex-1">
              {title && <ToastTitle>{title}</ToastTitle>}
              {description && (
                <ToastDescription>{description}</ToastDescription>
              )}
            </div>
            {action}
            <button
              onClick={() => dismiss(id)}
              className="absolute right-2 top-2 rounded-md p-1 text-foreground/50 opacity-0 transition-opacity hover:text-foreground focus:opacity-100 focus:outline-none focus:ring-2 group-hover:opacity-100"
              aria-label="Close notification"
            >
              <X className="h-4 w-4" />
            </button>
          </Toast>
        );
      })}
      
      {toasts.length > 0 && (
        <button
          onClick={clearAll}
          className="fixed bottom-4 right-4 text-xs font-semibold text-slate-500 hover:text-slate-700 bg-white border border-slate-200 rounded px-3 py-1.5 hover:bg-slate-50 transition-colors z-50"
          aria-label="Clear all notifications"
        >
          Clear All
        </button>
      )}
      
      <ToastViewport />
    </ToastProvider>
  );
}