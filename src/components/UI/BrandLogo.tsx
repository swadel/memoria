import React from "react";
import logo from "../../assets/logo.png";

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
      className="flex items-center gap-3 hover:opacity-80 transition-opacity focus:outline-none appBrandButton"
      data-testid="brand-home-link"
      aria-label="Go to Dashboard"
    >
      <img
        src={logo}
        className={`${size} w-auto object-contain mix-blend-multiply appLogo`}
        alt="Memoria Logo"
      />
      <span className="text-2xl font-semibold tracking-tighter text-slate-800 title">
        {text}
      </span>
    </button>
  );
};
