import React from "react";
import logo from "../../assets/flower_1024.png";

export interface PipelineProgress {
  current: number;
  total: number;
  detail: string;
}

interface LoadingStateProps {
  message?: string;
  hint?: string;
  progress?: PipelineProgress | null;
}

export const LoadingState: React.FC<LoadingStateProps> = ({
  message = "Processing...",
  hint = "This may take a moment depending on your library size.",
  progress = null
}) => {
  const pct = progress && progress.total > 0
    ? Math.round((progress.current / progress.total) * 100)
    : null;

  return (
    <div className="flex min-h-[60vh] flex-col items-center justify-center px-6 py-16" data-testid="loading-state-root">
      <div className="flex flex-col items-center space-y-3 rounded-2xl bg-white/55 px-10 py-8 shadow-paper backdrop-blur-md" style={{ minWidth: 280 }}>
        <img src={logo} className="object-contain mix-blend-multiply animate-pulse logoSmooth" style={{ animationDuration: "3s", width: "32px", height: "32px" }} data-testid="loading-state-logo" alt="Memoria Logo" />
        <p className="text-lg font-medium text-slate-700 animate-in fade-in slide-in-from-bottom-2">{message}</p>
        <p className="text-sm text-slate-500" data-testid="loading-state-hint">{hint}</p>
        {progress && (
          <div className="w-full" data-testid="loading-state-progress">
            <div className="flex justify-between text-xs text-slate-500 mb-1">
              <span className="truncate max-w-[200px]" data-testid="loading-state-progress-detail">{progress.detail}</span>
              {pct !== null && <span data-testid="loading-state-progress-pct">{pct}%</span>}
            </div>
            <div className="w-full h-1.5 rounded-full bg-slate-200 overflow-hidden">
              <div
                data-testid="loading-state-progress-bar"
                className="h-full rounded-full bg-gradient-to-r from-blue-400 via-purple-400 to-orange-300 transition-all duration-300"
                style={{ width: `${pct ?? 0}%` }}
              />
            </div>
            {progress.total > 0 && (
              <p className="text-xs text-slate-400 mt-1 text-center" data-testid="loading-state-progress-count">
                {progress.current} of {progress.total}
              </p>
            )}
          </div>
        )}
      </div>
    </div>
  );
};
