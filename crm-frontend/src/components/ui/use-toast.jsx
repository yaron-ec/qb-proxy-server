// Toast system with auto-dismiss, deduplication, max 3 visible, smooth animations
import { useState, useEffect } from "react";

const TOAST_MAX_VISIBLE = 3;
const ANIMATION_DELAY = 500; // ms for fade-out before removal

const actionTypes = {
  ADD_TOAST: "ADD_TOAST",
  UPDATE_TOAST: "UPDATE_TOAST",
  DISMISS_TOAST: "DISMISS_TOAST",
  REMOVE_TOAST: "REMOVE_TOAST",
  CLEAR_ALL: "CLEAR_ALL",
};

let count = 0;

function genId() {
  count = (count + 1) % Number.MAX_VALUE;
  return count.toString();
}

const toastTimers = new Map(); // maps toastId -> { dismissTimer, removeTimer }

const scheduleAutoDismiss = (toastId, variant) => {
  let delay = 5000; // default: 5s
  if (variant === "destructive") delay = 0; // manual only
  else if (String(variant).includes("warning")) delay = 8000;

  if (delay > 0) {
    const timer = setTimeout(() => {
      dispatch({ type: actionTypes.DISMISS_TOAST, toastId });
    }, delay);
    
    const existing = toastTimers.get(toastId) || {};
    toastTimers.set(toastId, { ...existing, dismissTimer: timer });
  }
};

const clearAutoTimers = (toastId) => {
  const timers = toastTimers.get(toastId);
  if (timers) {
    if (timers.dismissTimer) clearTimeout(timers.dismissTimer);
    if (timers.removeTimer) clearTimeout(timers.removeTimer);
    toastTimers.delete(toastId);
  }
};

export const reducer = (state, action) => {
  switch (action.type) {
    case actionTypes.ADD_TOAST: {
      const newToast = action.toast;
      const dedup = state.toasts.find(t => t.dedup_key && t.dedup_key === newToast.dedup_key);
      
      if (dedup) {
        // Update existing toast instead of creating new one
        return {
          ...state,
          toasts: state.toasts.map(t =>
            t.id === dedup.id
              ? { ...dedup, ...newToast, id: dedup.id, open: true }
              : t
          ),
        };
      }

      // Prepend new toast and keep only most recent TOAST_MAX_VISIBLE
      return {
        ...state,
        toasts: [newToast, ...state.toasts].slice(0, TOAST_MAX_VISIBLE),
      };
    }

    case actionTypes.UPDATE_TOAST:
      return {
        ...state,
        toasts: state.toasts.map((t) =>
          t.id === action.toast.id ? { ...t, ...action.toast } : t
        ),
      };

    case actionTypes.DISMISS_TOAST: {
      const { toastId } = action;
      clearAutoTimers(toastId);

      // Mark as closed and schedule removal after animation
      const updated = state.toasts.map((t) =>
        t.id === toastId ? { ...t, open: false } : t
      );

      if (toastId) {
        const timer = setTimeout(() => {
          dispatch({
            type: actionTypes.REMOVE_TOAST,
            toastId,
          });
        }, ANIMATION_DELAY);
        
        const existing = toastTimers.get(toastId) || {};
        toastTimers.set(toastId, { ...existing, removeTimer: timer });
      }

      return { ...state, toasts: updated };
    }

    case actionTypes.REMOVE_TOAST:
      clearAutoTimers(action.toastId);
      return {
        ...state,
        toasts: state.toasts.filter((t) => t.id !== action.toastId),
      };

    case actionTypes.CLEAR_ALL:
      state.toasts.forEach(t => clearAutoTimers(t.id));
      return { ...state, toasts: [] };

    default:
      return state;
  }
};

const listeners = [];

let memoryState = { toasts: [] };

function dispatch(action) {
  memoryState = reducer(memoryState, action);
  listeners.forEach((listener) => {
    listener(memoryState);
  });
}

function toast({ dedup_key, variant = "default", ...props }) {
  const id = genId();

  const update = (props) =>
    dispatch({
      type: actionTypes.UPDATE_TOAST,
      toast: { ...props, id },
    });

  const dismiss = () =>
    dispatch({ type: actionTypes.DISMISS_TOAST, toastId: id });

  dispatch({
    type: actionTypes.ADD_TOAST,
    toast: {
      ...props,
      id,
      dedup_key,
      variant,
      open: true,
      onOpenChange: (open) => {
        if (!open) dismiss();
      },
    },
  });

  // Schedule auto-dismiss based on variant
  scheduleAutoDismiss(id, variant);

  return {
    id,
    dismiss,
    update,
  };
}

function useToast() {
  const [state, setState] = useState(memoryState);

  useEffect(() => {
    listeners.push(setState);
    return () => {
      const index = listeners.indexOf(setState);
      if (index > -1) {
        listeners.splice(index, 1);
      }
    };
  }, [state]);

  const clearAll = () => dispatch({ type: actionTypes.CLEAR_ALL });

  return {
    ...state,
    toast,
    dismiss: (toastId) => dispatch({ type: actionTypes.DISMISS_TOAST, toastId }),
    clearAll,
  };
}

export { useToast, toast };