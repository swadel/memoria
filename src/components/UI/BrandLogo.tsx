import React from "react";
import logo from "../../assets/flower_1024.png";

export const BrandLogo: React.FC<{ size?: string; text?: string; onClick?: () => void }> = ({ size = "h-10", text = "Memoria", onClick }) => {
  return (
    <button
      type="button"
      onClick={() => {
        if (onClick) {
          onClick();
          return;
        }
        window.location.href = "/";
      }}
      className="flex flex-col items-center justify-center gap-1 hover:opacity-80 transition-opacity focus:outline-none appBrandButton"
      data-testid="brand-home-link"
      aria-label="Go to Dashboard"
    >
      <img
        src={logo}
        className={`${size} w-auto object-contain mix-blend-screen opacity-90 appLogo`}
        alt="Memoria Logo"
      />
      <span className="text-xl font-semibold tracking-tighter text-slate-800 title">
        {text}
      </span>
    </button>
  );
};
