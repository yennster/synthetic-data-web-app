import { Component, type ErrorInfo, type ReactNode } from 'react';

/**
 * React error boundary. Without one, an uncaught render error (most
 * commonly a WebGL / WASM initialization failure inside the lazy-loaded
 * Scene on iOS Safari) unmounts the entire tree and the user is left
 * staring at the dark body background — the "big black screen"
 * regression. Wrapping the app (and the Scene specifically) means a
 * failure surfaces as a readable message instead.
 *
 * Static fallback content only — no hooks, no store reads. The store
 * itself may be the thing that threw.
 */
type Props = {
  children: ReactNode;
  /** Short label for the boundary's scope, e.g. "Scene" or "App". */
  scope?: string;
  /** Optional custom fallback. Receives the caught error. */
  fallback?: (error: Error, reset: () => void) => ReactNode;
};

type State = { error: Error | null };

export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error(
      `[ErrorBoundary${this.props.scope ? `:${this.props.scope}` : ''}]`,
      error,
      info,
    );
  }

  private reset = (): void => {
    this.setState({ error: null });
  };

  render(): ReactNode {
    const { error } = this.state;
    if (!error) return this.props.children;
    if (this.props.fallback) return this.props.fallback(error, this.reset);
    return (
      <div className="error-fallback" role="alert">
        <div className="error-fallback-inner">
          <h1>Something went wrong</h1>
          <p>
            {this.props.scope === 'Scene'
              ? 'The 3D scene failed to start. This is usually a WebGL or memory limit on the current browser — try a desktop browser, or close other tabs and reload.'
              : 'The app hit an unexpected error. Reload to try again.'}
          </p>
          <pre>{error.message || String(error)}</pre>
          <div className="error-fallback-actions">
            <button
              type="button"
              className="primary"
              onClick={() => window.location.reload()}
            >
              Reload
            </button>
            <button type="button" onClick={this.reset}>
              Dismiss
            </button>
          </div>
        </div>
      </div>
    );
  }
}
