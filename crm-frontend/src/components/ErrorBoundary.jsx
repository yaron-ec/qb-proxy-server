import { Component } from "react";
import { AlertTriangle, RefreshCw } from "lucide-react";

/**
 * ErrorBoundary — generic React error boundary.
 *
 * Production defect this exists for: Lead Detail had NO error boundary
 * anywhere above it, so a single uncaught render exception (e.g. a mutation
 * handler setting state shaped in a way a child component couldn't render)
 * unmounted the ENTIRE page — a blank white screen with the URL unchanged
 * and no way back except a manual reload. React's default behavior for an
 * uncaught render error with no boundary is to unmount the whole tree; this
 * catches it at whatever level it's placed and shows a recoverable fallback
 * instead, so the rest of the app (nav, sidebar) and the user's ability to
 * retry are never destroyed by one bad render.
 *
 * `resetKey`: when it changes (e.g. the lead id in the route), the boundary
 * clears itself so navigating to a different record isn't permanently stuck
 * in the fallback from an earlier one.
 */
export default class ErrorBoundary extends Component {
  constructor(props) {
    super(props);
    this.state = { hasError: false, error: null };
  }

  static getDerivedStateFromError(error) {
    return { hasError: true, error };
  }

  componentDidCatch(error, info) {
    console.error(`[ErrorBoundary${this.props.name ? `:${this.props.name}` : ''}]`, error, info?.componentStack);
  }

  componentDidUpdate(prevProps) {
    if (this.state.hasError && prevProps.resetKey !== this.props.resetKey) {
      this.setState({ hasError: false, error: null });
    }
  }

  handleRetry = () => this.setState({ hasError: false, error: null });

  render() {
    if (this.state.hasError) {
      if (this.props.fallback) return this.props.fallback(this.state.error, this.handleRetry);
      return (
        <div className="flex flex-col items-center justify-center gap-3 py-16 px-6 text-center">
          <AlertTriangle className="w-8 h-8 text-amber-500" />
          <p className="text-sm font-semibold text-slate-700">Something went wrong displaying this page.</p>
          <p className="text-xs text-slate-500 max-w-md">
            {this.props.userMessage || 'An unexpected error occurred. Your data was not lost — try again, or reload the page.'}
          </p>
          <button
            onClick={this.handleRetry}
            className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold text-white bg-amber-600 hover:bg-amber-700 rounded transition-colors"
          >
            <RefreshCw className="w-3.5 h-3.5" /> Try again
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}
