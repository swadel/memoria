import React from "react";
import logo from "../../assets/flower_1024.png";

interface LoadingStateProps {
  message?: string;
}

export const LoadingState: React.FC<LoadingStateProps> = ({ message = "Processing..." }) => {
  return (
    <div className="flex min-h-[60vh] flex-col items-center justify-center p-16 space-y-6" data-testid="loading-state-root">
      <div className="relative">
        <div className="absolute inset-0 bg-petal-blue/20 blur-3xl rounded-full animate-pulse" />
        <img
          src={logo}
          className="relative h-24 w-24 object-contain mix-blend-multiply animate-pulse logoSmooth"
          style={{ animationDuration: "3s" }}
          data-testid="loading-state-logo"
          alt="Memoria Logo"
        />
      </div>

      <div className="text-center space-y-2">
        <p className="text-lg font-medium text-slate-700 animate-in fade-in slide-in-from-bottom-2">{message}</p>
        <p className="text-sm text-slate-400">This may take a moment depending on your library size.</p>
      </div>
    </div>
  );
};
