import { ThemeProvider } from "@/app/theme/ThemeProvider";
import { ToastProvider } from "@/core/shared/components/Toast";
import { ErrorBoundary } from "@/app/ErrorBoundary";
import { AppRouter } from "@/app/router";

export default function App() {
  return (
    <ThemeProvider>
      <ToastProvider>
        <ErrorBoundary>
          <AppRouter />
        </ErrorBoundary>
      </ToastProvider>
    </ThemeProvider>
  );
}
