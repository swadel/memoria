import React from "react";
import logo from "../../assets/flower_1024.png";

interface LoadingStateProps {
  message?: string;
  hint?: string;
}

export const LoadingState: React.FC<LoadingStateProps> = ({
  message = "Processing...",
  hint = "This may take a moment depending on your library size."
}) => {
  return (
    <div className="flex min-h-[60vh] flex-col items-center justify-center px-6 py-16" data-testid="loading-state-root">
      <div className="flex flex-col items-center space-y-3 rounded-2xl bg-white/55 px-10 py-8 shadow-paper backdrop-blur-md">
        <img src={logo} className="object-contain mix-blend-multiply animate-pulse logoSmooth" style={{ animationDuration: "3s", width: "32px", height: "32px" }} data-testid="loading-state-logo" alt="Memoria Logo" />
        <p className="text-lg font-medium text-slate-700 animate-in fade-in slide-in-from-bottom-2">{message}</p>
        <p className="text-sm text-slate-500" data-testid="loading-state-hint">{hint}</p>
      </div>
    </div>
  );
};
